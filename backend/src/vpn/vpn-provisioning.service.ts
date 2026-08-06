import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
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

    // Порт/сеть должны быть уникальны в пределах сервера НЕЗАВИСИМО от протокола — иначе
    // второй протокол на том же порту/сети ловит малопонятную ошибку прямо на SSH-уровне
    // ("RTNETLINK answers: Address already in use" от ip/wg-quick) вместо явной ошибки
    // здесь, ДО того как что-либо тронули на сервере (поймано вживую: форма установки
    // протокола на сервере подставляет одинаковые порт/сеть по умолчанию для любого
    // протокола, легко не заметить при добавлении второго протокола на тот же сервер).
    // Смотрим только ACTIVE/INSTALLING других протоколов — ERROR уже откатил себя при
    // неудачной установке (см. driver.install) и ничего реально не занимает на сервере.
    const others = await this.serverProtocolsRepository.find({
      where: { serverId, protocol: Not(protocol), status: In([ServerProtocolStatus.ACTIVE, ServerProtocolStatus.INSTALLING]) },
    });
    const portConflict = others.find((sp) => sp.listenPort === listenPort);
    if (portConflict) {
      throw new BadRequestException(`Порт ${listenPort} на этом сервере уже занят протоколом ${portConflict.protocol} — выберите другой порт`);
    }
    const cidrConflict = others.find((sp) => sp.networkCidr === networkCidr);
    if (cidrConflict) {
      throw new BadRequestException(
        `Сеть ${networkCidr} на этом сервере уже используется протоколом ${cidrConflict.protocol} — выберите другую сеть клиентов`,
      );
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

  // Общая для ВСЕХ мостов на self-сервере метка и правило маршрутизации — работает сразу
  // для любого числа мостов: КАКОЙ трафик получает метку решает ipset+mangle-правило
  // каждого конкретного моста (см. ниже), а куда её направить — одно общее правило.
  private static readonly BYPASS_FWMARK = '0x2a';
  private static readonly BYPASS_RULE_PRIORITY = 90;

  // Список обхода upstream моста (Bridge.bypassDestinations, задаётся в настройках моста) —
  // трафик клиентов моста к этим доменам/IP должен идти НАПРЯМУЮ с self-сервера, минуя
  // upstream ("зарубежный" сервер). Приоритет 100 у "весь трафик клиента -> routeTable"
  // (см. setupBridgeNat выше) — здесь используется МЕНЬШИЙ priority (90, выше по
  // приоритету для `ip rule`), поэтому совпавшие с ipset пакеты уходят через main ДО того,
  // как дошли бы до правила на routeTable.
  //
  // Механизм: iptables mangle помечает пакет (MARK) при совпадении dst с ipset моста ->
  // `ip rule fwmark ... lookup main` направляет помеченные пакеты в main вместо routeTable
  // -> отдельный MASQUERADE и FORWARD ACCEPT для этого пути (приватный IP клиента иначе не
  // смог бы выйти в интернет напрямую и/или был бы отброшен в FORWARD). Обратное
  // направление (ответы) не помечено (mark не переживает новый проход через PREROUTING у
  // ответных пакетов) — пропускается по ESTABLISHED,RELATED, а не по метке.
  //
  // destinations — уже финальный плоский список (IP/CIDR как есть + ещё НЕ резолвленные
  // домены, см. BridgesService.syncBypassRules/refreshBypassRules) — резолвинг доменов
  // делает сама эта функция, одним SSH-сеансом вместе с остальной настройкой.
  async setupBridgeBypass(
    selfServer: Server,
    bridgeId: string,
    clientInterfaces: Array<{ networkCidr: string; interfaceName: string }>,
    destinations: string[],
  ): Promise<void> {
    const connection = this.connectionParams(selfServer);
    // ipset ограничивает длину имени (IPSET_MAXLEN=32) — префикс + 16 hex-символов id с
    // запасом укладывается.
    const ipsetName = `vpnmgr-byp-${bridgeId.replace(/-/g, '').slice(0, 16)}`;
    const tmpSetName = `${ipsetName}-tmp`;
    const fwmark = VpnProvisioningService.BYPASS_FWMARK;

    await this.sshService.withConnection(connection, async (ssh) => {
      // ipset не всегда стоит из коробки (в отличие от iptables/ip) — доустанавливаем при
      // необходимости, идемпотентно.
      await this.sshService.execOrThrow(ssh, `which ipset >/dev/null 2>&1 || (apt-get update -y && apt-get install -y ipset)`);

      const ips: string[] = [];
      const domains: string[] = [];
      for (const destination of destinations) {
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(destination)) {
          ips.push(destination);
        } else {
          domains.push(destination);
        }
      }
      if (domains.length > 0) {
        // Один SSH-запрос на все домены сразу — резолвим тем же резолвером, что видит и
        // сам self-сервер (getent ahostsv4 отдаёт ВСЕ A-записи, не только первую — важно
        // для доменов за CDN с несколькими IP).
        const script = domains.map((domain) => `getent ahostsv4 ${domain} 2>/dev/null | awk '{print $1}'`).join('; ');
        const result = await this.sshService.exec(ssh, script);
        const resolved = result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(line));
        ips.push(...new Set(resolved.map((ip) => `${ip}/32`)));
      }

      // create -exist — идемпотентно (не падает, если ipset уже существует). swap вместо
      // flush+add — атомарная замена содержимого, без "окна", когда набор пуст между
      // пересчётами (домен временно не резолвится и т.п.).
      await this.sshService.execOrThrow(ssh, `ipset create ${ipsetName} hash:net -exist`);
      await this.sshService.execOrThrow(ssh, `ipset create ${tmpSetName} hash:net -exist`);
      await this.sshService.execOrThrow(ssh, `ipset flush ${tmpSetName}`);
      for (const ip of ips) {
        await this.sshService.execOrThrow(ssh, `ipset add ${tmpSetName} ${ip} -exist`);
      }
      await this.sshService.execOrThrow(ssh, `ipset swap ${tmpSetName} ${ipsetName}`);
      await this.sshService.execOrThrow(ssh, `ipset destroy ${tmpSetName}`);

      // Общее для ВСЕХ мостов на этом self-сервере правило — идемпотентно, безопасно
      // вызывать из каждого моста по отдельности.
      await this.sshService.execOrThrow(
        ssh,
        `ip rule show | grep -q "fwmark ${fwmark} lookup main" || ` +
          `ip rule add fwmark ${fwmark} lookup main priority ${VpnProvisioningService.BYPASS_RULE_PRIORITY}`,
      );

      for (const { networkCidr, interfaceName } of clientInterfaces) {
        await this.sshService.execOrThrow(
          ssh,
          `iptables -t mangle -C PREROUTING -s ${networkCidr} -m set --match-set ${ipsetName} dst -j MARK --set-mark ${fwmark} 2>/dev/null || ` +
            `iptables -t mangle -A PREROUTING -s ${networkCidr} -m set --match-set ${ipsetName} dst -j MARK --set-mark ${fwmark}`,
        );
        await this.sshService.execOrThrow(
          ssh,
          `iptables -C FORWARD -i ${interfaceName} -m mark --mark ${fwmark} -j ACCEPT 2>/dev/null || ` +
            `iptables -A FORWARD -i ${interfaceName} -m mark --mark ${fwmark} -j ACCEPT`,
        );
        // Ответные пакеты приходят новым проходом через PREROUTING без метки (mark не
        // переживает границу соединения) — пропускаем их по ESTABLISHED,RELATED, а не по
        // fwmark, иначе исходящая часть работала бы, а ответы обрубались бы в FORWARD.
        await this.sshService.execOrThrow(
          ssh,
          `iptables -C FORWARD -o ${interfaceName} -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || ` +
            `iptables -A FORWARD -o ${interfaceName} -m state --state ESTABLISHED,RELATED -j ACCEPT`,
        );
        // Трафик в обход upstream всё равно исходит из приватной подсети клиентов моста —
        // без MASQUERADE именно для этого пути (в дополнение к upstream-специфичному из
        // setupBridgeNat) пакеты уходили бы с нероутящимся приватным source.
        await this.sshService.execOrThrow(
          ssh,
          `iptables -t nat -C POSTROUTING -s ${networkCidr} -m mark --mark ${fwmark} -j MASQUERADE 2>/dev/null || ` +
            `iptables -t nat -A POSTROUTING -s ${networkCidr} -m mark --mark ${fwmark} -j MASQUERADE`,
        );
      }
    });
  }
}
