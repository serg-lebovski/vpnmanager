import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LogLevel } from '../common/enums';
import { BridgeLog } from './bridge-log.entity';

// Отдельный, ни от чего не зависящий "листовой" модуль (см. bridge-log.module.ts) — нужен и
// VpnProvisioningService (VpnModule), и SettingsService (SystemModule), и самому
// BridgesModule; если бы это жило внутри BridgesModule, импорт из VpnModule создал бы
// DI-цикл (BridgesModule уже импортирует VpnModule).
@Injectable()
export class BridgeLogService {
  private readonly logger = new Logger(BridgeLogService.name);

  constructor(@InjectRepository(BridgeLog) private readonly repository: Repository<BridgeLog>) {}

  // Best-effort и без await со стороны большинства вызывающих мест — запись в журнал не
  // должна ронять или задерживать саму операцию с мостом, ради которой её пишут.
  async log(level: LogLevel, message: string, bridgeId?: string | null, bridgeName?: string | null): Promise<void> {
    try {
      await this.repository.insert({ level, message, bridgeId: bridgeId ?? null, bridgeName: bridgeName ?? null });
    } catch (error) {
      this.logger.warn(`Не удалось записать событие в журнал мостов: ${(error as Error).message}`);
    }
  }

  async list(limit = 300): Promise<BridgeLog[]> {
    return this.repository.find({ order: { createdAt: 'DESC' }, take: limit });
  }
}
