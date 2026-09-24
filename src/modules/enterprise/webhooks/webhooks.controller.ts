import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import type { AuthUser } from '../../../common/auth-types.js';
import { ClientIp, CurrentUser, GroupWide, RequirePermission } from '../../../common/decorators/index.js';
import { RequireFeature } from '../../entitlements/entitlements.decorators.js';
import { WebhooksService } from './webhooks.service.js';

export class UpdateWebhookEndpointDto {
  @IsOptional() @IsString() @MaxLength(2000) url?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsString({ each: true }) events?: string[];
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(300) description?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) propertyIds?: string[] | null;
  @IsOptional() @IsIn(['ACTIVE', 'DISABLED']) status?: 'ACTIVE' | 'DISABLED';
}

export class CreateWebhookEndpointDto {
  @IsString() @MaxLength(2000) url!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsString({ each: true }) events!: string[];
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(300) description?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) propertyIds?: string[] | null;
}

export class DeliveriesQueryDto {
  @IsOptional() @IsIn(['PENDING', 'RETRYING', 'SUCCEEDED', 'FAILED']) status?: string;
  @IsOptional() @IsString() @MaxLength(60) eventType?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(200) cursor?: string;
}

@ApiTags('Webhooks')
@ApiBearerAuth()
@RequireFeature('api_access')
@GroupWide()
@Controller('webhook-endpoints')
export class WebhookEndpointsController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('events') @RequirePermission('integrations.view')
  events() {
    return this.webhooks.events();
  }

  @Get() @RequirePermission('integrations.view')
  list(@CurrentUser() u: AuthUser) {
    return this.webhooks.list(u);
  }

  @Get(':id') @RequirePermission('integrations.view')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.get(u, id);
  }

  @Post() @RequirePermission('integrations.manage')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateWebhookEndpointDto, @ClientIp() ip?: string) {
    return this.webhooks.create(u, dto, ip);
  }

  @Patch(':id') @RequirePermission('integrations.manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWebhookEndpointDto, @ClientIp() ip?: string) {
    return this.webhooks.update(u, id, dto, ip);
  }

  @Delete(':id') @RequirePermission('integrations.manage')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.webhooks.remove(u, id, ip);
  }

  @Post(':id/rotate-secret') @RequirePermission('integrations.manage') @HttpCode(200)
  rotate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.webhooks.rotateSecret(u, id, ip);
  }

  @Post(':id/test') @RequirePermission('integrations.manage')
  test(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.test(u, id);
  }

  @Get(':id/deliveries') @RequirePermission('integrations.view')
  deliveries(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: DeliveriesQueryDto) {
    return this.webhooks.deliveries(u, id, q);
  }
}

@ApiTags('Webhooks')
@ApiBearerAuth()
@RequireFeature('api_access')
@GroupWide()
@Controller('webhook-deliveries')
export class WebhookDeliveriesController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get(':id') @RequirePermission('integrations.view')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.delivery(u, id);
  }

  @Post(':id/replay') @RequirePermission('integrations.manage')
  replay(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.webhooks.replay(u, id, ip);
  }
}
