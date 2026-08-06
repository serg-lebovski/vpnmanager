import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemSettings } from '../system/system-settings.entity';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [TypeOrmModule.forFeature([SystemSettings])],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
