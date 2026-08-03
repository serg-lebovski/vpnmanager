import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { probeTcpPort } from '../common/tcp-probe.util';
import { BridgeStatus, BridgeUpstreamMode } from '../common/enums';
import { Bridge } from './bridge.entity';
import { BridgesService } from './bridges.service';

const FAILOVER_CHECK_INTERVAL_MS = 20_000;

// Кандидат считается "упавшим"/"восстановившимся" только после нескольких подряд
// одинаковых результатов проверки — иначе мост дёргался бы между основным и резервом на
// одной случайной сетевой заминке (та же логика, что REBALANCE_THRESHOLD в
// bridges.service.ts, но для доступности, а не нагрузки).
const FLAP_PROTECTION_CONSECUTIVE = 3;

interface ProbeState {
  reachable: boolean | null;
  consecutiveOk: number;
  consecutiveFail: number;
}

// Отдельный от BridgesService сервис — у него своё приватное mutable-состояние (счётчики
// проверок по серверам), не относящееся к обязанностям BridgesService. Зависимость только
// в одну сторону (сюда → BridgesService.setUpstream), без обратной, чтобы не создавать
// DI-цикл — аннотирование доступности на список мостов (если понадобится) делается на
// уровне контроллера, а не внутри BridgesService.
@Injectable()
export class BridgeFailoverService {
  private readonly logger = new Logger(BridgeFailoverService.name);
  private readonly stateByServerId = new Map<string, ProbeState>();

  constructor(
    @InjectRepository(Bridge) private readonly bridgesRepository: Repository<Bridge>,
    private readonly bridgesService: BridgesService,
  ) {}

  // Снимок текущей (flap-protected) доступности по serverId — null, пока сервер ещё не
  // прошёл ни одного полного цикла проверки. Используется GET /bridges/:id/candidate-status.
  getReachabilityByServerId(): Record<string, boolean | null> {
    const result: Record<string, boolean | null> = {};
    for (const [serverId, state] of this.stateByServerId) {
      result[serverId] = state.reachable;
    }
    return result;
  }

  @Interval(FAILOVER_CHECK_INTERVAL_MS)
  private async pollFailoverBridges(): Promise<void> {
    const bridges = await this.bridgesRepository.find({
      where: { upstreamMode: BridgeUpstreamMode.FAILOVER },
      relations: ['upstreamCandidates', 'upstreamCandidates.serverProtocol', 'upstreamCandidates.serverProtocol.server'],
    });
    if (bridges.length === 0) {
      return;
    }

    // Проверяем каждый физический VPS один раз за тик, даже если он кандидат сразу у
    // нескольких мостов.
    const serversById = new Map<string, { host: string; sshPort: number }>();
    for (const bridge of bridges) {
      for (const candidate of bridge.upstreamCandidates ?? []) {
        const server = candidate.serverProtocol?.server;
        if (server && !serversById.has(server.id)) {
          serversById.set(server.id, { host: server.host, sshPort: server.sshPort });
        }
      }
    }

    await Promise.all(
      Array.from(serversById.entries()).map(async ([serverId, { host, sshPort }]) => {
        const ok = await probeTcpPort(host, sshPort);
        this.updateState(serverId, ok);
      }),
    );

    for (const bridge of bridges) {
      await this.reconcileBridge(bridge);
    }
  }

  // reachable начинается с null ("ещё не знаем") и переходит в true/false только после
  // FLAP_PROTECTION_CONSECUTIVE подряд одинаковых результатов — то же самое окно и для
  // самого первого присвоения (null → true/false), и для смены уже известного состояния,
  // поэтому сразу после включения режима не полыхнёт "всё упало" по одной проверке.
  private updateState(serverId: string, ok: boolean): void {
    const state = this.stateByServerId.get(serverId) ?? { reachable: null, consecutiveOk: 0, consecutiveFail: 0 };
    if (ok) {
      state.consecutiveOk += 1;
      state.consecutiveFail = 0;
      if (state.reachable !== true && state.consecutiveOk >= FLAP_PROTECTION_CONSECUTIVE) {
        state.reachable = true;
      }
    } else {
      state.consecutiveFail += 1;
      state.consecutiveOk = 0;
      if (state.reachable !== false && state.consecutiveFail >= FLAP_PROTECTION_CONSECUTIVE) {
        state.reachable = false;
      }
    }
    this.stateByServerId.set(serverId, state);
  }

  private async reconcileBridge(bridge: Bridge): Promise<void> {
    if (bridge.status === BridgeStatus.CONFIGURING) {
      return;
    }
    const ordered = (bridge.upstreamCandidates ?? []).slice().sort((a, b) => a.priority - b.priority);
    const best = ordered.find((candidate) => {
      const serverId = candidate.serverProtocol?.server?.id;
      return serverId ? this.stateByServerId.get(serverId)?.reachable === true : false;
    });

    if (!best) {
      this.logger.warn(`Мост "${bridge.name}": ни один upstream-кандидат сейчас не доступен — оставляю текущий upstream как есть`);
      return;
    }
    if (best.serverProtocolId === bridge.upstreamServerProtocolId) {
      return;
    }

    this.logger.log(`Мост "${bridge.name}": переключаю upstream на кандидата с приоритетом ${best.priority} (failover)`);
    try {
      await this.bridgesService.setUpstream(bridge.id, best.serverProtocolId);
    } catch (error) {
      this.logger.error(`Failover-переключение моста "${bridge.name}" не удалось: ${(error as Error).message}`);
    }
  }
}
