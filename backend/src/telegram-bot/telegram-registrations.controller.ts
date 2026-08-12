import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
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

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.telegramRegistrationsService.remove(id);
  }

  @Post('broadcast')
  broadcast(@Body() dto: BroadcastMessageDto) {
    return this.telegramRegistrationsService.broadcast(dto.text);
  }
}
