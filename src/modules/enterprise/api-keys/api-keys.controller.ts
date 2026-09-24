import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import type { AuthUser, PlatformPrincipal } from '../../../common/auth-types.js';
import { ClientIp, CurrentPlatformUser, CurrentUser, GroupWide, PlatformOnly, RequirePermission } from '../../../common/decorators/index.js';
import { RequireFeature } from '../../entitlements/entitlements.decorators.js';
import { PlatformPermissionRequired } from '../../platform/security/platform-permissions.js';
import { SCOPE_CODES } from './api-keys.logic.js';
import { ApiKeysService } from './api-keys.service.js';

export class UpdateApiKeyDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(60) name?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsIn(SCOPE_CODES as string[], { each: true }) scopes?: string[];
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) propertyIds?: string[] | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) ipAllowlist?: string[];
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsDateString() expiresAt?: string | null;
}

export class CreateApiKeyDto extends UpdateApiKeyDto {
  @IsString() @MinLength(3) @MaxLength(60) declare name: string;
  @IsIn(['LIVE', 'TEST']) environment!: 'LIVE' | 'TEST';
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsIn(SCOPE_CODES as string[], { each: true }) declare scopes: string[];
}

export class UsageQueryDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
}

@ApiTags('API keys')
@ApiBearerAuth()
@RequireFeature('api_access')
@GroupWide()
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get('scopes') @RequirePermission('integrations.view')
  scopes() {
    return this.keys.scopes();
  }

  @Get('usage') @RequirePermission('integrations.view')
  usage(@CurrentUser() u: AuthUser, @Query() q: UsageQueryDto) {
    return this.keys.usage(u.tenantId, q);
  }

  @Get() @RequirePermission('integrations.view')
  list(@CurrentUser() u: AuthUser) {
    return this.keys.list(u);
  }

  @Get(':id') @RequirePermission('integrations.view')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.keys.get(u, id);
  }

  @Post() @RequirePermission('integrations.manage')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateApiKeyDto, @ClientIp() ip?: string) {
    return this.keys.create(u, dto, ip);
  }

  @Patch(':id') @RequirePermission('integrations.manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateApiKeyDto, @ClientIp() ip?: string) {
    return this.keys.update(u, id, dto, ip);
  }

  @Post(':id/rotate') @RequirePermission('integrations.manage') @HttpCode(200)
  rotate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.keys.rotate(u, id, ip);
  }

  @Post(':id/revoke') @RequirePermission('integrations.manage') @HttpCode(200)
  revoke(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.keys.revoke(u, id, ip);
  }

  @Delete(':id') @RequirePermission('integrations.manage')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    await this.keys.revoke(u, id, ip);
    return { success: true };
  }
}

@ApiTags('API keys')
@ApiBearerAuth()
@RequireFeature('api_access')
@GroupWide()
@Controller('developers')
export class DevelopersController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get('quickstart') @RequirePermission('integrations.view')
  quickstart(@CurrentUser() u: AuthUser) {
    return this.keys.quickstart(u);
  }
}

@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformOnly()
@Controller('platform')
export class PlatformApiUsageController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get('api-usage') @PlatformPermissionRequired('tenants.view')
  usage(@CurrentPlatformUser() p: PlatformPrincipal, @Query() q: UsageQueryDto) {
    return this.keys.platformUsage(p, q);
  }

  @Get('tenants/:id/api-usage') @PlatformPermissionRequired('tenants.view')
  tenantUsage(@Param('id', ParseUUIDPipe) id: string, @Query() q: UsageQueryDto) {
    return this.keys.usage(id, q);
  }
}
