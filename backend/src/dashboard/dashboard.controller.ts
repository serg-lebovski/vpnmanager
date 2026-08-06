import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/enums';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { DashboardService, TrafficRange } from './dashboard.service';

const VALID_RANGES: TrafficRange[] = ['day', 'week', 'month'];

// SUPER_ADMIN-only — та же граница, что у живого дашборда (WS namespace 'dashboard'
// пускает только super_admin, см. dashboard.gateway.ts).
@Controller('dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  private parseRange(range?: string): TrafficRange {
    return VALID_RANGES.includes(range as TrafficRange) ? (range as TrafficRange) : 'day';
  }

  @Get('traffic/by-server')
  getTrafficByServer(@Query('range') range?: string) {
    return this.dashboardService.getTrafficByServer(this.parseRange(range));
  }

  @Get('traffic/by-peer')
  getTrafficByPeer(@Query('range') range?: string) {
    return this.dashboardService.getTrafficByPeer(this.parseRange(range));
  }

  @Get('traffic/monthly')
  getTrafficMonthly(@Query('months') months?: string) {
    const parsed = Number(months);
    return this.dashboardService.getTrafficMonthly(Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 24) : 6);
  }
}
