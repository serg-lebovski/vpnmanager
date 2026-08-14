import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateServerDto } from './dto/create-server.dto';
import { InstallProtocolDto } from './dto/install-protocol.dto';
import { UpdateServerCredentialsDto } from './dto/update-server-credentials.dto';
import { UpdateServerDto } from './dto/update-server.dto';
import { MtProxyService } from './mtproxy.service';
import { ServersService } from './servers.service';

@Controller('servers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class ServersController {
  constructor(
    private readonly serversService: ServersService,
    private readonly mtProxyService: MtProxyService,
  ) {}

  @Get()
  findAll() {
    return this.serversService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.serversService.findOneOrFail(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateServerDto) {
    return this.serversService.update(id, dto);
  }

  @Patch(':id/credentials')
  updateCredentials(@Param('id') id: string, @Body() dto: UpdateServerCredentialsDto) {
    return this.serversService.updateCredentials(id, dto);
  }

  @Post()
  create(@Body() dto: CreateServerDto) {
    return this.serversService.create(dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.serversService.remove(id);
  }

  @Post(':id/test-connection')
  testConnection(@Param('id') id: string) {
    return this.serversService.testConnection(id);
  }

  @Post(':id/reboot')
  reboot(@Param('id') id: string) {
    return this.serversService.reboot(id);
  }

  @Post(':id/protocols')
  installProtocol(@Param('id') id: string, @Body() dto: InstallProtocolDto) {
    return this.serversService.installProtocol(id, dto);
  }

  @Post('protocols/:serverProtocolId/scan')
  scanAndImport(@Param('serverProtocolId') serverProtocolId: string) {
    return this.serversService.scanAndImport(serverProtocolId);
  }

  @Delete('protocols/:serverProtocolId')
  removeProtocol(@Param('serverProtocolId') serverProtocolId: string) {
    return this.serversService.removeProtocol(serverProtocolId);
  }

  @Post('protocols/:serverProtocolId/check-version')
  checkProtocolVersion(@Param('serverProtocolId') serverProtocolId: string) {
    return this.serversService.checkProtocolVersion(serverProtocolId);
  }

  @Post('protocols/:serverProtocolId/update-package')
  updateProtocolPackage(@Param('serverProtocolId') serverProtocolId: string) {
    return this.serversService.updateProtocolPackage(serverProtocolId);
  }

  @Post(':id/detect')
  detectExistingInstallations(@Param('id') id: string) {
    return this.serversService.detectExistingInstallations(id);
  }

  @Post(':id/fail2ban')
  ensureFail2ban(@Param('id') id: string) {
    return this.serversService.ensureFail2banFor(id);
  }

  // Осознанный сброс TOFU-отпечатка SSH host key (см. Server.sshHostKeyFingerprint) —
  // после легитимной переустановки/смены сервера, иначе подключение отклонялось бы
  // навсегда как возможная подмена (SshHostKeyMismatchError).
  @Post(':id/reset-host-key')
  resetHostKeyFingerprint(@Param('id') id: string) {
    return this.serversService.resetHostKeyFingerprint(id);
  }

  // Постоянный MTProto-proxy для обхода блокировки Telegram у клиентов, устанавливаемый
  // только на self-сервере — см. MtProxyService. GET — посмотреть текущую ссылку без
  // переустановки (переустановка меняет порт+ключ и обрывает уже разосланные ссылки).
  @Get(':id/mtproxy')
  getMtProxyStatus(@Param('id') id: string) {
    return this.mtProxyService.getStatus(id);
  }

  @Post(':id/mtproxy')
  installMtProxy(@Param('id') id: string) {
    return this.mtProxyService.install(id);
  }
}
