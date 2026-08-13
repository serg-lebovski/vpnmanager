import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PeerDeviceType, VpnProtocol } from '../common/enums';
import { IssuePortalConfigDto } from './dto/issue-portal-config.dto';
import { RegisterViaPortalDto } from './dto/register-via-portal.dto';
import { TelegramPortalService } from './telegram-portal.service';

// Публичный контроллер (без JwtAuthGuard/RolesGuard намеренно) — веб-канал регистрации/
// доступа к конфигам для клиентов без Telegram, см. TelegramPortalService. Единственная
// защита — сам токен в URL; глобальный ThrottlerGuard (см. app.module.ts) + отдельный,
// более строгий лимит на /register (создаёт строки в БД, как логин) — та же вторая линия
// защиты, что и у AuthController.login.
@Controller('telegram-portal')
export class TelegramPortalController {
  constructor(private readonly telegramPortalService: TelegramPortalService) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  register(@Body() dto: RegisterViaPortalDto) {
    return this.telegramPortalService.register(dto.orgQuery, dto.fullName);
  }

  @Get(':token')
  getStatus(@Param('token') token: string) {
    return this.telegramPortalService.getStatus(token);
  }

  @Get(':token/upstream-options')
  listUpstreamOptions(@Param('token') token: string, @Query('protocol') protocol: VpnProtocol) {
    return this.telegramPortalService.listUpstreamOptions(token, protocol);
  }

  @Post(':token/config')
  issueConfig(@Param('token') token: string, @Body() dto: IssuePortalConfigDto) {
    return this.telegramPortalService.issueConfig(token, dto);
  }

  // Повторное скачивание уже выданного конфига — в отличие от POST .../config не трогает
  // ключи/сервер, GET осознанно (идемпотентно, ничего не меняет).
  @Get(':token/config/:deviceType')
  downloadConfig(@Param('token') token: string, @Param('deviceType') deviceType: PeerDeviceType) {
    return this.telegramPortalService.downloadConfig(token, deviceType);
  }

  // Реально провижинит временный процесс на self-сервере по SSH (см.
  // TelegramMtProxyService) — заметно дороже остальных ручек контроллера, отдельный лимит
  // не даёт злоупотребить этим как способом просадить self-сервер частыми запросами.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':token/mtproxy')
  requestMtProxy(@Param('token') token: string) {
    return this.telegramPortalService.requestMtProxy(token);
  }
}
