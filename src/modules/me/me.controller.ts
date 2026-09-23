import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { CurrentUser } from '../../common/decorators/index.js';
import { MeService } from './me.service.js';

@ApiTags('Me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get()
  @ApiOperation({
    summary: 'Current staff user, tenant, subscription and entitlements',
  })
  get(@CurrentUser() user: AuthUser) {
    return this.me.get(user);
  }
}
