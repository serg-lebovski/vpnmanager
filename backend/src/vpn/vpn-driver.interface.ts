import { NodeSSH } from 'node-ssh';
import { VpnProtocol } from '../common/enums';
import { Server } from '../servers/server.entity';
import { ServerProtocol } from '../servers/server-protocol.entity';

export interface VpnDriverContext {
  ssh: NodeSSH;
  server: Server;
  serverProtocol: ServerProtocol;
}

export interface PeerSpec {
  publicKey: string;
  presharedKey?: string | null;
  allowedIp: string;
  name?: string;
}

export interface InstallOptions {
  listenPort: number;
  networkCidr: string;
  // Явный MTU интерфейса — нужен клиентскому интерфейсу моста: трафик там проходит ЕЩЁ
  // через один туннель (self-сервер → upstream), и стандартный MTU ~1420 на обоих хопах
  // приводит к фрагментации/потерям на крупных пакетах (не на мелких — поэтому DNS вроде
  // бы работает, а страницы грузятся плохо). undefined — обычное поведение по умолчанию
  // (для одиночных, не-мостовых серверов запас не нужен).
  mtu?: number;
  // Явное имя интерфейса вместо дефолтного (wg0/awg0 у драйвера) — нужно мостам: на одном
  // self-сервере может быть несколько мостов с одним и тем же протоколом (разные порты),
  // и им нельзя делить одно и то же имя интерфейса/путь конфига. undefined — обычное имя
  // по умолчанию (для одиночных, не-мостовых серверов конфликтовать не с кем).
  interfaceName?: string;
}

export interface InstallResult {
  interfaceName: string;
  serverPublicKey: string;
  obfuscationParams?: Record<string, number | string>;
  mtu?: number;
}

export interface ScannedPeer {
  publicKey: string;
  allowedIp: string;
  name?: string;
  presharedKey?: string;
}

export interface PeerTransferStats {
  rxBytes: number;
  txBytes: number;
  // Unix-время (секунды) последнего успешного handshake — 0, если его не было ни разу
  // (см. `wg show <iface> dump`, поле "latest handshake"). Используется, в частности, для
  // предупреждения "peer создан, но ни разу не подключился" (см. dashboard/).
  latestHandshake: number;
}

export interface DetectedInstallation {
  interfaceName: string;
  listenPort: number;
  networkCidr: string;
  serverPublicKey: string;
  obfuscationParams?: Record<string, number | string>;
  // Имя Docker-контейнера, если протокол работает внутри контейнера (например,
  // официальный self-hosted сервер AmneziaVPN), а не установлен напрямую на хост.
  execContainer?: string | null;
  // Директория с конфигом, если она отличается от стандартной для драйвера.
  remoteConfDir?: string | null;
  // Исходное значение "Address = ..." из найденного конфига, если оно отличается от
  // нашего стандартного gatewayAddress(networkCidr).
  remoteInterfaceAddress?: string | null;
}

// Данные для подключения "клиентом" к чужому серверу того же протокола (режим моста):
// свой приватный ключ/адрес в туннеле + публичные данные противоположной стороны.
export interface UpstreamPeerConfig {
  privateKey: string;
  address: string; // например "10.8.1.4/32" — свой адрес, выданный upstream-сервером
  presharedKey?: string | null;
  serverPublicKey: string;
  endpointHost: string;
  endpointPort: number;
  obfuscationParams?: Record<string, number | string>;
  dns?: string;
}

// Готовность kernel-модуля протокола ПЕРЕД тем, как install()/connectAsClient() попробуют
// поднять интерфейс ("<quickBinary> up" внутри себя делает "ip link add ... type <protocol>",
// который требует загруженного модуля). rebootKernel — версия ядра, для которой DKMS УЖЕ
// собрал и установил модуль (см. `dkms status`), если она отличается от текущей
// (`uname -r`) — типичная причина: apt upgrade подтянул новый kernel-пакет, DKMS
// пересобрал модуль под него, но сервер ещё не перезагружен в этот новый kernel. В этом
// случае проблема чинится перезагрузкой сервера (см. VpnProvisioningService.
// ensureKernelModuleReady) — в отличие от случая, когда модуль вообще не собрался
// (rebootKernel: null), где перезагрузка ничего не даст и нужно вмешательство человека.
export type KernelModuleStatus = { ready: true } | { ready: false; rebootKernel: string | null };

export interface VpnDriver {
  readonly protocol: VpnProtocol;
  install(ctx: VpnDriverContext, options: InstallOptions): Promise<InstallResult>;
  // См. KernelModuleStatus. Дешёвая проверка (modprobe + при неудаче — dkms status) —
  // вызывается перед КАЖДЫМ install()/connectAsClient(), поэтому должна быть быстрой и не
  // бросать исключений самостоятельно.
  checkKernelModuleStatus(ssh: NodeSSH): Promise<KernelModuleStatus>;
  scanExistingPeers(ctx: VpnDriverContext): Promise<ScannedPeer[]>;
  applyPeers(ctx: VpnDriverContext, peers: PeerSpec[]): Promise<void>;
  getActivePeerCount(ctx: VpnDriverContext): Promise<number>;
  // Живая статистика трафика по каждому peer'у интерфейса (`wg show <iface> transfer` /
  // аналог у AmneziaWG) — ключ карты: publicKey peer'а. Пусто, если интерфейс сейчас не
  // поднят (не ошибка — например, протокол помечен ACTIVE, но интерфейс временно лежит).
  getTransferStats(ctx: VpnDriverContext): Promise<Map<string, PeerTransferStats>>;
  // Ищет уже существующую (настроенную не через наш сервис) установку протокола на
  // сервере: сначала по стандартным путям на хосте, затем — среди Docker-контейнеров
  // (в т.ч. официальный self-hosted сервер AmneziaVPN, разворачивающий протоколы как
  // контейнеры amnezia-*). null — если не найдено.
  detectExisting(ssh: NodeSSH): Promise<DetectedInstallation | null>;
  // Режим моста: поднимает интерфейс в РОЛИ КЛИЕНТА (один [Peer] — upstream-сервер,
  // AllowedIPs = 0.0.0.0/0) на хосте, где выполняется ssh (self-сервер моста).
  // routeTable — отдельная таблица маршрутизации ЭТОГО моста (см. Bridge.routeTable):
  // маршрут по умолчанию добавляется только туда, а не в основную таблицу хоста —
  // на одном self-сервере может быть несколько мостов, каждый со своим upstream.
  connectAsClient(ssh: NodeSSH, interfaceName: string, config: UpstreamPeerConfig, routeTable: number): Promise<void>;
  disconnectAsClient(ssh: NodeSSH, interfaceName: string): Promise<void>;
  // Ставит CLI-инструменты протокола (wg/awg + *-tools), не трогая никакой конфиг/интерфейс.
  // Нужно на self-сервере моста перед connectAsClient, если там ещё нет инструментов для
  // протокола upstream-сервера (например, self-сервер поднят под обычный WireGuard для
  // клиентов моста, а upstream — AmneziaWG, и `awg`/`awg-quick` там ещё не установлены).
  ensureClientToolsInstalled(ssh: NodeSSH): Promise<void>;
  // Версия установленных CLI-инструментов (`wg --version`/`awg --version`) — null, если
  // бинарник не найден или протокол работает в стороннем Docker-контейнере (команда там
  // недоступна напрямую с хоста).
  getInstalledVersion(ctx: VpnDriverContext): Promise<string | null>;
  // apt upgrade пакетов протокола до последней версии в уже подключённых источниках (не
  // смена мажорной версии/PPA) — возвращает версию ПОСЛЕ обновления. Бросает, если
  // протокол работает в стороннем Docker-контейнере — не наша ответственность.
  updatePackage(ctx: VpnDriverContext): Promise<string | null>;
  // Полностью снимает протокол С СЕРВЕРА (down интерфейса, отключение автозапуска, удаление
  // конфига/файлов ключей) — используется при удалении протокола из панели, чтобы не
  // оставлять "осиротевший" интерфейс (раньше удаление трогало только БД). Бросает, если
  // протокол работает в стороннем Docker-контейнере.
  uninstall(ctx: VpnDriverContext): Promise<void>;
}
