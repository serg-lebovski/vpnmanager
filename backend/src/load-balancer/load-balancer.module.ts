import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Bridge } from '../bridges/bridge.entity';
import { Peer } from '../peers/peer.entity';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { LoadBalancerService } from './load-balancer.service';

@Module({
  imports: [TypeOrmModule.forFeature([ServerProtocol, Peer, Bridge])],
  providers: [LoadBalancerService],
  exports: [LoadBalancerService],
})
export class LoadBalancerModule {}
