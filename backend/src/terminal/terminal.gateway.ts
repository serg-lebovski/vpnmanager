import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { NodeSSH } from 'node-ssh';
import { ClientChannel } from 'ssh2';
import { Server as SocketIoServer, Socket } from 'socket.io';
import { Repository } from 'typeorm';
import { Server } from '../servers/server.entity';
import { SshService } from '../ssh/ssh.service';
import { VpnProvisioningService } from '../vpn/vpn-provisioning.service';

interface AccessTokenPayload {
  type: 'access' | 'refresh';
  role: string;
}

interface TerminalSession {
  ssh: NodeSSH;
  channel: ClientChannel;
}

// Веб-терминал SSH к добавленным серверам прямо из панели (backlog из README, ранее
// сознательно отложенный пользователем — "не приоритет, можешь пока просто
// запланировать"). SUPER_ADMIN-only: терминал даёт полный интерактивный root-доступ к
// серверу, строже даже обычного /servers (там хотя бы нет произвольных команд). Та же
// ручная проверка JWT в handshake, что и у DashboardGateway/SystemGateway (socket.io
// handshake не проходит через обычный Nest guard-стек).
//
// В отличие от VpnProvisioningService/SshService.withConnection (открыть — выполнить
// команду — сразу закрыть), здесь соединение живёт весь срок интерактивной сессии
// (минуты/часы) — держим его в this.sessions по socket.id и закрываем явно на disconnect
// или при явном закрытии канала сервером.
@WebSocketGateway({ namespace: 'terminal', cors: { origin: '*' } })
export class TerminalGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private readonly server: SocketIoServer;

  private readonly logger = new Logger(TerminalGateway.name);
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly sshService: SshService,
    private readonly vpnProvisioningService: VpnProvisioningService,
    @InjectRepository(Server) private readonly serversRepository: Repository<Server>,
  ) {}

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
      }
    } catch (error) {
      this.logger.debug(`Отклонено WS-подключение к терминалу: ${(error as Error).message}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.closeSession(client.id);
  }

  private closeSession(socketId: string): void {
    const session = this.sessions.get(socketId);
    if (!session) {
      return;
    }
    this.sessions.delete(socketId);
    try {
      session.channel.end();
    } catch {
      // Канал мог уже закрыться сам (например, "exit" в шелле) — не мешает освободить SSH.
    }
    session.ssh.dispose();
  }

  // Клиент присылает это сразу после подключения к namespace, выбрав сервер в UI —
  // отдельным событием, а не через handshake auth, потому что до этого момента фронтенду
  // ещё может быть неизвестно, к какому именно серверу подключаться (общий диалог "Терминал").
  @SubscribeMessage('start')
  async handleStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { serverId: string; cols?: number; rows?: number },
  ): Promise<void> {
    // Повторный "start" в уже открытой сессии (например, пользователь выбрал другой
    // сервер, не переоткрывая сокет) — сначала закрываем предыдущий канал.
    this.closeSession(client.id);

    const server = await this.serversRepository.findOne({ where: { id: body.serverId } });
    if (!server) {
      client.emit('error', 'Сервер не найден');
      return;
    }

    try {
      const connection = this.vpnProvisioningService.connectionParams(server);
      const ssh = await this.sshService.connect(connection);
      const channel = await ssh.requestShell({
        term: 'xterm-256color',
        cols: body.cols && body.cols > 0 ? body.cols : 80,
        rows: body.rows && body.rows > 0 ? body.rows : 24,
      });
      this.sessions.set(client.id, { ssh, channel });

      channel.on('data', (chunk: Buffer) => client.emit('data', chunk.toString('utf-8')));
      channel.stderr.on('data', (chunk: Buffer) => client.emit('data', chunk.toString('utf-8')));
      channel.on('close', () => {
        client.emit('closed');
        this.closeSession(client.id);
      });

      client.emit('ready');
    } catch (error) {
      client.emit('error', `Не удалось подключиться: ${(error as Error).message}`);
    }
  }

  @SubscribeMessage('input')
  handleInput(@ConnectedSocket() client: Socket, @MessageBody() data: string): void {
    this.sessions.get(client.id)?.channel.write(data);
  }

  @SubscribeMessage('resize')
  handleResize(@ConnectedSocket() client: Socket, @MessageBody() body: { cols: number; rows: number }): void {
    this.sessions.get(client.id)?.channel.setWindow(body.rows, body.cols, 0, 0);
  }
}
