import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateServerDto } from './dto/create-server.dto';
import { InstallProtocolDto } from './dto/install-protocol.dto';
import { ServersService } from './servers.service';

@Controller('servers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class ServersController {
  constructor(private readonly serversService: ServersService) {}

  @Get()
  findAll() {
    return this.serversService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.serversService.findOneOrFail(id);
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

  @Post(':id/protocols')
  installProtocol(@Param('id') id: string, @Body() dto: InstallProtocolDto) {
    return this.serversService.installProtocol(id, dto);
  }

  @Post('protocols/:serverProtocolId/scan')
  scanAndImport(@Param('serverProtocolId') serverProtocolId: string) {
    return this.serversService.scanAndImport(serverProtocolId);
  }

  @Post(':id/detect')
  detectExistingInstallations(@Param('id') id: string) {
    return this.serversService.detectExistingInstallations(id);
  }
}
