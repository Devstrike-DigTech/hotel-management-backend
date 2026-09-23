import { Body, Controller, Get, Headers, HttpCode, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min, ValidateNested } from 'class-validator';
import type { Response } from 'express';
import type { AppRequest, AuthUser } from '../../common/auth-types.js';
import { AnyPermission, ClientIp, CurrentUser, Public, RequirePermission } from '../../common/decorators/index.js';
import { PaginationQueryDto } from '../../common/utils/pagination.dto.js';
import { AlertsService } from './alerts.service.js';
import { WhatsAppInboundService } from './inbound.service.js';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export class AlertRecipientsDto {
  @IsOptional() @IsBoolean() owners?: boolean;
  @IsOptional() @IsBoolean() managers?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) userIds?: string[];
}

export class GuardAlertSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @ValidateNested() @Type(() => AlertRecipientsDto) recipients?: AlertRecipientsDto;
  @IsOptional() @IsArray() @IsIn(['WHATSAPP', 'EMAIL'], { each: true }) channels?: ('WHATSAPP' | 'EMAIL')[];
  @IsOptional() @IsInt() @Min(0) @Max(30) debounceMinutes?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) urgentRules?: string[];
  @IsOptional() @IsInt() @Min(0) urgentAmountKobo?: number;
}

export class QuietHoursDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @Matches(TIME) start?: string;
  @IsOptional() @Matches(TIME) end?: string;
}

export class DigestSettingsPartDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) recipients?: string[];
}

export class NotificationSettingsDto {
  @IsOptional() @ValidateNested() @Type(() => GuardAlertSettingsDto) guardAlerts?: GuardAlertSettingsDto;
  @IsOptional() @ValidateNested() @Type(() => QuietHoursDto) quietHours?: QuietHoursDto;
  @IsOptional() @ValidateNested() @Type(() => DigestSettingsPartDto) digest?: DigestSettingsPartDto;
}

@ApiTags('WhatsApp')
@ApiBearerAuth()
@Controller()
export class WhatsAppController {
  constructor(private readonly alerts: AlertsService) {}

  @Get('whatsapp/templates')
  @AnyPermission('settings.manage', 'guard.view')
  @ApiOperation({ summary: 'Approved WhatsApp templates and their status' })
  templates() {
    return this.alerts.templates();
  }

  @Get('notification-settings')
  @AnyPermission('settings.manage', 'guard.view')
  settings(@CurrentUser() user: AuthUser) {
    return this.alerts.getSettings(user);
  }

  @Put('notification-settings')
  @RequirePermission('settings.manage')
  putSettings(@CurrentUser() user: AuthUser, @Body() dto: NotificationSettingsDto, @ClientIp() ip?: string) {
    return this.alerts.putSettings(user, dto as Parameters<AlertsService['putSettings']>[1], ip);
  }

  @Get('guard/alerts')
  @RequirePermission('guard.view')
  list(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto) {
    return this.alerts.list(user, q.page, q.pageSize);
  }

  @Post('guard/alerts/test')
  @HttpCode(200)
  @RequirePermission('settings.manage')
  test(@CurrentUser() user: AuthUser) {
    return this.alerts.sendTest(user);
  }
}

/** Meta WhatsApp Cloud API webhook (public; signed with the app secret). */
@ApiTags('WhatsApp')
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(private readonly inbound: WhatsAppInboundService) {}

  @Get()
  @Public()
  @ApiExcludeEndpoint()
  verify(@Query('hub.mode') mode: string | undefined, @Query('hub.verify_token') token: string | undefined, @Query('hub.challenge') challenge: string | undefined, @Res() res: Response) {
    res.type('text/plain').send(this.inbound.verifySubscription(mode, token, challenge));
  }

  @Post()
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Inbound WhatsApp messages (X-Hub-Signature-256 required)' })
  receive(@Req() req: AppRequest, @Headers('x-hub-signature-256') signature: string | undefined, @Body() body: unknown) {
    return this.inbound.receive(req.rawBody, signature, body);
  }
}
