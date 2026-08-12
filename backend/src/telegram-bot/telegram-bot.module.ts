import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { Organization } from '../organizations/organization.entity';
import { PeersModule } from '../peers/peers.module';
import { TelegramBotLog } from './telegram-bot-log.entity';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramBroadcast } from './telegram-broadcast.entity';
import { TelegramContentController } from './telegram-content.controller';
import { TelegramContentPost } from './telegram-content-post.entity';
import { TelegramContentService } from './telegram-content.service';
import { TelegramRegistration } from './telegram-registration.entity';
import { TelegramRegistrationsController } from './telegram-registrations.controller';
import { TelegramRegistrationsService } from './telegram-registrations.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([TelegramRegistration, TelegramBroadcast, TelegramBotLog, TelegramContentPost, Organization]),
    NotificationsModule,
    PeersModule,
  ],
  controllers: [TelegramRegistrationsController, TelegramContentController],
  providers: [TelegramBotService, TelegramRegistrationsService, TelegramContentService],
})
export class TelegramBotModule {}
