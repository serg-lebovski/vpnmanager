import { Socket } from 'net';

// Лёгкая проверка доступности хоста — обычный TCP-коннект без какой-либо сессии поверх
// (без SSH-аутентификации/exec). Используется там, где нужен быстрый и дешёвый сигнал
// "жив ли сервер вообще", а не полноценная проверка конкретного сервиса — например, в
// BridgeFailoverService, где на каждый тик опрашиваются все кандидаты upstream.
export function probeTcpPort(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}
