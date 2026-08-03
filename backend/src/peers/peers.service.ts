import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { Bridge } from '../bridges/bridge.entity';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { decryptSecret, encryptSecret } from '../common/encryption.util';
import { PeerSource, PeerStatus, Role, ServerProtocolStatus } from '../common/enums';
import { LoadBalancerService } from '../load-balancer/load-balancer.service';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { Server } from '../servers/server.entity';
import { PeerSpec } from '../vpn/vpn-driver.interface';
import { VpnProvisioningService } from '../vpn/vpn-provisioning.service';
import { buildClientConfig } from './config-generator.util';
import { CreatePeerDto } from './dto/create-peer.dto';
import { Peer } from './peer.entity';
import { generatePresharedKey, generateWgKeyPair } from './wg-keypair.util';
import { hostAddress } from '../vpn/network.util';

type SafeServerProtocol = Omit<ServerProtocol, 'server' | 'peers'> & { server: Omit<Server, 'sshSecretEnc'> };
export type PeerListItem = Omit<Peer, 'privateKeyEnc' | 'presharedKeyEnc' | 'serverProtocol'> & { serverProtocol: SafeServerProtocol };

@Injectable()
export class PeersService {
  constructor(
    @InjectRepository(Peer) private readonly peersRepository: Repository<Peer>,
    @InjectRepository(ServerProtocol) private readonly serverProtocolsRepository: Repository<ServerProtocol>,
    @InjectRepository(Server) private readonly serversRepository: Repository<Server>,
    @InjectRepository(Bridge) private readonly bridgesRepository: Repository<Bridge>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly loadBalancerService: LoadBalancerService,
    private readonly vpnProvisioningService: VpnProvisioningService,
  ) {}

  async findAllForRequester(requester: AuthenticatedUser, organizationId?: string): Promise<PeerListItem[]> {
    // Системные upstream-peers моста (BRIDGE_UPSTREAM) не показываются в обычных списках —
    // ими управляет только BridgesService.
    const where =
      requester.role === Role.SUPER_ADMIN
        ? { source: Not(PeerSource.BRIDGE_UPSTREAM), ...(organizationId ? { organizationId } : {}) }
        : { organizationId: requester.organizationId ?? IsNull(), source: Not(PeerSource.BRIDGE_UPSTREAM) };

    const peers = await this.peersRepository.find({
      where,
      relations: ['serverProtocol', 'serverProtocol.server'],
      order: { createdAt: 'DESC' },
    });
    return peers.map((peer) => this.toListItem(peer));
  }

  // Убирает секреты перед отдачей на фронтенд: приватный/preshared ключ peer'а и
  // зашифрованный SSH-секрет сервера (иначе он попал бы в ответ /peers даже org_admin/
  // org_user — сервер должен оставаться видимым только по имени, не как полная сущность).
  private toListItem(peer: Peer): PeerListItem {
    const { privateKeyEnc, presharedKeyEnc, serverProtocol, ...rest } = peer;
    const { server, ...serverProtocolRest } = serverProtocol;
    const { sshSecretEnc, ...safeServer } = server;
    return { ...rest, serverProtocol: { ...serverProtocolRest, server: safeServer } };
  }

  async create(requester: AuthenticatedUser, dto: CreatePeerDto): Promise<Peer> {
    const organizationId = this.resolveOrganizationId(requester, dto.organizationId);

    const serverProtocol = dto.bridgeId
      ? await this.findBridgeClientProtocol(requester, dto.bridgeId, dto.protocol)
      : dto.serverId
        ? await this.findActiveServerProtocolByServer(dto.serverId, dto.protocol)
        : await this.loadBalancerService.pickServerProtocol(dto.protocol);

    return this.createInternal(serverProtocol, {
      organizationId,
      name: dto.name,
      source: PeerSource.CREATED,
      createdByUserId: requester.userId,
    });
  }

  // Системный upstream-peer моста на backend-сервере — не привязан к организации, не
  // виден в обычных списках peers (см. findAllForRequester). Используется BridgesService.
  async createSystemPeer(serverProtocolId: string, name: string): Promise<Peer> {
    const serverProtocol = await this.serverProtocolsRepository.findOneOrFail({ where: { id: serverProtocolId } });
    return this.createInternal(serverProtocol, {
      organizationId: null,
      name,
      source: PeerSource.BRIDGE_UPSTREAM,
      createdByUserId: null,
    });
  }

  private async createInternal(
    serverProtocol: ServerProtocol,
    params: { organizationId: string | null; name: string; source: PeerSource; createdByUserId: string | null },
  ): Promise<Peer> {
    const { publicKey, privateKey } = generateWgKeyPair();
    const presharedKey = generatePresharedKey();

    const allowedIp = await this.allocateIp(serverProtocol.id);

    const peer = this.peersRepository.create({
      organizationId: params.organizationId,
      serverProtocolId: serverProtocol.id,
      name: params.name,
      publicKey,
      privateKeyEnc: encryptSecret(privateKey),
      presharedKeyEnc: encryptSecret(presharedKey),
      allowedIp,
      source: params.source,
      status: PeerStatus.ACTIVE,
      createdByUserId: params.createdByUserId,
    });
    const saved = await this.peersRepository.save(peer);

    // Если реальная отправка на сервер не удалась — не оставляем в БД "фантомный" peer,
    // который выглядит активным, но по факту на сервере не настроен.
    try {
      await this.syncServerPeers(serverProtocol.id);
    } catch (error) {
      await this.peersRepository.remove(saved);
      throw error;
    }

    return saved;
  }

  async revoke(requester: AuthenticatedUser, id: string): Promise<void> {
    const peer = await this.findOneScoped(requester, id);
    await this.revokeInternal(peer);
  }

  // Безвозвратное удаление записи — разрешено только для уже отозванных peers (сначала
  // отзыв, потом удаление; это гарантирует, что peer уже убран с сервера через
  // syncServerPeers перед тем, как мы потеряем о нём всякую память).
  async purge(requester: AuthenticatedUser, id: string): Promise<void> {
    const peer = await this.findOneScoped(requester, id);
    if (peer.status !== PeerStatus.REVOKED) {
      throw new BadRequestException('Можно удалить только уже отозванный peer — сначала отзовите его');
    }
    await this.peersRepository.remove(peer);
  }

  // Безвозвратное удаление системного upstream-peer — аналог purge(), но без требования
  // "текущего пользователя"/org-скоупинга (peer системный). Используется BridgesService
  // при удалении моста — после revokeSystemPeer (который уже убрал peer с upstream-
  // сервера по SSH), чтобы запись не висела в БД вечно как "отозванная, но не удалённая".
  async purgeSystemPeer(id: string): Promise<void> {
    const peer = await this.peersRepository.findOneOrFail({ where: { id } });
    await this.peersRepository.remove(peer);
  }

  // Отзыв системного upstream-peer моста — без требования "текущего пользователя" и без
  // org-скоупинга (peer системный). Используется BridgesService при смене upstream.
  async revokeSystemPeer(id: string): Promise<void> {
    const peer = await this.peersRepository.findOneOrFail({ where: { id } });
    await this.revokeInternal(peer);
  }

  private async revokeInternal(peer: Peer): Promise<void> {
    const previousStatus = peer.status;
    peer.status = PeerStatus.REVOKED;
    await this.peersRepository.save(peer);
    try {
      await this.syncServerPeers(peer.serverProtocolId);
    } catch (error) {
      peer.status = previousStatus;
      await this.peersRepository.save(peer);
      throw error;
    }
  }

  async getDownloadableConfig(requester: AuthenticatedUser, id: string): Promise<{ filename: string; content: string }> {
    const peer = await this.findOneScoped(requester, id);
    if (!peer.privateKeyEnc) {
      throw new BadRequestException(
        'Для этого peer приватный ключ недоступен (импортирован из уже существующей настройки VPN). Отзовите его и создайте новый через сервис.',
      );
    }
    const serverProtocol = await this.serverProtocolsRepository.findOneOrFail({ where: { id: peer.serverProtocolId } });
    const server = await this.serversRepository.findOneOrFail({ where: { id: serverProtocol.serverId } });
    const privateKey = decryptSecret(peer.privateKeyEnc);
    const presharedKey = peer.presharedKeyEnc ? decryptSecret(peer.presharedKeyEnc) : null;
    // Если serverProtocol — клиентский интерфейс моста с заданным domainName, Endpoint в
    // конфиге должен указывать на домен, а не на IP self-сервера (см. Bridge.domainName) —
    // так peer переживёт переезд self-сервера на новый хост/IP после смены DNS-записи.
    const bridge = await this.bridgesRepository.findOne({
      where: [{ wireguardClientProtocolId: serverProtocol.id }, { amneziawgClientProtocolId: serverProtocol.id }],
    });
    const endpointServer = bridge?.domainName ? { ...server, host: bridge.domainName } : server;
    const content = buildClientConfig(peer, privateKey, endpointServer, serverProtocol, presharedKey);
    return { filename: `${peer.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.conf`, content };
  }

  async importScannedPeers(serverProtocolId: string): Promise<number> {
    const scannedPeers = await this.vpnProvisioningService.scanExistingPeers(serverProtocolId);
    const existingPublicKeys = new Set(
      (await this.peersRepository.find({ where: { serverProtocolId } })).map((peer) => peer.publicKey),
    );

    let importedCount = 0;
    for (const scanned of scannedPeers) {
      if (existingPublicKeys.has(scanned.publicKey)) {
        continue;
      }
      const peer = this.peersRepository.create({
        organizationId: null,
        serverProtocolId,
        name: scanned.name || `imported-${scanned.publicKey.slice(0, 8)}`,
        publicKey: scanned.publicKey,
        privateKeyEnc: null,
        presharedKeyEnc: scanned.presharedKey ? encryptSecret(scanned.presharedKey) : null,
        allowedIp: scanned.allowedIp.split('/')[0],
        source: PeerSource.IMPORTED,
        status: PeerStatus.ACTIVE,
        createdByUserId: null,
      });
      await this.peersRepository.save(peer);
      importedCount += 1;
    }

    if (importedCount > 0) {
      await this.bumpNextHostOctetPastAllocated(serverProtocolId);
    }

    return importedCount;
  }

  // После импорта peers (созданных не через наш load-balancer/allocateIp) счётчик выдачи
  // IP на ServerProtocol может отставать от реально занятых адресов — сдвигаем его вперёд,
  // чтобы новый peer не получил уже занятый адрес.
  private async bumpNextHostOctetPastAllocated(serverProtocolId: string): Promise<void> {
    const peers = await this.peersRepository.find({ where: { serverProtocolId } });
    const maxOctet = peers.reduce((max, peer) => {
      const lastOctet = Number(peer.allowedIp.split('.').pop());
      return Number.isFinite(lastOctet) ? Math.max(max, lastOctet) : max;
    }, 1);

    await this.dataSource.transaction(async (manager) => {
      const serverProtocol = await manager.findOneOrFail(ServerProtocol, {
        where: { id: serverProtocolId },
        lock: { mode: 'pessimistic_write' },
      });
      if (serverProtocol.nextHostOctet <= maxOctet) {
        serverProtocol.nextHostOctet = maxOctet + 1;
        await manager.save(serverProtocol);
      }
    });
  }

  // null — явный осознанный выбор суперадмина «без клиента» (peer не привязан ни к одной
  // организации); undefined — поле не передали вовсе, это ошибка, суперадмин должен
  // выбрать явно (см. CreatePeerDto.organizationId).
  private resolveOrganizationId(requester: AuthenticatedUser, requestedOrgId?: string | null): string | null {
    if (requester.role === Role.SUPER_ADMIN) {
      if (requestedOrgId === undefined) {
        throw new BadRequestException('Для суперадмина обязателен organizationId (или явно null — «без клиента»)');
      }
      return requestedOrgId;
    }
    if (!requester.organizationId) {
      throw new ForbiddenException('Пользователь не привязан к организации');
    }
    return requester.organizationId;
  }

  // Раньше блокировался весь self-сервер целиком (Server.isSelf) — но self-сервер может
  // нести и protocols, НЕ занятые ни одним мостом (например, если на нём есть запас
  // ёмкости помимо клиентских интерфейсов моста), и такой сервер не должен пропадать из
  // выбора целиком. Поэтому проверяем неоднозначность/занятость на уровне КОНКРЕТНОГО
  // протокола, а не сервера.
  private async findActiveServerProtocolByServer(serverId: string, protocol: CreatePeerDto['protocol']): Promise<ServerProtocol> {
    const candidates = await this.serverProtocolsRepository.find({ where: { serverId, protocol } });
    const active = candidates.filter((sp) => sp.status === ServerProtocolStatus.ACTIVE);
    if (active.length === 0) {
      throw new BadRequestException('На указанном сервере протокол не установлен или неактивен');
    }
    if (active.length > 1) {
      // На одном self-сервере может быть несколько мостов с одним и тем же протоколом
      // (разные порты/сети, см. CLAUDE.md про несколько мостов на self-сервере) — выбор
      // по serverId+protocol был бы неоднозначен (взял бы первый попавшийся, рискуя
      // создать peer не в том мосту).
      throw new BadRequestException(
        'На этом сервере несколько интерфейсов этого протокола (используются разными мостами) — выберите конкретный мост в поле «Мост» вместо сервера.',
      );
    }
    const serverProtocol = active[0];
    const claimedByBridge = await this.bridgesRepository.findOne({
      where: [{ wireguardClientProtocolId: serverProtocol.id }, { amneziawgClientProtocolId: serverProtocol.id }],
    });
    if (claimedByBridge) {
      throw new BadRequestException(
        `Этот протокол — клиентский интерфейс моста «${claimedByBridge.name}». Выберите этот мост в поле «Мост» вместо сервера.`,
      );
    }
    return serverProtocol;
  }

  // Резолвит клиентский интерфейс конкретного моста под нужный протокол. org_admin/
  // org_user могут указывать только мост своей организации либо общий (organizationId
  // = null) — чужой мост им не виден и не назначаем, даже зная его id напрямую.
  private async findBridgeClientProtocol(
    requester: AuthenticatedUser,
    bridgeId: string,
    protocol: CreatePeerDto['protocol'],
  ): Promise<ServerProtocol> {
    const bridge = await this.bridgesRepository.findOne({ where: { id: bridgeId } });
    if (!bridge) {
      throw new BadRequestException('Мост не найден');
    }
    if (requester.role !== Role.SUPER_ADMIN && bridge.organizationId !== null && bridge.organizationId !== requester.organizationId) {
      throw new ForbiddenException('Недостаточно прав для этого моста');
    }
    const serverProtocolId = protocol === 'wireguard' ? bridge.wireguardClientProtocolId : bridge.amneziawgClientProtocolId;
    if (!serverProtocolId) {
      throw new BadRequestException(`На этом мосту не установлен протокол ${protocol}`);
    }
    const serverProtocol = await this.serverProtocolsRepository.findOne({ where: { id: serverProtocolId } });
    if (!serverProtocol || serverProtocol.status !== 'active') {
      throw new BadRequestException('Клиентский интерфейс моста не установлен или неактивен');
    }
    return serverProtocol;
  }

  private async findOneScoped(requester: AuthenticatedUser, id: string): Promise<Peer> {
    const peer = await this.peersRepository.findOne({ where: { id } });
    if (!peer) {
      throw new NotFoundException('Peer не найден');
    }
    if (requester.role !== Role.SUPER_ADMIN && peer.organizationId !== requester.organizationId) {
      throw new ForbiddenException('Недостаточно прав для доступа к этому peer');
    }
    return peer;
  }

  private async allocateIp(serverProtocolId: string): Promise<string> {
    return this.dataSource.transaction(async (manager) => {
      const serverProtocol = await manager.findOneOrFail(ServerProtocol, {
        where: { id: serverProtocolId },
        lock: { mode: 'pessimistic_write' },
      });
      if (serverProtocol.nextHostOctet > 254) {
        throw new BadRequestException('Адресное пространство сети на этом сервере исчерпано');
      }
      const octet = serverProtocol.nextHostOctet;
      serverProtocol.nextHostOctet += 1;
      await manager.save(serverProtocol);
      return hostAddress(serverProtocol.networkCidr, octet);
    });
  }

  private async syncServerPeers(serverProtocolId: string): Promise<void> {
    const serverProtocol = await this.serverProtocolsRepository.findOneOrFail({ where: { id: serverProtocolId } });
    const server = await this.serversRepository.findOneOrFail({ where: { id: serverProtocol.serverId } });
    const activePeers = await this.peersRepository.find({
      where: { serverProtocolId, status: PeerStatus.ACTIVE },
    });
    const specs: PeerSpec[] = activePeers.map((peer) => ({
      publicKey: peer.publicKey,
      presharedKey: peer.presharedKeyEnc ? decryptSecret(peer.presharedKeyEnc) : undefined,
      allowedIp: peer.allowedIp,
      name: peer.name,
    }));
    await this.vpnProvisioningService.applyPeers(serverProtocol, server, specs);
  }
}
