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

export interface VpnDriver {
  readonly protocol: VpnProtocol;
  install(ctx: VpnDriverContext, options: InstallOptions): Promise<InstallResult>;
  scanExistingPeers(ctx: VpnDriverContext): Promise<ScannedPeer[]>;
  applyPeers(ctx: VpnDriverContext, peers: PeerSpec[]): Promise<void>;
  getActivePeerCount(ctx: VpnDriverContext): Promise<number>;
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
}
