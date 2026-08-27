import { randomInt } from 'crypto';
import { NodeSSH } from 'node-ssh';
import { SshService } from '../ssh/ssh.service';
import { gatewayAddress } from './network.util';
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

interface ParsedPeerBlock {
  name?: string;
  publicKey: string;
  allowedIp: string;
  presharedKey?: string;
}

// Официальный self-hosted сервер AmneziaVPN разворачивает протоколы как Docker-контейнеры
// (например, `amnezia-awg2` для AmneziaWG) с конфигом внутри контейнера — не на хосте.
// Здесь ищем такие контейнеры по имени, если на хосте по стандартным путям ничего не нашли.
const AMNEZIA_CONTAINER_CONF_SEARCH = `find /opt/amnezia -maxdepth 2 -iname '*.conf' 2>/dev/null`;

/**
 * Общая логика для протоколов, совместимых по формату с WireGuard (сам WireGuard и AmneziaWG).
 * Отличаются только бинарники/пути установки и наличием параметров обфускации.
 */
export abstract class BaseWireGuardLikeDriver implements VpnDriver {
  protected constructor(protected readonly sshService: SshService) {}

  abstract readonly protocol: VpnDriver['protocol'];
  protected abstract readonly binary: string;
  protected abstract readonly quickBinary: string;
  protected abstract readonly confDir: string;
  protected abstract readonly defaultInterfaceName: string;
  // Подстроки имени Docker-контейнера, по которым узнаём "это наш протокол" среди
  // контейнеров официального self-hosted сервера AmneziaVPN (см. AMNEZIA_CONTAINER_CONF_SEARCH).
  protected abstract readonly containerNameHints: string[];
  // apt-пакеты протокола — используется и при первой установке (ensureClientToolsInstalled
  // в подклассах), и при обновлении (updatePackage ниже), чтобы не дублировать список имён
  // пакетов в двух местах.
  protected abstract readonly aptPackages: string;

  abstract ensureClientToolsInstalled(ssh: NodeSSH): Promise<void>;
  protected abstract buildObfuscationParams(): Record<string, number | string> | undefined;
  protected abstract parseObfuscationParamsFromConfig(configText: string): Record<string, number | string> | undefined;

  // Если протокол работает внутри Docker-контейнера, все команды на сервере нужно
  // выполнять через `docker exec`, а не напрямую — оборачиваем команду соответствующим
  // образом. Команда прогоняется через base64, чтобы не думать о вложенном экранировании
  // кавычек (base64-алфавит не содержит символов, которые сломали бы внешние кавычки).
  private buildCommand(command: string, execContainer: string | null): string {
    if (!execContainer) {
      return command;
    }
    const encoded = Buffer.from(command, 'utf8').toString('base64');
    return `docker exec ${execContainer} sh -c "echo ${encoded} | base64 -d | sh"`;
  }

  private confPath(confDir: string, interfaceName: string): string {
    return `${confDir}/${interfaceName}.conf`;
  }

  // Имя файлов ключей сервера в confDir. По умолчанию ('server_private.key'/
  // 'server_public.key') — так исторически называются файлы для ЕДИНСТВЕННОГО экземпляра
  // протокола на сервере (подавляющее большинство случаев, включая уже работающие
  // production-серверы — менять это имя для них нельзя, иначе applyPeers перестанет
  // находить существующий приватный ключ). Только когда интерфейс НЕ дефолтный (т.е. это
  // второй+ экземпляр протокола на одном self-сервере — несколько мостов) — используем имя
  // интерфейса как префикс, чтобы разные экземпляры не делили один и тот же файл ключа.
  private keyFilePrefix(interfaceName: string): string {
    return interfaceName === this.defaultInterfaceName ? 'server' : interfaceName;
  }

  // Определяет исходящий интерфейс для правила MASQUERADE. Для execContainer-протоколов
  // выполняется ВНУТРИ контейнера (у него своя сетевая namespace, интерфейсы хоста там не
  // существуют) — иначе получили бы имя интерфейса хоста и подставили его в конфиг,
  // который применяется в другой netns (ровно так испортился конфиг bithosting раньше).
  private async detectEgressInterface(ssh: NodeSSH, execContainer: string | null): Promise<string> {
    const output = await this.sshService.execOrThrow(
      ssh,
      this.buildCommand(
        `ip route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if ($i=="dev") print $(i+1)}' | head -n1`,
        execContainer,
      ),
    );
    return output.trim() || 'eth0';
  }

  // Пойманный вживую инцидент: на части VPS-провайдеров IPv6 "полусломан" — интерфейсу не
  // назначен глобальный адрес и нет default-маршрута (только автоматический link-local),
  // но резолвинг внешних доменов (PPA-зеркала, GPG-keyserver'ы) всё равно возвращает
  // AAAA-записи. apt-get/add-apt-repository пытаются подключиться по IPv6, пакеты уходят
  // в никуда, и команда виснет на много минут вместо быстрой ошибки или fallback на IPv4
  // (сам таймаут в SshService.exec это со временем обрывает, но впустую тратит 8 минут при
  // КАЖДОЙ попытке установки на таком хосте). Проверяем наличие default-маршрута IPv6
  // перед сетевыми операциями; если его нет — отключаем IPv6 на хосте (безопасно: он и
  // так нерабочий), tools дальше резолвят и используют только IPv4.
  protected async ensureIpv4NetworkPreferred(ssh: NodeSSH): Promise<void> {
    await this.sshService.exec(
      ssh,
      'ip -6 route show default | grep -q . || sysctl -w net.ipv6.conf.all.disable_ipv6=1 >/dev/null 2>&1 || true',
    );
  }

  async install(ctx: VpnDriverContext, options: InstallOptions): Promise<InstallResult> {
    await this.ensureClientToolsInstalled(ctx.ssh);

    const interfaceName = options.interfaceName || this.defaultInterfaceName;
    const keyPrefix = this.keyFilePrefix(interfaceName);
    await this.sshService.execOrThrow(ctx.ssh, `mkdir -p ${this.confDir} && chmod 700 ${this.confDir}`);

    await this.sshService.execOrThrow(
      ctx.ssh,
      `cd ${this.confDir} && umask 077 && ${this.binary} genkey | tee ${keyPrefix}_private.key | ${this.binary} pubkey > ${keyPrefix}_public.key`,
    );
    const privateKey = await this.sshService.execOrThrow(ctx.ssh, `cat ${this.confDir}/${keyPrefix}_private.key`);
    const serverPublicKey = await this.sshService.execOrThrow(ctx.ssh, `cat ${this.confDir}/${keyPrefix}_public.key`);

    const obfuscationParams = this.buildObfuscationParams();
    const egressInterface = await this.detectEgressInterface(ctx.ssh, null);
    const interfaceAddress = gatewayAddress(options.networkCidr);
    const configText = this.renderConfig({
      privateKey,
      interfaceAddress,
      listenPort: options.listenPort,
      networkCidr: options.networkCidr,
      interfaceName,
      nat: { egressInterface },
      obfuscationParams,
      mtu: options.mtu,
      peers: [],
    });
    await this.sshService.execOrThrow(
      ctx.ssh,
      `echo ${Buffer.from(configText, 'utf8').toString('base64')} | base64 -d > ${this.confPath(this.confDir, interfaceName)} && chmod 600 ${this.confPath(this.confDir, interfaceName)}`,
    );

    await this.sshService.execOrThrow(
      ctx.ssh,
      `sysctl -w net.ipv4.ip_forward=1 && (grep -q net.ipv4.ip_forward /etc/sysctl.d/99-vpnmanager.conf 2>/dev/null || echo net.ipv4.ip_forward=1 >> /etc/sysctl.d/99-vpnmanager.conf)`,
    );
    // Включаем юнит для автозапуска при перезагрузке (просто создаёт symlink, процессов не
    // запускает), а поднимаем интерфейс прямо сейчас отдельной командой напрямую через
    // wg-quick/awg-quick, а не `systemctl ... --now`. На части хостов (замечено на нашем
    // self-хосте для режима моста — вложенный Proxmox LXC + systemd + Docker) запуск именно
    // через systemd почему-то приводит к segfault в самом wg-quick/ip при операциях с
    // WireGuard-интерфейсом, хотя тот же бинарник и та же команда, вызванные напрямую (не
    // через systemd), отрабатывают штатно. Прямой вызов работает везде и для установки не
    // требует systemd, поэтому используем его.
    // Раньше на этом месте администратор узнавал про конфликт только из ошибки ниже и шёл
    // чинить руками по SSH — теперь чиним сами ДО попытки поднять интерфейс (см.
    // reclaimConflictingInterface). Хинт в catch остаётся как подстраховка на случай, если
    // авточистка не сработала (например, ip -d link show не опознал интерфейс как
    // wireguard-совместимый) — тогда всё ещё нужно вмешательство человека.
    await this.reclaimConflictingInterface(ctx.ssh, interfaceAddress, interfaceName);

    await this.sshService.execOrThrow(ctx.ssh, `systemctl enable ${this.quickBinary}@${interfaceName}`);
    try {
      await this.sshService.execOrThrow(ctx.ssh, `${this.quickBinary} up ${this.confPath(this.confDir, interfaceName)}`);
    } catch (error) {
      // "Address already in use" здесь почти всегда значит, что шлюзовой IP этой сети уже
      // занят ДРУГИМ интерфейсом на хосте — например, оставшимся от протокола/моста,
      // который удалили через панель (удаление трогает только БД, сам wg-quick/awg-quick
      // интерфейс на хосте не снимается, см. README про удаление серверов/мостов) и он
      // просто продолжает жить с той же сетью. Обычная ошибка netlink тут малопонятна
      // пользователю без доступа по SSH — добавляем прямую подсказку.
      const message = (error as Error).message;
      if (/address already in use/i.test(message)) {
        const hint =
          `Похоже, сеть ${options.networkCidr} уже занята другим интерфейсом на этом сервере ` +
          `(часто остаётся от ранее удалённого протокола/моста — удаление в панели не трогает сам сетевой ` +
          `интерфейс на сервере). Зайдите по SSH и выполните "ip link show", найдите интерфейс с этим адресом ` +
          `и удалите его ("ip link delete <имя>", а также "systemctl disable --now ${this.quickBinary}@<имя>" ` +
          `если включён автозапуск), либо выберите другую сеть клиентов.`;
        throw new Error(`${message}\n\n${hint}`);
      }
      throw this.withKernelModuleHint(error as Error);
    }

    // Некоторые провайдеры (например ISPmanager) включают ufw с политикой DROP по
    // умолчанию и разрешают только явно перечисленные порты — без открытия порта
    // протокола клиенты не могут даже начать handshake, хотя сам интерфейс/NAT
    // настроены полностью верно (пойманный вживую инцидент: peer навсегда оставался
    // без единого handshake, никакой ошибки при этом нигде не было — ufw молча роняет
    // пакет ДО того, как он доходит до wg/awg). Команда — no-op на хостах без ufw или
    // с неактивным ufw (`|| true` — не валим установку, если ufw отсутствует).
    await this.sshService.exec(
      ctx.ssh,
      `command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active" && ufw allow ${options.listenPort}/udp || true`,
    );

    return { interfaceName, serverPublicKey, obfuscationParams, mtu: options.mtu };
  }

  // "ip link add ... type <protocol>" ("<quickBinary> up" вызывает это внутри себя) падает
  // с "Unknown device type", когда в ядре хоста нет соответствующего netlink-модуля — почти
  // всегда AmneziaWG на нестандартном/кастомном ядре провайдера без собранного DKMS-модуля
  // (см. класс-комментарий AmneziaWgDriver и README "Известные ограничения MVP"), но WireGuard
  // на совсем урезанных ядрах тоже может не иметь встроенного модуля. Общий для install() и
  // connectAsClient() — обе точки делают "up" и могут упереться в один и тот же класс ошибки;
  // `this.protocol` ('wireguard'/'amneziawg') совпадает со строкой link type у обоих квик-скриптов.
  private withKernelModuleHint(error: Error): Error {
    if (!/unknown device type/i.test(error.message)) {
      return error;
    }
    const hint =
      `Ядро этого сервера не поддерживает модуль ${this.protocol} ("ip link add ... type ${this.protocol}" ` +
      `вернул "Unknown device type") — обычно значит, что DKMS-модуль не собрался под текущее ядро ` +
      `(нестандартное/кастомное ядро провайдера, либо не установлены заголовки ядра). Проверьте по SSH: ` +
      `"modprobe ${this.protocol}" (покажет реальную причину), "dkms status" (собрался ли модуль под текущее ` +
      `ядро), "apt-get install -y linux-headers-$(uname -r) && apt-get install --reinstall -y ${this.aptPackages}" ` +
      `(пересобрать модуль под текущее ядро — иногда нужен перезапуск сервера после установки заголовков). ` +
      `Если модуль всё равно не собирается — на этом ядре ${this.protocol} физически недоступен, используйте ` +
      `WireGuard.`;
    return new Error(`${error.message}\n\n${hint}`);
  }

  // См. KernelModuleStatus. `modprobe` — самый дешёвый и надёжный способ спросить у ядра
  // "готов ли модуль прямо сейчас" (в отличие от парсинга `ip link add`, тут не создаётся
  // и не удаляется никакой netdev). Если не готов — `dkms status` может показать, что
  // модуль вообще-то СОБРАН, просто под ДРУГУЮ версию ядра (см. комментарий типа выше) —
  // тогда даём вызывающему коду (VpnProvisioningService.ensureKernelModuleReady) шанс
  // починить это перезагрузкой сервера, вместо того чтобы сразу проваливать install().
  async checkKernelModuleStatus(ssh: NodeSSH): Promise<KernelModuleStatus> {
    const probe = await this.sshService.exec(ssh, `modprobe ${this.protocol}`);
    if (probe.code === 0) {
      return { ready: true };
    }
    const currentKernel = (await this.sshService.exec(ssh, 'uname -r')).stdout.trim();
    const dkmsStatus = await this.sshService.exec(ssh, 'dkms status');
    // Строка вида "amneziawg/1.0.0, 6.8.0-137-generic, x86_64: installed" — берём версию
    // ядра из первой строки протокола со статусом "installed" (сборка под какое-то ядро
    // прошла успешно), не обязательно текущего.
    const pattern = new RegExp(`^${this.protocol}/\\S+,\\s*(\\S+),.*:\\s*installed`, 'm');
    const match = dkmsStatus.stdout.match(pattern);
    const builtForKernel = match?.[1] ?? null;
    if (builtForKernel && builtForKernel !== currentKernel) {
      return { ready: false, rebootKernel: builtForKernel };
    }
    return { ready: false, rebootKernel: null };
  }

  // Автоматизирует то, что раньше приходилось делать руками по SSH (см. подсказку в catch
  // выше install()): если IP, который вот-вот займёт наш новый интерфейс, уже держит
  // ДРУГОЙ wireguard-совместимый интерфейс на этом хосте — обычно осиротевший после
  // удаления протокола/моста через панель (раньше удаление трогало только БД, см.
  // uninstall() ниже, который это как раз и чинит на будущее) — сносим его сами перед
  // установкой. Проверяем именно link type "wireguard" в `ip -d link show`, а не удаляем
  // что попало: AmneziaWG — форк ядра WireGuard и репортует тот же link type, так что
  // проверка ловит осиротевшие интерфейсы ОБОИХ протоколов, а не только своего.
  private async reclaimConflictingInterface(ssh: NodeSSH, interfaceAddress: string, ownInterfaceName: string): Promise<void> {
    const found = await this.sshService.exec(ssh, `ip -o -4 addr show | awk '$4 == "${interfaceAddress}" {print $2}'`);
    const staleInterface = found.stdout.trim().split('\n')[0]?.trim();
    if (!staleInterface || staleInterface === ownInterfaceName) {
      return;
    }
    const linkInfo = await this.sshService.exec(ssh, `ip -d link show ${staleInterface}`);
    if (!/wireguard/i.test(linkInfo.stdout)) {
      return;
    }
    // Не знаем заранее, каким именно юнитом (wg-quick@/awg-quick@) он был поднят —
    // пробуем оба, best-effort (interfaces без такого юнита просто дают безобидную ошибку).
    await this.sshService.exec(
      ssh,
      `systemctl disable --now wg-quick@${staleInterface} >/dev/null 2>&1; systemctl disable --now awg-quick@${staleInterface} >/dev/null 2>&1; true`,
    );
    await this.sshService.exec(ssh, `ip link delete ${staleInterface} >/dev/null 2>&1 || true`);
  }

  // Версия CLI-инструментов — для отображения в панели и как способ узнать, что стоит
  // обновить. null — бинарник не найден (например, если ensureClientToolsInstalled ещё ни
  // разу не отработал на этом хосте) или протокол работает в стороннем Docker-контейнере
  // (в него команда напрямую с хоста не достучится, ctx.ssh — SSH на ХОСТ).
  async getInstalledVersion(ctx: VpnDriverContext): Promise<string | null> {
    if (ctx.serverProtocol.execContainer) {
      return null;
    }
    const result = await this.sshService.exec(ctx.ssh, `${this.binary} --version`);
    return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
  }

  // apt upgrade в рамках уже подключённых источников (обычный apt-репозиторий для
  // WireGuard, PPA amnezia/ppa для AmneziaWG — сам PPA не переподключаем, см.
  // ensureClientToolsInstalled в подклассах) — НЕ смена мажорной версии. Возвращает версию
  // ПОСЛЕ обновления.
  async updatePackage(ctx: VpnDriverContext): Promise<string | null> {
    if (ctx.serverProtocol.execContainer) {
      throw new Error(
        'Обновление недоступно для протокола, работающего в стороннем Docker-контейнере (официальный self-hosted сервер AmneziaVPN) — управляется вне этой панели',
      );
    }
    await this.sshService.execOrThrow(
      ctx.ssh,
      `export DEBIAN_FRONTEND=noninteractive && apt-get update -y && apt-get install --only-upgrade -y ${this.aptPackages}`,
    );
    return this.getInstalledVersion(ctx);
  }

  // Полностью снимает протокол с сервера — используется при удалении протокола из панели
  // (см. ServersService.removeProtocol), чтобы НЕ оставлять осиротевший интерфейс (именно
  // такие интерфейсы reclaimConflictingInterface потом подчищает при следующей установке
  // — но лучше не создавать их вовсе). down — best-effort (`|| true`): если интерфейс уже
  // не поднят, wg-quick/awg-quick завершится с ошибкой, это не повод останавливать очистку.
  async uninstall(ctx: VpnDriverContext): Promise<void> {
    if (ctx.serverProtocol.execContainer) {
      throw new Error(
        'Удаление недоступно для протокола, работающего в стороннем Docker-контейнере — остановите/удалите контейнер вручную по SSH',
      );
    }
    const interfaceName = ctx.serverProtocol.interfaceName;
    const confDir = ctx.serverProtocol.remoteConfDir || this.confDir;
    const keyPrefix = this.keyFilePrefix(interfaceName);
    const remotePath = this.confPath(confDir, interfaceName);
    await this.sshService.exec(ctx.ssh, `${this.quickBinary} down ${remotePath} >/dev/null 2>&1 || true`);
    await this.sshService.exec(ctx.ssh, `systemctl disable --now ${this.quickBinary}@${interfaceName} >/dev/null 2>&1 || true`);
    await this.sshService.exec(ctx.ssh, `ip link delete ${interfaceName} >/dev/null 2>&1 || true`);
    await this.sshService.exec(ctx.ssh, `rm -f ${remotePath} ${confDir}/${keyPrefix}_private.key ${confDir}/${keyPrefix}_public.key`);
  }

  async applyPeers(ctx: VpnDriverContext, peers: PeerSpec[]): Promise<void> {
    const execContainer = ctx.serverProtocol.execContainer;
    const confDir = ctx.serverProtocol.remoteConfDir || this.confDir;
    const interfaceName = ctx.serverProtocol.interfaceName;
    const keyPrefix = this.keyFilePrefix(interfaceName);
    const privateKey = await this.sshService.execOrThrow(
      ctx.ssh,
      this.buildCommand(`cat ${confDir}/${keyPrefix}_private.key`, execContainer),
    );

    // Для протоколов, найденных внутри стороннего Docker-контейнера, не берём на себя
    // NAT/forwarding — контейнер (например, официальный self-hosted сервер AmneziaVPN)
    // управляет этим сам вне conf-файла (в оригинальном конфиге bithosting таких строк не
    // было вовсе). Добавление своих PostUp/PostDown с интерфейсом ХОСТА туда, где реально
    // работает netns КОНТЕЙНЕРА, — ровно то, что испортило конфиг в прошлый раз.
    const nat = execContainer ? undefined : { egressInterface: await this.detectEgressInterface(ctx.ssh, null) };

    const configText = this.renderConfig({
      privateKey,
      interfaceAddress: ctx.serverProtocol.remoteInterfaceAddress || gatewayAddress(ctx.serverProtocol.networkCidr),
      listenPort: ctx.serverProtocol.listenPort,
      networkCidr: ctx.serverProtocol.networkCidr,
      interfaceName,
      nat,
      obfuscationParams: ctx.serverProtocol.obfuscationParams || undefined,
      mtu: ctx.serverProtocol.mtu || undefined,
      peers,
    });
    const remotePath = this.confPath(confDir, interfaceName);
    const encoded = Buffer.from(configText, 'utf8').toString('base64');
    await this.sshService.execOrThrow(
      ctx.ssh,
      this.buildCommand(`echo ${encoded} | base64 -d > ${remotePath} && chmod 600 ${remotePath}`, execContainer),
    );

    // Передаём полный путь к конфигу, а не голое имя интерфейса: `{quick} up wg0` ищет
    // wg0.conf по зашитому в сам wg-quick пути по умолчанию (для awg-quick это
    // /etc/amnezia/amneziawg/), который может не совпадать с реальным remoteConfDir —
    // именно так провалился первый прогон на bithosting (`awg-quick: ... does not exist`).
    await this.sshService.execOrThrow(
      ctx.ssh,
      this.buildCommand(`${this.quickBinary} down ${remotePath} 2>/dev/null; ${this.quickBinary} up ${remotePath}`, execContainer),
    );
  }

  async scanExistingPeers(ctx: VpnDriverContext): Promise<ScannedPeer[]> {
    const confDir = ctx.serverProtocol.remoteConfDir || this.confDir;
    const interfaceName = ctx.serverProtocol.interfaceName;
    const result = await this.sshService.exec(
      ctx.ssh,
      this.buildCommand(`cat ${this.confPath(confDir, interfaceName)}`, ctx.serverProtocol.execContainer),
    );
    if (result.code !== 0) {
      return [];
    }
    return this.parsePeers(result.stdout);
  }

  async getActivePeerCount(ctx: VpnDriverContext): Promise<number> {
    const peers = await this.scanExistingPeers(ctx);
    return peers.length;
  }

  // `wg show <iface> dump` печатает первой строкой данные САМОГО интерфейса (4 поля:
  // privateKey/publicKey/listenPort/fwmark), а дальше — по строке на peer (8 полей:
  // publicKey presharedKey endpoint allowedIps latestHandshake rxBytes txBytes keepalive) —
  // awg тот же формат, drop-in совместимый CLI. Один запрос вместо отдельных "transfer" +
  // "latest-handshakes" — то же количество SSH-раундтрипов, что было раньше, но данных
  // больше (используется для предупреждения "peer создан, но ни разу не подключился",
  // см. dashboard/). Пустая карта, если интерфейс сейчас не поднят (команда завершается
  // ошибкой) — не считаем это фатальным, просто нет данных.
  async getTransferStats(ctx: VpnDriverContext): Promise<Map<string, PeerTransferStats>> {
    const interfaceName = ctx.serverProtocol.interfaceName;
    const result = await this.sshService.exec(
      ctx.ssh,
      this.buildCommand(`${this.binary} show ${interfaceName} dump`, ctx.serverProtocol.execContainer),
    );
    const stats = new Map<string, PeerTransferStats>();
    if (result.code !== 0) {
      return stats;
    }
    for (const line of result.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      // Строка интерфейса (4 поля) — не peer, пропускаем; пустые строки — тоже.
      if (parts.length < 8) {
        continue;
      }
      const [publicKey, , endpoint, , latestHandshake, rx, tx] = parts;
      if (publicKey) {
        stats.set(publicKey, {
          rxBytes: Number(rx) || 0,
          txBytes: Number(tx) || 0,
          latestHandshake: Number(latestHandshake) || 0,
          // "(none)", если peer ни разу не подключался — эндпоинт узнаётся только
          // из фактического входящего UDP-пакета, а не задаётся конфигом.
          endpoint: endpoint && endpoint !== '(none)' ? endpoint : null,
        });
      }
    }
    return stats;
  }

  // Режим моста: поднимает интерфейс в роли КЛИЕНТА (один [Peer] — upstream-сервер) на
  // хосте, куда подключён `ssh` (self-сервер моста). Всегда host-based — self-сервер не
  // бывает Docker-контейнером с нашей стороны SSH-подключения.
  async connectAsClient(ssh: NodeSSH, interfaceName: string, config: UpstreamPeerConfig, routeTable: number): Promise<void> {
    // Table = off — иначе wg-quick сам подменит маршрут по умолчанию ДЛЯ ВСЕГО ХОСТА
    // (его штатное поведение при AllowedIPs=0.0.0.0/0), а не только для трафика
    // клиентов моста. Вместо этого маршрут через upstream добавляется вручную в
    // отдельную таблицу (см. ниже) — в основной таблице собственная связность
    // self-сервера остаётся нетронутой.
    const lines: string[] = ['[Interface]', `PrivateKey = ${config.privateKey}`, `Address = ${config.address}`, 'Table = off'];
    if (config.dns) {
      lines.push(`DNS = ${config.dns}`);
    }
    if (config.obfuscationParams) {
      for (const [key, value] of Object.entries(config.obfuscationParams)) {
        lines.push(`${key} = ${value}`);
      }
    }
    lines.push('', '[Peer]', `PublicKey = ${config.serverPublicKey}`);
    if (config.presharedKey) {
      lines.push(`PresharedKey = ${config.presharedKey}`);
    }
    lines.push(`Endpoint = ${config.endpointHost}:${config.endpointPort}`, 'AllowedIPs = 0.0.0.0/0, ::/0', 'PersistentKeepalive = 25');
    const configText = lines.join('\n') + '\n';

    const remotePath = this.confPath(this.confDir, interfaceName);
    await this.sshService.execOrThrow(ssh, `mkdir -p ${this.confDir} && chmod 700 ${this.confDir}`);
    const encoded = Buffer.from(configText, 'utf8').toString('base64');
    await this.sshService.execOrThrow(ssh, `echo ${encoded} | base64 -d > ${remotePath} && chmod 600 ${remotePath}`);
    // interfaceName здесь — ВСЕГДА Bridge.upstreamInterfaceName, сгенерированный нами
    // случайным именем специально под этот upstream-туннель — с чем-либо посторонним
    // столкнуться не может, поэтому безопасно сносить безусловно (в отличие от
    // reclaimConflictingInterface в install(), которая разбирает ЧУЖИЕ осиротевшие
    // интерфейсы и поэтому сначала проверяет тип линка). Нужно на случай, если
    // disconnectAsClient не был вызван (например, самый первый connect) или не до конца
    // снял интерфейс при переключении upstream МЕЖДУ ПРОТОКОЛАМИ — тогда `awg-quick up`
    // после `wg-quick`-интерфейса того же имени (или наоборот) падает с "already exists"
    // (поймано вживую: переключение WireGuard-upstream -> AmneziaWG-upstream).
    await this.sshService.exec(ssh, `ip link delete ${interfaceName} >/dev/null 2>&1 || true`);
    try {
      await this.sshService.execOrThrow(ssh, `${this.quickBinary} up ${remotePath}`);
    } catch (error) {
      throw this.withKernelModuleHint(error as Error);
    }
    // `Table = off` означает, что wg-quick не добавил маршрут по умолчанию сам —
    // делаем это явно, но только в выделенной таблице (реально её использует только
    // трафик из сети клиентов моста — см. `ip rule` в setupBridgeNat). `replace`, а не
    // `add`: при каждом переключении upstream интерфейс пересоздаётся (`wg-quick down`
    // удаляет netdev и вместе с ним — привязанные к нему маршруты), поэтому маршрут
    // нужно переустанавливать заново при каждом connectAsClient.
    await this.sshService.execOrThrow(ssh, `ip route replace default dev ${interfaceName} table ${routeTable}`);
  }

  async disconnectAsClient(ssh: NodeSSH, interfaceName: string): Promise<void> {
    const remotePath = this.confPath(this.confDir, interfaceName);
    await this.sshService.exec(ssh, `${this.quickBinary} down ${remotePath} 2>/dev/null`);
    await this.sshService.exec(ssh, `rm -f ${remotePath}`);
    // `*-quick down` — best-effort и на этом файле не единственный источник истины: если он
    // по любой причине не удалил netdev (ошибка молча проглатывается выше), следующий
    // connectAsClient — возможно, уже ДРУГИМ протоколом/бинарником (переключение upstream с
    // WireGuard на AmneziaWG и обратно, интерфейс переиспользует то же имя) — упадёт с
    // "already exists". Подчищаем интерфейс напрямую, безусловно (это всегда НАШ upstream-
    // интерфейс, см. connectAsClient).
    await this.sshService.exec(ssh, `ip link delete ${interfaceName} >/dev/null 2>&1 || true`);
  }

  async detectExisting(ssh: NodeSSH): Promise<DetectedInstallation | null> {
    const hostResult = await this.detectAt(ssh, null, `ls ${this.confDir}/*.conf 2>/dev/null`);
    if (hostResult) {
      return hostResult;
    }

    const containerName = await this.findAmneziaContainer(ssh);
    if (!containerName) {
      return null;
    }
    return this.detectAt(ssh, containerName, AMNEZIA_CONTAINER_CONF_SEARCH);
  }

  private async findAmneziaContainer(ssh: NodeSSH): Promise<string | null> {
    const result = await this.sshService.exec(ssh, `docker ps --format '{{.Names}}' 2>/dev/null`);
    if (result.code !== 0) {
      return null;
    }
    const names = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return names.find((name) => this.containerNameHints.some((hint) => name.toLowerCase().includes(hint))) || null;
  }

  // На сервере может остаться несколько .conf-файлов от предыдущих попыток установки —
  // ни неудачная установка, ни удаление протокола/моста через панель не чистят файлы на
  // диске (сам wg-quick/awg-quick интерфейс на хосте не снимается, см. README). `ls
  // *.conf` перечисляет их все по алфавиту — раньше просто брался первый файл из списка,
  // и если "мёртвый" конфиг от давно заброшенной попытки сортировался раньше реально
  // поднятого интерфейса, detectExisting путал их и затирал рабочую запись в БД чужими
  // ключами/именем интерфейса (пойманный вживую инцидент: активный мост перестал
  // принимать пиров без единой ошибки в логах). Теперь предпочитаем файл, чей интерфейс
  // РЕАЛЬНО поднят (`ip link show`); если ни один не поднят — откатываемся к первому по
  // алфавиту, как и раньше (единственный разумный вариант при полностью погашенной
  // установке, когда нечего сверять).
  private async pickLikelyActiveConfPath(ssh: NodeSSH, execContainer: string | null, confPaths: string[]): Promise<string> {
    for (const confPath of confPaths) {
      const interfaceName = confPath.split('/').pop()?.replace(/\.conf$/, '') ?? '';
      const linkResult = await this.sshService.exec(ssh, this.buildCommand(`ip link show ${interfaceName} 2>/dev/null`, execContainer));
      if (linkResult.code === 0 && linkResult.stdout.trim()) {
        return confPath;
      }
    }
    return confPaths[0];
  }

  private async detectAt(
    ssh: NodeSSH,
    execContainer: string | null,
    listCommand: string,
  ): Promise<DetectedInstallation | null> {
    const listResult = await this.sshService.exec(ssh, this.buildCommand(listCommand, execContainer));
    const confPaths = listResult.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (listResult.code !== 0 || confPaths.length === 0) {
      return null;
    }
    const confPath = await this.pickLikelyActiveConfPath(ssh, execContainer, confPaths);

    const catResult = await this.sshService.exec(ssh, this.buildCommand(`cat ${confPath}`, execContainer));
    if (catResult.code !== 0) {
      return null;
    }
    const configText = catResult.stdout;

    const listenPortMatch = configText.match(/^ListenPort\s*=\s*(\d+)/m);
    const addressLineMatch = configText.match(/^Address\s*=\s*(\S+)/m);
    const privateKeyMatch = configText.match(/^PrivateKey\s*=\s*(\S+)/m);
    if (!listenPortMatch || !addressLineMatch || !privateKeyMatch) {
      return null;
    }
    const remoteInterfaceAddress = addressLineMatch[1];
    const networkPrefixMatch = remoteInterfaceAddress.match(/^(\d+\.\d+\.\d+)\.\d+/);
    if (!networkPrefixMatch) {
      return null;
    }

    const interfaceName = confPath.split('/').pop()!.replace(/\.conf$/, '');
    const remoteConfDir = confPath.slice(0, confPath.length - `/${interfaceName}.conf`.length) || this.confDir;
    const keyPrefix = this.keyFilePrefix(interfaceName);
    const privateKey = privateKeyMatch[1];
    const serverPublicKey = await this.sshService.execOrThrow(
      ssh,
      this.buildCommand(`echo '${privateKey}' | ${this.binary} pubkey`, execContainer),
    );

    // "Усыновляем" найденную установку: сохраняем приватный ключ в тот же файл, который
    // использует наш install(), — чтобы дальнейшее управление peers (applyPeers) работало
    // одинаково для установок снаружи и установленных через сервис. Сам конфиг интерфейса
    // и текущее состояние VPN не меняем, интерфейс не перезапускаем. На некоторых
    // read-only контейнерах запись может не получиться — тогда просто не сможем позже
    // управлять peers на этом протоколе, но само обнаружение и импорт существующих peers
    // всё равно отработает.
    try {
      await this.sshService.execOrThrow(
        ssh,
        this.buildCommand(
          `mkdir -p ${remoteConfDir} && chmod 700 ${remoteConfDir} && umask 077 && echo '${privateKey}' > ${remoteConfDir}/${keyPrefix}_private.key && echo '${serverPublicKey}' > ${remoteConfDir}/${keyPrefix}_public.key`,
          execContainer,
        ),
      );
    } catch {
      // не критично для самого обнаружения — см. комментарий выше
    }

    return {
      interfaceName,
      listenPort: Number(listenPortMatch[1]),
      networkCidr: `${networkPrefixMatch[1]}.0/24`,
      serverPublicKey,
      obfuscationParams: this.parseObfuscationParamsFromConfig(configText),
      execContainer,
      remoteConfDir,
      remoteInterfaceAddress,
    };
  }

  private parsePeers(configText: string): ParsedPeerBlock[] {
    const blocks = configText.split(/\n(?=\[Peer\])/g).slice(1);
    const peers: ParsedPeerBlock[] = [];
    for (const block of blocks) {
      const publicKeyMatch = block.match(/PublicKey\s*=\s*(\S+)/);
      const allowedIpsMatch = block.match(/AllowedIPs\s*=\s*(\S+)/);
      const nameMatch = block.match(/#\s*name:\s*(.+)/);
      const presharedKeyMatch = block.match(/PresharedKey\s*=\s*(\S+)/);
      if (publicKeyMatch && allowedIpsMatch) {
        peers.push({
          publicKey: publicKeyMatch[1],
          allowedIp: allowedIpsMatch[1],
          name: nameMatch ? nameMatch[1].trim() : undefined,
          presharedKey: presharedKeyMatch ? presharedKeyMatch[1] : undefined,
        });
      }
    }
    return peers;
  }

  private renderConfig(params: {
    privateKey: string;
    interfaceAddress: string;
    listenPort: number;
    networkCidr: string;
    interfaceName: string;
    // undefined — не добавлять PostUp/PostDown вовсе (используется для протоколов внутри
    // стороннего Docker-контейнера, который сам управляет NAT вне conf-файла).
    nat?: { egressInterface: string };
    obfuscationParams?: Record<string, number | string>;
    // Явный MTU — нужен клиентскому интерфейсу моста (см. InstallOptions.mtu). undefined —
    // обычное поведение wg-quick/awg-quick по умолчанию (авто ~1420).
    mtu?: number;
    peers: PeerSpec[];
  }): string {
    const lines: string[] = [];
    lines.push('[Interface]');
    lines.push(`PrivateKey = ${params.privateKey}`);
    lines.push(`Address = ${params.interfaceAddress}`);
    lines.push(`ListenPort = ${params.listenPort}`);
    if (params.mtu) {
      lines.push(`MTU = ${params.mtu}`);
    }
    if (params.obfuscationParams) {
      for (const [key, value] of Object.entries(params.obfuscationParams)) {
        lines.push(`${key} = ${value}`);
      }
    }
    if (params.nat) {
      lines.push(
        `PostUp = iptables -t nat -A POSTROUTING -s ${params.networkCidr} -o ${params.nat.egressInterface} -j MASQUERADE; iptables -A FORWARD -i ${params.interfaceName} -j ACCEPT; iptables -A FORWARD -o ${params.interfaceName} -j ACCEPT`,
      );
      lines.push(
        `PostDown = iptables -t nat -D POSTROUTING -s ${params.networkCidr} -o ${params.nat.egressInterface} -j MASQUERADE; iptables -D FORWARD -i ${params.interfaceName} -j ACCEPT; iptables -D FORWARD -o ${params.interfaceName} -j ACCEPT`,
      );
    }

    for (const peer of params.peers) {
      lines.push('');
      if (peer.name) {
        lines.push(`# name: ${peer.name}`);
      }
      lines.push('[Peer]');
      lines.push(`PublicKey = ${peer.publicKey}`);
      if (peer.presharedKey) {
        lines.push(`PresharedKey = ${peer.presharedKey}`);
      }
      lines.push(`AllowedIPs = ${peer.allowedIp}/32`);
    }

    return lines.join('\n') + '\n';
  }

  protected static randomJitter(min: number, max: number): number {
    return randomInt(min, max + 1);
  }
}
