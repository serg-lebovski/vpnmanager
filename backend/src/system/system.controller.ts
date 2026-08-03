import { Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { BackupService } from './backup.service';
import { LogsService } from './logs.service';
import { UpdateService } from './update.service';

@Controller('system')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class SystemController {
  constructor(
    private readonly backupService: BackupService,
    private readonly updateService: UpdateService,
    private readonly logsService: LogsService,
  ) {}

  @Get('backup')
  downloadBackup(@Res() res: Response) {
    this.backupService.streamDatabaseDump(res);
  }

  @Get('version')
  getVersion() {
    return this.updateService.getVersion();
  }

  @Post('update')
  triggerUpdate() {
    this.updateService.triggerUpdate();
    return { message: 'Обновление запущено — приложение перезапустится через несколько минут' };
  }

  @Get('logs')
  async getLogs(@Query('service') service = 'backend', @Query('tail') tail = '300') {
    const logs = await this.logsService.getLogs(service, Number(tail));
    return { logs };
  }

  @Get('logs/download')
  async downloadLogs(@Query('service') service = 'backend', @Query('tail') tail = '2000', @Res() res: Response) {
    const logs = await this.logsService.getLogs(service, Number(tail));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${service}-${new Date().toISOString().replace(/[:.]/g, '-')}.log"`);
    res.send(logs);
  }
}
