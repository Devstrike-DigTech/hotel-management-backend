import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { CurrentUser, Roles } from '../../common/decorators/index.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { FrontDeskService } from './front-desk.service.js';

@ApiTags('Front desk')
@ApiBearerAuth()
@RequireFeature('front_desk')
@Controller('front-desk')
export class FrontDeskController {
  constructor(private readonly svc: FrontDeskService) {}

  @Get('today')
  @Roles('OWNER', 'MANAGER', 'FRONT_DESK', 'ACCOUNTANT')
  @ApiOperation({ summary: "Today's arrivals, in-house, departures, day-use, room counts and my shift" })
  today(@CurrentUser() user: AuthUser) {
    return this.svc.today(user);
  }
}
