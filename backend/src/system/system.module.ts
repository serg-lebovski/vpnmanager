import { Module } from '@nestjs/common';
import { BackupService } from './backup.service';
import { SystemController } from './system.controller';
import { UpdateService } from './update.service';

@Module({
  controllers: [SystemController],
  providers: [BackupService, UpdateService],
})
export class SystemModule {}
