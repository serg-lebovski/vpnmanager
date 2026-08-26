import { io, Socket } from 'socket.io-client';
import { tokenStorage } from '../auth/tokenStorage';

// Namespace 'terminal' (backend/src/terminal/terminal.gateway.ts) — веб-терминал SSH к
// добавленному серверу, SUPER_ADMIN-only. Долгоживущее соединение (в отличие от
// dashboard/bridgeSocket — там сервер сам транслирует снапшоты, здесь клиент явно шлёт
// ввод и получает вывод интерактивной shell-сессии).
export function connectTerminalSocket(): Socket {
  return io('/terminal', {
    path: '/socket.io',
    auth: { token: tokenStorage.getAccessToken() },
  });
}
