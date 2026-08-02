import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Bridge } from '../bridges/bridge.entity';
import { LoadBalancerModule } from '../load-balancer/load-balancer.module';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { Server } from '../servers/server.entity';
import { VpnModule } from '../vpn/vpn.module';
import { Peer } from './peer.entity';
import { PeersController } from './peers.controller';
import { PeersService } from './peers.service';

@Module({
  imports: [TypeOrmModule.forFeature([Peer, ServerProtocol, Server, Bridge]), LoadBalancerModule, VpnModule],
  controllers: [PeersController],
  providers: [PeersService],
  exports: [PeersService],
})
export class PeersModule {}
