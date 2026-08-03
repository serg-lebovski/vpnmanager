import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BridgesService } from '../bridges/bridges.service';
import { decryptSecret, encryptSecret } from '../common/encryption.util';
import { ServerProtocolStatus, ServerStatus, VpnProtocol } from '../common/enums';
import { PeersService } from '../peers/peers.service';
import { SshService } from '../ssh/ssh.service';
import { VpnProvisioningService } from '../vpn/vpn-provisioning.service';
import { CreateServerDto } from './dto/create-server.dto';
import { InstallProtocolDto } from './dto/install-protocol.dto';
import { ServerProtocol } from './server-protocol.entity';
import { Server } from './server.entity';

export type ServerListItem = Omit<Server, 'protocols'> & { protocols: Array<ServerProtocol & { bridgeName: string | null }> };

@Injectable()
export class ServersService {
  private readonly logger = new Logger(ServersService.name);

  constructor(
    @InjectRepository(Server) private readonly serversRepository: Repository<Server>,
    @InjectRepository(ServerProtocol) private readonly serverProtocolsRepository: Repository<ServerProtocol>,
    private readonly sshService: SshService,
    private readonly vpnProvisioningService: VpnProvisioningService,
    private readonly peersService: PeersService,
    private readonly bridgesService: BridgesService,
  ) {}

  async findAll(): Promise<ServerListItem[]> {
    const servers = await this.serversRepository.find({ relations: ['protocols'], order: { createdAt: 'DESC' } });
    const { selfServerIds, protocolBridgeNames } = await this.bridgesService.getSelfServerContext();

    // Server.isSelf иногда не проставлен для self-сервера, который уже фактически
    // используется мостом (см. BridgesService.getSelfServerContext) — чиним здесь же по
    // факту, чтобы фильтр «не показывать self-сервера» на фронтенде (ServersPage) не
    // зависел от того, когда и как именно этот флаг был выставлен изначально.
    const toFix = servers.filter((server) => !server.isSelf && selfServerIds.has(server.id));
    if (toFix.length > 0) {
      toFix.forEach((server) => (server.isSelf = true));
      await this.serversRepository.save(toFix);
    }

    return servers.map((server) => ({
      ...server,
      protocols: server.protocols.map((sp) => ({ ...sp, bridgeName: protocolBridgeNames.get(sp.id) ?? null })),
    }));
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

  async remove(id: string): Promise<void> {
    const server = await this.findOneOrFail(id);
    // Если сервер сейчас служит upstream для какого-то моста — переключаем мост на другой
    // доступный сервер того же протокола, прежде чем удалять (иначе мост остался бы без
    // upstream и без возможности исправить это иначе как вручную по SSH).
    const protocolIds = server.protocols.map((p) => p.id);
    await this.bridgesService.reassignUpstreamAwayFrom(protocolIds);
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
