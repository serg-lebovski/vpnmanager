import { Body, Controller, Get, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { BackupService } from './backup.service';
import { LogsService } from './logs.service';
import { RenewCertificateDto } from './dto/renew-certificate.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { SettingsService } from './settings.service';
import { UpdateService } from './update.service';

@Controller('system')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class SystemController {
  constructor(
    private readonly backupService: BackupService,
    private readonly updateService: UpdateService,
    private readonly logsService: LogsService,
    private readonly settingsService: SettingsService,
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

  @Get('settings')
  getSettings() {
    return this.settingsService.getOrCreate();
  }

  @Patch('settings')
  updateSettings(@Body() dto: UpdateSettingsDto) {
    return this.settingsService.update(dto);
  }

  @Post('certificate/renew')
  renewCertificate(@Body() dto: RenewCertificateDto) {
    return this.settingsService.renewCertificateNow(Boolean(dto.force));
  }
}
