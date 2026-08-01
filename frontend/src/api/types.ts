export type Role = 'super_admin' | 'org_admin' | 'org_user';
export type VpnProtocol = 'wireguard' | 'amneziawg';
export type ServerStatus = 'unknown' | 'online' | 'offline';
export type ServerProtocolStatus = 'not_installed' | 'installing' | 'active' | 'error';
export type PeerSource = 'created' | 'imported' | 'bridge_upstream';
export type PeerStatus = 'active' | 'revoked';
export type SshAuthType = 'password' | 'private_key';
export type BridgeUpstreamMode = 'manual' | 'auto';
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
  createdAt: string;
  protocols: ServerProtocolEntity[];
}

export interface BridgeEntity {
  id: string;
  name: string;
  clientServerProtocolId: string;
  clientServerProtocol?: ServerProtocolEntity & { server?: ServerEntity };
  upstreamMode: BridgeUpstreamMode;
  upstreamServerProtocolId: string | null;
  upstreamServerProtocol?: (ServerProtocolEntity & { server?: ServerEntity }) | null;
  upstreamPeerId: string | null;
  upstreamInterfaceName: string;
  status: BridgeStatus;
  lastError: string | null;
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
}
