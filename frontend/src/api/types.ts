export type Role = 'super_admin' | 'org_admin' | 'org_user' | 'engineer';
export type VpnProtocol = 'wireguard' | 'amneziawg';
export type PeerDeviceType = 'phone' | 'pc';
type ServerStatus = 'unknown' | 'online' | 'offline';
export type ServerProtocolStatus = 'not_installed' | 'installing' | 'active' | 'error';
type PeerSource = 'created' | 'imported' | 'bridge_upstream';
type PeerStatus = 'active' | 'revoked';
export type SshAuthType = 'password' | 'private_key';
export type BridgeUpstreamMode = 'manual' | 'auto' | 'failover';
type BridgeStatus = 'not_configured' | 'configuring' | 'active' | 'error';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  organizationId: string | null;
}

export interface Organization {
  id: string;
  name: string;
  // ИНН — используется Telegram-ботом самостоятельной регистрации для сопоставления
  // "название + ИНН" с этой организацией. Необязателен.
  inn: string | null;
  // Какие обычные серверы можно выбрать напрямую (в обход моста) при создании peer'а —
  // allow-list, пусто по умолчанию (нет доступа, кроме моста).
  allowedServerIds: string[];
  // Какие мосты (из видимых организации — общие + свои) недоступны — block-list, пусто
  // по умолчанию (доступны все видимые).
  blockedBridgeIds: string[];
  createdAt: string;
}

export type TelegramRegistrationStatus = 'pending' | 'approved';

export interface TelegramRegistration {
  id: string;
  // null — заявка заведена через веб-портал и Telegram ещё не привязан (см.
  // TelegramRegistration.webToken на бэкенде).
  telegramChatId: string | null;
  telegramUsername: string | null;
  organizationId: string;
  organizationName: string;
  fullName: string;
  status: TelegramRegistrationStatus;
  createdAt: string;
}

export interface TelegramBroadcast {
  id: string;
  text: string;
  pinned: boolean;
  recipientCount: number;
  createdAt: string;
}

export type TelegramBotLogLevel = 'info' | 'warn' | 'error';

export interface TelegramBotLogEntry {
  id: string;
  level: TelegramBotLogLevel;
  message: string;
  chatId: string | null;
  createdAt: string;
}

export interface TelegramContentPost {
  id: string;
  title: string | null;
  body: string;
  // data:-URI (data:image/...;base64,...) — так же превью на фронтенде, без отдельного
  // запроса за картинкой.
  images: string[];
  createdAt: string;
}

export interface AppUser {
  id: string;
  email: string;
  role: Role;
  organizationId: string | null;
  createdAt: string;
}

export interface ServerProtocolEntity {
  id: string;
  serverId: string;
  protocol: VpnProtocol;
  interfaceName: string;
  listenPort: number;
  networkCidr: string;
  status: ServerProtocolStatus;
  lastError: string | null;
  createdAt: string;
  // Имя моста, если этот протокол — клиентский интерфейс моста на self-сервере (см.
  // ServersService.findAll на бэкенде); null — обычный протокол, мостом не используется.
  bridgeName?: string | null;
  // Версия CLI-инструментов (`wg --version`/`awg --version`) — null, если ещё не
  // проверялась или протокол работает в стороннем Docker-контейнере.
  packageVersion: string | null;
  // Имя Docker-контейнера, если протокол работает внутри стороннего контейнера (например,
  // официальный self-hosted сервер AmneziaVPN) — тогда проверка версии/обновление пакета
  // недоступны с этой панели (см. VpnDriver.updatePackage/uninstall на бэкенде).
  execContainer: string | null;
}

export interface ServerEntity {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUsername: string;
  sshAuthType: SshAuthType;
  status: ServerStatus;
  maxPeers: number;
  isSelf: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  needsCredentials: boolean;
  // TOFU-отпечаток SSH host key — null, пока ни разу не подключались (или сброшен вручную
  // после переустановки сервера). См. SshService/ServersPage.
  sshHostKeyFingerprint: string | null;
  // Постоянный MTProto-proxy (обход блокировки Telegram) — см. MtProxyStatus/ServersPage.
  // mtProxyPort !== null означает "установлен"; сам секрет/ссылка сюда не попадают —
  // за ними отдельный запрос (fetchMtProxyStatus), чтобы не гонять их в общем списке.
  mtProxyPort: number | null;
  mtProxyUpdatedAt: string | null;
  createdAt: string;
  protocols: ServerProtocolEntity[];
}

export interface BridgeEntity {
  id: string;
  name: string;
  organizationId: string | null;
  wireguardClientProtocolId: string | null;
  wireguardClientProtocol?: (ServerProtocolEntity & { server?: ServerEntity }) | null;
  amneziawgClientProtocolId: string | null;
  amneziawgClientProtocol?: (ServerProtocolEntity & { server?: ServerEntity }) | null;
  upstreamMode: BridgeUpstreamMode;
  upstreamServerProtocolId: string | null;
  upstreamServerProtocol?: (ServerProtocolEntity & { server?: ServerEntity }) | null;
  upstreamPeerId: string | null;
  upstreamInterfaceName: string;
  status: BridgeStatus;
  lastError: string | null;
  domainName: string | null;
  // Домены/IP, трафик к которым идёт напрямую с self-сервера, минуя upstream ("зарубежный"
  // сервер) — см. VpnProvisioningService.setupBridgeBypass на бэкенде.
  bypassDestinations: string[];
  upstreamCandidates: Array<{ id: string; priority: number; serverProtocol: (ServerProtocolEntity & { server?: ServerEntity }) | null }>;
  createdAt: string;
}

export interface PeerEntity {
  id: string;
  organizationId: string | null;
  serverProtocolId: string;
  name: string;
  publicKey: string;
  allowedIp: string;
  dns: string;
  source: PeerSource;
  status: PeerStatus;
  createdAt: string;
  serverProtocol?: ServerProtocolEntity & { server?: ServerEntity };
  // Ключ(и) есть, но не расшифровываются текущим ключом шифрования панели (обычно после
  // восстановления БД на другом деплое) — peer нерабочий, нужно отозвать и создать заново.
  needsRecreation: boolean;
  // "Подписка" без оплат: null — бессрочно. Если задано и срок прошёл — peer НЕ удаляется
  // и не отзывается, просто перестаёт применяться на сервере (см. isExpired). Управляет
  // только super_admin.
  expiresAt: string | null;
  isExpired: boolean;
  // Заполнено только для мультиконфига (WireGuard + AmneziaWG одним .vpn-файлом) — id
  // второго peer'а той же пары. null — обычный одно-протокольный peer.
  pairedPeerId: string | null;
}
