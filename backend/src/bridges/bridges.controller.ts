import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { BridgesService } from './bridges.service';
import { CreateBridgeDto } from './dto/create-bridge.dto';
import { SetModeDto } from './dto/set-mode.dto';
import { SetUpstreamDto } from './dto/set-upstream.dto';
import { UpdateBridgeDto } from './dto/update-bridge.dto';

@Controller('bridges')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BridgesController {
  constructor(private readonly bridgesService: BridgesService) {}

  // Доступен всем аутентифицированным ролям — org_admin/org_user должны видеть мост
  // своей организации, чтобы создавать под него peers. Скоуп по организации решает
  // сервис (BridgesService.findAll), не guard.
  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.bridgesService.findAll(user);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN)
  create(@Body() dto: CreateBridgeDto) {
    return this.bridgesService.create(dto);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateBridgeDto) {
    return this.bridgesService.update(id, dto);
  }

  @Post(':id/upstream')
  @Roles(Role.SUPER_ADMIN)
  setUpstream(@Param('id') id: string, @Body() dto: SetUpstreamDto) {
    return this.bridgesService.setUpstream(id, dto.serverProtocolId);
  }

  @Post(':id/mode')
  @Roles(Role.SUPER_ADMIN)
  setMode(@Param('id') id: string, @Body() dto: SetModeDto) {
    return this.bridgesService.setMode(id, dto.mode);
  }

  @Post(':id/rebalance')
  @Roles(Role.SUPER_ADMIN)
  rebalance(@Param('id') id: string) {
    return this.bridgesService.rebalanceNow(id);
  }

  @Delete(':id')
  @Roles(Role.SUPER_ADMIN)
  remove(@Param('id') id: string) {
    return this.bridgesService.remove(id);
  }
}
