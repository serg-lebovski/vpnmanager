import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server as SocketIoServer, Socket } from 'socket.io';

export interface UpdateProgress {
  percent: number;
  step: string;
  done: boolean;
  error?: string;
}

interface AccessTokenPayload {
  type: 'access' | 'refresh';
  role: string;
}

// Прогресс самообновления (UpdateService.triggerUpdate) — операция долгая (git pull +
// сборка образов + пересоздание контейнеров) и в конце неизбежно рвёт это же
// соединение: backend пересоздаёт сам себя последним шагом (см. комментарий в
// update.service.ts) — фронтенд должен сам обработать обрыв как "скорее всего, почти
// готово", а не как ошибку. Та же ручная проверка JWT в handshake, что и в
// DashboardGateway/BridgesGateway (socket.io handshake не проходит через обычный
// Nest guard-стек).
@WebSocketGateway({ namespace: 'system', cors: { origin: '*' } })
export class SystemGateway implements OnGatewayConnection {
  @WebSocketServer()
  private readonly server: SocketIoServer;

  private readonly logger = new Logger(SystemGateway.name);

  constructor(private readonly jwtService: JwtService) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = client.handshake.auth?.token as string | undefined;
    if (!token) {
      client.disconnect(true);
      return;
    }
    try {
      const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token);
      if (payload.type !== 'access' || payload.role !== 'super_admin') {
        client.disconnect(true);
        return;
      }
    } catch (error) {
      this.logger.debug(`Отклонено WS-подключение к прогрессу обновления: ${(error as Error).message}`);
      client.disconnect(true);
    }
  }

  broadcastUpdateProgress(progress: UpdateProgress): void {
    this.server?.emit('update-progress', progress);
  }
}
