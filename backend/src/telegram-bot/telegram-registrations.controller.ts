import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { BroadcastMessageDto } from './dto/broadcast-message.dto';
import { TelegramRegistrationsService } from './telegram-registrations.service';

// Управление самостоятельной регистрацией через Telegram-бота — только суперадмин: видит
// организации/ИНН клиентов и может рассылать сообщения всем подтверждённым пользователям.
@Controller('telegram-registrations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class TelegramRegistrationsController {
  constructor(private readonly telegramRegistrationsService: TelegramRegistrationsService) {}

  @Get()
  findAll() {
    return this.telegramRegistrationsService.findAll();
  }

  @Post(':id/approve')
  approve(@Param('id') id: string) {
    return this.telegramRegistrationsService.approve(id);
  }

  // Персональная ссылка веб-портала (для клиентов без доступа к Telegram) — генерируется
  // лениво по первому запросу, если у заявки токена ещё нет (см. TelegramRegistration.
  // webToken). Возвращает только сам токен — полный URL (домен/IP панели) собирает фронтенд
  // из своего текущего origin, бэкенд не обязан знать, как панель сейчас доступна снаружи.
  @Get(':id/portal-link')
  getPortalLink(@Param('id') id: string) {
    return this.telegramRegistrationsService.getPortalLink(id);
  }

  // revokePeers по умолчанию true (безопасное поведение по умолчанию — не оставлять
  // работающие peers без присмотра) — фронтенд всегда передаёт его явно после выбора
  // суперадмина в диалоге подтверждения.
  @Delete(':id')
  remove(@Param('id') id: string, @Query('revokePeers') revokePeers?: string) {
    return this.telegramRegistrationsService.remove(id, revokePeers !== 'false');
  }

  @Post('broadcast')
  broadcast(@Body() dto: BroadcastMessageDto) {
    return this.telegramRegistrationsService.broadcast(dto.text, dto.pin ?? false);
  }

  @Get('broadcasts')
  listBroadcasts() {
    return this.telegramRegistrationsService.listBroadcasts();
  }

  @Delete('broadcasts/:id')
  deleteBroadcast(@Param('id') id: string) {
    return this.telegramRegistrationsService.deleteBroadcast(id);
  }

  @Get('logs')
  listLogs() {
    return this.telegramRegistrationsService.listLogs();
  }
}
