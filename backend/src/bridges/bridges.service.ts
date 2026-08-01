import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { decryptSecret } from '../common/encryption.util';
import { BridgeStatus, BridgeUpstreamMode, PeerStatus, ServerProtocolStatus, VpnProtocol } from '../common/enums';
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

@Injectable()
export class BridgesService {
  private readonly logger = new Logger(BridgesService.name);

  constructor(
    @InjectRepository(Bridge) private readonly bridgesRepository: Repository<Bridge>,
    @InjectRepository(ServerProtocol) private readonly serverProtocolsRepository: Repository<ServerProtocol>,
    @InjectRepository(Server) private readonly serversRepository: Repository<Server>,
    @InjectRepository(Peer) private readonly peersRepository: Repository<Peer>,
    private readonly peersService: PeersService,
    private readonly vpnProvisioningService: VpnProvisioningService,
  ) {}

  async findAll(): Promise<Bridge[]> {
    return this.bridgesRepository.find({
      relations: ['clientServerProtocol', 'clientServerProtocol.server', 'upstreamServerProtocol', 'upstreamServerProtocol.server'],
      order: { createdAt: 'DESC' },
    });
  }

  async create(dto: CreateBridgeDto): Promise<Bridge> {
    const selfServer = await this.serversRepository.findOne({ where: { id: dto.selfServerId } });
    if (!selfServer) {
      throw new NotFoundException('Сервер не найден');
    }
    selfServer.isSelf = true;
    await this.serversRepository.save(selfServer);

    // Клиентский интерфейс моста — переиспользуем обычную установку протокола, как для
    // любого другого сервера. Протокол выбирается явно (dto.protocol): там, где обычный
    // WireGuard блокируется/детектится DPI, клиентский хоп тоже должен быть AmneziaWG,
    // а не только upstream.
    const clientServerProtocol = await this.vpnProvisioningService.installProtocol(
      selfServer.id,
      dto.protocol,
      dto.listenPort,
      dto.networkCidr,
    );
    if (clientServerProtocol.status === ServerProtocolStatus.ERROR) {
      throw new BadRequestException(`Не удалось поднять локальный интерфейс для моста: ${clientServerProtocol.lastError}`);
    }

    const bridge = this.bridgesRepository.create({
      name: dto.name,
      clientServerProtocolId: clientServerProtocol.id,
      status: BridgeStatus.NOT_CONFIGURED,
    });
    return this.bridgesRepository.save(bridge);
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
    if (target.id === bridge.clientServerProtocolId) {
      throw new BadRequestException('Нельзя маршрутизировать мост через его же собственный клиентский интерфейс');
    }

    const selfServer = await this.getSelfServer(bridge);

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
        await this.vpnProvisioningService.connectBridgeUpstream(selfServer, target.protocol, bridge.upstreamInterfaceName, config);
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

    const loads = await Promise.all(
      candidates
        .filter((serverProtocol) => serverProtocol.id !== bridge.clientServerProtocolId)
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
    const clientServerProtocol = await this.serverProtocolsRepository.findOneOrFail({
      where: { id: bridge.clientServerProtocolId },
    });
    await this.vpnProvisioningService.setupBridgeNat(
      selfServer,
      clientServerProtocol.networkCidr,
      clientServerProtocol.interfaceName,
      bridge.upstreamInterfaceName,
    );
  }

  private async getSelfServer(bridge: Bridge): Promise<Server> {
    const clientServerProtocol = await this.serverProtocolsRepository.findOneOrFail({
      where: { id: bridge.clientServerProtocolId },
      relations: ['server'],
    });
    return clientServerProtocol.server;
  }

  private async findOneOrFail(id: string): Promise<Bridge> {
    const bridge = await this.bridgesRepository.findOne({
      where: { id },
      relations: ['clientServerProtocol', 'clientServerProtocol.server', 'upstreamServerProtocol', 'upstreamServerProtocol.server'],
    });
    if (!bridge) {
      throw new NotFoundException('Мост не найден');
    }
    return bridge;
  }
}
