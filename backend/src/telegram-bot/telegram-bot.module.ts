import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { Organization } from '../organizations/organization.entity';
import { PeersModule } from '../peers/peers.module';
import { Server } from '../servers/server.entity';
import { SshModule } from '../ssh/ssh.module';
import { VpnModule } from '../vpn/vpn.module';
import { TelegramBotLog } from './telegram-bot-log.entity';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramBroadcast } from './telegram-broadcast.entity';
import { TelegramContentController } from './telegram-content.controller';
import { TelegramContentPost } from './telegram-content-post.entity';
import { TelegramContentService } from './telegram-content.service';
import { TelegramMtProxyService } from './telegram-mtproxy.service';
import { TelegramPortalController } from './telegram-portal.controller';
import { TelegramPortalService } from './telegram-portal.service';
import { TelegramRegistration } from './telegram-registration.entity';
import { TelegramRegistrationsController } from './telegram-registrations.controller';
import { TelegramRegistrationsService } from './telegram-registrations.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([TelegramRegistration, TelegramBroadcast, TelegramBotLog, TelegramContentPost, Organization, Server]),
    NotificationsModule,
    PeersModule,
    SshModule,
    VpnModule,
  ],
  controllers: [TelegramRegistrationsController, TelegramContentController, TelegramPortalController],
  providers: [TelegramBotService, TelegramRegistrationsService, TelegramContentService, TelegramPortalService, TelegramMtProxyService],
})
export class TelegramBotModule {}
