import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { Organization } from '../organizations/organization.entity';
import { Peer } from '../peers/peer.entity';
import { Server } from '../servers/server.entity';
import { VpnModule } from '../vpn/vpn.module';
import { DashboardController } from './dashboard.controller';
import { DashboardGateway } from './dashboard.gateway';
import { DashboardService } from './dashboard.service';
import { PeerConnectivityAlertService } from './peer-connectivity-alert.service';
import { PeerTrafficSample } from './peer-traffic-sample.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Server, Peer, PeerTrafficSample, Organization]),
    VpnModule,
    NotificationsModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [DashboardController],
  providers: [DashboardGateway, DashboardService, PeerConnectivityAlertService],
})
export class DashboardModule {}
