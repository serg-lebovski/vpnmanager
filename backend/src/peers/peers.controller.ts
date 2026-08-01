import { Body, Controller, Delete, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import * as QRCode from 'qrcode';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreatePeerDto } from './dto/create-peer.dto';
import { PeersService } from './peers.service';

@Controller('peers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PeersController {
  constructor(private readonly peersService: PeersService) {}

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser, @Query('organizationId') organizationId?: string) {
    return this.peersService.findAllForRequester(user, organizationId);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePeerDto) {
    return this.peersService.create(user, dto);
  }

  @Delete(':id')
  revoke(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.peersService.revoke(user, id);
  }

  @Get(':id/config')
  async downloadConfig(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Res() res: Response) {
    const { filename, content } = await this.peersService.getDownloadableConfig(user, id);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  }

  @Get(':id/qrcode')
  async downloadQrCode(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Res() res: Response) {
    const { content } = await this.peersService.getDownloadableConfig(user, id);
    const png = await QRCode.toBuffer(content, { type: 'png', width: 400 });
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  }
}
