import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import type { AuthUser, PlatformPrincipal } from '../../../common/auth-types.js';
import { ClientIp, CurrentPlatformUser, CurrentUser, GroupWide, PlatformOnly, Public, RequirePermission } from '../../../common/decorators/index.js';
import { RequireFeature } from '../../entitlements/entitlements.decorators.js';
import { PlatformPermissionRequired } from '../../platform/security/platform-permissions.js';
import { WhiteLabelService } from './white-label.service.js';

class FooterLinkDto {
  @IsString() @MinLength(1) @MaxLength(40) label!: string;
  @IsString() @MaxLength(500) url!: string;
}

const nullableStr = (max: number) => [IsOptional(), ValidateIf((_o, v) => v !== null), IsString(), MaxLength(max)];
const apply = (decorators: PropertyDecorator[]): PropertyDecorator => (target, key) => decorators.forEach((d) => d(target, key));

export class WhiteLabelDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @apply(nullableStr(80)) brandName?: string | null;
  @apply(nullableStr(500)) logoUrl?: string | null;
  @apply(nullableStr(500)) faviconUrl?: string | null;
  @apply(nullableStr(7)) primaryColor?: string | null;
  @apply(nullableStr(7)) accentColor?: string | null;
  @apply(nullableStr(60)) headingFont?: string | null;
  @apply(nullableStr(60)) bodyFont?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(8) @ValidateNested({ each: true }) @Type(() => FooterLinkDto) footerLinks?: FooterLinkDto[];
  @IsOptional() @IsBoolean() hidePoweredBy?: boolean;
  @apply(nullableStr(80)) emailFromName?: string | null;
}

export class EmailDomainDto {
  @IsString() @MaxLength(253) domain!: string;
  @IsOptional() @IsString() @MaxLength(40) fromLocalPart?: string;
}

export class SmsSenderDto {
  @IsString() @MinLength(3) @MaxLength(11) senderId!: string;
  @IsString() @MinLength(20) @MaxLength(500) useCase!: string;
}

export class PortalDomainDto {
  @IsString() @MaxLength(253) domain!: string;
}

export class SmsDecisionDto {
  @IsIn(['APPROVED', 'REJECTED', 'PENDING']) status!: 'APPROVED' | 'REJECTED' | 'PENDING';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class SmsSenderListQueryDto {
  @IsOptional() @IsIn(['REQUESTED', 'PENDING', 'APPROVED', 'REJECTED']) status?: string;
}

export class StaffPortalQueryDto {
  @IsString() @MaxLength(253) host!: string;
}

@ApiTags('White-label')
@ApiBearerAuth()
@RequireFeature('white_label')
@GroupWide()
@Controller('white-label')
export class WhiteLabelController {
  constructor(private readonly wl: WhiteLabelService) {}

  @Get('fonts') @RequirePermission('whitelabel.manage')
  fonts() {
    return this.wl.fonts();
  }

  @Get() @RequirePermission('whitelabel.manage')
  get(@CurrentUser() u: AuthUser) {
    return this.wl.get(u);
  }

  @Put() @RequirePermission('whitelabel.manage')
  put(@CurrentUser() u: AuthUser, @Body() dto: WhiteLabelDto, @ClientIp() ip?: string) {
    return this.wl.put(u, dto, ip);
  }

  @Post('email-domain') @RequirePermission('whitelabel.manage')
  emailDomain(@CurrentUser() u: AuthUser, @Body() dto: EmailDomainDto, @ClientIp() ip?: string) {
    return this.wl.createEmailDomain(u, dto, ip);
  }

  @Post('email-domain/verify') @RequirePermission('whitelabel.manage') @HttpCode(200)
  verifyEmail(@CurrentUser() u: AuthUser) {
    return this.wl.verifyEmailDomain(u.tenantId);
  }

  @Post('email-domain/dev/verify') @RequirePermission('whitelabel.manage') @HttpCode(200)
  devVerifyEmail(@CurrentUser() u: AuthUser) {
    return this.wl.devVerifyEmailDomain(u.tenantId);
  }

  @Delete('email-domain') @RequirePermission('whitelabel.manage')
  removeEmail(@CurrentUser() u: AuthUser, @ClientIp() ip?: string) {
    return this.wl.removeEmailDomain(u, ip);
  }

  @Get('sms-sender') @RequirePermission('whitelabel.manage')
  sms(@CurrentUser() u: AuthUser) {
    return this.wl.smsSender(u);
  }

  @Post('sms-sender') @RequirePermission('whitelabel.manage')
  requestSms(@CurrentUser() u: AuthUser, @Body() dto: SmsSenderDto, @ClientIp() ip?: string) {
    return this.wl.requestSmsSender(u, dto, ip);
  }

  @Post('staff-portal') @RequirePermission('whitelabel.manage')
  portal(@CurrentUser() u: AuthUser, @Body() dto: PortalDomainDto, @ClientIp() ip?: string) {
    return this.wl.createPortal(u, dto.domain, ip);
  }

  @Post('staff-portal/verify') @RequirePermission('whitelabel.manage') @HttpCode(200)
  verifyPortal(@CurrentUser() u: AuthUser) {
    return this.wl.verifyPortal(u.tenantId);
  }

  @Post('staff-portal/dev/publish') @RequirePermission('whitelabel.manage') @HttpCode(200)
  devPublish(@CurrentUser() u: AuthUser) {
    return this.wl.devPublishPortal(u.tenantId);
  }

  @Delete('staff-portal') @RequirePermission('whitelabel.manage')
  removePortal(@CurrentUser() u: AuthUser, @ClientIp() ip?: string) {
    return this.wl.removePortal(u, ip);
  }
}

@ApiTags('Public')
@Public()
@Controller('public/staff-portal')
export class PublicStaffPortalController {
  constructor(private readonly wl: WhiteLabelService) {}

  @Get()
  get(@Query() q: StaffPortalQueryDto) {
    return this.wl.staffPortal(q.host);
  }
}

@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformOnly()
@Controller('platform/sms-senders')
export class PlatformSmsSendersController {
  constructor(private readonly wl: WhiteLabelService) {}

  @Get() @PlatformPermissionRequired('tenants.view')
  list(@Query() q: SmsSenderListQueryDto) {
    return this.wl.platformSmsSenders(q.status);
  }

  @Patch(':id') @PlatformPermissionRequired('tenants.manage')
  decide(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SmsDecisionDto, @ClientIp() ip?: string) {
    return this.wl.decideSmsSender(p, id, dto, ip);
  }
}
