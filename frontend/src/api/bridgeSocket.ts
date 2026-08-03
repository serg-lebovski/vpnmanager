import { io, Socket } from 'socket.io-client';
import { tokenStorage } from '../auth/tokenStorage';

export interface BridgeSwitchProgress {
  bridgeId: string;
  percent: number;
  step: string;
  done: boolean;
  error?: string;
}

// Namespace 'bridges' (backend/src/bridges/bridges.gateway.ts) — прогресс переключения
// upstream (BridgesService.setUpstream), т.к. сама операция синхронная и небыстрая
// (несколько последовательных SSH-подключений).
export function connectBridgeProgressSocket(onProgress: (progress: BridgeSwitchProgress) => void): Socket {
  const socket = io('/bridges', {
    path: '/socket.io',
    auth: { token: tokenStorage.getAccessToken() },
  });
  socket.on('switch-progress', onProgress);
  return socket;
}
