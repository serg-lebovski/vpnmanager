import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PeerStatus, ServerProtocolStatus, VpnProtocol } from '../common/enums';
import { Peer } from '../peers/peer.entity';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { Server } from '../servers/server.entity';
import { VpnProvisioningService } from '../vpn/vpn-provisioning.service';
import { DashboardGateway } from './dashboard.gateway';

export interface DashboardServerStats {
  serverId: string;
  serverName: string;
  isSelf: boolean;
  online: boolean;
  loadAvg1: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
  activePeers: number;
  maxPeers: number;
}

export interface DashboardPeerStats {
  peerId: string;
  name: string;
  serverName: string;
  protocol: VpnProtocol;
  rxBytesTotal: number;
  txBytesTotal: number;
  rxBps: number;
  txBps: number;
}

export interface DashboardSnapshot {
  timestamp: string;
  servers: DashboardServerStats[];
  peers: DashboardPeerStats[];
}

// Опрашивать каждую пару минут смысла нет (это "реальное время"), но и раз в секунду —
// перебор: на каждый сервер тратится отдельное SSH-подключение (см. SshService), и по
// нескольку команд на каждый активный протокол. 7 секунд — компромисс между
// отзывчивостью дашборда и нагрузкой на SSH/сеть при десятках серверов.
const POLL_INTERVAL_MS = 7000;

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);
  private lastSnapshot: DashboardSnapshot | null = null;
  // publicKey peer'а -> последняя проба трафика, чтобы считать мгновенную скорость
  // (байт/сек) как дельту между двумя опросами, а не только кумулятивный счётчик.
  private readonly lastSample = new Map<string, { rxBytes: number; txBytes: number; at: number }>();
  private gateway: DashboardGateway | null = null;

  constructor(
    @InjectRepository(Server) private readonly serversRepository: Repository<Server>,
    @InjectRepository(Peer) private readonly peersRepository: Repository<Peer>,
    private readonly vpnProvisioningService: VpnProvisioningService,
  ) {}

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
          memUsedMb: null,
          memTotalMb: null,
          activePeers: 0,
          maxPeers: server.maxPeers,
        });
      }
    });

    return { timestamp: new Date().toISOString(), servers: serverStats, peers: peerStats };
  }

  private async pollServer(server: Server): Promise<{ server: DashboardServerStats; peers: DashboardPeerStats[] }> {
    const load = await this.vpnProvisioningService.getServerLoad(server);
    const activeProtocols = server.protocols.filter((sp) => sp.status === ServerProtocolStatus.ACTIVE);

    const peersNested = await Promise.all(activeProtocols.map((serverProtocol) => this.pollProtocol(server, serverProtocol)));
    const peers = peersNested.flat();

    return {
      server: {
        serverId: server.id,
        serverName: server.name,
        isSelf: server.isSelf,
        // getServerLoad возвращает null-поля при недоступности сервера (см. её реализацию
        // в vpn-provisioning.service.ts) — используем это как признак "не в сети", не
        // трогая Server.status (его меняет только явная "Проверить подключение").
        online: load.loadAvg1 !== null,
        loadAvg1: load.loadAvg1,
        memUsedMb: load.memUsedMb,
        memTotalMb: load.memTotalMb,
        activePeers: peers.length,
        maxPeers: server.maxPeers,
      },
      peers,
    };
  }

  private async pollProtocol(server: Server, serverProtocol: ServerProtocol): Promise<DashboardPeerStats[]> {
    const [transferStats, peers] = await Promise.all([
      this.vpnProvisioningService.getTransferStats(serverProtocol, server),
      this.peersRepository.find({ where: { serverProtocolId: serverProtocol.id, status: PeerStatus.ACTIVE } }),
    ]);

    const now = Date.now();
    return peers.map((peer) => {
      const sample = transferStats.get(peer.publicKey);
      const rxBytesTotal = sample?.rxBytes ?? 0;
      const txBytesTotal = sample?.txBytes ?? 0;

      const previous = this.lastSample.get(peer.publicKey);
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
        this.lastSample.set(peer.publicKey, { rxBytes: rxBytesTotal, txBytes: txBytesTotal, at: now });
      }

      return {
        peerId: peer.id,
        name: peer.name,
        serverName: server.name,
        protocol: serverProtocol.protocol,
        rxBytesTotal,
        txBytesTotal,
        rxBps: Math.round(rxBps),
        txBps: Math.round(txBps),
      };
    });
  }
}
