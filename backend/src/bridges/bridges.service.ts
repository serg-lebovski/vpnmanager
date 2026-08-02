import { randomBytes } from 'crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { decryptSecret } from '../common/encryption.util';
import { BridgeStatus, BridgeUpstreamMode, PeerStatus, Role, ServerProtocolStatus, VpnProtocol } from '../common/enums';
import { Peer } from '../peers/peer.entity';
import { PeersService } from '../peers/peers.service';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { Server } from '../servers/server.entity';
import { UpstreamPeerConfig } from '../vpn/vpn-driver.interface';
import { VpnProvisioningService } from '../vpn/vpn-provisioning.service';
import { Bridge } from './bridge.entity';
import { CreateBridgeDto } from './dto/create-bridge.dto';

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
];

@Injectable()
export class BridgesService {
  private readonly logger = new Logger(BridgesService.name);

  constructor(
    @InjectRepository(Bridge) private readonly bridgesRepository: Repository<Bridge>,
    @InjectRepository(ServerProtocol) private readonly serverProtocolsRepository: Repository<ServerProtocol>,
    @InjectRepository(Server) private readonly serversRepository: Repository<Server>,
    @InjectRepository(Peer) private readonly peersRepository: Repository<Peer>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly peersService: PeersService,
    private readonly vpnProvisioningService: VpnProvisioningService,
  ) {}

  async findAll(requester: AuthenticatedUser): Promise<Bridge[]> {
    const bridges = await this.bridgesRepository.find({
      relations: BRIDGE_RELATIONS,
      order: { createdAt: 'DESC' },
    });
    if (requester.role === Role.SUPER_ADMIN) {
      return bridges;
    }
    // org_admin/org_user видят только мосты своей организации плюс общие (organizationId
    // = null) — по тому же принципу, что видимость peers (см. findAllForRequester в
    // peers.service.ts).
    return bridges.filter((bridge) => bridge.organizationId === null || bridge.organizationId === requester.organizationId);
  }

  async create(dto: CreateBridgeDto): Promise<Bridge> {
    const protocols = new Set(dto.clientProtocols.map((p) => p.protocol));
    if (protocols.size !== dto.clientProtocols.length) {
      throw new BadRequestException('Протокол клиентского интерфейса моста нельзя указывать дважды');
    }

    const selfServer = await this.serversRepository.findOne({ where: { id: dto.selfServerId } });
    if (!selfServer) {
      throw new NotFoundException('Сервер не найден');
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

    selfServer.isSelf = true;
    await this.serversRepository.save(selfServer);

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
      await this.peersService.revokeSystemPeer(bridge.upstreamPeerId);
    }
    const clientProtocolIds = this.clientProtocolIds(bridge);
    if (clientProtocolIds.length > 0) {
      await this.serverProtocolsRepository.delete(clientProtocolIds);
    } else {
      await this.bridgesRepository.remove(bridge);
    }
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
          await this.setUpstream(bridge.id, alternative.id);
        } else {
          this.logger.warn(`Сервер удаляется — для моста "${bridge.name}" не нашлось альтернативного upstream`);
        }
      } catch (error) {
        this.logger.error(`Не удалось переключить upstream моста "${bridge.name}" при удалении сервера: ${(error as Error).message}`);
      }
    }
  }

  async setMode(bridgeId: string, mode: BridgeUpstreamMode): Promise<Bridge> {
    const bridge = await this.findOneOrFail(bridgeId);
    if (mode === BridgeUpstreamMode.AUTO && !bridge.upstreamServerProtocolId) {
      throw new BadRequestException('Сначала выберите upstream вручную — автобаланс переключает уже настроенный мост');
    }
    bridge.upstreamMode = mode;
    return this.bridgesRepository.save(bridge);
  }

  async setUpstream(bridgeId: string, targetServerProtocolId: string): Promise<Bridge> {
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

    try {
      // Создаём системный peer на цели ДО отключения старого — если что-то пойдёт не так,
      // старый upstream останется рабочим и клиенты моста не потеряют связь.
      const systemPeer = await this.peersService.createSystemPeer(target.id, `bridge:${bridge.name}`);
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

      try {
        if (wasConfiguredBefore) {
          await this.vpnProvisioningService.disconnectBridgeUpstream(selfServer, previousProtocol!, bridge.upstreamInterfaceName);
        }
        // self-сервер мог ещё не иметь дела с протоколом upstream-сервера (например, поднят
        // под обычный WireGuard для клиентов моста, а upstream — AmneziaWG) — доустанавливаем
        // недостающие CLI-инструменты перед подключением.
        await this.vpnProvisioningService.ensureClientToolsInstalled(selfServer, target.protocol);
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
        // мост им не воспользуется, не оставляем его висеть там.
        await this.peersService.revokeSystemPeer(systemPeer.id);
        throw error;
      }

      if (!wasConfiguredBefore) {
        await this.configureNat(selfServer, bridge);
      }

      bridge.upstreamServerProtocolId = target.id;
      bridge.upstreamPeerId = systemPeer.id;
      bridge.status = BridgeStatus.ACTIVE;
      const saved = await this.bridgesRepository.save(bridge);

      if (previousPeerId) {
        await this.peersService.revokeSystemPeer(previousPeerId);
      }

      return saved;
    } catch (error) {
      bridge.status = BridgeStatus.ERROR;
      bridge.lastError = (error as Error).message;
      await this.bridgesRepository.save(bridge);
      throw error;
    }
  }

  async rebalanceNow(bridgeId: string): Promise<Bridge> {
    const bridge = await this.findOneOrFail(bridgeId);
    const best = await this.findBetterCandidate(bridge);
    if (!best) {
      return bridge;
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
          await this.setUpstream(bridge.id, best.id);
        }
      } catch (error) {
        this.logger.error(`Автобаланс моста "${bridge.name}" не удался: ${(error as Error).message}`);
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
