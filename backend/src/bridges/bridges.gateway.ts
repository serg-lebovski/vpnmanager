import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server as SocketIoServer, Socket } from 'socket.io';

export interface BridgeSwitchProgress {
  bridgeId: string;
  percent: number;
  step: string;
  done: boolean;
  error?: string;
}

interface AccessTokenPayload {
  type: 'access' | 'refresh';
  role: string;
}

// Прогресс переключения upstream (BridgesService.setUpstream) — операция синхронная
// (несколько последовательных SSH-подключений), сама HTTP-ручка отвечает только по
// завершении. Прогресс-бар в UI подписан на этот канал отдельно от самого HTTP-запроса.
// Тот же паттерн ручной проверки JWT в handshake, что и в DashboardGateway — тем же
// причинам (socket.io handshake не проходит через обычный Nest guard-стек).
@WebSocketGateway({ namespace: 'bridges', cors: { origin: '*' } })
export class BridgesGateway implements OnGatewayConnection {
  @WebSocketServer()
  private readonly server: SocketIoServer;

  private readonly logger = new Logger(BridgesGateway.name);

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
      this.logger.debug(`Отклонено WS-подключение к прогрессу мостов: ${(error as Error).message}`);
      client.disconnect(true);
    }
  }

  broadcastProgress(progress: BridgeSwitchProgress): void {
    this.server?.emit('switch-progress', progress);
  }
}
