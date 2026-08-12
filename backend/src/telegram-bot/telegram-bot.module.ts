import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { Organization } from '../organizations/organization.entity';
import { PeersModule } from '../peers/peers.module';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramBroadcast } from './telegram-broadcast.entity';
import { TelegramRegistration } from './telegram-registration.entity';
import { TelegramRegistrationsController } from './telegram-registrations.controller';
import { TelegramRegistrationsService } from './telegram-registrations.service';

@Module({
  imports: [TypeOrmModule.forFeature([TelegramRegistration, TelegramBroadcast, Organization]), NotificationsModule, PeersModule],
  controllers: [TelegramRegistrationsController],
  providers: [TelegramBotService, TelegramRegistrationsService],
})
export class TelegramBotModule {}
