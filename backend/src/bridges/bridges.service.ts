import { randomBytes } from 'crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, Repository } from 'typeorm';
import { BridgeLogService } from '../bridge-log/bridge-log.service';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { decryptSecret, encryptSecret } from '../common/encryption.util';
import { BridgeStatus, BridgeUpstreamMode, LogLevel, PeerStatus, Role, ServerProtocolStatus, VpnProtocol } from '../common/enums';
import { Organization } from '../organizations/organization.entity';
import { Peer } from '../peers/peer.entity';
import { PeersService } from '../peers/peers.service';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { Server } from '../servers/server.entity';
import { classifyBypassEntry } from '../vpn/network.util';
import { UpstreamPeerConfig } from '../vpn/vpn-driver.interface';
import { VpnProvisioningService } from '../vpn/vpn-provisioning.service';
import { Bridge } from './bridge.entity';
import { BridgeUpstreamCandidate } from './bridge-upstream-candidate.entity';
import { BridgesGateway } from './bridges.gateway';
import { CreateBridgeDto } from './dto/create-bridge.dto';
import { UpdateBridgeDto } from './dto/update-bridge.dto';

// Порог для автобаланса: переключаем upstream только если кандидат загружен заметно
// меньше текущего — иначе мост будет дёргаться между двумя почти одинаково загруженными
// серверами при каждой проверке.
const REBALANCE_THRESHOLD = 0.2;

// MTU клиентского интерфейса моста — см. комментарий в create(). Занижен относительно
// обычного ~1420, чтобы оставить запас под вторую инкапсуляцию (self-сервер → upstream).
const BRIDGE_CLIENT_MTU = 1280;

// Стартовый номер для routeTable первого моста — дальше выделяется как MAX+1 (см.
// allocateRouteTable). Произвольное число, не пересекающееся с зарезервированными
// main(254)/default(253)/local(255).
const FIRST_ROUTE_TABLE = 52000;

const BRIDGE_RELATIONS = [
  'wireguardClientProtocol',
  'wireguardClientProtocol.server',
  'amneziawgClientProtocol',
  'amneziawgClientProtocol.server',
  'upstreamServerProtocol',
  'upstreamServerProtocol.server',
  'upstreamCandidates',
  'upstreamCandidates.serverProtocol',
  'upstreamCandidates.serverProtocol.server',
];

type SafeClientProtocol = (Omit<ServerProtocol, 'server' | 'peers'> & { server: Omit<Server, 'sshSecretEnc'> }) | null;
export type BridgeListItem = Omit<
  Bridge,
  'wireguardClientProtocol' | 'amneziawgClientProtocol' | 'upstreamServerProtocol' | 'upstreamCandidates'
> & {
  wireguardClientProtocol: SafeClientProtocol;
  amneziawgClientProtocol: SafeClientProtocol;
  upstreamServerProtocol: SafeClientProtocol;
  upstreamCandidates: Array<{ id: string; priority: number; serverProtocol: SafeClientProtocol }>;
};

@Injectable()
export class BridgesService {
  private readonly logger = new Logger(BridgesService.name);

  constructor(
    @InjectRepository(Bridge) private readonly bridgesRepository: Repository<Bridge>,
    @InjectRepository(BridgeUpstreamCandidate) private readonly upstreamCandidatesRepository: Repository<BridgeUpstreamCandidate>,
    @InjectRepository(ServerProtocol) private readonly serverProtocolsRepository: Repository<ServerProtocol>,
    @InjectRepository(Server) private readonly serversRepository: Repository<Server>,
    @InjectRepository(Peer) private readonly peersRepository: Repository<Peer>,
    @InjectRepository(Organization) private readonly organizationsRepository: Repository<Organization>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly peersService: PeersService,
    private readonly vpnProvisioningService: VpnProvisioningService,
    private readonly bridgesGateway: BridgesGateway,
    private readonly bridgeLogService: BridgeLogService,
  ) {}

  async findAll(requester: AuthenticatedUser): Promise<BridgeListItem[]> {
    const bridges = await this.bridgesRepository.find({
      relations: BRIDGE_RELATIONS,
      order: { createdAt: 'DESC' },
    });
    // ENGINEER видит ВСЕ мосты (не привязан к организации, может создавать peers для
    // любого) — та же граница видимости, что у суперадмина, здесь.
    let visible =
      requester.role === Role.SUPER_ADMIN || requester.role === Role.ENGINEER
        ? bridges
        : // org_admin/org_user видят только мосты своей организации плюс общие (organizationId
          // = null) — по тому же принципу, что видимость peers (см. findAllForRequester в
          // peers.service.ts).
          bridges.filter((bridge) => bridge.organizationId === null || bridge.organizationId === requester.organizationId);

    // Организация может явно забрать доступ к отдельным (в т.ч. общим) мостам — см.
    // Organization.blockedBridgeIds. Суперадмина это не касается — та же логика, что и у
    // allowedServerIds в PeersService.create.
    if (requester.role !== Role.SUPER_ADMIN && requester.organizationId) {
      const organization = await this.organizationsRepository.findOne({ where: { id: requester.organizationId } });
      if (organization && organization.blockedBridgeIds.length > 0) {
        const blocked = new Set(organization.blockedBridgeIds);
        visible = visible.filter((bridge) => !blocked.has(bridge.id));
      }
    }

    return visible.map((bridge) => this.toSafeBridge(bridge));
  }

  // Безопасный (без SSH-секретов и остальных полей Server) список серверов+протоколов для
  // настройки моста (детект "self-сервер уже есть" при создании, выбор upstream-
  // кандидатов/переключение) — используется ENGINEER, у которого НЕТ доступа к полному
  // GET /servers (там же зашифрованный Server.sshSecretEnc, см. ServersController —
  // единый @Roles(SUPER_ADMIN) на весь контроллер). SUPER_ADMIN тоже может использовать
  // этот эндпоинт вместо /servers для тех же целей — состав полей одинаков для обеих ролей.
  async getCandidateServers(): Promise<
    Array<{ id: string; name: string; host: string; isSelf: boolean; protocols: Array<Pick<ServerProtocol, 'id' | 'serverId' | 'protocol' | 'status' | 'listenPort' | 'networkCidr'>> }>
  > {
    const servers = await this.serversRepository.find({ relations: ['protocols'], order: { createdAt: 'DESC' } });
    return servers.map((server) => ({
      id: server.id,
      name: server.name,
      host: server.host,
      isSelf: server.isSelf,
      protocols: server.protocols.map((p) => ({
        id: p.id,
        serverId: p.serverId,
        protocol: p.protocol,
        status: p.status,
        listenPort: p.listenPort,
        networkCidr: p.networkCidr,
      })),
    }));
  }

  // Эндпоинт доступен всем ролям (см. BridgesController.findAll), включая org_admin/
  // org_user — им нельзя видеть сервера панели вообще (это отдельная от Peer/Bridge
  // граница мультитенантности, см. ServersController), поэтому перед отдачей клиенту
  // вырезаем зашифрованный SSH-секрет self- и upstream-сервера из вложенных
  // ServerProtocol.server. Используется только на выходе из сервиса — внутренняя логика
  // (getSelfServer/connectAsClient и т.п.) продолжает работать с полной Bridge-сущностью.
  private toSafeBridge(bridge: Bridge): BridgeListItem {
    const sanitize = (sp: ServerProtocol | null | undefined): SafeClientProtocol => {
      if (!sp) {
        return null;
      }
      const { server, peers, ...rest } = sp;
      const { sshSecretEnc, ...safeServer } = server;
      return { ...rest, server: safeServer };
    };
    const upstreamCandidates = (bridge.upstreamCandidates ?? [])
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map((candidate) => ({ id: candidate.id, priority: candidate.priority, serverProtocol: sanitize(candidate.serverProtocol) }));
    return {
      ...bridge,
      wireguardClientProtocol: sanitize(bridge.wireguardClientProtocol),
      amneziawgClientProtocol: sanitize(bridge.amneziawgClientProtocol),
      upstreamServerProtocol: sanitize(bridge.upstreamServerProtocol),
      upstreamCandidates,
    };
  }

  async create(dto: CreateBridgeDto): Promise<Bridge> {
    const protocols = new Set(dto.clientProtocols.map((p) => p.protocol));
    if (protocols.size !== dto.clientProtocols.length) {
      throw new BadRequestException('Протокол клиентского интерфейса моста нельзя указывать дважды');
    }

    // Self-сервер — один и тот же физический хост для ВСЕХ мостов (тот, на котором
    // развёрнута сама панель): переиспользуем уже существующий, если он есть (isSelf=true
    // означает "уже используется как клиентский интерфейс какого-то моста", см.
    // getSelfServerContext/ServersService.findAll), вместо того чтобы просить выбрать его
    // из списка при создании каждого нового моста — пользователю больше не нужно заранее
    // вручную добавлять свой же хост на вкладке «Серверы». SSH-доступ (selfServerCredentials)
    // нужен и используется только при создании самого первого моста в системе.
    let selfServer = await this.serversRepository.findOne({ where: { isSelf: true } });
    if (!selfServer) {
      if (!dto.selfServerCredentials) {
        throw new BadRequestException(
          'Сервер панели ещё не настроен — укажите SSH-доступ к серверу, на котором развёрнуто приложение (это нужно только для самого первого моста)',
        );
      }
      selfServer = await this.serversRepository.save(
        this.serversRepository.create({
          name: 'Этот сервер',
          host: dto.selfServerCredentials.host,
          sshPort: dto.selfServerCredentials.sshPort ?? 22,
          sshUsername: dto.selfServerCredentials.sshUsername ?? 'root',
          sshAuthType: dto.selfServerCredentials.sshAuthType,
          sshSecretEnc: encryptSecret(dto.selfServerCredentials.secret),
          isSelf: true,
        }),
      );
      // Best-effort, не блокирует создание моста — свой же IP в whitelist на всякий
      // случай (см. ServersService.ensureFail2banFor — там это актуальнее для ЧУЖИХ
      // серверов, но и себе не повредит).
      const bootstrappedSelfServer = selfServer;
      this.vpnProvisioningService.ensureFail2ban(bootstrappedSelfServer, [bootstrappedSelfServer.host]).catch((error) => {
        this.logger.warn(`Не удалось настроить fail2ban на self-сервере: ${(error as Error).message}`);
      });
    }

    // На одном self-сервере может быть несколько мостов — порт занят, если уже
    // используется ЛЮБЫМ протоколом на этом сервере (проверяем заранее, чтобы дать
    // понятную ошибку вместо сырого сбоя SSH при коллизии портов).
    for (const clientProtocol of dto.clientProtocols) {
      const portTaken = await this.serverProtocolsRepository.findOne({
        where: { serverId: selfServer.id, listenPort: clientProtocol.listenPort },
      });
      if (portTaken) {
        throw new BadRequestException(`Порт ${clientProtocol.listenPort} уже занят на этом сервере другим протоколом`);
      }
    }

    // Клиентские интерфейсы моста — переиспользуем обычную установку протокола, как для
    // любого другого сервера, по одному вызову на каждый выбранный протокол. Там, где
    // обычный WireGuard блокируется/детектится DPI, клиентский хоп тоже должен быть
    // AmneziaWG — не только upstream; а если у части клиентов WG работает нормально,
    // можно выдавать peers сразу по обоим протоколам с одного и того же моста.
    //
    // MTU занижен намеренно (BRIDGE_CLIENT_MTU): трафик клиентов моста проходит ещё через
    // ОДИН туннель (self-сервер → upstream), и обычный MTU ~1420 на обоих хопах даёт
    // фрагментацию/потери на крупных пакетах — мелкие (DNS) при этом проходят нормально,
    // что выглядит как "DNS работает через раз, а сайты — нет". Занижаем сразу при
    // создании моста, а не только когда назначен upstream, — потому что клиентские
    // конфиги peers уже будут скачаны с этим MTU и раздать новый после назначения upstream
    // не сможем.
    let wireguardClientProtocolId: string | null = null;
    let amneziawgClientProtocolId: string | null = null;
    for (const clientProtocol of dto.clientProtocols) {
      // Случайное имя интерфейса — не дефолтное wg0/awg0 драйвера: на одном self-сервере
      // может быть несколько мостов с одним и тем же протоколом (разные порты/сети), и им
      // нельзя делить один и тот же netdev/файл конфига/файл ключей.
      const interfaceNamePrefix = clientProtocol.protocol === VpnProtocol.WIREGUARD ? 'wg-br' : 'awg-br';
      const installed = await this.vpnProvisioningService.installProtocol(
        selfServer.id,
        clientProtocol.protocol,
        clientProtocol.listenPort,
        clientProtocol.networkCidr,
        BRIDGE_CLIENT_MTU,
        `${interfaceNamePrefix}-${randomBytes(3).toString('hex')}`,
      );
      if (installed.status === ServerProtocolStatus.ERROR) {
        throw new BadRequestException(`Не удалось поднять клиентский интерфейс (${clientProtocol.protocol}) для моста: ${installed.lastError}`);
      }
      if (clientProtocol.protocol === VpnProtocol.WIREGUARD) {
        wireguardClientProtocolId = installed.id;
      } else {
        amneziawgClientProtocolId = installed.id;
      }
    }

    const routeTable = await this.allocateRouteTable();
    const bridge = this.bridgesRepository.create({
      name: dto.name,
      organizationId: dto.organizationId ?? null,
      wireguardClientProtocolId,
      amneziawgClientProtocolId,
      // Случайный суффикс — не константа: на одном self-сервере может быть несколько
      // мостов, и у каждого должен быть свой upstream-интерфейс, иначе они начнут
      // управлять одним и тем же netdev друг у друга при подключении upstream.
      upstreamInterfaceName: `wg-up-${randomBytes(4).toString('hex')}`,
      routeTable,
      status: BridgeStatus.NOT_CONFIGURED,
    });
    return this.bridgesRepository.save(bridge);
  }

  async update(id: string, dto: UpdateBridgeDto): Promise<BridgeListItem> {
    const bridge = await this.findOneOrFail(id);
    if (dto.name !== undefined) {
      bridge.name = dto.name;
    }
    if (dto.organizationId !== undefined) {
      if (dto.organizationId !== null) {
        const organization = await this.organizationsRepository.findOne({ where: { id: dto.organizationId } });
        if (!organization) {
          throw new NotFoundException('Организация не найдена');
        }
      }
      bridge.organizationId = dto.organizationId;
    }
    if (dto.domainName !== undefined) {
      bridge.domainName = dto.domainName;
    }
    if (dto.bypassDestinations !== undefined) {
      const parsed: string[] = [];
      const seen = new Set<string>();
      for (const raw of dto.bypassDestinations) {
        const classified = classifyBypassEntry(raw);
        if (!classified) {
          throw new BadRequestException(`Некорректная строка в списке обхода upstream: "${raw}" — ожидается IP/CIDR или доменное имя`);
        }
        if (!seen.has(classified.value)) {
          seen.add(classified.value);
          parsed.push(classified.value);
        }
      }
      bridge.bypassDestinations = parsed;
    }
    if (dto.isDefault !== undefined) {
      bridge.isDefault = dto.isDefault;
    }
    const saved = await this.bridgesRepository.save(bridge);

    // Только ОДИН мост может быть "по умолчанию" одновременно — сбрасываем флаг у всех
    // остальных ПОСЛЕ сохранения этого (не в одной транзакции: невелика цена гонки для
    // чисто UX-настройки, зато код проще — ordinary update, без блокировок).
    if (dto.isDefault === true) {
      await this.bridgesRepository
        .createQueryBuilder()
        .update(Bridge)
        .set({ isDefault: false })
        .where('id != :id', { id: saved.id })
        .execute();
    }

    // В отличие от имени/организации (чистая косметика в БД), список обхода нужно сразу
    // применить на self-сервере — не дожидаясь ближайшего тика refreshBypassRules.
    // Best-effort: self-сервер может быть временно недоступен — не откатываем сохранённый
    // список, периодическая пересинхронизация всё равно догонит его позже.
    if (dto.bypassDestinations !== undefined) {
      try {
        await this.syncBypassRules(saved);
      } catch (error) {
        this.logger.warn(`Не удалось сразу применить список обхода upstream моста "${saved.name}": ${(error as Error).message}`);
        this.bridgeLogService.log(
          LogLevel.WARN,
          `Не удалось сразу применить список обхода upstream: ${(error as Error).message}`,
          saved.id,
          saved.name,
        );
      }
    }

    return this.toSafeBridge(saved);
  }

  // Общий шаг для update() (сразу после сохранения) и refreshBypassRules() (периодический
  // пере-резолв доменов) — резолвинг самих доменов делает VpnProvisioningService.
  private async syncBypassRules(bridge: Bridge): Promise<void> {
    const selfServer = this.getSelfServer(bridge);
    const clientInterfaces = [bridge.wireguardClientProtocol, bridge.amneziawgClientProtocol]
      .filter((sp): sp is ServerProtocol => Boolean(sp))
      .map((sp) => ({ networkCidr: sp.networkCidr, interfaceName: sp.interfaceName }));
    if (clientInterfaces.length === 0) {
      return;
    }
    await this.vpnProvisioningService.setupBridgeBypass(selfServer, bridge.id, clientInterfaces, bridge.bypassDestinations);
  }

  // Домены в списке обхода могут поменять IP (CDN и т.п.) без какого-либо действия
  // администратора — периодически пере-резолвим и обновляем ipset на self-сервере.
  // Пропускаем мосты без непустого списка — незачем открывать SSH ради него.
  @Interval(5 * 60 * 1000)
  private async refreshBypassRules(): Promise<void> {
    const bridges = await this.bridgesRepository.find({ relations: BRIDGE_RELATIONS });
    for (const bridge of bridges) {
      if (!bridge.bypassDestinations || bridge.bypassDestinations.length === 0) {
        continue;
      }
      try {
        await this.syncBypassRules(bridge);
      } catch (error) {
        this.logger.warn(`Не удалось обновить список обхода upstream моста "${bridge.name}": ${(error as Error).message}`);
        this.bridgeLogService.log(
          LogLevel.WARN,
          `Периодическое обновление списка обхода upstream не удалось: ${(error as Error).message}`,
          bridge.id,
          bridge.name,
        );
      }
    }
  }

  // MAX(routeTable) + 1 по всем мостам, под pessimistic-lock — тем же паттерном, что
  // allocateIp/nextHostOctet в peers.service.ts. Низкочастотная админская операция,
  // жёсткая транзакционность важнее производительности.
  private async allocateRouteTable(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const bridges = await manager.find(Bridge, { lock: { mode: 'pessimistic_write' } });
      const maxTable = bridges.reduce((max, b) => Math.max(max, b.routeTable || 0), FIRST_ROUTE_TABLE - 1);
      return maxTable + 1;
    });
  }

  // Удаление затрагивает только БД (тот же принцип, что и у ServersService.remove) — сам
  // wg-quick/awg-quick интерфейс на self-сервере, если был поднят, остаётся жить, пока его
  // не снимут вручную по SSH. Сначала отзываем системный upstream-peer (реально уберёт
  // peer с upstream-сервера через SSH), затем удаляем клиентские ServerProtocol — это
  // каскадом (ON DELETE CASCADE) удалит и сам мост, и все peers, созданные для него.
  async remove(id: string): Promise<void> {
    const bridge = await this.findOneOrFail(id);
    if (bridge.upstreamPeerId) {
      // revoke — снимает peer с upstream-сервера по SSH (пока запись ещё жива);
      // purge — убирает саму запись, чтобы она не висела в БД вечно как "отозванная,
      // но не удалённая".
      await this.peersService.revokeSystemPeer(bridge.upstreamPeerId);
      await this.peersService.purgeSystemPeer(bridge.upstreamPeerId);
    }
    const clientProtocolIds = this.clientProtocolIds(bridge);
    if (clientProtocolIds.length > 0) {
      await this.serverProtocolsRepository.delete(clientProtocolIds);
    } else {
      await this.bridgesRepository.remove(bridge);
    }
  }

  // Используется ServersService.findAll: какие сервера сейчас служат self-сервером хотя бы
  // одному мосту (по FK client-протоколов, а не по хранимому Server.isSelf) и какой мост
  // владеет каждым конкретным client-протоколом. Считаем от FK, а не только доверяем
  // Server.isSelf, — при synchronize:true (без миграций) это надёжный источник истины
  // независимо от того, когда и как флаг был проставлен; ServersService сверяет его с
  // этими данными и самостоятельно чинит несовпадение.
  async getSelfServerContext(): Promise<{ selfServerIds: Set<string>; protocolBridgeNames: Map<string, string> }> {
    const bridges = await this.bridgesRepository.find({
      relations: ['wireguardClientProtocol', 'amneziawgClientProtocol'],
    });
    const selfServerIds = new Set<string>();
    const protocolBridgeNames = new Map<string, string>();
    for (const bridge of bridges) {
      for (const clientProtocol of [bridge.wireguardClientProtocol, bridge.amneziawgClientProtocol]) {
        if (clientProtocol) {
          selfServerIds.add(clientProtocol.serverId);
          protocolBridgeNames.set(clientProtocol.id, bridge.name);
        }
      }
    }
    return { selfServerIds, protocolBridgeNames };
  }

  // Вызывается ServersService ПЕРЕД удалением сервера: если он сейчас служит upstream для
  // какого-то моста, переключает мост на другой доступный сервер того же протокола —
  // иначе после удаления (FK ON DELETE SET NULL) мост остался бы висеть без upstream и без
  // возможности исправить это иначе как вручную. Best-effort: ошибка по одному мосту не
  // должна блокировать удаление сервера и остальные мосты.
  async reassignUpstreamAwayFrom(deadServerProtocolIds: string[]): Promise<void> {
    if (deadServerProtocolIds.length === 0) {
      return;
    }
    const affected = await this.bridgesRepository.find({
      where: { upstreamServerProtocolId: In(deadServerProtocolIds) },
    });
    for (const bridge of affected) {
      try {
        const current = await this.serverProtocolsRepository.findOneOrFail({
          where: { id: bridge.upstreamServerProtocolId! },
        });
        const clientProtocolIds = this.clientProtocolIds(bridge);
        const candidates = await this.serverProtocolsRepository.find({
          where: { protocol: current.protocol, status: ServerProtocolStatus.ACTIVE },
        });
        const alternative = candidates.find(
          (sp) => !deadServerProtocolIds.includes(sp.id) && !clientProtocolIds.includes(sp.id),
        );
        if (alternative) {
          this.logger.log(`Сервер удаляется — мост "${bridge.name}" переключается на другой upstream`);
          this.bridgeLogService.log(LogLevel.INFO, 'Сервер-upstream удаляется — переключаю мост на другой', bridge.id, bridge.name);
          await this.setUpstream(bridge.id, alternative.id);
        } else {
          this.logger.warn(`Сервер удаляется — для моста "${bridge.name}" не нашлось альтернативного upstream`);
          this.bridgeLogService.log(
            LogLevel.WARN,
            'Сервер-upstream удаляется — альтернативы не нашлось, мост останется без upstream',
            bridge.id,
            bridge.name,
          );
        }
      } catch (error) {
        this.logger.error(`Не удалось переключить upstream моста "${bridge.name}" при удалении сервера: ${(error as Error).message}`);
        this.bridgeLogService.log(
          LogLevel.ERROR,
          `Переключение upstream при удалении сервера не удалось: ${(error as Error).message}`,
          bridge.id,
          bridge.name,
        );
      }
    }
  }

  async setMode(bridgeId: string, mode: BridgeUpstreamMode): Promise<BridgeListItem> {
    const bridge = await this.findOneOrFail(bridgeId);
    if (mode === BridgeUpstreamMode.AUTO && !bridge.upstreamServerProtocolId) {
      throw new BadRequestException('Сначала выберите upstream вручную — автобаланс переключает уже настроенный мост');
    }
    if (mode === BridgeUpstreamMode.FAILOVER) {
      const candidateCount = await this.upstreamCandidatesRepository.count({ where: { bridgeId } });
      if (candidateCount === 0) {
        throw new BadRequestException('Сначала настройте основной и резервные серверы в разделе "Приоритет upstream"');
      }
    }
    bridge.upstreamMode = mode;
    const saved = await this.bridgesRepository.save(bridge);
    this.bridgeLogService.log(LogLevel.INFO, `Режим upstream изменён на "${mode}"`, bridge.id, bridge.name);
    return this.toSafeBridge(saved);
  }

  // Полностью заменяет приоритетный список upstream-кандидатов моста (delete-all-then-
  // insert, тот же UX, что у clientProtocols при создании моста) — порядок serverProtocolIds
  // задаёт priority (индекс = приоритет, 0 = основной). Используется формой "Приоритет
  // upstream" на фронтенде и опрашивается BridgeFailoverService.
  async setUpstreamCandidates(bridgeId: string, serverProtocolIds: string[]): Promise<BridgeListItem> {
    const bridge = await this.findOneOrFail(bridgeId);
    if (new Set(serverProtocolIds).size !== serverProtocolIds.length) {
      throw new BadRequestException('Сервер нельзя указывать в списке кандидатов дважды');
    }
    const clientProtocolIds = this.clientProtocolIds(bridge);
    if (serverProtocolIds.some((id) => clientProtocolIds.includes(id))) {
      throw new BadRequestException('Нельзя маршрутизировать мост через его же собственный клиентский интерфейс');
    }
    const candidates = await this.serverProtocolsRepository.find({ where: { id: In(serverProtocolIds) } });
    if (candidates.length !== serverProtocolIds.length) {
      throw new BadRequestException('Один или несколько серверов-кандидатов не найдены');
    }
    if (candidates.some((c) => c.status !== ServerProtocolStatus.ACTIVE)) {
      throw new BadRequestException('Все кандидаты должны быть активными протоколами');
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(BridgeUpstreamCandidate, { bridgeId });
      const rows = serverProtocolIds.map((serverProtocolId, index) =>
        manager.create(BridgeUpstreamCandidate, { bridgeId, serverProtocolId, priority: index }),
      );
      await manager.save(rows);
    });

    return this.toSafeBridge(await this.findOneOrFail(bridgeId));
  }

  async setUpstream(bridgeId: string, targetServerProtocolId: string): Promise<BridgeListItem> {
    const bridge = await this.findOneOrFail(bridgeId);
    const target = await this.serverProtocolsRepository.findOne({
      where: { id: targetServerProtocolId },
      relations: ['server'],
    });
    if (!target || target.status !== ServerProtocolStatus.ACTIVE) {
      throw new BadRequestException('Целевой протокол не найден или неактивен');
    }
    const clientProtocolIds = this.clientProtocolIds(bridge);
    if (clientProtocolIds.includes(target.id)) {
      throw new BadRequestException('Нельзя маршрутизировать мост через его же собственный клиентский интерфейс');
    }

    const selfServer = this.getSelfServer(bridge);

    bridge.status = BridgeStatus.CONFIGURING;
    bridge.lastError = null;
    await this.bridgesRepository.save(bridge);
    this.bridgeLogService.log(
      LogLevel.INFO,
      `Переключение upstream на "${target.server.name}" (${target.protocol}) начато`,
      bridge.id,
      bridge.name,
    );

    const progress = (percent: number, step: string) =>
      this.bridgesGateway.broadcastProgress({ bridgeId: bridge.id, percent, step, done: false });

    try {
      progress(5, 'Проверка целевого сервера');

      // Заранее поднятый на этапе установки протокола (см. ServerProtocol.reservedUpstreamPeer
      // и ServersService.installProtocol) upstream-peer переиспользуем, если он свободен —
      // это экономит SSH на целевой сервер и полную перезапись/обрыв его интерфейса,
      // которые как раз и делают переключение долгим. Если резерва нет или он уже занят
      // ДРУГИМ мостом — откатываемся к старому поведению (создаём peer на лету).
      progress(15, 'Подготовка upstream-peer на целевом сервере');
      const reusedReserved = await this.tryReuseReservedPeer(bridge, target);
      const systemPeer = reusedReserved ?? (await this.peersService.createSystemPeer(target.id, `bridge:${bridge.name}`));

      const privateKey = decryptSecret(systemPeer.privateKeyEnc!);
      const presharedKey = systemPeer.presharedKeyEnc ? decryptSecret(systemPeer.presharedKeyEnc) : null;

      const config: UpstreamPeerConfig = {
        privateKey,
        address: `${systemPeer.allowedIp}/32`,
        presharedKey,
        serverPublicKey: target.serverPublicKey!,
        endpointHost: target.server.host,
        endpointPort: target.listenPort,
        obfuscationParams: target.obfuscationParams || undefined,
      };

      const wasConfiguredBefore = Boolean(bridge.upstreamServerProtocolId);
      const previousPeerId = bridge.upstreamPeerId;
      const previousProtocol = bridge.upstreamServerProtocol?.protocol;
      // Резерв НЕ отзываем при уходе с сервера (см. ниже) — он остаётся жить там для
      // следующего переключения, а не только для текущего моста.
      const previousReservedPeerId = bridge.upstreamServerProtocol?.reservedUpstreamPeerId;

      try {
        if (wasConfiguredBefore) {
          progress(35, 'Отключение предыдущего upstream-интерфейса');
          await this.vpnProvisioningService.disconnectBridgeUpstream(selfServer, previousProtocol!, bridge.upstreamInterfaceName);
        }
        // self-сервер мог ещё не иметь дела с протоколом upstream-сервера (например, поднят
        // под обычный WireGuard для клиентов моста, а upstream — AmneziaWG) — доустанавливаем
        // недостающие CLI-инструменты перед подключением.
        progress(55, 'Проверка CLI-инструментов на self-сервере');
        await this.vpnProvisioningService.ensureClientToolsInstalled(selfServer, target.protocol);
        progress(75, 'Подключение нового upstream-интерфейса');
        await this.vpnProvisioningService.connectBridgeUpstream(
          selfServer,
          target.protocol,
          bridge.upstreamInterfaceName,
          config,
          bridge.routeTable,
        );
      } catch (error) {
        // self-сервер не удалось подключить к новому upstream — системный peer уже создан
        // и применён НА ЦЕЛЕВОМ сервере (это отдельный шаг с собственным успехом), но раз
        // мост им не воспользуется, не оставляем его висеть там (кроме резерва — его
        // оставляем жить для следующей попытки).
        if (!reusedReserved) {
          await this.peersService.revokeSystemPeer(systemPeer.id);
        }
        throw error;
      }

      // Вызываем при КАЖДОМ переключении, не только при первом назначении upstream —
      // сама функция идемпотентна (проверяет перед добавлением, см.
      // VpnProvisioningService.setupBridgeNat). Раньше вызывалась только один раз в
      // расчёте на то, что правила не нужно пересоздавать — но ip rule/iptables не
      // переживают перезагрузку self-сервера и ничем не восстанавливались сами; поймано
      // вживую (трафик клиентов моста молча уходил через обычный интернет self-сервера
      // вместо upstream-туннеля). Теперь каждое переключение заодно чинит то, что могло
      // пропасть.
      progress(90, 'Настройка NAT');
      await this.configureNat(selfServer, bridge);

      bridge.upstreamServerProtocolId = target.id;
      bridge.upstreamPeerId = systemPeer.id;
      bridge.status = BridgeStatus.ACTIVE;
      const saved = await this.bridgesRepository.save(bridge);

      if (previousPeerId && previousPeerId !== previousReservedPeerId) {
        progress(95, 'Отзыв старого upstream-peer');
        await this.peersService.revokeSystemPeer(previousPeerId);
      }

      this.bridgesGateway.broadcastProgress({ bridgeId: bridge.id, percent: 100, step: 'Готово', done: true });
      this.bridgeLogService.log(LogLevel.INFO, `Upstream переключён на "${target.server.name}" (${target.protocol})`, bridge.id, bridge.name);
      return this.toSafeBridge(saved);
    } catch (error) {
      bridge.status = BridgeStatus.ERROR;
      bridge.lastError = (error as Error).message;
      await this.bridgesRepository.save(bridge);
      this.bridgesGateway.broadcastProgress({
        bridgeId: bridge.id,
        percent: 100,
        step: 'Ошибка',
        done: true,
        error: (error as Error).message,
      });
      this.bridgeLogService.log(
        LogLevel.ERROR,
        `Переключение upstream на "${target.server.name}" не удалось: ${(error as Error).message}`,
        bridge.id,
        bridge.name,
      );
      throw error;
    }
  }

  // Возвращает резерв, если он есть, активен и не занят другим мостом прямо сейчас; иначе
  // null (вызывающий код создаёт peer на лету, как до этой оптимизации).
  private async tryReuseReservedPeer(bridge: Bridge, target: ServerProtocol): Promise<Peer | null> {
    if (!target.reservedUpstreamPeerId) {
      return null;
    }
    const reserved = await this.peersRepository.findOne({
      where: { id: target.reservedUpstreamPeerId, status: PeerStatus.ACTIVE },
    });
    if (!reserved) {
      return null;
    }
    const claimedByOtherBridge = await this.bridgesRepository.findOne({
      where: { upstreamPeerId: reserved.id, id: Not(bridge.id) },
    });
    return claimedByOtherBridge ? null : reserved;
  }

  async rebalanceNow(bridgeId: string): Promise<BridgeListItem> {
    const bridge = await this.findOneOrFail(bridgeId);
    const best = await this.findBetterCandidate(bridge);
    if (!best) {
      return this.toSafeBridge(bridge);
    }
    return this.setUpstream(bridgeId, best.id);
  }

  // Раз в 5 минут пересчитывает upstream для мостов в режиме AUTO.
  @Interval(5 * 60 * 1000)
  private async handleAutoRebalance(): Promise<void> {
    const autoBridges = await this.bridgesRepository.find({
      where: { upstreamMode: BridgeUpstreamMode.AUTO },
      relations: ['upstreamServerProtocol'],
    });
    for (const bridge of autoBridges) {
      try {
        const best = await this.findBetterCandidate(bridge);
        if (best) {
          this.logger.log(`Автобаланс: мост "${bridge.name}" переключается на менее загруженный сервер`);
          this.bridgeLogService.log(LogLevel.INFO, 'Автобаланс: переключаюсь на менее загруженный сервер', bridge.id, bridge.name);
          await this.setUpstream(bridge.id, best.id);
        }
      } catch (error) {
        this.logger.error(`Автобаланс моста "${bridge.name}" не удался: ${(error as Error).message}`);
        this.bridgeLogService.log(LogLevel.ERROR, `Автобаланс не удался: ${(error as Error).message}`, bridge.id, bridge.name);
      }
    }
  }

  // Ищет среди ACTIVE ServerProtocol того же протокола, что текущий upstream, заметно
  // менее загруженный (по доле активных peers от maxPeers), чем текущий. null — если
  // текущий upstream уже лучший вариант (или ещё не настроен).
  private async findBetterCandidate(bridge: Bridge): Promise<ServerProtocol | null> {
    if (!bridge.upstreamServerProtocolId) {
      return null;
    }
    const current = await this.serverProtocolsRepository.findOneOrFail({
      where: { id: bridge.upstreamServerProtocolId },
      relations: ['server'],
    });
    const candidates = await this.serverProtocolsRepository.find({
      where: { protocol: current.protocol, status: ServerProtocolStatus.ACTIVE },
      relations: ['server'],
    });

    const clientProtocolIds = this.clientProtocolIds(bridge);
    const loads = await Promise.all(
      candidates
        .filter((serverProtocol) => !clientProtocolIds.includes(serverProtocol.id))
        .map(async (serverProtocol) => ({
          serverProtocol,
          load: await this.computeLoad(serverProtocol),
        })),
    );

    const currentLoad = loads.find((item) => item.serverProtocol.id === current.id)?.load ?? (await this.computeLoad(current));
    const better = loads
      .filter((item) => item.serverProtocol.id !== current.id)
      .sort((a, b) => a.load - b.load)[0];

    if (better && currentLoad - better.load >= REBALANCE_THRESHOLD) {
      return better.serverProtocol;
    }
    return null;
  }

  private async computeLoad(serverProtocol: ServerProtocol): Promise<number> {
    const activePeers = await this.peersRepository.count({
      where: { serverProtocolId: serverProtocol.id, status: PeerStatus.ACTIVE },
    });
    return serverProtocol.server.maxPeers > 0 ? activePeers / serverProtocol.server.maxPeers : 1;
  }

  private async configureNat(selfServer: Server, bridge: Bridge): Promise<void> {
    const clientInterfaces = [bridge.wireguardClientProtocol, bridge.amneziawgClientProtocol]
      .filter((sp): sp is ServerProtocol => Boolean(sp))
      .map((sp) => ({ networkCidr: sp.networkCidr, interfaceName: sp.interfaceName }));
    await this.vpnProvisioningService.setupBridgeNat(selfServer, clientInterfaces, bridge.upstreamInterfaceName, bridge.routeTable);
  }

  private clientProtocolIds(bridge: Bridge): string[] {
    return [bridge.wireguardClientProtocolId, bridge.amneziawgClientProtocolId].filter((id): id is string => Boolean(id));
  }

  private getSelfServer(bridge: Bridge): Server {
    // Оба клиентских интерфейса (если есть оба) всегда на одном и том же self-сервере —
    // достаточно взять сервер у любого из установленных.
    const server = bridge.wireguardClientProtocol?.server ?? bridge.amneziawgClientProtocol?.server;
    if (!server) {
      throw new NotFoundException('У моста нет ни одного установленного клиентского интерфейса');
    }
    return server;
  }

  private async findOneOrFail(id: string): Promise<Bridge> {
    const bridge = await this.bridgesRepository.findOne({
      where: { id },
      relations: BRIDGE_RELATIONS,
    });
    if (!bridge) {
      throw new NotFoundException('Мост не найден');
    }
    return bridge;
  }
}
