import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BridgesModule } from '../bridges/bridges.module';
import { Peer } from '../peers/peer.entity';
import { PeersModule } from '../peers/peers.module';
import { SshModule } from '../ssh/ssh.module';
import { VpnModule } from '../vpn/vpn.module';
import { MtProxyService } from './mtproxy.service';
import { ServerProtocol } from './server-protocol.entity';
import { Server } from './server.entity';
import { ServersController } from './servers.controller';
import { ServersService } from './servers.service';

@Module({
  imports: [TypeOrmModule.forFeature([Server, ServerProtocol, Peer]), SshModule, VpnModule, PeersModule, BridgesModule],
  controllers: [ServersController],
  providers: [ServersService, MtProxyService],
  // MtProxyService экспортирован — используется и из TelegramBotModule (портал показывает
  // постоянную ссылку на этом же self-сервере, см. TelegramPortalService).
  exports: [ServersService, MtProxyService],
})
export class ServersModule {}
