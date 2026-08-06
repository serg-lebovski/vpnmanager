import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Bridge } from '../bridges/bridge.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Server } from '../servers/server.entity';
import { VpnModule } from '../vpn/vpn.module';
import { BackupService } from './backup.service';
import { CertbotService } from './certbot.service';
import { LogsService } from './logs.service';
import { NginxConfigService } from './nginx-config.service';
import { RestoreService } from './restore.service';
import { SettingsService } from './settings.service';
import { SystemController } from './system.controller';
import { SystemGateway } from './system.gateway';
import { SystemSettings } from './system-settings.entity';
import { UpdateService } from './update.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([SystemSettings, Bridge, Server]),
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
  controllers: [SystemController],
  providers: [BackupService, UpdateService, SystemGateway, LogsService, CertbotService, NginxConfigService, SettingsService, RestoreService],
})
export class SystemModule {}
