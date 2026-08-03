export enum Role {
  SUPER_ADMIN = 'super_admin',
  ORG_ADMIN = 'org_admin',
  ORG_USER = 'org_user',
}

export enum VpnProtocol {
  WIREGUARD = 'wireguard',
  AMNEZIAWG = 'amneziawg',
}

export enum ServerStatus {
  UNKNOWN = 'unknown',
  ONLINE = 'online',
  OFFLINE = 'offline',
}

export enum ServerProtocolStatus {
  NOT_INSTALLED = 'not_installed',
  INSTALLING = 'installing',
  ACTIVE = 'active',
  ERROR = 'error',
}

export enum PeerSource {
  CREATED = 'created',
  IMPORTED = 'imported',
  // Системный upstream-peer моста на backend-сервере — не показывается в обычных списках
  // peers клиентов, управляется только BridgesService.
  BRIDGE_UPSTREAM = 'bridge_upstream',
}

export enum PeerStatus {
  ACTIVE = 'active',
  REVOKED = 'revoked',
}

export enum SshAuthType {
  PASSWORD = 'password',
  PRIVATE_KEY = 'private_key',
}

export enum BridgeUpstreamMode {
  MANUAL = 'manual',
  AUTO = 'auto',
  // По доступности: постоянно проверяет TCP-доступность SSH-порта кандидатов из
  // bridge_upstream_candidates (см. BridgeFailoverService) и держит upstream на первом
  // доступном по приоритету — включая автоматический возврат на основной, когда он снова
  // станет доступен. Взаимоисключающий с AUTO на одном мосту (оба дёргают setUpstream по
  // интервалу) — валидируется в BridgesService.setMode.
  FAILOVER = 'failover',
}

export enum BridgeStatus {
  NOT_CONFIGURED = 'not_configured',
  CONFIGURING = 'configuring',
  ACTIVE = 'active',
  ERROR = 'error',
}
