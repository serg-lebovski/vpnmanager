import { io, Socket } from 'socket.io-client';
import { tokenStorage } from '../auth/tokenStorage';
import { apiClient } from './client';
import { VpnProtocol } from './types';

export interface DashboardServerStats {
  serverId: string;
  serverName: string;
  isSelf: boolean;
  online: boolean;
  loadAvg1: number | null;
  cpuCores: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
  diskUsedMb: number | null;
  diskTotalMb: number | null;
  networkBps: number;
  activePeers: number;
  maxPeers: number;
}

export interface DashboardPeerStats {
  peerId: string;
  name: string;
  serverName: string;
  protocol: VpnProtocol;
  rxBytesTotal: number;
  txBytesTotal: number;
  rxBps: number;
  txBps: number;
  // Unix-время (секунды) последнего handshake, 0 — не было ни разу.
  latestHandshake: number;
  createdAt: string;
  // "ip:port" последнего входящего пакета клиента — null, если handshake не было ни разу.
  endpoint: string | null;
}

export interface DashboardSnapshot {
  timestamp: string;
  servers: DashboardServerStats[];
  peers: DashboardPeerStats[];
}

// Namespace 'dashboard' (backend/src/dashboard/dashboard.gateway.ts) — handshake всё равно
// идёт по стандартному socket.io-пути /socket.io/ (см. nginx.conf), namespace — это уже
// логическое разделение поверх того же соединения.
export function connectDashboardSocket(onSnapshot: (snapshot: DashboardSnapshot) => void): Socket {
  const socket = io('/dashboard', {
    path: '/socket.io',
    auth: { token: tokenStorage.getAccessToken() },
  });
  socket.on('snapshot', onSnapshot);
  return socket;
}

export type TrafficRange = 'day' | 'week' | 'month';

export interface ServerTrafficRow {
  serverId: string;
  serverName: string;
  rxBytes: number;
  txBytes: number;
}

export interface PeerTrafficRow {
  peerId: string;
  peerName: string;
  serverName: string;
  organizationId: string | null;
  organizationName: string;
  rxBytes: number;
  txBytes: number;
}

export interface OrganizationTrafficRow {
  organizationId: string | null;
  organizationName: string;
  rxBytes: number;
  txBytes: number;
}

export interface MonthlyServerTrafficRow {
  month: string;
  serverId: string;
  serverName: string;
  rxBytes: number;
  txBytes: number;
}

export interface TrafficFilters {
  organizationId?: string;
  serverId?: string;
}

export async function fetchTrafficByServer(range: TrafficRange, filters: TrafficFilters = {}): Promise<ServerTrafficRow[]> {
  const { data } = await apiClient.get<ServerTrafficRow[]>('/dashboard/traffic/by-server', {
    params: { range, organizationId: filters.organizationId },
  });
  return data;
}

export async function fetchTrafficByOrganization(range: TrafficRange, filters: TrafficFilters = {}): Promise<OrganizationTrafficRow[]> {
  const { data } = await apiClient.get<OrganizationTrafficRow[]>('/dashboard/traffic/by-organization', {
    params: { range, serverId: filters.serverId },
  });
  return data;
}

export async function fetchTrafficByPeer(range: TrafficRange, filters: TrafficFilters = {}): Promise<PeerTrafficRow[]> {
  const { data } = await apiClient.get<PeerTrafficRow[]>('/dashboard/traffic/by-peer', {
    params: { range, organizationId: filters.organizationId, serverId: filters.serverId },
  });
  return data;
}

export async function fetchTrafficMonthly(months = 6, filters: TrafficFilters = {}): Promise<MonthlyServerTrafficRow[]> {
  const { data } = await apiClient.get<MonthlyServerTrafficRow[]>('/dashboard/traffic/monthly', {
    params: { months, organizationId: filters.organizationId },
  });
  return data;
}
