import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Peer } from '../peers/peer.entity';
import { PeersModule } from '../peers/peers.module';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { Server } from '../servers/server.entity';
import { VpnModule } from '../vpn/vpn.module';
import { Bridge } from './bridge.entity';
import { BridgesController } from './bridges.controller';
import { BridgesService } from './bridges.service';

@Module({
  imports: [TypeOrmModule.forFeature([Bridge, ServerProtocol, Server, Peer]), PeersModule, VpnModule],
  controllers: [BridgesController],
  providers: [BridgesService],
})
export class BridgesModule {}
