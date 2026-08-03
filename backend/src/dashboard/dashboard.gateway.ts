import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server as SocketIoServer, Socket } from 'socket.io';
import { DashboardService, DashboardSnapshot } from './dashboard.service';

interface AccessTokenPayload {
  type: 'access' | 'refresh';
  role: string;
}

// Отдельный namespace, а не общий guard/interceptor — socket.io-хендшейк не проходит
// через обычный HTTP middleware-стек Nest (JwtAuthGuard/RolesGuard рассчитаны на
// Express-запрос), поэтому токен проверяется вручную при подключении. Дашборд показывает
// инфраструктуру всех клиентских серверов сразу — доступ только суперадмину, то же самое
// разделение, что и у /servers.
@WebSocketGateway({ namespace: 'dashboard', cors: { origin: '*' } })
export class DashboardGateway implements OnGatewayConnection {
  @WebSocketServer()
  private readonly server: SocketIoServer;

  private readonly logger = new Logger(DashboardGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly dashboardService: DashboardService,
  ) {
    this.dashboardService.setGateway(this);
  }

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
      this.logger.debug(`Отклонено WS-подключение к дашборду: ${(error as Error).message}`);
      client.disconnect(true);
      return;
    }

    const snapshot = this.dashboardService.getLastSnapshot();
    if (snapshot) {
      client.emit('snapshot', snapshot);
    }
  }

  broadcast(snapshot: DashboardSnapshot): void {
    this.server?.emit('snapshot', snapshot);
  }
}
