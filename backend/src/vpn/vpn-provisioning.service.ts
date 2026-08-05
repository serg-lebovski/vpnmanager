import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
  private readonly logger = new Logger(VpnProvisioningService.name);
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

    // Установка (особенно AmneziaWG: add-apt-repository + apt-get update + install из PPA)
    // может занимать дольше, чем таймаут HTTP-прокси перед этим эндпоинтом (см.
    // nginx/nginx.conf.template) — если клиент к этому моменту уже отвалился по таймауту,
    // единственный способ узнать реальный исход операции без похода в БД напрямую — вот
    // этот лог (Настройки → «Логи» → backend).
    this.logger.log(`Установка ${protocol} на сервере "${server.name}" (${server.host}:${listenPort})…`);
    try {
      const result = await this.sshService.withConnection(connection, (ssh) =>
        driver.install({ ssh, server, serverProtocol }, { listenPort, networkCidr, mtu, interfaceName }),
      );
      serverProtocol.interfaceName = result.interfaceName;
      serverProtocol.serverPublicKey = result.serverPublicKey;
      serverProtocol.obfuscationParams = result.obfuscationParams || null;
      serverProtocol.mtu = result.mtu || null;
      serverProtocol.status = ServerProtocolStatus.ACTIVE;
      this.logger.log(`${protocol} успешно установлен на сервере "${server.name}" (интерфейс ${result.interfaceName})`);
    } catch (error) {
      serverProtocol.status = ServerProtocolStatus.ERROR;
      serverProtocol.lastError = (error as Error).message;
      this.logger.error(`Установка ${protocol} на сервере "${server.name}" не удалась: ${(error as Error).message}`);
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

  // Для дашборда (см. dashboard/) — общая нагрузка хоста (1-минутный loadavg, число ядер
  // для перевода loadavg в примерный % CPU, память, диск корневого раздела) И живая
  // статистика трафика по peer'ам КАЖДОГО активного протокола сервера — всё за ОДНО SSH-
  // подключение. Раньше это были отдельные getServerLoad()/getTransferStats() с отдельным
  // withConnection() на каждый вызов: 1 (loadavg) + N (по числу активных протоколов)
  // независимых SSH-хендшейков на сервер каждые 7с опроса дашборда навсегда — Diffie-
  // Hellman + подпись при каждом коннекте не бесплатны что для backend, что для самого VPS.
  // Если подключиться не удалось вообще — бросаем (как раньше бросал getTransferStats),
  // buildSnapshot() в dashboard.service.ts уже ловит это через Promise.allSettled и рисует
  // сервер офлайн.
  async getServerSnapshot(
    server: Server,
    activeProtocols: ServerProtocol[],
  ): Promise<{
    load: {
      loadAvg1: number | null;
      cpuCores: number | null;
      memTotalMb: number | null;
      memUsedMb: number | null;
      diskTotalMb: number | null;
      diskUsedMb: number | null;
    };
    transferStatsByProtocolId: Map<string, Map<string, PeerTransferStats>>;
  }> {
    const connection = this.connectionParams(server);
    const transferStatsByProtocolId = new Map<string, Map<string, PeerTransferStats>>();

    const load = await this.sshService.withConnection(connection, async (ssh) => {
      const loadResult = await this.sshService.exec(ssh, `cat /proc/loadavg`);
      const cpuResult = await this.sshService.exec(ssh, `nproc`);
      const memResult = await this.sshService.exec(ssh, `free -m | awk '/Mem:/ {print $2, $3}'`);
      const diskResult = await this.sshService.exec(ssh, `df -k / | tail -1 | awk '{print $2, $3}'`);

      const loadAvg1 = loadResult.code === 0 ? parseFloat(loadResult.stdout.trim().split(/\s+/)[0]) : null;
      const cpuCores = cpuResult.code === 0 ? parseInt(cpuResult.stdout.trim(), 10) : null;
      const [memTotal, memUsed] = memResult.code === 0 ? memResult.stdout.trim().split(/\s+/) : [];
      // df -k выводит в 1024-байтных блоках — переводим в МБ тем же способом, что и free -m.
      const [diskTotalKb, diskUsedKb] = diskResult.code === 0 ? diskResult.stdout.trim().split(/\s+/) : [];

      for (const serverProtocol of activeProtocols) {
        const driver = this.driverFor(serverProtocol.protocol);
        transferStatsByProtocolId.set(serverProtocol.id, await driver.getTransferStats({ ssh, server, serverProtocol }));
      }

      return {
        loadAvg1: Number.isFinite(loadAvg1) ? loadAvg1 : null,
        cpuCores: cpuCores !== null && Number.isFinite(cpuCores) && cpuCores > 0 ? cpuCores : null,
        memTotalMb: memTotal !== undefined ? Number(memTotal) : null,
        memUsedMb: memUsed !== undefined ? Number(memUsed) : null,
        diskTotalMb: diskTotalKb !== undefined ? Math.round(Number(diskTotalKb) / 1024) : null,
        diskUsedMb: diskUsedKb !== undefined ? Math.round(Number(diskUsedKb) / 1024) : null,
      };
    });

    return { load, transferStatsByProtocolId };
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
  // ИДЕМПОТЕНТНО: каждая команда сначала проверяет (-C для iptables, grep по `ip rule
  // show` для policy routing), существует ли правило, и добавляет только если его нет.
  // Раньше вызывалось только ОДИН раз — при первом назначении upstream моста (расчёт был
  // на то, что правила ссылаются на постоянные имена интерфейсов и не требуют
  // пересоздания при последующих переключениях) — но `ip rule`/iptables это состояние
  // ядра, не переживающее перезагрузку self-сервера, и ничего не пересоздавало их
  // само собой. Поймано вживую: правило исчезло (сервер перезагружали/что-то его
  // сбросило), трафик клиентов моста стал молча уходить через обычный интернет
  // self-сервера вместо upstream-туннеля — работоспособность моста никак не
  // сигнализировала об этой поломке. Теперь setupBridgeNat вызывается при КАЖДОМ
  // setUpstream (см. bridges.service.ts) — самовосстанавливается при следующем же
  // переключении, а не только при самом первом назначении.
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
          `iptables -t nat -C POSTROUTING -s ${networkCidr} -o ${upstreamInterfaceName} -j MASQUERADE 2>/dev/null || ` +
            `iptables -t nat -A POSTROUTING -s ${networkCidr} -o ${upstreamInterfaceName} -j MASQUERADE`,
        );
        await this.sshService.execOrThrow(
          ssh,
          `iptables -C FORWARD -i ${interfaceName} -o ${upstreamInterfaceName} -j ACCEPT 2>/dev/null || ` +
            `iptables -A FORWARD -i ${interfaceName} -o ${upstreamInterfaceName} -j ACCEPT`,
        );
        await this.sshService.execOrThrow(
          ssh,
          `iptables -C FORWARD -i ${upstreamInterfaceName} -o ${interfaceName} -j ACCEPT 2>/dev/null || ` +
            `iptables -A FORWARD -i ${upstreamInterfaceName} -o ${interfaceName} -j ACCEPT`,
        );
        // Только пакеты с источником из сети ЭТОГО клиентского интерфейса ищут маршрут
        // в отдельной таблице ЭТОГО моста (routeTable — там upstream — шлюз по
        // умолчанию, см. connectAsClient); всё остальное на хосте по-прежнему
        // резолвится через main. Приоритет 100 — заведомо раньше правила main (32766).
        await this.sshService.execOrThrow(
          ssh,
          `ip rule show | grep -q "from ${networkCidr} lookup ${routeTable}" || ` +
            `ip rule add from ${networkCidr} table ${routeTable} priority 100`,
        );
      }
    });
  }
}
