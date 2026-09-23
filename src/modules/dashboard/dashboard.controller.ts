import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { GroupReportsService } from '../reports/group-reports.service.js';
import { DashboardService } from './dashboard.service.js';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly svc: DashboardService,
    private readonly group: GroupReportsService,
  ) {}

  @Get('group')
  @RequirePermission('reports.view')
  @RequireFeature('multi_property')
  @ApiOperation({ summary: 'Today across every property the user can access (M5)' })
  groupDashboard(@CurrentUser() user: AuthUser) {
    return this.group.dashboard(user);
  }

  @Get('summary')
  @ApiOperation({
    summary:
      'Room counts by status, occupancy (fraction 0-1, occupied / non-out-of-order rooms), usage and recent activity',
  })
  summary(@CurrentUser() user: AuthUser) {
    return this.svc.summary(user);
  }
}
