import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { CurrentUser } from '../../common/decorators/index.js';
import { DashboardService } from './dashboard.service.js';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Get('summary')
  @ApiOperation({
    summary:
      'Room counts by status, occupancy (fraction 0-1, occupied / non-out-of-order rooms), usage and recent activity',
  })
  summary(@CurrentUser() user: AuthUser) {
    return this.svc.summary(user);
  }
}
