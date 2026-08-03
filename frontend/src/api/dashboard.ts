import { io, Socket } from 'socket.io-client';
import { tokenStorage } from '../auth/tokenStorage';
import { VpnProtocol } from './types';

export interface DashboardServerStats {
  serverId: string;
  serverName: string;
  isSelf: boolean;
  online: boolean;
  loadAvg1: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
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
