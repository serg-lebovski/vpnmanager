import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, LessThanOrEqual, MoreThan, Not, Repository } from 'typeorm';
import { Bridge } from '../bridges/bridge.entity';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { decryptSecret, encryptSecret } from '../common/encryption.util';
import { PeerDeviceType, PeerSource, PeerStatus, Role, ServerProtocolStatus, VpnProtocol } from '../common/enums';
import { LoadBalancerService } from '../load-balancer/load-balancer.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Organization } from '../organizations/organization.entity';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { Server } from '../servers/server.entity';
import { TelegramRegistration } from '../telegram-bot/telegram-registration.entity';
import { PeerSpec } from '../vpn/vpn-driver.interface';
import { VpnProvisioningService } from '../vpn/vpn-provisioning.service';
import { AmneziaContainerInput, buildAmneziaAppConfig } from './amnezia-config.util';
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
    private readonly notificationsService: NotificationsService,
  ) {}

  async findAllForRequester(requester: AuthenticatedUser, organizationId?: string): Promise<PeerListItem[]> {
    // Системные upstream-peers моста (BRIDGE_UPSTREAM) не показываются в обычных списках —
    // ими управляет только BridgesService. ENGINEER не привязан к организации (создаёт
    // peers для ЛЮБОЙ) — поэтому скоупится не по organizationId, а по тому, кто именно
    // создал peer (см. findOneScoped — та же логика для доступа к одному peer'у).
    const where =
      requester.role === Role.SUPER_ADMIN
        ? { source: Not(PeerSource.BRIDGE_UPSTREAM), ...(organizationId ? { organizationId } : {}) }
        : requester.role === Role.ENGINEER
          ? { createdByUserId: requester.userId, source: Not(PeerSource.BRIDGE_UPSTREAM) }
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
    // ENGINEER создаёt peers для любой организации/моста — как и суперадмину, ему не имеет
    // смысла ограничивать выбор серверов через allowedServerIds конкретной организации.
    if (requester.role === Role.SUPER_ADMIN || requester.role === Role.ENGINEER) {
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

    // Суперадмин и ENGINEER не ограничены allowedServerIds/blockedBridgeIds организации —
    // эти ограничения существуют для self-service org_admin/org_user, не для управления
    // инфраструктурой в целом (оба явно выбирают организацию каждого peer'а сами).
    let allowedServerIds: string[] | undefined;
    if (requester.role !== Role.SUPER_ADMIN && requester.role !== Role.ENGINEER && organizationId) {
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

    if (dto.multiProtocol) {
      return this.createMultiProtocol(requester, dto, organizationId, allowedServerIds);
    }

    const serverProtocol = await this.resolveServerProtocolForCreate(requester, dto, dto.protocol, allowedServerIds);

    return this.createInternal(serverProtocol, {
      organizationId,
      name: dto.name,
      source: PeerSource.CREATED,
      createdByUserId: requester.userId,
    });
  }

  private async resolveServerProtocolForCreate(
    requester: AuthenticatedUser,
    dto: CreatePeerDto,
    protocol: CreatePeerDto['protocol'],
    allowedServerIds: string[] | undefined,
  ): Promise<ServerProtocol> {
    return dto.bridgeId
      ? this.findBridgeClientProtocol(requester, dto.bridgeId, protocol)
      : dto.serverId
        ? this.findActiveServerProtocolByServer(dto.serverId, protocol)
        : this.loadBalancerService.pickServerProtocol(protocol, allowedServerIds);
  }

  // «Мультиконфиг» — один логический peer сразу на двух протоколах (WireGuard и
  // AmneziaWG), выдаваемый одним .vpn-файлом для официального приложения AmneziaVPN, где
  // протокол переключается прямо внутри приложения (см. amnezia-config.util.ts). Технически
  // это ДВА обычных Peer (свои ключи/IP — WG и AmneziaWG не могут делить один ServerProtocol
  // с его собственной сетью/интерфейсом), связанных Peer.pairedPeerId в обе стороны;
  // revoke/purge/переименование/срок действия на одном каскадом применяются к другому
  // (см. revoke/purge/update). Требует, чтобы ОБА протокола были активны на выбранном
  // мосту/сервере — если хотя бы один не резолвится, откатываем уже созданный первый peer,
  // не оставляя половинчатый "мульти"-peer без пары.
  private async createMultiProtocol(
    requester: AuthenticatedUser,
    dto: CreatePeerDto,
    organizationId: string | null,
    allowedServerIds: string[] | undefined,
  ): Promise<Peer> {
    const wireguardProtocol = await this.resolveServerProtocolForCreate(requester, dto, VpnProtocol.WIREGUARD, allowedServerIds);
    const amneziawgProtocol = await this.resolveServerProtocolForCreate(requester, dto, VpnProtocol.AMNEZIAWG, allowedServerIds);

    const wireguardPeer = await this.createInternal(wireguardProtocol, {
      organizationId,
      name: dto.name,
      source: PeerSource.CREATED,
      createdByUserId: requester.userId,
    });

    let amneziawgPeer: Peer;
    try {
      amneziawgPeer = await this.createInternal(amneziawgProtocol, {
        organizationId,
        name: dto.name,
        source: PeerSource.CREATED,
        createdByUserId: requester.userId,
      });
    } catch (error) {
      await this.revokeInternal(wireguardPeer);
      await this.peersRepository.remove(wireguardPeer);
      throw error;
    }

    wireguardPeer.pairedPeerId = amneziawgPeer.id;
    amneziawgPeer.pairedPeerId = wireguardPeer.id;
    await this.peersRepository.save([wireguardPeer, amneziawgPeer]);

    return wireguardPeer;
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

    // Организация/имя/срок действия — с точки зрения администратора атрибуты ОДНОГО
    // логического peer'а мультиконфига, а не двух независимых записей (см.
    // createMultiProtocol) — рассинхронизация была бы более запутанной, чем лишний write.
    if (peer.pairedPeerId) {
      await this.applyToPairedPeer(peer.pairedPeerId, dto);
    }

    const withRelations = await this.peersRepository.findOneOrFail({
      where: { id: saved.id },
      relations: ['serverProtocol', 'serverProtocol.server'],
    });
    return this.toListItem(withRelations);
  }

  // Роли уже проверены на первичном peer'е в update() — тот же requester и та же операция,
  // повторная проверка прав здесь не нужна. Ошибка синхронизации истечения срока на парном
  // протоколе не должна проваливать весь update (основной peer уже сохранён) — только
  // откатывает expiresAt самого парного peer'а и логируется.
  private async applyToPairedPeer(pairedId: string, dto: UpdatePeerDto): Promise<void> {
    const paired = await this.peersRepository.findOne({ where: { id: pairedId } });
    if (!paired) {
      return;
    }
    if (dto.organizationId !== undefined) {
      paired.organizationId = dto.organizationId;
    }
    if (dto.name !== undefined) {
      paired.name = dto.name;
    }
    let previousExpiresAt: Date | null | undefined;
    if (dto.expiresAt !== undefined) {
      previousExpiresAt = paired.expiresAt;
      paired.expiresAt = dto.expiresAt === null ? null : new Date(dto.expiresAt);
    }
    await this.peersRepository.save(paired);
    if (dto.expiresAt !== undefined) {
      try {
        await this.syncServerPeers(paired.serverProtocolId);
      } catch (error) {
        paired.expiresAt = previousExpiresAt ?? null;
        await this.peersRepository.save(paired);
        this.logger.warn(`Не удалось синхронизировать срок действия парного peer'а мультиконфига (${paired.id}): ${(error as Error).message}`);
      }
    }
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

  // Отзыв каскадом применяется и к парному peer'у мультиконфига (см. createMultiProtocol) —
  // с точки зрения администратора это один логический peer, отзыв должен убрать доступ на
  // ОБОИХ протоколах, а не только на том, что попался в списке первым.
  async revoke(requester: AuthenticatedUser, id: string): Promise<void> {
    const peer = await this.findOneScoped(requester, id);
    await this.revokeInternal(peer);
    if (peer.pairedPeerId) {
      const paired = await this.peersRepository.findOne({ where: { id: peer.pairedPeerId } });
      if (paired && paired.status !== PeerStatus.REVOKED) {
        await this.revokeInternal(paired);
      }
    }
  }

  // Безвозвратное удаление записи — разрешено только для уже отозванных peers (сначала
  // отзыв, потом удаление; это гарантирует, что peer уже убран с сервера через
  // syncServerPeers перед тем, как мы потеряем о нём всякую память). Каскадом удаляет и
  // парный peer мультиконфига, если он тоже уже отозван — иначе оставляет его как есть
  // (не блокирует purge половины пары ошибкой про вторую половину: paired мог быть отозван
  // отдельно позже своим чередом).
  async purge(requester: AuthenticatedUser, id: string): Promise<void> {
    const peer = await this.findOneScoped(requester, id);
    if (peer.status !== PeerStatus.REVOKED) {
      throw new BadRequestException('Можно удалить только уже отозванный peer — сначала отзовите его');
    }
    await this.peersRepository.remove(peer);
    if (peer.pairedPeerId) {
      const paired = await this.peersRepository.findOne({ where: { id: peer.pairedPeerId } });
      if (paired && paired.status === PeerStatus.REVOKED) {
        await this.peersRepository.remove(paired);
      }
    }
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
    return this.buildDownloadableConfig(peer);
  }

  // Вынесено из getDownloadableConfig, чтобы этим же путём (расшифровка + подмена
  // Endpoint на Bridge.domainName при наличии) мог пользоваться и Telegram-бот
  // (telegram-bot/telegram-bot.service.ts) — там peer уже известен напрямую, без HTTP-
  // контекста и без AuthenticatedUser, которого требует findOneScoped.
  private async buildDownloadableConfig(peer: Peer): Promise<{ filename: string; content: string }> {
    if (!peer.privateKeyEnc) {
      throw new BadRequestException(
        'Для этого peer приватный ключ недоступен (импортирован из уже существующей настройки VPN). Отзовите его и создайте новый через сервис.',
      );
    }
    const serverProtocol = await this.serverProtocolsRepository.findOneOrFail({ where: { id: peer.serverProtocolId } });
    const server = await this.serversRepository.findOneOrFail({ where: { id: serverProtocol.serverId } });
    const privateKey = decryptSecret(peer.privateKeyEnc);
    const presharedKey = peer.presharedKeyEnc ? decryptSecret(peer.presharedKeyEnc) : null;
    const endpointServer = await this.resolveEndpointServer(serverProtocol, server);
    const content = buildClientConfig(peer, privateKey, endpointServer, serverProtocol, presharedKey);
    // \p{L}/\p{N} — буква/цифра ЛЮБОГО алфавита, не только латиница — иначе кириллическое
    // имя (например, ФИО из Telegram-бота) целиком превращалось бы в подчёркивания и файл
    // приходил бы клиенту фактически без видимого названия. Соседние небезопасные символы
    // схлопываются в одно "_", чтобы не плодить "Иванов___Иван".
    const safeName = peer.name.replace(/[^\p{L}\p{N}_-]+/gu, '_');
    return { filename: `${safeName}.conf`, content };
  }

  // Если serverProtocol — клиентский интерфейс моста с заданным domainName, Endpoint в
  // конфиге должен указывать на домен, а не на IP self-сервера (см. Bridge.domainName) —
  // так peer переживёт переезд self-сервера на новый хост/IP после смены DNS-записи.
  // Общий для обычного .conf (buildDownloadableConfig) и .vpn мультиконфига
  // (getAmneziaAppConfig) — оба должны одинаково резолвить Endpoint.
  private async resolveEndpointServer(serverProtocol: ServerProtocol, server: Server): Promise<Server> {
    const bridge = await this.bridgesRepository.findOne({
      where: [{ wireguardClientProtocolId: serverProtocol.id }, { amneziawgClientProtocolId: serverProtocol.id }],
    });
    return bridge?.domainName ? { ...server, host: bridge.domainName } : server;
  }

  // Дополнительный способ скачать peer — файл .vpn для официального приложения AmneziaVPN
  // (формат "vpn://...", см. amnezia-config.util.ts), НЕ заменяет обычный .conf/QR-код —
  // тот остаётся как есть для wg-quick/awg-quick и любых других клиентов. Если у peer'а есть
  // пара (мультиконфиг, см. createMultiProtocol), в файл попадают ОБА протокола — внутри
  // приложения AmneziaVPN пользователь переключается между ними без повторного импорта;
  // для обычного одно-протокольного peer'а получится файл с одним протоколом внутри —
  // тоже валиден, просто без возможности переключения.
  async getAmneziaAppConfig(requester: AuthenticatedUser, id: string): Promise<{ filename: string; content: string }> {
    const peer = await this.findOneScoped(requester, id);
    const peersInGroup = [peer];
    if (peer.pairedPeerId) {
      const paired = await this.peersRepository.findOne({ where: { id: peer.pairedPeerId } });
      if (paired) {
        peersInGroup.push(paired);
      }
    }
    return this.buildAmneziaAppConfigFor(peersInGroup);
  }

  // Общий сборщик .vpn для панели (getAmneziaAppConfig) и Telegram-бота/портала (см. ниже
  // createMultiProtocolForTelegramRegistration/getAmneziaAppConfigForTelegramRegistration) —
  // на вход 1 peer (одно-протокольный) либо 2 (пара мультиконфига).
  private async buildAmneziaAppConfigFor(peersInGroup: Peer[]): Promise<{ filename: string; content: string }> {
    const containers: AmneziaContainerInput[] = [];
    for (const groupPeer of peersInGroup) {
      if (!groupPeer.privateKeyEnc) {
        throw new BadRequestException(
          `Для peer "${groupPeer.name}" приватный ключ недоступен (импортирован из уже существующей настройки VPN) — отзовите его и создайте новый через сервис.`,
        );
      }
      const serverProtocol = await this.serverProtocolsRepository.findOneOrFail({ where: { id: groupPeer.serverProtocolId } });
      const server = await this.serversRepository.findOneOrFail({ where: { id: serverProtocol.serverId } });
      const endpointServer = await this.resolveEndpointServer(serverProtocol, server);
      containers.push({
        protocol: serverProtocol.protocol,
        peer: groupPeer,
        privateKey: decryptSecret(groupPeer.privateKeyEnc),
        presharedKey: groupPeer.presharedKeyEnc ? decryptSecret(groupPeer.presharedKeyEnc) : null,
        server: endpointServer,
        serverProtocol,
      });
    }

    // Имя ПРОФИЛЯ, которое видит клиент в приложении AmneziaVPN, — НЕ имя peer'а (у peers,
    // выданных через Telegram-бота/портал, это ФИО клиента — не то, что должно всплывать
    // в приложении как "название сервера", см. Server.amneziaAppName). Имя файла при этом
    // остаётся по peer'у — практичнее для администратора, различающего файлы на диске.
    const description = containers[0].server.amneziaAppName?.trim() || containers[0].server.name;
    const content = buildAmneziaAppConfig(containers, description);
    const safeName = peersInGroup[0].name.replace(/[^\p{L}\p{N}_-]+/gu, '_');
    return { filename: `${safeName}.vpn`, content };
  }

  // --- Telegram-бот (telegram-bot/) — создание/перевыпуск peer без AuthenticatedUser ---

  // Список вариантов "куда подключиться" для организации: мосты (общие+свои, минус
  // blockedBridgeIds) и, если разрешено явно, прямые серверы (allowedServerIds) — тот же
  // набор источников, что доступен org_user/org_admin в обычной форме создания peer'а
  // (см. create()), только собранный целиком, а не выбранный за пользователя. key —
  // непрозрачный идентификатор ("bridge:<id>"/"server:<id>"), передаётся обратно в
  // resolveUpstreamOption при фактическом создании peer'а.
  async listUpstreamOptions(
    organization: Organization,
    protocol: CreatePeerDto['protocol'],
  ): Promise<Array<{ key: string; label: string; isDefault?: boolean }>> {
    const options: Array<{ key: string; label: string; isDefault?: boolean }> = [];
    const bridges = await this.bridgesRepository.find({
      where: [{ organizationId: IsNull() }, { organizationId: organization.id }],
    });
    for (const bridge of bridges) {
      if (organization.blockedBridgeIds.includes(bridge.id)) {
        continue;
      }
      const serverProtocolId = protocol === 'wireguard' ? bridge.wireguardClientProtocolId : bridge.amneziawgClientProtocolId;
      if (!serverProtocolId) {
        continue;
      }
      const active = await this.serverProtocolsRepository.exists({ where: { id: serverProtocolId, status: ServerProtocolStatus.ACTIVE } });
      if (active) {
        options.push({ key: `bridge:${bridge.id}`, label: `Мост «${bridge.name}»`, isDefault: bridge.isDefault });
      }
    }
    if (organization.allowedServerIds.length > 0) {
      const directProtocols = await this.serverProtocolsRepository.find({
        where: { protocol, status: ServerProtocolStatus.ACTIVE, serverId: In(organization.allowedServerIds) },
        relations: ['server'],
      });
      for (const sp of directProtocols) {
        options.push({ key: `server:${sp.serverId}`, label: `Напрямую: ${sp.server.name}` });
      }
    }
    return options;
  }

  private async resolveUpstreamOption(organization: Organization, protocol: CreatePeerDto['protocol'], key: string): Promise<ServerProtocol> {
    const [kind, id] = key.split(':');
    if (kind === 'bridge') {
      const bridge = await this.bridgesRepository.findOneOrFail({ where: { id } });
      return this.findBridgeClientProtocolByBridge(bridge, protocol);
    }
    if (kind === 'server') {
      return this.findActiveServerProtocolByServer(id, protocol);
    }
    throw new BadRequestException('Некорректный выбор сервера');
  }

  private async findBridgeClientProtocolByBridge(bridge: Bridge, protocol: CreatePeerDto['protocol']): Promise<ServerProtocol> {
    const serverProtocolId = protocol === 'wireguard' ? bridge.wireguardClientProtocolId : bridge.amneziawgClientProtocolId;
    if (!serverProtocolId) {
      throw new BadRequestException(`На этом мосту не установлен протокол ${protocol}`);
    }
    const serverProtocol = await this.serverProtocolsRepository.findOne({
      where: { id: serverProtocolId, status: ServerProtocolStatus.ACTIVE },
    });
    if (!serverProtocol) {
      throw new BadRequestException('Клиентский интерфейс моста не установлен или неактивен');
    }
    await this.assertBridgeCapacity(bridge);
    return serverProtocol;
  }

  // Bridge.maxPeers — независимый от Server.maxPeers лимит (тот общий на ВСЕ мосты одного
  // self-сервера, см. комментарий у поля). Считает активные peers по ОБОИМ клиентским
  // протоколам моста сразу (мультиконфиг даёт по одному peer'у на каждый — оба считаются),
  // без системного upstream-peer (это не клиент, а сам мост). null — лимита нет.
  private async assertBridgeCapacity(bridge: Bridge): Promise<void> {
    if (bridge.maxPeers === null || bridge.maxPeers === undefined) {
      return;
    }
    const protocolIds = [bridge.wireguardClientProtocolId, bridge.amneziawgClientProtocolId].filter(
      (id): id is string => !!id,
    );
    if (protocolIds.length === 0) {
      return;
    }
    const count = await this.peersRepository.count({
      where: { serverProtocolId: In(protocolIds), status: PeerStatus.ACTIVE, source: Not(PeerSource.BRIDGE_UPSTREAM) },
    });
    if (count >= bridge.maxPeers) {
      throw new BadRequestException(`На мосту «${bridge.name}» достигнут лимит peers (${bridge.maxPeers})`);
    }
  }

  // upstreamKey — явный выбор пользователя (см. listUpstreamOptions), если бот уже спросил
  // (несколько доступных вариантов). Не задан — берём первый доступный мост, иначе
  // авто-баланс среди allowedServerIds (единственный вариант или бот решил не спрашивать).
  async createForTelegramRegistration(
    registration: TelegramRegistration,
    organization: Organization,
    protocol: CreatePeerDto['protocol'],
    deviceType: PeerDeviceType,
    upstreamKey?: string,
  ): Promise<{ filename: string; content: string }> {
    const serverProtocol = upstreamKey
      ? await this.resolveUpstreamOption(organization, protocol, upstreamKey)
      : await this.pickServerProtocolForOrganization(organization, protocol);
    const deviceLabel = deviceType === PeerDeviceType.PHONE ? 'телефон' : 'ПК';
    const peer = await this.createInternal(serverProtocol, {
      organizationId: organization.id,
      name: `${registration.fullName} — ${deviceLabel}`,
      source: PeerSource.CREATED,
      createdByUserId: null,
    });
    peer.telegramRegistrationId = registration.id;
    peer.deviceType = deviceType;
    await this.peersRepository.save(peer);
    return this.buildDownloadableConfig(peer);
  }

  // Фолбэк, когда upstreamKey не передан: мост "по умолчанию" (Bridge.isDefault), если он
  // среди доступных организации, иначе первый доступный мост, иначе авто-баланс среди
  // allowedServerIds — тот же дух, что у org_user без явного выбора моста/сервера в create().
  private async pickServerProtocolForOrganization(organization: Organization, protocol: CreatePeerDto['protocol']): Promise<ServerProtocol> {
    const bridges = await this.bridgesRepository.find({
      where: [{ organizationId: IsNull() }, { organizationId: organization.id }],
    });
    const candidates = bridges.filter((b) => !organization.blockedBridgeIds.includes(b.id));
    const bridge = candidates.find((b) => b.isDefault) ?? candidates[0];
    if (bridge) {
      return this.findBridgeClientProtocolByBridge(bridge, protocol);
    }
    if (organization.allowedServerIds.length === 0) {
      throw new BadRequestException('Для вашей организации ещё не настроен доступ ни к одному серверу или мосту');
    }
    return this.loadBalancerService.pickServerProtocol(protocol, organization.allowedServerIds);
  }

  async reissueForTelegramRegistration(
    registration: TelegramRegistration,
    organization: Organization,
    protocol: CreatePeerDto['protocol'],
    deviceType: PeerDeviceType,
    upstreamKey?: string,
  ): Promise<{ filename: string; content: string }> {
    const existing = await this.peersRepository.findOne({
      where: { telegramRegistrationId: registration.id, deviceType, status: PeerStatus.ACTIVE },
    });
    if (existing) {
      await this.revokeInternal(existing);
      await this.peersRepository.remove(existing);
    }
    return this.createForTelegramRegistration(registration, organization, protocol, deviceType, upstreamKey);
  }

  // --- Мультиконфиг (WireGuard + AmneziaWG одним .vpn-файлом, см. amnezia-config.util.ts)
  // через Telegram-бота/веб-портал — тот же принцип, что и createMultiProtocol() панели
  // (см. выше), только без AuthenticatedUser/org-скоупинга (как и остальные методы этого
  // блока), плюс сразу проставляет telegramRegistrationId/deviceType на ОБА peer'а пары.

  // Аналог listUpstreamOptions, но оставляет только те мосты/серверы, где активны СРАЗУ
  // ОБА протокола — мультиконфиг должен указывать на один и тот же endpoint для обоих
  // протоколов, а не на два разных сервера с независимой балансировкой.
  async listMultiProtocolUpstreamOptions(organization: Organization): Promise<Array<{ key: string; label: string; isDefault?: boolean }>> {
    const options: Array<{ key: string; label: string; isDefault?: boolean }> = [];
    const bridges = await this.bridgesRepository.find({
      where: [{ organizationId: IsNull() }, { organizationId: organization.id }],
    });
    for (const bridge of bridges) {
      if (organization.blockedBridgeIds.includes(bridge.id) || !bridge.wireguardClientProtocolId || !bridge.amneziawgClientProtocolId) {
        continue;
      }
      const [wgActive, awgActive] = await Promise.all([
        this.serverProtocolsRepository.exists({ where: { id: bridge.wireguardClientProtocolId, status: ServerProtocolStatus.ACTIVE } }),
        this.serverProtocolsRepository.exists({ where: { id: bridge.amneziawgClientProtocolId, status: ServerProtocolStatus.ACTIVE } }),
      ]);
      if (wgActive && awgActive) {
        options.push({ key: `bridge:${bridge.id}`, label: `Мост «${bridge.name}»`, isDefault: bridge.isDefault });
      }
    }
    if (organization.allowedServerIds.length > 0) {
      const activeProtocols = await this.serverProtocolsRepository.find({
        where: { status: ServerProtocolStatus.ACTIVE, serverId: In(organization.allowedServerIds) },
        relations: ['server'],
      });
      const byServer = new Map<string, { name: string; protocols: Set<VpnProtocol> }>();
      for (const sp of activeProtocols) {
        const entry = byServer.get(sp.serverId) ?? { name: sp.server.name, protocols: new Set<VpnProtocol>() };
        entry.protocols.add(sp.protocol);
        byServer.set(sp.serverId, entry);
      }
      for (const [serverId, entry] of byServer) {
        if (entry.protocols.has(VpnProtocol.WIREGUARD) && entry.protocols.has(VpnProtocol.AMNEZIAWG)) {
          options.push({ key: `server:${serverId}`, label: `Напрямую: ${entry.name}` });
        }
      }
    }
    return options;
  }

  private async resolveMultiProtocolUpstreamOption(
    organization: Organization,
    key: string,
  ): Promise<{ wireguard: ServerProtocol; amneziawg: ServerProtocol }> {
    const [kind, id] = key.split(':');
    if (kind === 'bridge') {
      const bridge = await this.bridgesRepository.findOneOrFail({ where: { id } });
      const [wireguard, amneziawg] = await Promise.all([
        this.findBridgeClientProtocolByBridge(bridge, VpnProtocol.WIREGUARD),
        this.findBridgeClientProtocolByBridge(bridge, VpnProtocol.AMNEZIAWG),
      ]);
      return { wireguard, amneziawg };
    }
    if (kind === 'server') {
      const [wireguard, amneziawg] = await Promise.all([
        this.findActiveServerProtocolByServer(id, VpnProtocol.WIREGUARD),
        this.findActiveServerProtocolByServer(id, VpnProtocol.AMNEZIAWG),
      ]);
      return { wireguard, amneziawg };
    }
    throw new BadRequestException('Некорректный выбор сервера');
  }

  private async pickMultiProtocolServerProtocolForOrganization(
    organization: Organization,
  ): Promise<{ wireguard: ServerProtocol; amneziawg: ServerProtocol }> {
    const bridges = await this.bridgesRepository.find({
      where: [{ organizationId: IsNull() }, { organizationId: organization.id }],
    });
    const candidates = bridges.filter(
      (b) => !organization.blockedBridgeIds.includes(b.id) && b.wireguardClientProtocolId && b.amneziawgClientProtocolId,
    );
    const bridge = candidates.find((b) => b.isDefault) ?? candidates[0];
    if (bridge) {
      const [wireguard, amneziawg] = await Promise.all([
        this.findBridgeClientProtocolByBridge(bridge, VpnProtocol.WIREGUARD),
        this.findBridgeClientProtocolByBridge(bridge, VpnProtocol.AMNEZIAWG),
      ]);
      return { wireguard, amneziawg };
    }
    if (organization.allowedServerIds.length === 0) {
      throw new BadRequestException('Для вашей организации ещё не настроен доступ ни к одному серверу или мосту с обоими протоколами');
    }
    const activeProtocols = await this.serverProtocolsRepository.find({
      where: { status: ServerProtocolStatus.ACTIVE, serverId: In(organization.allowedServerIds) },
    });
    const byServer = new Map<string, Set<VpnProtocol>>();
    for (const sp of activeProtocols) {
      const protocols = byServer.get(sp.serverId) ?? new Set<VpnProtocol>();
      protocols.add(sp.protocol);
      byServer.set(sp.serverId, protocols);
    }
    const matchingServerId = [...byServer.entries()].find(
      ([, protocols]) => protocols.has(VpnProtocol.WIREGUARD) && protocols.has(VpnProtocol.AMNEZIAWG),
    )?.[0];
    if (!matchingServerId) {
      throw new BadRequestException('Ни один доступный сервер или мост не имеет активными сразу оба протокола (WireGuard и AmneziaWG)');
    }
    const [wireguard, amneziawg] = await Promise.all([
      this.findActiveServerProtocolByServer(matchingServerId, VpnProtocol.WIREGUARD),
      this.findActiveServerProtocolByServer(matchingServerId, VpnProtocol.AMNEZIAWG),
    ]);
    return { wireguard, amneziawg };
  }

  async createMultiProtocolForTelegramRegistration(
    registration: TelegramRegistration,
    organization: Organization,
    deviceType: PeerDeviceType,
    upstreamKey?: string,
  ): Promise<{ filename: string; content: string }> {
    const { wireguard, amneziawg } = upstreamKey
      ? await this.resolveMultiProtocolUpstreamOption(organization, upstreamKey)
      : await this.pickMultiProtocolServerProtocolForOrganization(organization);
    const deviceLabel = deviceType === PeerDeviceType.PHONE ? 'телефон' : 'ПК';
    const name = `${registration.fullName} — ${deviceLabel}`;

    const wireguardPeer = await this.createInternal(wireguard, {
      organizationId: organization.id,
      name,
      source: PeerSource.CREATED,
      createdByUserId: null,
    });
    let amneziawgPeer: Peer;
    try {
      amneziawgPeer = await this.createInternal(amneziawg, {
        organizationId: organization.id,
        name,
        source: PeerSource.CREATED,
        createdByUserId: null,
      });
    } catch (error) {
      await this.revokeInternal(wireguardPeer);
      await this.peersRepository.remove(wireguardPeer);
      throw error;
    }

    wireguardPeer.pairedPeerId = amneziawgPeer.id;
    wireguardPeer.telegramRegistrationId = registration.id;
    wireguardPeer.deviceType = deviceType;
    amneziawgPeer.pairedPeerId = wireguardPeer.id;
    amneziawgPeer.telegramRegistrationId = registration.id;
    amneziawgPeer.deviceType = deviceType;
    await this.peersRepository.save([wireguardPeer, amneziawgPeer]);

    return this.buildAmneziaAppConfigFor([wireguardPeer, amneziawgPeer]);
  }

  // В отличие от reissueForTelegramRegistration (findOne — рассчитан на ровно один peer на
  // устройство) снимает ВСЕ активные peers этого устройства сразу — их может быть два
  // (пара мультиконфига), либо один (если раньше был выдан обычный одно-протокольный конфиг,
  // а теперь пользователь переключается на мультиконфиг тем же устройством).
  async reissueMultiProtocolForTelegramRegistration(
    registration: TelegramRegistration,
    organization: Organization,
    deviceType: PeerDeviceType,
    upstreamKey?: string,
  ): Promise<{ filename: string; content: string }> {
    const existing = await this.peersRepository.find({
      where: { telegramRegistrationId: registration.id, deviceType, status: PeerStatus.ACTIVE },
    });
    for (const peer of existing) {
      await this.revokeInternal(peer);
      await this.peersRepository.remove(peer);
    }
    return this.createMultiProtocolForTelegramRegistration(registration, organization, deviceType, upstreamKey);
  }

  // Повторное скачивание уже выданного мультиконфига — аналог
  // getDownloadableConfigForTelegramRegistration, но по .vpn/buildAmneziaAppConfigFor;
  // peers может быть 1 (одно-протокольный, тоже валиден для этого формата) или 2 (пара).
  async getAmneziaAppConfigForTelegramRegistration(
    registrationId: string,
    deviceType: PeerDeviceType,
  ): Promise<{ filename: string; content: string }> {
    const peers = await this.peersRepository.find({
      where: { telegramRegistrationId: registrationId, deviceType, status: PeerStatus.ACTIVE },
    });
    if (peers.length === 0) {
      throw new NotFoundException('Конфиг для этого устройства ещё не выдан');
    }
    return this.buildAmneziaAppConfigFor(peers);
  }

  // Для отображения "уже есть peer для этого устройства?" в диалоге бота и для отзыва всех
  // peers организации при удалении её регистрации суперадмином.
  async findActivePeersForTelegramRegistration(registrationId: string): Promise<Peer[]> {
    return this.peersRepository.find({ where: { telegramRegistrationId: registrationId, status: PeerStatus.ACTIVE } });
  }

  // Повторное скачивание УЖЕ выданного конфига без перевыпуска (см. кнопку «Скачать» в
  // PortalPage.tsx) — в отличие от createForTelegramRegistration/reissueForTelegramRegistration
  // не трогает ключи и сервер, просто ещё раз строит .conf+имя из уже сохранённого peer'а тем
  // же buildDownloadableConfig, что и обычное скачивание в панели.
  async getDownloadableConfigForTelegramRegistration(
    registrationId: string,
    deviceType: PeerDeviceType,
  ): Promise<{ filename: string; content: string }> {
    const peer = await this.peersRepository.findOne({
      where: { telegramRegistrationId: registrationId, deviceType, status: PeerStatus.ACTIVE },
    });
    if (!peer) {
      throw new NotFoundException('Конфиг для этого устройства ещё не выдан');
    }
    return this.buildDownloadableConfig(peer);
  }

  // Вызывается при удалении заявки суперадмином (TelegramRegistrationsController) — снимает
  // с сервера все peers этой регистрации перед удалением самой записи, а не полагается
  // только на ON DELETE SET NULL (иначе peer остался бы активным на сервере осиротевшим).
  async revokeAllPeersForTelegramRegistration(registrationId: string): Promise<void> {
    const peers = await this.findActivePeersForTelegramRegistration(registrationId);
    for (const peer of peers) {
      try {
        await this.revokeInternal(peer);
        await this.peersRepository.remove(peer);
      } catch (error) {
        this.logger.warn(`Не удалось отозвать peer "${peer.name}" при удалении Telegram-регистрации: ${(error as Error).message}`);
      }
    }
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

  // null — явный осознанный выбор «без клиента» (peer не привязан ни к одной организации);
  // undefined — поле не передали вовсе, это ошибка, суперадмин/ENGINEER должны выбрать
  // явно (см. CreatePeerDto.organizationId) — ни один из них не привязан к своей
  // организации, поэтому в отличие от org_admin/org_user взять её неоткуда неявно.
  private resolveOrganizationId(requester: AuthenticatedUser, requestedOrgId?: string | null): string | null {
    if (requester.role === Role.SUPER_ADMIN || requester.role === Role.ENGINEER) {
      if (requestedOrgId === undefined) {
        throw new BadRequestException('Обязателен organizationId (или явно null — «без клиента»)');
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
    // ENGINEER может создавать peers для ЛЮБОГО моста, не только своей организации (у него
    // и нет своей — см. resolveOrganizationId), поэтому пропускает эту проверку так же, как
    // суперадмин.
    if (
      requester.role !== Role.SUPER_ADMIN &&
      requester.role !== Role.ENGINEER &&
      bridge.organizationId !== null &&
      bridge.organizationId !== requester.organizationId
    ) {
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
    await this.assertBridgeCapacity(bridge);
    return serverProtocol;
  }

  private async findOneScoped(requester: AuthenticatedUser, id: string): Promise<Peer> {
    const peer = await this.peersRepository.findOne({ where: { id } });
    if (!peer) {
      throw new NotFoundException('Peer не найден');
    }
    // ENGINEER не привязан к организации — видит и управляет только ТЕМИ peers, что создал
    // сам (в т.ч. в чужих организациях), а не всеми peers какой-либо организации.
    if (requester.role === Role.ENGINEER) {
      if (peer.createdByUserId !== requester.userId) {
        throw new ForbiddenException('Недостаточно прав для доступа к этому peer');
      }
      return peer;
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
    const newlyExpiredPeers: Peer[] = [];
    for (const peer of expiredPeers) {
      currentIds.add(peer.id);
      const expiryTimestamp = peer.expiresAt!.getTime();
      if (this.appliedExpiry.get(peer.id) !== expiryTimestamp) {
        this.appliedExpiry.set(peer.id, expiryTimestamp);
        affectedProtocolIds.add(peer.serverProtocolId);
        newlyExpiredPeers.push(peer);
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

    for (const peer of newlyExpiredPeers) {
      void this.notificationsService.sendMessage(
        `⏳ Срок действия peer'а «${peer.name}» истёк — доступ отключён (запись не удалена, можно продлить в панели).`,
      );
    }
  }
}
