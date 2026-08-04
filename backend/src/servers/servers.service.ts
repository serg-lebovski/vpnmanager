import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BridgesService } from '../bridges/bridges.service';
import { decryptSecret, encryptSecret } from '../common/encryption.util';
import { PeerStatus, ServerProtocolStatus, ServerStatus, VpnProtocol } from '../common/enums';
import { Peer } from '../peers/peer.entity';
import { PeersService } from '../peers/peers.service';
import { SshService } from '../ssh/ssh.service';
import { VpnProvisioningService } from '../vpn/vpn-provisioning.service';
import { CreateServerDto } from './dto/create-server.dto';
import { InstallProtocolDto } from './dto/install-protocol.dto';
import { UpdateServerCredentialsDto } from './dto/update-server-credentials.dto';
import { UpdateServerDto } from './dto/update-server.dto';
import { ServerProtocol } from './server-protocol.entity';
import { Server } from './server.entity';

export type ServerListItem = Omit<Server, 'protocols'> & {
  protocols: Array<ServerProtocol & { bridgeName: string | null }>;
  needsCredentials: boolean;
};

@Injectable()
export class ServersService {
  private readonly logger = new Logger(ServersService.name);

  constructor(
    @InjectRepository(Server) private readonly serversRepository: Repository<Server>,
    @InjectRepository(ServerProtocol) private readonly serverProtocolsRepository: Repository<ServerProtocol>,
    @InjectRepository(Peer) private readonly peersRepository: Repository<Peer>,
    private readonly sshService: SshService,
    private readonly vpnProvisioningService: VpnProvisioningService,
    private readonly peersService: PeersService,
    private readonly bridgesService: BridgesService,
  ) {}

  async findAll(): Promise<ServerListItem[]> {
    const servers = await this.serversRepository.find({ relations: ['protocols'], order: { createdAt: 'DESC' } });
    const { selfServerIds, protocolBridgeNames } = await this.bridgesService.getSelfServerContext();

    // Server.isSelf может разойтись с реальностью в обе стороны: не проставлен вовремя
    // (см. BridgesService.getSelfServerContext) — или, наоборот, остался true у сервера,
    // который раньше был self-сервером какого-то моста, а потом мост с него сняли
    // (сменили клиентский интерфейс на другой сервер) — флаг никогда не сбрасывался
    // обратно (поймано вживую: bithosting nl продолжал висеть с пометкой "Мост (self)"
    // после того, как перестал использоваться мостом). Чиним оба случая по факту при
    // каждом чтении списка.
    const toFix = servers.filter((server) => server.isSelf !== selfServerIds.has(server.id));
    if (toFix.length > 0) {
      toFix.forEach((server) => (server.isSelf = selfServerIds.has(server.id)));
      await this.serversRepository.save(toFix);
    }

    return servers.map((server) => ({
      ...server,
      // Расшифровывается ключом APP_ENCRYPTION_KEY из .env — если сервер (и вся БД)
      // восстановлен на деплое с ДРУГИМ ключом (см. system/restore.service.ts, disaster
      // recovery), sshSecretEnc становится нечитаемым мусором (несовпадение GCM auth
      // tag). Единая точка обнаружения на чтение — работает для любой причины
      // нерасшифровываемости, не только restore; PATCH /servers/:id/credentials снимает
      // флаг после ввода новых учётных данных.
      needsCredentials: !this.canDecryptSecret(server.sshSecretEnc),
      protocols: server.protocols.map((sp) => ({ ...sp, bridgeName: protocolBridgeNames.get(sp.id) ?? null })),
    }));
  }

  private canDecryptSecret(sshSecretEnc: string): boolean {
    try {
      decryptSecret(sshSecretEnc);
      return true;
    } catch {
      return false;
    }
  }

  async findOneOrFail(id: string): Promise<Server> {
    const server = await this.serversRepository.findOne({ where: { id }, relations: ['protocols'] });
    if (!server) {
      throw new NotFoundException('Сервер не найден');
    }
    return server;
  }

  async create(dto: CreateServerDto): Promise<Server> {
    const server = this.serversRepository.create({
      name: dto.name,
      host: dto.host,
      sshPort: dto.sshPort ?? 22,
      sshUsername: dto.sshUsername,
      sshAuthType: dto.sshAuthType,
      sshSecretEnc: encryptSecret(dto.secret),
      maxPeers: dto.maxPeers ?? 100,
      status: ServerStatus.UNKNOWN,
    });
    return this.serversRepository.save(server);
  }

  async update(id: string, dto: UpdateServerDto): Promise<Server> {
    const server = await this.findOneOrFail(id);
    if (dto.name !== undefined) {
      server.name = dto.name;
    }
    return this.serversRepository.save(server);
  }

  // Переввод SSH-учётных данных — узкий эндпоинт (тот же паттерн, что /test-connection,
  // /reboot, /detect), нужен когда sshSecretEnc не расшифровывается текущим
  // APP_ENCRYPTION_KEY (см. needsCredentials в findAll()). secret обязателен — в этом и
  // весь смысл вызова.
  async updateCredentials(id: string, dto: UpdateServerCredentialsDto): Promise<Server> {
    const server = await this.findOneOrFail(id);
    if (dto.sshUsername !== undefined) {
      server.sshUsername = dto.sshUsername;
    }
    if (dto.sshPort !== undefined) {
      server.sshPort = dto.sshPort;
    }
    if (dto.sshAuthType !== undefined) {
      server.sshAuthType = dto.sshAuthType;
    }
    server.sshSecretEnc = encryptSecret(dto.secret);
    return this.serversRepository.save(server);
  }

  async remove(id: string): Promise<void> {
    const server = await this.findOneOrFail(id);
    // Если сервер сейчас служит upstream для какого-то моста — переключаем мост на другой
    // доступный сервер того же протокола, прежде чем удалять (иначе мост остался бы без
    // upstream и без возможности исправить это иначе как вручную по SSH).
    const protocolIds = server.protocols.map((p) => p.id);
    await this.bridgesService.reassignUpstreamAwayFrom(protocolIds);

    if (protocolIds.length > 0) {
      // Явно деактивируем и удаляем peers и протоколы этого сервера, а не полагаемся
      // только на ON DELETE CASCADE в БД — надёжнее и нагляднее, что после удаления
      // сервера ничего не остаётся "подвешенным" (peer, к которому уже не подключиться,
      // раз сервера в панели больше нет). SSH на сам удаляемый сервер не дёргаем —
      // сервер обычно удаляют именно потому, что он недоступен/выводится из эксплуатации.
      await this.peersRepository.update({ serverProtocolId: In(protocolIds) }, { status: PeerStatus.REVOKED });
      await this.peersRepository.delete({ serverProtocolId: In(protocolIds) });
      await this.serverProtocolsRepository.delete(protocolIds);
    }

    await this.serversRepository.remove(server);
  }

  async testConnection(id: string): Promise<{ ok: boolean; info?: string; error?: string }> {
    const server = await this.findOneOrFail(id);
    const result = await this.sshService.testConnection({
      host: server.host,
      port: server.sshPort,
      username: server.sshUsername,
      authType: server.sshAuthType,
      secret: decryptSecret(server.sshSecretEnc),
    });
    server.status = result.ok ? ServerStatus.ONLINE : ServerStatus.OFFLINE;
    server.lastCheckedAt = new Date();
    server.lastError = result.ok ? null : result.error || null;
    await this.serversRepository.save(server);
    return result;
  }

  // Отправляет команду перезагрузки по SSH и сразу возвращает управление — сама
  // перезагрузка обрывает SSH-соединение раньше, чем оно успело бы штатно закрыться
  // (это нормально, не ошибка выполнения команды, поэтому подавляем исключение).
  async reboot(id: string): Promise<{ message: string }> {
    const server = await this.findOneOrFail(id);
    const connection = this.vpnProvisioningService.connectionParams(server);
    try {
      await this.sshService.withConnection(connection, (ssh) => this.sshService.exec(ssh, 'reboot'));
    } catch (error) {
      this.logger.debug(`SSH-соединение оборвалось при перезагрузке ${server.name} (ожидаемо): ${(error as Error).message}`);
    }
    return { message: 'Команда перезагрузки отправлена' };
  }

  async installProtocol(serverId: string, dto: InstallProtocolDto): Promise<ServerProtocol> {
    const serverProtocol = await this.vpnProvisioningService.installProtocol(serverId, dto.protocol, dto.listenPort, dto.networkCidr);
    if (serverProtocol.status === ServerProtocolStatus.ACTIVE) {
      await this.ensureReservedUpstreamPeer(serverProtocol);
    }
    return serverProtocol;
  }

  // Заранее поднимает системный upstream-peer на только что установленном протоколе —
  // BridgesService.setUpstream переиспользует его вместо создания нового при первом же
  // переключении моста на этот сервер (см. комментарий у ServerProtocol.reservedUpstreamPeer).
  // Best-effort: если не получилось (например, сервер стал недоступен сразу после
  // установки) — не валим сам install, setUpstream просто создаст peer на лету как раньше.
  private async ensureReservedUpstreamPeer(serverProtocol: ServerProtocol): Promise<void> {
    try {
      const reserved = await this.peersService.createSystemPeer(serverProtocol.id, `upstream-reserved:${serverProtocol.id.slice(0, 8)}`);
      serverProtocol.reservedUpstreamPeerId = reserved.id;
      await this.serverProtocolsRepository.save(serverProtocol);
    } catch (error) {
      this.logger.warn(`Не удалось заранее создать upstream-peer для ${serverProtocol.id}: ${(error as Error).message}`);
    }
  }

  async scanAndImport(serverProtocolId: string): Promise<{ importedCount: number }> {
    const importedCount = await this.peersService.importScannedPeers(serverProtocolId);
    return { importedCount };
  }

  // Проверяет сервер на уже существующую (не заведённую через сервис) установку
  // WireGuard и/или AmneziaWG по стандартным путям и, если находит, подключает её к
  // учёту (ServerProtocol) и сразу забирает её peers в базу. Ничего не устанавливает
  // и не перезапускает интерфейс — только читает и, при обнаружении, "усыновляет".
  async detectExistingInstallations(
    serverId: string,
  ): Promise<Array<{ protocol: VpnProtocol; found: boolean; importedCount?: number }>> {
    const results: Array<{ protocol: VpnProtocol; found: boolean; importedCount?: number }> = [];
    for (const protocol of [VpnProtocol.WIREGUARD, VpnProtocol.AMNEZIAWG]) {
      const serverProtocol = await this.vpnProvisioningService.detectExisting(serverId, protocol);
      if (!serverProtocol) {
        results.push({ protocol, found: false });
        continue;
      }
      const importedCount = await this.peersService.importScannedPeers(serverProtocol.id);
      results.push({ protocol, found: true, importedCount });
    }
    return results;
  }
}
