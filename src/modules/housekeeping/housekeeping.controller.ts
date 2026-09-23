import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';

@ApiTags('Housekeeping')
@ApiBearerAuth()
@RequireFeature('housekeeping')
@Controller('housekeeping')
export class HousekeepingController {
  /** Stub for M1: proves feature gating end to end. */
  @Get('tasks')
  @ApiOperation({ summary: 'Housekeeping tasks (requires the housekeeping feature)' })
  tasks(): unknown[] {
    return [];
  }
}
