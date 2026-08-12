import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { TelegramContentKind, Role } from '../common/enums';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateTelegramContentDto } from './dto/create-telegram-content.dto';
import { TelegramContentService } from './telegram-content.service';

// Управление новостями и инструкциями бота — только суперадмин, как и остальная вкладка
// Telegram. Два набора роутов (news/instructions) вместо одного с query-параметром kind —
// понятнее на фронтенде (два независимых api-модуля) и в самих URL.
@Controller('telegram-content')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class TelegramContentController {
  constructor(private readonly telegramContentService: TelegramContentService) {}

  @Get('news')
  listNews() {
    return this.telegramContentService.list(TelegramContentKind.NEWS);
  }

  @Post('news')
  createNews(@Body() dto: CreateTelegramContentDto) {
    return this.telegramContentService.create(TelegramContentKind.NEWS, dto);
  }

  @Delete('news/:id')
  removeNews(@Param('id') id: string) {
    return this.telegramContentService.remove(id);
  }

  @Get('instructions')
  listInstructions() {
    return this.telegramContentService.list(TelegramContentKind.INSTRUCTION);
  }

  @Post('instructions')
  createInstructions(@Body() dto: CreateTelegramContentDto) {
    return this.telegramContentService.create(TelegramContentKind.INSTRUCTION, dto);
  }

  @Delete('instructions/:id')
  removeInstructions(@Param('id') id: string) {
    return this.telegramContentService.remove(id);
  }
}
