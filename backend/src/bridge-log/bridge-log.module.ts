import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BridgeLog } from './bridge-log.entity';
import { BridgeLogService } from './bridge-log.service';

// Листовой модуль без собственных зависимостей — импортируется и VpnModule, и
// BridgesModule, и SystemModule (SettingsService) без риска DI-цикла. См. комментарий в
// bridge-log.service.ts.
@Module({
  imports: [TypeOrmModule.forFeature([BridgeLog])],
  providers: [BridgeLogService],
  exports: [BridgeLogService],
})
export class BridgeLogModule {}
