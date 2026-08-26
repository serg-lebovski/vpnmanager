import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import * as QRCode from 'qrcode';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreatePeerDto } from './dto/create-peer.dto';
import { UpdatePeerDto } from './dto/update-peer.dto';
import { PeersService } from './peers.service';

// HTTP-заголовки — только Latin-1/ASCII на уровне байт; сырая кириллица в filename="..."
// либо обрубается до мусора при отправке, либо браузер не может её разобрать — скачивание
// молча не срабатывает (пойманный вживую регресс: имена peers из Telegram-бота — кириллица,
// см. buildDownloadableConfig). Отдаём и ASCII-фолбэк (для совсем старых клиентов), и
// RFC 5987/6266 filename*=UTF-8''... — так его показывают все современные браузеры.
function contentDispositionHeader(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_') || 'peer.conf';
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

@Controller('peers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PeersController {
  constructor(private readonly peersService: PeersService) {}

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser, @Query('organizationId') organizationId?: string) {
    return this.peersService.findAllForRequester(user, organizationId);
  }

  // Для формы создания peer — какие обычные серверы можно выбрать напрямую (см.
  // Organization.allowedServerIds). Доступно всем ролям (не только super_admin, в
  // отличие от /servers) — сервис сам скоупит по организации требующего.
  @Get('allowed-servers')
  getAllowedServers(@CurrentUser() user: AuthenticatedUser) {
    return this.peersService.getAllowedServersForRequester(user);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePeerDto) {
    return this.peersService.create(user, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdatePeerDto) {
    return this.peersService.update(user, id, dto);
  }

  @Delete(':id')
  revoke(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.peersService.revoke(user, id);
  }

  // Безвозвратное удаление — только для уже отозванных peers (см. PeersService.purge).
  @Delete(':id/purge')
  purge(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.peersService.purge(user, id);
  }

  @Get(':id/config')
  async downloadConfig(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Res() res: Response) {
    const { filename, content } = await this.peersService.getDownloadableConfig(user, id);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', contentDispositionHeader(filename));
    res.send(content);
  }

  // Дополнительный формат конфига — не заменяет /config (.conf для wg-quick/awg-quick),
  // а .vpn для официального приложения AmneziaVPN (см. PeersService.getAmneziaAppConfig).
  // Работает и для обычного одно-протокольного peer'а, и для пары мультиконфига.
  @Get(':id/amnezia-config')
  async downloadAmneziaConfig(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Res() res: Response) {
    const { filename, content } = await this.peersService.getAmneziaAppConfig(user, id);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', contentDispositionHeader(filename));
    res.send(content);
  }

  @Get(':id/qrcode')
  async downloadQrCode(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Res() res: Response) {
    const { content } = await this.peersService.getDownloadableConfig(user, id);
    const png = await QRCode.toBuffer(content, { type: 'png', width: 400 });
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  }

  // QR для .vpn (AmneziaVPN) — тот же принцип, что и /qrcode для обычного .conf, просто
  // кодирует содержимое getAmneziaAppConfig (саму строку "vpn://...") вместо .conf-текста.
  @Get(':id/amnezia-qrcode')
  async downloadAmneziaQrCode(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Res() res: Response) {
    const { content } = await this.peersService.getAmneziaAppConfig(user, id);
    const png = await QRCode.toBuffer(content, { type: 'png', width: 400 });
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  }
}
