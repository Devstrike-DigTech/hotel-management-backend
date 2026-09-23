import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { ClientIp, CurrentUser, GroupWide, RequirePermission } from '../../common/decorators/index.js';
import { CheckLimit, RequireFeature } from '../entitlements/entitlements.decorators.js';
import { CreatePropertyDto, CurrentPropertyDto, UpdatePropertyM5Dto } from './property.dto.js';
import { PropertyService } from './property.service.js';

@ApiTags('Property')
@ApiBearerAuth()
@Controller('property')
export class PropertyController {
  constructor(private readonly svc: PropertyService) {}

  @Get()
  @ApiOperation({ summary: 'The current property (X-Property-Id or the user default)' })
  get(@CurrentUser() user: AuthUser) {
    return this.svc.get(user);
  }

  @Patch()
  @RequirePermission('settings.manage')
  @ApiOperation({
    summary: 'Update the current property profile (accentColor/logoUrl need booking_site_branding)',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdatePropertyM5Dto,
    @ClientIp() ip?: string,
  ) {
    return this.svc.update(user, dto, ip);
  }
}

/** M5: the hotel group's properties (tenant-wide; X-Property-Id is ignored). */
@ApiTags('Properties')
@ApiBearerAuth()
@GroupWide()
@Controller()
export class PropertiesController {
  constructor(private readonly svc: PropertyService) {}

  @Get('properties')
  @ApiOperation({ summary: 'Properties the user can access, oldest first' })
  list(@CurrentUser() user: AuthUser) {
    return this.svc.list(user);
  }

  @Post('properties')
  @RequirePermission('properties.manage')
  @RequireFeature('multi_property')
  @CheckLimit('max_properties')
  @ApiOperation({ summary: 'Add a property to the group (Pro: 3, Enterprise: unlimited)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePropertyDto, @ClientIp() ip?: string) {
    return this.svc.create(user, dto, ip);
  }

  @Get('properties/:id')
  getOne(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getById(user, id);
  }

  @Patch('properties/:id')
  @RequirePermission('settings.manage')
  updateOne(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePropertyM5Dto, @ClientIp() ip?: string) {
    return this.svc.updateById(user, id, dto, ip);
  }

  @Put('me/current-property')
  @HttpCode(200)
  @ApiOperation({ summary: 'Save the property used when a request has no X-Property-Id' })
  setCurrent(@CurrentUser() user: AuthUser, @Body() dto: CurrentPropertyDto) {
    return this.svc.setCurrent(user, dto.propertyId);
  }
}
