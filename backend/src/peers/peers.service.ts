import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, LessThanOrEqual, MoreThan, Not, Repository } from 'typeorm';
import { Bridge } from '../bridges/bridge.entity';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { decryptSecret, encryptSecret } from '../common/encryption.util';
import { PeerSource, PeerStatus, Role, ServerProtocolStatus } from '../common/enums';
import { LoadBalancerService } from '../load-balancer/load-balancer.service';
import { Organization } from '../organizations/organization.entity';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { Server } from '../servers/server.entity';
import { PeerSpec } from '../vpn/vpn-driver.interface';
import { VpnProvisioningService } from '../vpn/vpn-provisioning.service';
import { buildClientConfig } from './config-generator.util';
import { CreatePeerDto } from './dto/create-peer.dto';
import { UpdatePeerDto } from './dto/update-peer.dto';
import { Peer } from './peer.entity';
import { generatePresharedKey, generateWgKeyPair } from './wg-keypair.util';
import { hostAddress } from '../vpn/network.util';

type SafeServerProtocol = Omit<ServerProtocol, 'server' | 'peers'> & { server: Omit<Server, 'sshSecretEnc'> };
export type PeerListItem = Omit<Peer, 'privateKeyEnc' | 'presharedKeyEnc' | 'serverProtocol'> & {
  serverProtocol: SafeServerProtocol;
  // true — ключ(и) peer'а есть, но не расшифровываются текущим APP_ENCRYPTION_KEY (обычно
  // после восстановления БД на деплое с другим ключом, см. system/restore.service.ts) —
  // peer нерабочий и невосстановимый (в отличие от Server.sshSecretEnc, ключ клиента нельзя
  // "ввести заново" — его никто, кроме уже потерянного сервера, не знал), нужно отозвать и
  // создать заново. false для импортированных peers (privateKeyEnc всегда null — это не
  // поломка, а ожидаемое состояние, см. importScannedPeers).
  needsRecreation: boolean;
  // Срок действия прошёл (expiresAt задан и уже в прошлом) — peer при этом остаётся
  // status ACTIVE, не удаляется и не отзывается, просто исключён из конфига на сервере.
  isExpired: boolean;
};

// Как часто проверять, не истёк ли у кого-то срок действия, если это НЕ произошло само
// по себе через другое действие (revoke/create/update другого peer на том же протоколе).
// Срок — точка во времени, а не событие: без отдельной периодической проверки peer так и
// остался бы применённым на сервере навсегда, пока что-то ещё не дёрнет syncServerPeers.
const EXPIRY_CHECK_INTERVAL_MS = 60 * 1000;

@Injectable()
export class PeersService {
  private readonly logger = new Logger(PeersService.name);
  // peerId -> expiresAt.getTime(), для которого уже выполнен syncServerPeers — не даёт
  // дёргать down;up всего протокола на каждый тик, пока peer остаётся в истёкшем
  // состоянии, и не путает повторное истечение после продления с уже обработанным.
  private readonly appliedExpiry = new Map<string, number>();

  constructor(
    @InjectRepository(Peer) private readonly peersRepository: Repository<Peer>,
    @InjectRepository(ServerProtocol) private readonly serverProtocolsRepository: Repository<ServerProtocol>,
    @InjectRepository(Server) private readonly serversRepository: Repository<Server>,
    @InjectRepository(Bridge) private readonly bridgesRepository: Repository<Bridge>,
    @InjectRepository(Organization) private readonly organizationsRepository: Repository<Organization>,
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

  // Для формы создания peer — org_admin/org_user не видят /servers вообще (он
  // super_admin-only, там же SSH-секреты), но должны знать, из каких обычных серверов
  // (не self-, не мостовых) им можно выбирать напрямую (см. Organization.allowedServerIds)
  // — только имя и id, без остальных полей сервера.
  async getAllowedServersForRequester(requester: AuthenticatedUser): Promise<Array<{ id: string; name: string }>> {
    if (requester.role === Role.SUPER_ADMIN) {
      const servers = await this.serversRepository.find({ order: { name: 'ASC' } });
      return servers.map((s) => ({ id: s.id, name: s.name }));
    }
    if (!requester.organizationId) {
      return [];
    }
    const organization = await this.organizationsRepository.findOneOrFail({ where: { id: requester.organizationId } });
    if (organization.allowedServerIds.length === 0) {
      return [];
    }
    const servers = await this.serversRepository.find({ where: { id: In(organization.allowedServerIds) }, order: { name: 'ASC' } });
    return servers.map((s) => ({ id: s.id, name: s.name }));
  }

  // Убирает секреты перед отдачей на фронтенд: приватный/preshared ключ peer'а и
  // зашифрованный SSH-секрет сервера (иначе он попал бы в ответ /peers даже org_admin/
  // org_user — сервер должен оставаться видимым только по имени, не как полная сущность).
  private toListItem(peer: Peer): PeerListItem {
    const { privateKeyEnc, presharedKeyEnc, serverProtocol, ...rest } = peer;
    const { server, ...serverProtocolRest } = serverProtocol;
    const { sshSecretEnc, ...safeServer } = server;
    const needsRecreation = !this.canDecrypt(privateKeyEnc) || !this.canDecrypt(presharedKeyEnc);
    const isExpired = peer.expiresAt !== null && peer.expiresAt.getTime() <= Date.now();
    return { ...rest, needsRecreation, isExpired, serverProtocol: { ...serverProtocolRest, server: safeServer } };
  }

  private canDecrypt(secretEnc: string | null): boolean {
    if (!secretEnc) {
      return true;
    }
    try {
      decryptSecret(secretEnc);
      return true;
    } catch {
      return false;
    }
  }

  async create(requester: AuthenticatedUser, dto: CreatePeerDto): Promise<Peer> {
    const organizationId = this.resolveOrganizationId(requester, dto.organizationId);

    // Суперадмин не ограничен allowedServerIds/blockedBridgeIds организации — эти
    // ограничения существуют для self-service org_admin/org_user, не для управления
    // инфраструктурой в целом (суперадмин и так явно выбирает организацию каждого peer'а).
    let allowedServerIds: string[] | undefined;
    if (requester.role !== Role.SUPER_ADMIN && organizationId) {
      const organization = await this.organizationsRepository.findOneOrFail({ where: { id: organizationId } });
      if (dto.bridgeId) {
        if (organization.blockedBridgeIds.includes(dto.bridgeId)) {
          throw new ForbiddenException('Этот мост недоступен для вашей организации');
        }
      } else if (dto.serverId) {
        if (!organization.allowedServerIds.includes(dto.serverId)) {
          throw new ForbiddenException('Этот сервер недоступен для вашей организации');
        }
      } else if (organization.allowedServerIds.length === 0) {
        // Ни мост, ни сервер не выбраны явно — авто-балансировка обычно перебирает ВСЕ
        // активные серверы протокола; без явно разрешённых серверов у организации это
        // означало бы попасть на сервер, который ей не выдавали.
        throw new ForbiddenException('Для вашей организации не настроены доступные серверы — выберите мост');
      } else {
        allowedServerIds = organization.allowedServerIds;
      }
    }

    const serverProtocol = dto.bridgeId
      ? await this.findBridgeClientProtocol(requester, dto.bridgeId, dto.protocol)
      : dto.serverId
        ? await this.findActiveServerProtocolByServer(dto.serverId, dto.protocol)
        : await this.loadBalancerService.pickServerProtocol(dto.protocol, allowedServerIds);

    return this.createInternal(serverProtocol, {
      organizationId,
      name: dto.name,
      source: PeerSource.CREATED,
      createdByUserId: requester.userId,
    });
  }

  // Переименование доступно всем, у кого есть доступ к peer'у (см. findOneScoped); смена
  // организации — только суперадмину. Не трогаем реальный конфиг на сервере (имя пира —
  // чисто конфигурационное поле в этой панели, а не то, что участвует в handshake) —
  // единственное место, где имя peer'а попадает в сам wg/awg-конфиг (комментарий "# name:
  // ..." в syncServerPeers), намеренно не пересобираем ради простого переименования: это
  // означало бы обрывать туннели ВСЕМ peers этого протокола (down;up всего интерфейса)
  // ради косметического изменения одной строки, которую всё равно никто не читает вручную.
  async update(requester: AuthenticatedUser, id: string, dto: UpdatePeerDto): Promise<PeerListItem> {
    const peer = await this.findOneScoped(requester, id);

    if (dto.organizationId !== undefined) {
      if (requester.role !== Role.SUPER_ADMIN) {
        throw new ForbiddenException('Только суперадмин может сменить организацию peer’а');
      }
      if (dto.organizationId !== null) {
        const organization = await this.organizationsRepository.findOne({ where: { id: dto.organizationId } });
        if (!organization) {
          throw new NotFoundException('Организация не найдена');
        }
      }
      peer.organizationId = dto.organizationId;
    }

    if (dto.name !== undefined) {
      peer.name = dto.name;
    }

    let previousExpiresAt: Date | null | undefined;
    if (dto.expiresAt !== undefined) {
      if (requester.role !== Role.SUPER_ADMIN) {
        throw new ForbiddenException('Только суперадмин может менять срок действия peer’а');
      }
      previousExpiresAt = peer.expiresAt;
      peer.expiresAt = dto.expiresAt === null ? null : new Date(dto.expiresAt);
    }

    const saved = await this.peersRepository.save(peer);

    // Срок действия влияет на то, применён ли peer на сервере ПРЯМО СЕЙЧАС (см.
    // syncServerPeers) — в отличие от имени/организации (чистая косметика в этой панели),
    // поэтому продление/установку срока нужно применить немедленно, а не ждать, пока это
    // подхватит случайный другой sync или периодическая проверка (см. checkExpiredPeers).
    if (dto.expiresAt !== undefined) {
      try {
        await this.syncServerPeers(saved.serverProtocolId);
      } catch (error) {
        saved.expiresAt = previousExpiresAt ?? null;
        await this.peersRepository.save(saved);
        throw error;
      }
    }

    const withRelations = await this.peersRepository.findOneOrFail({
      where: { id: saved.id },
      relations: ['serverProtocol', 'serverProtocol.server'],
    });
    return this.toListItem(withRelations);
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
    // Массив условий в TypeORM = OR: берём ACTIVE-peers без срока ИЛИ со сроком, который
    // ещё не прошёл — истёкшие (но не отозванные, см. Peer.expiresAt) молча выпадают из
    // конфига, применяемого на сервере, без изменения их status.
    const activePeers = await this.peersRepository.find({
      where: [
        { serverProtocolId, status: PeerStatus.ACTIVE, expiresAt: IsNull() },
        { serverProtocolId, status: PeerStatus.ACTIVE, expiresAt: MoreThan(new Date()) },
      ],
    });
    // presharedKeyEnc может оказаться нерасшифровываемым — например, после восстановления
    // БД на деплое с ДРУГИМ APP_ENCRYPTION_KEY (см. system/restore.service.ts). Раньше
    // decryptSecret, брошенный ВНУТРИ .map(), обрывал сборку specs целиком — один такой
    // "мёртвый" peer навсегда блокировал синхронизацию ВСЕХ остальных (в т.ч. живых) peers
    // этого протокола, включая попытку отозвать сам сломанный peer. Пропускаем такой peer
    // (не отправляем на сервер — он всё равно нерабочий без preshared-ключа) вместо того,
    // чтобы валить весь sync.
    const specs: PeerSpec[] = [];
    for (const peer of activePeers) {
      try {
        specs.push({
          publicKey: peer.publicKey,
          presharedKey: peer.presharedKeyEnc ? decryptSecret(peer.presharedKeyEnc) : undefined,
          allowedIp: peer.allowedIp,
          name: peer.name,
        });
      } catch (error) {
        this.logger.warn(
          `Peer "${peer.name}" (${peer.id}) исключён из синхронизации — не расшифровался preshared-ключ: ${(error as Error).message}`,
        );
      }
    }
    await this.vpnProvisioningService.applyPeers(serverProtocol, server, specs);
  }

  // Подхватывает истечение срока действия, если его НЕ подхватило что-то другое (revoke/
  // update/create другого peer на том же протоколе, которые и так вызывают
  // syncServerPeers). Синхронизирует протокол только один раз на каждое конкретное
  // значение expiresAt — если peer потом продлить и он истечёт заново с НОВОЙ датой, это
  // снова будет расценено как "впервые" (см. appliedExpiry).
  @Interval(EXPIRY_CHECK_INTERVAL_MS)
  private async checkExpiredPeers(): Promise<void> {
    const now = new Date();
    const expiredPeers = await this.peersRepository.find({
      where: { status: PeerStatus.ACTIVE, expiresAt: LessThanOrEqual(now) },
    });

    const currentIds = new Set<string>();
    const affectedProtocolIds = new Set<string>();
    for (const peer of expiredPeers) {
      currentIds.add(peer.id);
      const expiryTimestamp = peer.expiresAt!.getTime();
      if (this.appliedExpiry.get(peer.id) !== expiryTimestamp) {
        this.appliedExpiry.set(peer.id, expiryTimestamp);
        affectedProtocolIds.add(peer.serverProtocolId);
      }
    }
    // Peer'ы, продлённые с прошлого тика (больше не в числе истёкших), больше не нужно
    // помнить — иначе следующее истечение с новой датой не будет замечено.
    for (const peerId of this.appliedExpiry.keys()) {
      if (!currentIds.has(peerId)) {
        this.appliedExpiry.delete(peerId);
      }
    }

    for (const serverProtocolId of affectedProtocolIds) {
      try {
        await this.syncServerPeers(serverProtocolId);
      } catch (error) {
        this.logger.warn(`Не удалось отключить истёкшие peers на протоколе ${serverProtocolId}: ${(error as Error).message}`);
      }
    }
  }
}
