import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PeersModule } from '../peers/peers.module';
import { SshModule } from '../ssh/ssh.module';
import { VpnModule } from '../vpn/vpn.module';
import { ServerProtocol } from './server-protocol.entity';
import { Server } from './server.entity';
import { ServersController } from './servers.controller';
import { ServersService } from './servers.service';

@Module({
  imports: [TypeOrmModule.forFeature([Server, ServerProtocol]), SshModule, VpnModule, PeersModule],
  controllers: [ServersController],
  providers: [ServersService],
  exports: [ServersService],
})
export class ServersModule {}
