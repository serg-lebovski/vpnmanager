import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PeerSource, PeerStatus, ServerProtocolStatus, VpnProtocol } from '../common/enums';
import { Organization } from '../organizations/organization.entity';
import { Peer } from '../peers/peer.entity';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { Server } from '../servers/server.entity';
import { PeerTransferStats } from '../vpn/vpn-driver.interface';
import { VpnProvisioningService } from '../vpn/vpn-provisioning.service';
import { DashboardGateway } from './dashboard.gateway';
import { PeerTrafficSample } from './peer-traffic-sample.entity';

export interface DashboardServerStats {
  serverId: string;
  serverName: string;
  isSelf: boolean;
  online: boolean;
  loadAvg1: number | null;
  cpuCores: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
  diskUsedMb: number | null;
  diskTotalMb: number | null;
  // Суммарная текущая скорость (rx+tx) по всем активным peers сервера, байт/сек — сырое
  // число, а не готовый %: во сколько это % от "полосы" сервера решает фронтенд
  // (условный фиксированный лимит для наглядности, у SSH-сессии нет способа узнать
  // реальную пропускную способность канала VPS).
  networkBps: number;
  activePeers: number;
  maxPeers: number;
}

export interface DashboardPeerStats {
  peerId: string;
  name: string;
  serverId: string;
  serverName: string;
  organizationId: string | null;
  source: PeerSource;
  protocol: VpnProtocol;
  rxBytesTotal: number;
  txBytesTotal: number;
  rxBps: number;
  txBps: number;
  // Unix-время (секунды) последнего handshake, 0 — не было ни разу (см.
  // PeerTransferStats.latestHandshake). Вместе с createdAt используется для
  // предупреждения "peer создан, но ни разу не подключился" (см. PeerConnectivityAlertService).
  latestHandshake: number;
  createdAt: string;
}

export interface DashboardSnapshot {
  timestamp: string;
  servers: DashboardServerStats[];
  peers: DashboardPeerStats[];
}

export type TrafficRange = 'day' | 'week' | 'month';

export interface ServerTrafficRow {
  serverId: string;
  serverName: string;
  rxBytes: number;
  txBytes: number;
}

export interface PeerTrafficRow {
  peerId: string;
  peerName: string;
  serverName: string;
  organizationId: string | null;
  organizationName: string;
  rxBytes: number;
  txBytes: number;
}

export interface OrganizationTrafficRow {
  organizationId: string | null;
  organizationName: string;
  rxBytes: number;
  txBytes: number;
}

export interface MonthlyServerTrafficRow {
  month: string; // 'YYYY-MM'
  serverId: string;
  serverName: string;
  rxBytes: number;
  txBytes: number;
}

const NO_CLIENT_LABEL = 'Без клиента';

// Опрашивать каждую пару минут смысла нет (это "реальное время"), но и раз в секунду —
// перебор: на каждый сервер тратится отдельное SSH-подключение (см. SshService), и по
// нескольку команд на каждый активный протокол. 7 секунд — компромисс между
// отзывчивостью дашборда и нагрузкой на SSH/сеть при десятках серверов.
const POLL_INTERVAL_MS = 7000;

// Для истории трафика (день/неделя/месяц на дашборде) 7-секундная частота дала бы огромный
// объём строк почти без пользы (для отчёта не нужна секундная точность) — сохраняем в БД
// заметно реже, используя уже полученные (не новый SSH-запрос) данные того же опроса.
const PERSIST_INTERVAL_MS = 15 * 60 * 1000;

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);
  private lastSnapshot: DashboardSnapshot | null = null;
  // peerId -> последняя проба трафика, чтобы считать мгновенную скорость (байт/сек) как
  // дельту между двумя опросами, а не только кумулятивный счётчик. Чистится в buildSnapshot
  // от peers, пропавших из снапшота — иначе рос бы бесконечно на долгоживущем процессе.
  private readonly lastSample = new Map<string, { rxBytes: number; txBytes: number; at: number }>();
  private gateway: DashboardGateway | null = null;

  // peerId -> последняя кумулятивная проба, ИСПОЛЬЗОВАННАЯ для персиста дельты в историю
  // трафика — отдельно от lastSample (та — для мгновенного bps каждые 7с, эта — для
  // персиста раз в PERSIST_INTERVAL_MS, шаг другой).
  private readonly lastPersistedCumulative = new Map<string, { rxBytes: number; txBytes: number }>();
  private lastPersistedAt = 0;

  constructor(
    @InjectRepository(Server) private readonly serversRepository: Repository<Server>,
    @InjectRepository(Peer) private readonly peersRepository: Repository<Peer>,
    @InjectRepository(PeerTrafficSample) private readonly trafficSamplesRepository: Repository<PeerTrafficSample>,
    @InjectRepository(Organization) private readonly organizationsRepository: Repository<Organization>,
    private readonly vpnProvisioningService: VpnProvisioningService,
  ) {}

  // Общий резолвер имён клиентов для разрезов "по клиентам"/"по peers" — один запрос
  // по всем встреченным organizationId сразу, а не по одному на строку. null (peer без
  // организации) сознательно не попадает в IN(...) — это не ошибка резолва, а валидный
  // случай "Без клиента".
  private async resolveOrganizationNames(ids: Array<string | null>): Promise<Map<string, string>> {
    const uniqueIds = Array.from(new Set(ids.filter((id): id is string => id !== null)));
    if (uniqueIds.length === 0) {
      return new Map();
    }
    const orgs = await this.organizationsRepository.find({ where: { id: In(uniqueIds) }, select: ['id', 'name'] });
    return new Map(orgs.map((o) => [o.id, o.name]));
  }

  // Сеттер, а не конструктор, — иначе DashboardGateway <-> DashboardService оказались бы
  // взаимными конструкторными зависимостями. Вызывается из конструктора гейтвея.
  setGateway(gateway: DashboardGateway): void {
    this.gateway = gateway;
  }

  getLastSnapshot(): DashboardSnapshot | null {
    return this.lastSnapshot;
  }

  @Interval(POLL_INTERVAL_MS)
  private async poll(): Promise<void> {
    const snapshot = await this.buildSnapshot();
    this.lastSnapshot = snapshot;
    this.gateway?.broadcast(snapshot);

    const now = Date.now();
    if (now - this.lastPersistedAt >= PERSIST_INTERVAL_MS) {
      this.lastPersistedAt = now;
      try {
        await this.persistTrafficSamples(snapshot.peers);
      } catch (error) {
        this.logger.warn(`Не удалось сохранить историю трафика: ${(error as Error).message}`);
      }
    }
  }

  private async buildSnapshot(): Promise<DashboardSnapshot> {
    const servers = await this.serversRepository.find({ relations: ['protocols'] });
    const results = await Promise.allSettled(servers.map((server) => this.pollServer(server)));

    const serverStats: DashboardServerStats[] = [];
    const peerStats: DashboardPeerStats[] = [];
    results.forEach((result, index) => {
      const server = servers[index];
      if (result.status === 'fulfilled') {
        serverStats.push(result.value.server);
        peerStats.push(...result.value.peers);
      } else {
        this.logger.warn(`Опрос сервера "${server.name}" не удался: ${(result.reason as Error).message}`);
        serverStats.push({
          serverId: server.id,
          serverName: server.name,
          isSelf: server.isSelf,
          online: false,
          loadAvg1: null,
          cpuCores: null,
          memUsedMb: null,
          memTotalMb: null,
          diskUsedMb: null,
          diskTotalMb: null,
          networkBps: 0,
          activePeers: 0,
          maxPeers: server.maxPeers,
        });
      }
    });

    // Peers, отсутствующие в этом снапшоте (отозваны/удалены/сервер недоступен) — забываем
    // их последнюю пробу, иначе lastSample рос бы бесконечно на долгоживущем процессе (та
    // же чистка, что уже есть у lastPersistedCumulative в persistTrafficSamples).
    const seenPeerIds = new Set(peerStats.map((p) => p.peerId));
    for (const peerId of this.lastSample.keys()) {
      if (!seenPeerIds.has(peerId)) {
        this.lastSample.delete(peerId);
      }
    }

    return { timestamp: new Date().toISOString(), servers: serverStats, peers: peerStats };
  }

  private async pollServer(server: Server): Promise<{ server: DashboardServerStats; peers: DashboardPeerStats[] }> {
    const activeProtocols = server.protocols.filter((sp) => sp.status === ServerProtocolStatus.ACTIVE);

    // Один SSH-коннект на сервер (loadavg + трафик по всем активным протоколам разом) —
    // см. комментарий у getServerSnapshot в vpn-provisioning.service.ts. Список peers по
    // каждому протоколу — обычный запрос в БД, идёт параллельно, SSH тут ни при чём.
    const [{ load, transferStatsByProtocolId }, peersByProtocol] = await Promise.all([
      this.vpnProvisioningService.getServerSnapshot(server, activeProtocols),
      Promise.all(
        activeProtocols.map((serverProtocol) =>
          this.peersRepository.find({ where: { serverProtocolId: serverProtocol.id, status: PeerStatus.ACTIVE } }),
        ),
      ),
    ]);

    const peers = activeProtocols.flatMap((serverProtocol, index) =>
      this.buildPeerStats(
        server,
        serverProtocol,
        peersByProtocol[index],
        transferStatsByProtocolId.get(serverProtocol.id) ?? new Map(),
      ),
    );
    const networkBps = peers.reduce((sum, peer) => sum + peer.rxBps + peer.txBps, 0);

    return {
      server: {
        serverId: server.id,
        serverName: server.name,
        isSelf: server.isSelf,
        // loadAvg1 === null означает "сервер недоступен" (см. getServerSnapshot) —
        // используем это как признак "не в сети", не трогая Server.status (его меняет
        // только явная "Проверить подключение").
        online: load.loadAvg1 !== null,
        loadAvg1: load.loadAvg1,
        cpuCores: load.cpuCores,
        memUsedMb: load.memUsedMb,
        memTotalMb: load.memTotalMb,
        diskUsedMb: load.diskUsedMb,
        diskTotalMb: load.diskTotalMb,
        networkBps,
        activePeers: peers.length,
        maxPeers: server.maxPeers,
      },
      peers,
    };
  }

  private buildPeerStats(
    server: Server,
    serverProtocol: ServerProtocol,
    peers: Peer[],
    transferStats: Map<string, PeerTransferStats>,
  ): DashboardPeerStats[] {
    const now = Date.now();
    return peers.map((peer) => {
      const sample = transferStats.get(peer.publicKey);
      const rxBytesTotal = sample?.rxBytes ?? 0;
      const txBytesTotal = sample?.txBytes ?? 0;

      const previous = this.lastSample.get(peer.id);
      let rxBps = 0;
      let txBps = 0;
      if (previous && sample) {
        const elapsedSeconds = (now - previous.at) / 1000;
        if (elapsedSeconds > 0) {
          // max(0, ...) — счётчики на интерфейсе сбрасываются в 0 при пересоздании
          // (переустановка/down+up), отрицательная дельта в этом случае не означает
          // отрицательный трафик.
          rxBps = Math.max(0, (rxBytesTotal - previous.rxBytes) / elapsedSeconds);
          txBps = Math.max(0, (txBytesTotal - previous.txBytes) / elapsedSeconds);
        }
      }
      if (sample) {
        this.lastSample.set(peer.id, { rxBytes: rxBytesTotal, txBytes: txBytesTotal, at: now });
      }

      return {
        peerId: peer.id,
        name: peer.name,
        serverId: server.id,
        serverName: server.name,
        organizationId: peer.organizationId,
        source: peer.source,
        protocol: serverProtocol.protocol,
        rxBytesTotal,
        txBytesTotal,
        rxBps: Math.round(rxBps),
        txBps: Math.round(txBps),
        latestHandshake: sample?.latestHandshake ?? 0,
        createdAt: peer.createdAt.toISOString(),
      };
    });
  }

  // Раз в PERSIST_INTERVAL_MS сохраняет ДЕЛЬТУ (не кумулятивное значение) трафика каждого
  // peer'а с момента предыдущего персиста — используя уже полученный этим же опросом
  // снапшот (см. poll()), без единого лишнего SSH-запроса. max(0, ...) — та же защита от
  // сброса счётчиков интерфейса при пересоздании, что и у мгновенного bps в buildPeerStats.
  private async persistTrafficSamples(peers: DashboardPeerStats[]): Promise<void> {
    const rows: Array<Partial<PeerTrafficSample>> = [];
    const seenPeerIds = new Set<string>();

    for (const peer of peers) {
      seenPeerIds.add(peer.peerId);
      const previous = this.lastPersistedCumulative.get(peer.peerId);
      this.lastPersistedCumulative.set(peer.peerId, { rxBytes: peer.rxBytesTotal, txBytes: peer.txBytesTotal });
      if (!previous) {
        // Первая проба этого peer'а с момента старта backend — дельту считать не от чего
        // (посчитали бы весь накопленный к этому моменту трафик как "за один интервал").
        continue;
      }
      const rxBytes = Math.max(0, peer.rxBytesTotal - previous.rxBytes);
      const txBytes = Math.max(0, peer.txBytesTotal - previous.txBytes);
      if (rxBytes === 0 && txBytes === 0) {
        continue;
      }
      rows.push({
        peerId: peer.peerId,
        peerName: peer.name,
        peerSource: peer.source,
        organizationId: peer.organizationId,
        serverId: peer.serverId,
        serverName: peer.serverName,
        rxBytes,
        txBytes,
      });
    }

    // Peers, пропавшие из снапшота (отозваны/удалены/сервер недоступен) — забываем их
    // последнюю пробу, иначе появление НОВОГО peer'а с тем же id (после восстановления БД
    // из бэкапа, например) молча досчитает несуществующий разрыв как дельту.
    for (const peerId of this.lastPersistedCumulative.keys()) {
      if (!seenPeerIds.has(peerId)) {
        this.lastPersistedCumulative.delete(peerId);
      }
    }

    if (rows.length > 0) {
      await this.trafficSamplesRepository.insert(rows);
    }
  }

  private rangeStart(range: TrafficRange): Date {
    const from = new Date();
    if (range === 'day') {
      from.setDate(from.getDate() - 1);
    } else if (range === 'week') {
      from.setDate(from.getDate() - 7);
    } else {
      from.setMonth(from.getMonth() - 1);
    }
    return from;
  }

  // SUPER_ADMIN-only (см. DashboardController) — та же граница видимости, что у живого
  // дашборда (WS namespace пускает только super_admin), поэтому без org-скоупинга по
  // умолчанию: сумма по ВСЕМ организациям сразу, если organizationId не передан — фильтр
  // для удобства мониторинга конкретного клиента across серверов.
  async getTrafficByServer(range: TrafficRange, organizationId?: string): Promise<ServerTrafficRow[]> {
    const query = this.trafficSamplesRepository
      .createQueryBuilder('s')
      .select('s.serverId', 'serverId')
      .addSelect('MAX(s.serverName)', 'serverName')
      .addSelect('SUM(s.rxBytes)', 'rxBytes')
      .addSelect('SUM(s.txBytes)', 'txBytes')
      .where('s.sampledAt >= :from', { from: this.rangeStart(range) });
    if (organizationId) {
      query.andWhere('s.organizationId = :organizationId', { organizationId });
    }
    const rows = await query
      .groupBy('s.serverId')
      .orderBy('SUM(s.rxBytes) + SUM(s.txBytes)', 'DESC')
      .getRawMany<{ serverId: string; serverName: string; rxBytes: string; txBytes: string }>();
    return rows.map((r) => ({ serverId: r.serverId, serverName: r.serverName, rxBytes: Number(r.rxBytes), txBytes: Number(r.txBytes) }));
  }

  // Разрез "по клиентам" — сколько трафика потребила каждая организация (across всех её
  // peers на всех серверах). Без BRIDGE_UPSTREAM (см. getTrafficByPeer — это не трафик
  // настоящего клиента, а суммарный транзит моста через upstream) — иначе он бы весь
  // осел в "Без клиента" и исказил картину. serverId — необязательный фильтр, чтобы можно
  // было посмотреть "кто из клиентов сколько ест именно на этом сервере".
  async getTrafficByOrganization(range: TrafficRange, serverId?: string): Promise<OrganizationTrafficRow[]> {
    const query = this.trafficSamplesRepository
      .createQueryBuilder('s')
      .select('s.organizationId', 'organizationId')
      .addSelect('SUM(s.rxBytes)', 'rxBytes')
      .addSelect('SUM(s.txBytes)', 'txBytes')
      .where('s.sampledAt >= :from', { from: this.rangeStart(range) })
      .andWhere('s.peerSource != :bridgeUpstream', { bridgeUpstream: PeerSource.BRIDGE_UPSTREAM });
    if (serverId) {
      query.andWhere('s.serverId = :serverId', { serverId });
    }
    const rows = await query
      .groupBy('s.organizationId')
      .orderBy('SUM(s.rxBytes) + SUM(s.txBytes)', 'DESC')
      .getRawMany<{ organizationId: string | null; rxBytes: string; txBytes: string }>();
    const names = await this.resolveOrganizationNames(rows.map((r) => r.organizationId));
    return rows.map((r) => ({
      organizationId: r.organizationId,
      organizationName: r.organizationId ? (names.get(r.organizationId) ?? 'Организация удалена') : NO_CLIENT_LABEL,
      rxBytes: Number(r.rxBytes),
      txBytes: Number(r.txBytes),
    }));
  }

  // Без BRIDGE_UPSTREAM — это системный peer моста (суммарный трафик всех его клиентов), а
  // не настоящий клиент; он и так скрыт из обычных списков peers (см. PeersService).
  // organizationId/serverId — необязательные фильтры для удобства мониторинга (посмотреть
  // peers конкретного клиента и/или конкретного сервера, не пролистывая общий список).
  async getTrafficByPeer(range: TrafficRange, organizationId?: string, serverId?: string): Promise<PeerTrafficRow[]> {
    const query = this.trafficSamplesRepository
      .createQueryBuilder('s')
      .select('s.peerId', 'peerId')
      .addSelect('MAX(s.peerName)', 'peerName')
      .addSelect('MAX(s.serverName)', 'serverName')
      .addSelect('MAX(s.organizationId)', 'organizationId')
      .addSelect('SUM(s.rxBytes)', 'rxBytes')
      .addSelect('SUM(s.txBytes)', 'txBytes')
      .where('s.sampledAt >= :from', { from: this.rangeStart(range) })
      .andWhere('s.peerSource != :bridgeUpstream', { bridgeUpstream: PeerSource.BRIDGE_UPSTREAM });
    if (organizationId) {
      query.andWhere('s.organizationId = :organizationId', { organizationId });
    }
    if (serverId) {
      query.andWhere('s.serverId = :serverId', { serverId });
    }
    const rows = await query
      .groupBy('s.peerId')
      .orderBy('SUM(s.rxBytes) + SUM(s.txBytes)', 'DESC')
      .getRawMany<{ peerId: string; peerName: string; serverName: string; organizationId: string | null; rxBytes: string; txBytes: string }>();
    const names = await this.resolveOrganizationNames(rows.map((r) => r.organizationId));
    return rows.map((r) => ({
      peerId: r.peerId,
      peerName: r.peerName,
      serverName: r.serverName,
      organizationId: r.organizationId,
      organizationName: r.organizationId ? (names.get(r.organizationId) ?? 'Организация удалена') : NO_CLIENT_LABEL,
      rxBytes: Number(r.rxBytes),
      txBytes: Number(r.txBytes),
    }));
  }

  // "Помесячно" — по серверам (включая self-серверы, несущие мосты — это обычные Server,
  // отдельной группировки "по мостам" не нужно), последние `months` календарных месяцев.
  // organizationId — необязательный фильтр (динамика конкретного клиента по месяцам).
  async getTrafficMonthly(months: number, organizationId?: string): Promise<MonthlyServerTrafficRow[]> {
    const from = new Date();
    from.setMonth(from.getMonth() - (Math.max(1, months) - 1));
    from.setDate(1);
    from.setHours(0, 0, 0, 0);

    const query = this.trafficSamplesRepository
      .createQueryBuilder('s')
      .select("to_char(date_trunc('month', s.sampledAt), 'YYYY-MM')", 'month')
      .addSelect('s.serverId', 'serverId')
      .addSelect('MAX(s.serverName)', 'serverName')
      .addSelect('SUM(s.rxBytes)', 'rxBytes')
      .addSelect('SUM(s.txBytes)', 'txBytes')
      .where('s.sampledAt >= :from', { from });
    if (organizationId) {
      query.andWhere('s.organizationId = :organizationId', { organizationId });
    }
    const rows = await query
      .groupBy("date_trunc('month', s.sampledAt)")
      .addGroupBy('s.serverId')
      .orderBy("date_trunc('month', s.sampledAt)", 'DESC')
      .getRawMany<{ month: string; serverId: string; serverName: string; rxBytes: string; txBytes: string }>();
    return rows.map((r) => ({
      month: r.month,
      serverId: r.serverId,
      serverName: r.serverName,
      rxBytes: Number(r.rxBytes),
      txBytes: Number(r.txBytes),
    }));
  }
}
