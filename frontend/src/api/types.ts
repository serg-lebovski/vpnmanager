export type Role = 'super_admin' | 'org_admin' | 'org_user';
export type VpnProtocol = 'wireguard' | 'amneziawg';
export type ServerStatus = 'unknown' | 'online' | 'offline';
export type ServerProtocolStatus = 'not_installed' | 'installing' | 'active' | 'error';
export type PeerSource = 'created' | 'imported' | 'bridge_upstream';
export type PeerStatus = 'active' | 'revoked';
export type SshAuthType = 'password' | 'private_key';
export type BridgeUpstreamMode = 'manual' | 'auto' | 'failover';
export type BridgeStatus = 'not_configured' | 'configuring' | 'active' | 'error';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  organizationId: string | null;
}

export interface Organization {
  id: string;
  name: string;
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
}
