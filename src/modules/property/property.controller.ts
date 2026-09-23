import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { UpdatePropertyDto } from './property.dto.js';
import { PropertyService } from './property.service.js';

@ApiTags('Property')
@ApiBearerAuth()
@Controller('property')
export class PropertyController {
  constructor(private readonly svc: PropertyService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.svc.get(user);
  }

  @Patch()
  @RequirePermission('settings.manage')
  @ApiOperation({
    summary: 'Update the hotel profile (accentColor/logoUrl need booking_site_branding)',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdatePropertyDto,
    @ClientIp() ip?: string,
  ) {
    return this.svc.update(user, dto, ip);
  }
}
