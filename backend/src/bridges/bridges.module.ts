import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BridgeLogModule } from '../bridge-log/bridge-log.module';
import { Organization } from '../organizations/organization.entity';
import { Peer } from '../peers/peer.entity';
import { PeersModule } from '../peers/peers.module';
import { ServerProtocol } from '../servers/server-protocol.entity';
import { Server } from '../servers/server.entity';
import { SystemSettings } from '../system/system-settings.entity';
import { VpnModule } from '../vpn/vpn.module';
import { Bridge } from './bridge.entity';
import { BridgeUpstreamCandidate } from './bridge-upstream-candidate.entity';
import { BridgeFailoverService } from './bridge-failover.service';
import { BridgesController } from './bridges.controller';
import { BridgesGateway } from './bridges.gateway';
import { BridgesService } from './bridges.service';

@Module({
  imports: [
    // SystemSettings — только чтение telegramBridgeId при восстановлении моста (см.
    // BridgesService.reapplyTelegramRoutingBestEffort), без зависимости от SystemModule.
    TypeOrmModule.forFeature([Bridge, BridgeUpstreamCandidate, ServerProtocol, Server, Peer, Organization, SystemSettings]),
    PeersModule,
    VpnModule,
    BridgeLogModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [BridgesController],
  providers: [BridgesService, BridgesGateway, BridgeFailoverService],
  exports: [BridgesService],
})
export class BridgesModule {}
