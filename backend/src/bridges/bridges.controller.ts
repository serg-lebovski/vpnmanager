import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { BridgesService } from './bridges.service';
import { CreateBridgeDto } from './dto/create-bridge.dto';
import { SetModeDto } from './dto/set-mode.dto';
import { SetUpstreamDto } from './dto/set-upstream.dto';

@Controller('bridges')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class BridgesController {
  constructor(private readonly bridgesService: BridgesService) {}

  @Get()
  findAll() {
    return this.bridgesService.findAll();
  }

  @Post()
  create(@Body() dto: CreateBridgeDto) {
    return this.bridgesService.create(dto);
  }

  @Post(':id/upstream')
  setUpstream(@Param('id') id: string, @Body() dto: SetUpstreamDto) {
    return this.bridgesService.setUpstream(id, dto.serverProtocolId);
  }

  @Post(':id/mode')
  setMode(@Param('id') id: string, @Body() dto: SetModeDto) {
    return this.bridgesService.setMode(id, dto.mode);
  }

  @Post(':id/rebalance')
  rebalance(@Param('id') id: string) {
    return this.bridgesService.rebalanceNow(id);
  }
}
