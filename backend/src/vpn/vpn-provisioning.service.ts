import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { decryptSecret } from '../common/encryption.util';
import { ServerProtocolStatus, VpnProtocol } from '../common/enums';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { Server } from '../servers/server.entity';
import { SshConnectionParams, SshService } from '../ssh/ssh.service';
import { AmneziaWgDriver } from './amnezia-wg.driver';
import { assertSupportedCidr } from './network.util';
import { PeerSpec, PeerTransferStats, ScannedPeer, UpstreamPeerConfig, VpnDriver } from './vpn-driver.interface';
import { WireGuardDriver } from './wireguard.driver';

@Injectable()
export class VpnProvisioningService {
  private readonly drivers: Record<VpnProtocol, VpnDriver>;

  constructor(
    private readonly sshService: SshService,
    private readonly wireGuardDriver: WireGuardDriver,
    private readonly amneziaWgDriver: AmneziaWgDriver,
    @InjectRepository(Server) private readonly serversRepository: Repository<Server>,
    @InjectRepository(ServerProtocol) private readonly serverProtocolsRepository: Repository<ServerProtocol>,
  ) {
    this.drivers = {
      [VpnProtocol.WIREGUARD]: this.wireGuardDriver,
      [VpnProtocol.AMNEZIAWG]: this.amneziaWgDriver,
    };
  }

  driverFor(protocol: VpnProtocol): VpnDriver {
    return this.drivers[protocol];
  }

  connectionParams(server: Server): SshConnectionParams {
    return {
      host: server.host,
      port: server.sshPort,
      username: server.sshUsername,
      authType: server.sshAuthType,
      secret: decryptSecret(server.sshSecretEnc),
    };
  }

  async installProtocol(
    serverId: string,
    protocol: VpnProtocol,
    listenPort: number,
    networkCidr: string,
    mtu?: number,
    interfaceName?: string,
  ): Promise<ServerProtocol> {
    assertSupportedCidr(networkCidr);
    const server = await this.serversRepository.findOne({ where: { id: serverId } });
    if (!server) {
      throw new NotFoundException('Сервер не найден');
    }

    // Порт, а не только протокол — на одном self-сервере может стоять несколько мостов с
    // одним и тем же протоколом (разные порты/сети): без учёта порта второй мост считался
    // бы "уже установлен" из-за первого.
    const existing = await this.serverProtocolsRepository.findOne({ where: { serverId, protocol, listenPort } });
    if (existing && existing.status === ServerProtocolStatus.ACTIVE) {
      throw new BadRequestException('Этот протокол уже установлен на сервере');
    }

    let serverProtocol =
      existing ||
      this.serverProtocolsRepository.create({
        serverId,
        protocol,
        interfaceName: '',
        listenPort,
        networkCidr,
        nextHostOctet: 2,
      });
    serverProtocol.status = ServerProtocolStatus.INSTALLING;
    serverProtocol.lastError = null;
    serverProtocol = await this.serverProtocolsRepository.save(serverProtocol);

    const driver = this.driverFor(protocol);
    const connection = this.connectionParams(server);

    try {
      const result = await this.sshService.withConnection(connection, (ssh) =>
        driver.install({ ssh, server, serverProtocol }, { listenPort, networkCidr, mtu, interfaceName }),
      );
      serverProtocol.interfaceName = result.interfaceName;
      serverProtocol.serverPublicKey = result.serverPublicKey;
      serverProtocol.obfuscationParams = result.obfuscationParams || null;
      serverProtocol.mtu = result.mtu || null;
      serverProtocol.status = ServerProtocolStatus.ACTIVE;
    } catch (error) {
      serverProtocol.status = ServerProtocolStatus.ERROR;
      serverProtocol.lastError = (error as Error).message;
    }

    return this.serverProtocolsRepository.save(serverProtocol);
  }

  async scanExistingPeers(serverProtocolId: string): Promise<ScannedPeer[]> {
    const serverProtocol = await this.serverProtocolsRepository.findOne({
      where: { id: serverProtocolId },
      relations: ['server'],
    });
    if (!serverProtocol) {
      throw new NotFoundException('Протокол сервера не найден');
    }
    const driver = this.driverFor(serverProtocol.protocol);
    const connection = this.connectionParams(serverProtocol.server);
    return this.sshService.withConnection(connection, (ssh) =>
      driver.scanExistingPeers({ ssh, server: serverProtocol.server, serverProtocol }),
    );
  }

  async applyPeers(serverProtocol: ServerProtocol, server: Server, peers: PeerSpec[]): Promise<void> {
    const driver = this.driverFor(serverProtocol.protocol);
    const connection = this.connectionParams(server);
    await this.sshService.withConnection(connection, (ssh) =>
      driver.applyPeers({ ssh, server, serverProtocol }, peers),
    );
  }

  // Для дашборда (см. dashboard/) — живая статистика трафика по peer'ам конкретного
  // ServerProtocol, без похода в БД.
  async getTransferStats(serverProtocol: ServerProtocol, server: Server): Promise<Map<string, PeerTransferStats>> {
    const driver = this.driverFor(serverProtocol.protocol);
    const connection = this.connectionParams(server);
    return this.sshService.withConnection(connection, (ssh) => driver.getTransferStats({ ssh, server, serverProtocol }));
  }

  // Для дашборда — общая (не привязанная к протоколу) нагрузка хоста: 1-минутный
  // loadavg и память. null-поля — команда не удалась (сервер недоступен и т.п.), не бросаем.
  async getServerLoad(server: Server): Promise<{ loadAvg1: number | null; memTotalMb: number | null; memUsedMb: number | null }> {
    const connection = this.connectionParams(server);
    try {
      return await this.sshService.withConnection(connection, async (ssh) => {
        const loadResult = await this.sshService.exec(ssh, `cat /proc/loadavg`);
        const memResult = await this.sshService.exec(ssh, `free -m | awk '/Mem:/ {print $2, $3}'`);
        const loadAvg1 = loadResult.code === 0 ? parseFloat(loadResult.stdout.trim().split(/\s+/)[0]) : null;
        const [memTotal, memUsed] = memResult.code === 0 ? memResult.stdout.trim().split(/\s+/) : [];
        return {
          loadAvg1: Number.isFinite(loadAvg1) ? loadAvg1 : null,
          memTotalMb: memTotal !== undefined ? Number(memTotal) : null,
          memUsedMb: memUsed !== undefined ? Number(memUsed) : null,
        };
      });
    } catch {
      return { loadAvg1: null, memTotalMb: null, memUsedMb: null };
    }
  }

  // Ищет на сервере уже настроенный (не через наш сервис) VPN по стандартным путям
  // установки протокола и, если находит, заводит/обновляет запись ServerProtocol на
  // основе найденной конфигурации (не переустанавливая и не трогая сам VPN-интерфейс).
  // Возвращает null, если для этого протокола на сервере ничего не найдено.
  async detectExisting(serverId: string, protocol: VpnProtocol): Promise<ServerProtocol | null> {
    const server = await this.serversRepository.findOne({ where: { id: serverId } });
    if (!server) {
      throw new NotFoundException('Сервер не найден');
    }

    const existing = await this.serverProtocolsRepository.findOne({ where: { serverId, protocol } });
    const driver = this.driverFor(protocol);
    const connection = this.connectionParams(server);

    const detection = await this.sshService.withConnection(connection, (ssh) => driver.detectExisting(ssh));
    if (!detection) {
      return null;
    }

    const serverProtocol =
      existing ||
      this.serverProtocolsRepository.create({
        serverId,
        protocol,
        nextHostOctet: 2,
      });
    serverProtocol.interfaceName = detection.interfaceName;
    serverProtocol.listenPort = detection.listenPort;
    serverProtocol.networkCidr = detection.networkCidr;
    serverProtocol.serverPublicKey = detection.serverPublicKey;
    serverProtocol.obfuscationParams = detection.obfuscationParams || null;
    serverProtocol.execContainer = detection.execContainer ?? null;
    serverProtocol.remoteConfDir = detection.remoteConfDir ?? null;
    serverProtocol.remoteInterfaceAddress = detection.remoteInterfaceAddress ?? null;
    serverProtocol.status = ServerProtocolStatus.ACTIVE;
    serverProtocol.lastError = null;

    return this.serverProtocolsRepository.save(serverProtocol);
  }

  // Ставит CLI-инструменты протокола на selfServer (не трогая конфиг/интерфейсы) — нужно
  // перед connectBridgeUpstream, если self-сервер ещё не имел дела с этим протоколом.
  async ensureClientToolsInstalled(selfServer: Server, protocol: VpnProtocol): Promise<void> {
    const driver = this.driverFor(protocol);
    const connection = this.connectionParams(selfServer);
    await this.sshService.withConnection(connection, (ssh) => driver.ensureClientToolsInstalled(ssh));
  }

  // Режим моста: поднимает на selfServer интерфейс в роли клиента к upstream-серверу.
  async connectBridgeUpstream(
    selfServer: Server,
    protocol: VpnProtocol,
    interfaceName: string,
    config: UpstreamPeerConfig,
    routeTable: number,
  ): Promise<void> {
    const driver = this.driverFor(protocol);
    const connection = this.connectionParams(selfServer);
    await this.sshService.withConnection(connection, (ssh) => driver.connectAsClient(ssh, interfaceName, config, routeTable));
  }

  async disconnectBridgeUpstream(selfServer: Server, protocol: VpnProtocol, interfaceName: string): Promise<void> {
    const driver = this.driverFor(protocol);
    const connection = this.connectionParams(selfServer);
    await this.sshService.withConnection(connection, (ssh) => driver.disconnectAsClient(ssh, interfaceName));
  }

  // Режим моста: NAT+forwarding+policy routing на self-сервере — трафик ИЗ СЕТЕЙ
  // КЛИЕНТОВ МОСТА (и только их — один или два клиентских интерфейса, если у моста
  // включены и WireGuard, и AmneziaWG одновременно) уходит через upstream-интерфейс
  // вместо обычного egress хоста; остальной трафик self-сервера (включая его
  // собственную связность — SSH и т.п., и трафик ДРУГИХ мостов на том же хосте, у
  // каждого своя routeTable) продолжает идти через основной маршрут без изменений.
  // Настраивается один раз при первом подключении upstream (правила ссылаются только
  // на имена интерфейсов, которые не меняются при последующих переключениях upstream).
  async setupBridgeNat(
    selfServer: Server,
    clientInterfaces: Array<{ networkCidr: string; interfaceName: string }>,
    upstreamInterfaceName: string,
    routeTable: number,
  ): Promise<void> {
    const connection = this.connectionParams(selfServer);
    await this.sshService.withConnection(connection, async (ssh) => {
      await this.sshService.execOrThrow(
        ssh,
        `sysctl -w net.ipv4.ip_forward=1 && (grep -q net.ipv4.ip_forward /etc/sysctl.d/99-vpnmanager.conf 2>/dev/null || echo net.ipv4.ip_forward=1 >> /etc/sysctl.d/99-vpnmanager.conf)`,
      );
      for (const { networkCidr, interfaceName } of clientInterfaces) {
        await this.sshService.execOrThrow(
          ssh,
          `iptables -t nat -A POSTROUTING -s ${networkCidr} -o ${upstreamInterfaceName} -j MASQUERADE`,
        );
        await this.sshService.execOrThrow(ssh, `iptables -A FORWARD -i ${interfaceName} -o ${upstreamInterfaceName} -j ACCEPT`);
        await this.sshService.execOrThrow(ssh, `iptables -A FORWARD -i ${upstreamInterfaceName} -o ${interfaceName} -j ACCEPT`);
        // Только пакеты с источником из сети ЭТОГО клиентского интерфейса ищут маршрут
        // в отдельной таблице ЭТОГО моста (routeTable — там upstream — шлюз по
        // умолчанию, см. connectAsClient); всё остальное на хосте по-прежнему
        // резолвится через main. Приоритет 100 — заведомо раньше правила main (32766).
        await this.sshService.execOrThrow(ssh, `ip rule add from ${networkCidr} table ${routeTable} priority 100`);
      }
    });
  }
}
