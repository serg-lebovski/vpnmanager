import { randomBytes } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { NodeSSH } from 'node-ssh';
import { VpnProtocol } from '../common/enums';
import { SshService } from '../ssh/ssh.service';
import {
  DetectedInstallation,
  InstallOptions,
  InstallResult,
  KernelModuleStatus,
  PeerSpec,
  PeerTransferStats,
  ScannedPeer,
  UpstreamPeerConfig,
  VpnDriver,
  VpnDriverContext,
} from './vpn-driver.interface';
import {
  bridgeSocksPort,
  bridgeTunAddress,
  DEFAULT_REALITY_SNI,
  extractXrayClients,
  HEV_BINARY,
  HEV_SOCKS5_TUNNEL_VERSION,
  parseVlessServerParams,
  parseX25519Output,
  parseXrayUserStats,
  REALITY_FINGERPRINT,
  renderSystemdUnit,
  renderTunConfig,
  renderXrayClientConfig,
  renderXrayServerConfig,
  tunConfigPath,
  tunUnitName,
  VLESS_FLOW,
  XRAY_BINARY,
  XRAY_CONF_DIR,
  XRAY_INBOUND_TAG,
  XRAY_VERSION,
  xrayClientConfigPath,
  xrayClientUnitName,
  xrayConfigWithoutClients,
  xrayServerConfigPath,
  xrayServerUnitName,
} from './xray-config.util';

const SYSTEMD_DIR = '/etc/systemd/system';

/**
 * VLESS + XTLS-Reality поверх TCP на Xray-core. В отличие от WG/AWG это не L3-туннель, а
 * прокси: у клиента нет своего IP в туннеле, он определяется UUID (Peer.privateKeyEnc), а
 * Peer.publicKey — просто идентификатор пользователя Xray ("email"), по которому Xray ведёт
 * статистику трафика. Xray и его конфиг ставятся в /usr/local/bin и /etc/vpnmanager/xray,
 * каждый экземпляр — отдельный systemd-юнит (на одном сервере их может быть несколько:
 * клиентский протокол моста + upstream-клиенты мостов).
 *
 * В роли КЛИЕНТА (upstream моста) Xray сам по себе не даёт сетевого интерфейса, а вся
 * маршрутизация моста завязана на интерфейс upstream (routeTable, NAT, метки Telegram/
 * MTProxy) — поэтому рядом поднимается hev-socks5-tunnel: TUN с именем upstream-интерфейса
 * моста, заворачивающий всё в локальный SOCKS Xray-клиента.
 */
@Injectable()
export class XrayDriver implements VpnDriver {
  readonly protocol = VpnProtocol.VLESS;
  private readonly logger = new Logger(XrayDriver.name);

  // "Последний раз в сети" для VLESS: рукопожатия как у WireGuard нет — считаем, что клиент
  // был на связи, когда его счётчик трафика вырос с прошлого опроса. Ключ — id протокола +
  // email; первое наблюдение после старта backend только запоминает базу (иначе каждый
  // перезапуск объявлял бы всех "только что в сети").
  private readonly lastTraffic = new Map<string, { total: number; seenAt: number }>();

  constructor(private readonly sshService: SshService) {}

  async install(ctx: VpnDriverContext, options: InstallOptions): Promise<InstallResult> {
    await this.ensureXrayInstalled(ctx.ssh);
    const interfaceName = options.interfaceName || `xray-${options.listenPort}`;
    const unit = xrayServerUnitName(interfaceName);

    // Переустановка (протокол ранее упал) — сначала гасим свой же старый экземпляр, иначе
    // он сам и держал бы порт, который мы проверяем ниже.
    await this.sshService.exec(ctx.ssh, `systemctl stop ${unit} >/dev/null 2>&1 || true`);
    if (await this.isTcpPortBusy(ctx.ssh, options.listenPort)) {
      const owner = await this.sshService.exec(ctx.ssh, `ss -Hltnp "sport = :${options.listenPort}" | head -3`);
      throw new Error(
        `TCP-порт ${options.listenPort} на сервере уже занят другим процессом (${owner.stdout.trim() || 'неизвестно'}). ` +
          'Выберите другой порт для VLESS (на сервере панели 443 обычно занят nginx — используйте, например, 8443).',
      );
    }

    const apiPort = await this.pickFreeApiPort(ctx.ssh, options.listenPort);
    const isXhttp = options.vlessTransport === 'xhttp';
    let privateKey = '';
    let serverPublicKey = '';
    let params: Record<string, string | number>;
    if (isXhttp) {
      if (!options.xhttpDomain) {
        throw new Error('Для VLESS XHTTP нужен домен панели с включённым HTTPS (Настройки → «Домен и HTTPS»)');
      }
      // Xray слушает адрес docker-шлюза сети, в которой живёт nginx панели: nginx-контейнер
      // до него достаёт, а снаружи этот адрес не маршрутизируется (в отличие от 0.0.0.0).
      const gateway = await this.sshService.exec(
        ctx.ssh,
        `docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}' $(docker ps -q -f label=com.docker.compose.service=nginx | head -1) 2>/dev/null | awk '{print $1}'`,
      );
      const listenAddress = gateway.stdout.trim();
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(listenAddress)) {
        throw new Error('VLESS XHTTP ставится только на сервер панели: не найден docker-контейнер nginx панели');
      }
      params = {
        transport: 'xhttp',
        path: `/${randomBytes(9).toString('hex')}`,
        domain: options.xhttpDomain,
        publicPort: 443,
        listenAddress,
        fingerprint: REALITY_FINGERPRINT,
        flow: '',
        apiPort,
      };
    } else {
      const keys = parseX25519Output(await this.sshService.execOrThrow(ctx.ssh, `${XRAY_BINARY} x25519`));
      privateKey = keys.privateKey;
      serverPublicKey = keys.publicKey;
      params = {
        transport: 'reality',
        sni: options.realitySni || DEFAULT_REALITY_SNI,
        shortId: randomBytes(4).toString('hex'),
        fingerprint: REALITY_FINGERPRINT,
        flow: VLESS_FLOW,
        apiPort,
      };
    }
    const config = renderXrayServerConfig({
      listenPort: options.listenPort,
      apiPort,
      privateKey,
      params: parseVlessServerParams(params),
      clients: [],
      routing: ctx.serverProtocol.xrayRouting,
    });
    await this.writeFile(ctx.ssh, xrayServerConfigPath(interfaceName), JSON.stringify(config, null, 2), '600');
    await this.writeFile(
      ctx.ssh,
      `${SYSTEMD_DIR}/${unit}.service`,
      renderSystemdUnit({
        description: `VPN Manager: VLESS ${isXhttp ? 'XHTTP' : 'Reality'} (${interfaceName})`,
        execStart: `${XRAY_BINARY} run -config ${xrayServerConfigPath(interfaceName)}`,
      }),
      '644',
    );
    await this.sshService.execOrThrow(ctx.ssh, `systemctl daemon-reload && systemctl enable ${unit} >/dev/null 2>&1 && systemctl restart ${unit}`);
    await this.assertUnitActive(ctx.ssh, unit);

    // См. комментарий в BaseWireGuardLikeDriver.install про ufw с политикой DROP. Для xhttp
    // порт открываем ТОЛЬКО для docker-сетей (nginx панели), наружу он не нужен.
    await this.sshService.exec(ctx.ssh, this.firewallCommand('allow', options.listenPort, isXhttp));

    return { interfaceName, serverPublicKey, obfuscationParams: params };
  }

  async checkKernelModuleStatus(): Promise<KernelModuleStatus> {
    // Xray — обычный userspace-процесс, модуль ядра ему не нужен (TUN клиента моста есть в
    // любом стандартном ядре).
    return { ready: true };
  }

  async scanExistingPeers(ctx: VpnDriverContext): Promise<ScannedPeer[]> {
    const config = await this.readServerConfig(ctx);
    return extractXrayClients(config).map((client) => ({ publicKey: client.email, allowedIp: '' }));
  }

  async applyPeers(ctx: VpnDriverContext, peers: PeerSpec[]): Promise<void> {
    const interfaceName = ctx.serverProtocol.interfaceName;
    const unit = xrayServerUnitName(interfaceName);
    const params = parseVlessServerParams(ctx.serverProtocol.obfuscationParams);
    const current = await this.readServerConfig(ctx);
    if (!current) {
      throw new Error(`На сервере не найден конфиг Xray ${xrayServerConfigPath(interfaceName)} — переустановите VLESS`);
    }
    // Приватный ключ Reality живёт только в конфиге на сервере; у xhttp ключа нет (TLS — у nginx).
    let privateKey = '';
    if (params.transport === 'reality') {
      privateKey = (current as any)?.inbounds?.find((inbound: any) => inbound?.tag === XRAY_INBOUND_TAG)?.streamSettings?.realitySettings
        ?.privateKey;
      if (typeof privateKey !== 'string' || !privateKey) {
        throw new Error(`В конфиге Xray ${xrayServerConfigPath(interfaceName)} нет ключа Reality — переустановите VLESS`);
      }
    }

    const clients = peers
      .filter((peer): peer is PeerSpec & { vlessUuid: string } => Boolean(peer.vlessUuid))
      .map((peer) => ({ uuid: peer.vlessUuid, email: peer.publicKey }));
    const next = renderXrayServerConfig({
      listenPort: ctx.serverProtocol.listenPort,
      apiPort: params.apiPort,
      privateKey,
      params,
      clients,
      routing: ctx.serverProtocol.xrayRouting,
    });

    const sameBase = xrayConfigWithoutClients(current) === xrayConfigWithoutClients(next);
    const before = new Map(extractXrayClients(current).map((client) => [client.email, client.uuid]));
    const toRemove = [...before.keys()].filter((email) => !clients.some((client) => client.email === email && client.uuid === before.get(email)));
    const toAdd = clients.filter((client) => before.get(client.email) !== client.uuid);

    await this.writeFile(ctx.ssh, xrayServerConfigPath(interfaceName), JSON.stringify(next, null, 2), '600');

    const active = (await this.sshService.exec(ctx.ssh, `systemctl is-active ${unit}`)).stdout.trim() === 'active';
    if (!sameBase || !active) {
      await this.sshService.execOrThrow(ctx.ssh, `systemctl restart ${unit}`);
      await this.assertUnitActive(ctx.ssh, unit);
      return;
    }
    if (toRemove.length === 0 && toAdd.length === 0) {
      return;
    }
    // Пользователи меняются на лету через API Xray — без перезапуска, т.е. без обрыва уже
    // подключённых клиентов на каждое создание/отзыв peer'а. Файл конфига выше уже записан —
    // если API почему-то не сработал, просто перезапускаем Xray с ним.
    try {
      const server = `--server=127.0.0.1:${params.apiPort}`;
      if (toRemove.length > 0) {
        const output = await this.sshService.execOrThrow(
          ctx.ssh,
          `${XRAY_BINARY} api rmu ${server} -tag=${XRAY_INBOUND_TAG} ${toRemove.map((e) => `'${e}'`).join(' ')} 2>&1`,
        );
        // Как и adu, возвращает 0 даже при неудаче — сверяем число по выводу (иначе
        // отозванный peer продолжал бы подключаться до ближайшего перезапуска Xray).
        const removed = Number(/Removed (\d+) user/.exec(output)?.[1] ?? NaN);
        if (removed !== toRemove.length) {
          throw new Error(`xray api rmu удалил ${Number.isNaN(removed) ? '?' : removed} из ${toRemove.length}: ${output}`);
        }
      }
      if (toAdd.length > 0) {
        const addPath = `${XRAY_CONF_DIR}/.adu-${interfaceName}.json`;
        // listen/port обязательны: adu собирает из файла полноценный инбаунд и без порта
        // падает ("Listen on AnyIP but no Port(s) set"), при этом возвращая код 0 и печатая
        // "Added 0 user(s)" — пойманный вживую случай: peer создавался, а Xray его не знал
        // ("invalid request user id"). Поэтому проверяем и число добавленных по выводу.
        const addConfig = {
          inbounds: [
            {
              tag: XRAY_INBOUND_TAG,
              listen: '0.0.0.0',
              port: ctx.serverProtocol.listenPort,
              protocol: 'vless',
              settings: {
                clients: toAdd.map((client) =>
                  params.flow ? { id: client.uuid, email: client.email, flow: params.flow } : { id: client.uuid, email: client.email },
                ),
                decryption: 'none',
              },
            },
          ],
        };
        await this.writeFile(ctx.ssh, addPath, JSON.stringify(addConfig), '600');
        const output = await this.sshService.execOrThrow(ctx.ssh, `${XRAY_BINARY} api adu ${server} ${addPath} 2>&1; rc=$?; rm -f ${addPath}; exit $rc`);
        const added = Number(/Added (\d+) user/.exec(output)?.[1] ?? NaN);
        if (added !== toAdd.length) {
          throw new Error(`xray api adu добавил ${Number.isNaN(added) ? '?' : added} из ${toAdd.length}: ${output}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Горячее обновление пользователей Xray (${interfaceName}) не удалось, перезапуск: ${(error as Error).message}`);
      await this.sshService.execOrThrow(ctx.ssh, `systemctl restart ${unit}`);
      await this.assertUnitActive(ctx.ssh, unit);
    }
  }

  async getActivePeerCount(ctx: VpnDriverContext): Promise<number> {
    return (await this.scanExistingPeers(ctx)).length;
  }

  async getTransferStats(ctx: VpnDriverContext): Promise<Map<string, PeerTransferStats>> {
    const stats = new Map<string, PeerTransferStats>();
    let apiPort: number;
    try {
      apiPort = parseVlessServerParams(ctx.serverProtocol.obfuscationParams).apiPort;
    } catch {
      return stats;
    }
    const result = await this.sshService.exec(ctx.ssh, `${XRAY_BINARY} api statsquery --server=127.0.0.1:${apiPort} -pattern 'user>>>'`);
    if (result.code !== 0) {
      return stats;
    }
    const now = Math.floor(Date.now() / 1000);
    for (const [email, traffic] of parseXrayUserStats(result.stdout)) {
      const total = traffic.uplink + traffic.downlink;
      const key = `${ctx.serverProtocol.id}:${email}`;
      const previous = this.lastTraffic.get(key);
      let seenAt = previous?.seenAt ?? 0;
      if (previous && total > previous.total) {
        seenAt = now;
      }
      this.lastTraffic.set(key, { total, seenAt });
      // rx/tx — с точки зрения сервера, как у `wg show dump`: rx — получено ОТ клиента.
      stats.set(email, { rxBytes: traffic.uplink, txBytes: traffic.downlink, latestHandshake: seenAt, endpoint: null });
    }
    return stats;
  }

  async detectExisting(): Promise<DetectedInstallation | null> {
    // Импорт чужих (не нашей панелью поставленных) установок Xray не поддерживается.
    return null;
  }

  async connectAsClient(ssh: NodeSSH, interfaceName: string, config: UpstreamPeerConfig, routeTable: number): Promise<void> {
    await this.ensureClientToolsInstalled(ssh);
    const params = parseVlessServerParams(config.obfuscationParams);
    if (params.transport !== 'reality') {
      throw new Error('Upstream моста через VLESS XHTTP пока не поддерживается — выберите сервер с VLESS Reality или AmneziaWG');
    }
    const socksPort = bridgeSocksPort(routeTable);
    const xrayUnit = xrayClientUnitName(interfaceName);
    const tunUnit = tunUnitName(interfaceName);

    // Имя upstream-интерфейса моста переиспользуется при смене upstream между протоколами —
    // снимаем всё, что могло под ним жить (наш прошлый TUN или WG/AWG-интерфейс).
    await this.stopClientUnits(ssh, interfaceName);
    await this.sshService.exec(ssh, `ip link delete ${interfaceName} >/dev/null 2>&1 || true`);

    const clientConfig = renderXrayClientConfig({
      socksPort,
      host: config.endpointHost,
      port: config.endpointPort,
      uuid: config.privateKey,
      publicKey: config.serverPublicKey,
      params,
    });
    await this.writeFile(ssh, xrayClientConfigPath(interfaceName), JSON.stringify(clientConfig, null, 2), '600');
    await this.writeFile(
      ssh,
      tunConfigPath(interfaceName),
      renderTunConfig({ interfaceName, socksPort, tunAddress: bridgeTunAddress(routeTable) }),
      '600',
    );
    await this.writeFile(
      ssh,
      `${SYSTEMD_DIR}/${xrayUnit}.service`,
      renderSystemdUnit({
        description: `VPN Manager: VLESS upstream client (${interfaceName})`,
        execStart: `${XRAY_BINARY} run -config ${xrayClientConfigPath(interfaceName)}`,
      }),
      '644',
    );
    // Маршрут по умолчанию в таблице моста привязан к самому netdev и исчезает вместе с
    // ним — ExecStartPost восстанавливает его при каждом старте TUN (в т.ч. после
    // перезагрузки self-сервера, где WG/AWG-upstream сам себя не восстанавливает).
    await this.writeFile(
      ssh,
      `${SYSTEMD_DIR}/${tunUnit}.service`,
      renderSystemdUnit({
        description: `VPN Manager: TUN ${interfaceName} -> VLESS upstream`,
        execStart: `${HEV_BINARY} ${tunConfigPath(interfaceName)}`,
        execStartPost: `/bin/sh -c 'for i in $(seq 1 50); do ip link show ${interfaceName} >/dev/null 2>&1 && break; sleep 0.2; done; ip route replace default dev ${interfaceName} table ${routeTable}'`,
        after: `${xrayUnit}.service`,
        bindsTo: `${xrayUnit}.service`,
      }),
      '644',
    );
    await this.sshService.execOrThrow(
      ssh,
      `systemctl daemon-reload && systemctl enable ${xrayUnit} ${tunUnit} >/dev/null 2>&1 && systemctl restart ${xrayUnit} && systemctl restart ${tunUnit}`,
    );
    await this.assertUnitActive(ssh, xrayUnit);
    await this.assertUnitActive(ssh, tunUnit);
    await this.sshService.execOrThrow(
      ssh,
      `for i in $(seq 1 50); do ip link show ${interfaceName} >/dev/null 2>&1 && break; sleep 0.2; done; ip link show ${interfaceName} >/dev/null`,
    );
    await this.sshService.execOrThrow(ssh, `ip route replace default dev ${interfaceName} table ${routeTable}`);
  }

  async disconnectAsClient(ssh: NodeSSH, interfaceName: string): Promise<void> {
    await this.stopClientUnits(ssh, interfaceName);
    await this.sshService.exec(
      ssh,
      `rm -f ${SYSTEMD_DIR}/${xrayClientUnitName(interfaceName)}.service ${SYSTEMD_DIR}/${tunUnitName(interfaceName)}.service ` +
        `${xrayClientConfigPath(interfaceName)} ${tunConfigPath(interfaceName)}; systemctl daemon-reload`,
    );
    await this.sshService.exec(ssh, `ip link delete ${interfaceName} >/dev/null 2>&1 || true`);
  }

  async ensureClientToolsInstalled(ssh: NodeSSH): Promise<void> {
    await this.ensureXrayInstalled(ssh);
    await this.ensureHevInstalled(ssh);
  }

  async getInstalledVersion(ctx: VpnDriverContext): Promise<string | null> {
    return this.readXrayVersion(ctx.ssh);
  }

  async updatePackage(ctx: VpnDriverContext): Promise<string | null> {
    await this.ensureXrayInstalled(ctx.ssh, true);
    await this.sshService.exec(ctx.ssh, `systemctl restart ${xrayServerUnitName(ctx.serverProtocol.interfaceName)}`);
    return this.readXrayVersion(ctx.ssh);
  }

  async uninstall(ctx: VpnDriverContext): Promise<void> {
    const interfaceName = ctx.serverProtocol.interfaceName;
    const unit = xrayServerUnitName(interfaceName);
    await this.sshService.exec(
      ctx.ssh,
      `systemctl disable --now ${unit} >/dev/null 2>&1; rm -f ${SYSTEMD_DIR}/${unit}.service ${xrayServerConfigPath(interfaceName)}; systemctl daemon-reload`,
    );
    let isXhttp = false;
    try {
      isXhttp = parseVlessServerParams(ctx.serverProtocol.obfuscationParams).transport === 'xhttp';
    } catch {
      // параметры битые — правило файрвола всё равно попробуем снять в обоих вариантах ниже
    }
    await this.sshService.exec(ctx.ssh, this.firewallCommand('delete', ctx.serverProtocol.listenPort, isXhttp));
  }

  // ufw-правило для порта Xray: reality — открыть всем; xhttp — только docker-сетям (к Xray
  // ходит лишь nginx панели из своего контейнера). No-op, если ufw нет или он выключен.
  private firewallCommand(action: 'allow' | 'delete', port: number, xhttp: boolean): string {
    const rule = xhttp ? `from 172.16.0.0/12 to any port ${port} proto tcp` : `${port}/tcp`;
    const verb = action === 'allow' ? 'allow' : 'delete allow';
    return `command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active" && ufw ${verb} ${rule} >/dev/null 2>&1; true`;
  }

  private async stopClientUnits(ssh: NodeSSH, interfaceName: string): Promise<void> {
    await this.sshService.exec(
      ssh,
      `systemctl disable --now ${tunUnitName(interfaceName)} ${xrayClientUnitName(interfaceName)} >/dev/null 2>&1; ` +
        `systemctl reset-failed ${tunUnitName(interfaceName)} ${xrayClientUnitName(interfaceName)} >/dev/null 2>&1; true`,
    );
  }

  private async readServerConfig(ctx: VpnDriverContext): Promise<unknown> {
    const result = await this.sshService.exec(ctx.ssh, `cat ${xrayServerConfigPath(ctx.serverProtocol.interfaceName)}`);
    if (result.code !== 0) {
      return null;
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      return null;
    }
  }

  private async writeFile(ssh: NodeSSH, path: string, content: string, mode: string): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf('/'));
    await this.sshService.execOrThrowWithStdin(ssh, `mkdir -p ${dir} && umask 077 && cat > ${path}.new && chmod ${mode} ${path}.new && mv -f ${path}.new ${path}`, content);
  }

  private async isTcpPortBusy(ssh: NodeSSH, port: number): Promise<boolean> {
    const result = await this.sshService.exec(ssh, `ss -Hltn "sport = :${port}"`);
    return result.stdout.trim().length > 0;
  }

  // Порт API Xray (только 127.0.0.1) — свой на каждый экземпляр; подбираем свободный рядом
  // с детерминированной стартовой точкой.
  private async pickFreeApiPort(ssh: NodeSSH, listenPort: number): Promise<number> {
    for (let port = 10085 + (listenPort % 500); port < 11000; port++) {
      if (!(await this.isTcpPortBusy(ssh, port))) {
        return port;
      }
    }
    throw new Error('Не удалось подобрать свободный локальный порт для API Xray');
  }

  private async assertUnitActive(ssh: NodeSSH, unit: string): Promise<void> {
    const state = await this.sshService.exec(ssh, `sleep 1; systemctl is-active ${unit}`);
    if (state.stdout.trim() !== 'active') {
      const journal = await this.sshService.exec(ssh, `journalctl -u ${unit} -n 15 --no-pager -o cat`);
      throw new Error(`Служба ${unit} не запустилась (${state.stdout.trim() || 'unknown'}):\n${journal.stdout.trim()}`);
    }
  }

  private async readXrayVersion(ssh: NodeSSH): Promise<string | null> {
    const result = await this.sshService.exec(ssh, `${XRAY_BINARY} version 2>/dev/null | head -1`);
    const match = /Xray\s+(\S+)/.exec(result.stdout);
    return result.code === 0 && match ? `Xray ${match[1]}` : null;
  }

  // Бинарник из официального релиза Xray-core с проверкой sha256 из .dgst того же релиза —
  // без сторонних install-скриптов, версия зафиксирована (XRAY_VERSION).
  private async ensureXrayInstalled(ssh: NodeSSH, force = false): Promise<void> {
    if (!force && (await this.readXrayVersion(ssh)) === `Xray ${XRAY_VERSION}`) {
      return;
    }
    const base = `https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}`;
    const script = [
      'set -e',
      'case "$(uname -m)" in x86_64) A=64;; aarch64|arm64) A=arm64-v8a;; *) echo "Архитектура $(uname -m) не поддерживается" >&2; exit 1;; esac',
      'command -v unzip >/dev/null 2>&1 || (export DEBIAN_FRONTEND=noninteractive; apt-get update -y >/dev/null && apt-get install -y unzip >/dev/null)',
      'T=$(mktemp -d)',
      `curl -fsSL --retry 3 --connect-timeout 20 -o $T/xray.zip ${base}/Xray-linux-$A.zip`,
      `curl -fsSL --retry 3 --connect-timeout 20 -o $T/xray.dgst ${base}/Xray-linux-$A.zip.dgst`,
      `EXP=$(grep -i '^SHA2-256' $T/xray.dgst | head -1 | sed 's/.*= *//')`,
      'ACT=$(sha256sum $T/xray.zip | cut -d" " -f1)',
      '[ -n "$EXP" ] && [ "$EXP" = "$ACT" ] || { echo "Контрольная сумма архива Xray не совпала" >&2; rm -rf $T; exit 1; }',
      'unzip -o -q $T/xray.zip -d $T/x',
      `install -m 755 $T/x/xray ${XRAY_BINARY}`,
      'mkdir -p /usr/local/share/xray && cp -f $T/x/*.dat /usr/local/share/xray/ 2>/dev/null || true',
      'rm -rf $T',
    ].join('\n');
    await this.sshService.execOrThrowWithStdin(ssh, 'bash -s', script);
  }

  private async ensureHevInstalled(ssh: NodeSSH): Promise<void> {
    const marker = `${XRAY_CONF_DIR}/.hev-version`;
    const current = await this.sshService.exec(ssh, `test -x ${HEV_BINARY} && cat ${marker} 2>/dev/null`);
    if (current.code === 0 && current.stdout.trim() === HEV_SOCKS5_TUNNEL_VERSION) {
      return;
    }
    const base = `https://github.com/heiher/hev-socks5-tunnel/releases/download/${HEV_SOCKS5_TUNNEL_VERSION}`;
    const script = [
      'set -e',
      'case "$(uname -m)" in x86_64) A=x86_64;; aarch64|arm64) A=arm64;; *) echo "Архитектура $(uname -m) не поддерживается" >&2; exit 1;; esac',
      'T=$(mktemp)',
      `curl -fsSL --retry 3 --connect-timeout 20 -o $T ${base}/hev-socks5-tunnel-linux-$A`,
      `install -m 755 $T ${HEV_BINARY}`,
      'rm -f $T',
      `mkdir -p ${XRAY_CONF_DIR} && echo ${HEV_SOCKS5_TUNNEL_VERSION} > ${marker}`,
    ].join('\n');
    await this.sshService.execOrThrowWithStdin(ssh, 'bash -s', script);
  }
}
