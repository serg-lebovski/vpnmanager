import { Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { BackupService } from './backup.service';
import { UpdateService } from './update.service';

@Controller('system')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class SystemController {
  constructor(
    private readonly backupService: BackupService,
    private readonly updateService: UpdateService,
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
}
