import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import type { Response } from 'express';
import type { AppRequest, PlatformPrincipal } from '../../../common/auth-types.js';
import { ClientIp, CurrentPlatformUser, PlatformOnly } from '../../../common/decorators/index.js';
import { PlatformRole } from '../../../generated/prisma/enums.js';
import { PlatformAuthService } from '../platform-auth.service.js';
import { meta } from '../platform.controller.js';
import { PlatformAuditService } from '../security/platform-audit.service.js';
import { PlatformPermissionRequired, RequireStepUp, SuperAdminOnly } from '../security/platform-permissions.js';
import { CouponsService } from './coupons.service.js';
import { OffboardingService } from './offboarding.service.js';
import { PlatformUsersService } from './platform-users.service.js';
import { SystemHealthService } from './system-health.service.js';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export class OffboardDto {
  @IsString() @MinLength(1) @MaxLength(200) confirmName!: string;
  @IsString() @MinLength(5) @MaxLength(1000) reason!: string;
}

export class CancelOffboardingDto {
  @IsString() @MinLength(5) @MaxLength(1000) reason!: string;
}

export class OffboardingListQueryDto {
  @IsOptional() @IsIn(['EXPORTING', 'GRACE', 'DELETING', 'DELETED', 'CANCELLED', 'FAILED']) status?: string;
}

export class PlatformAuditQueryDto {
  @IsOptional() @IsUUID() actorId?: string;
  @IsOptional() @IsString() @MaxLength(80) action?: string;
  @IsOptional() @IsUUID() tenantId?: string;
  @IsOptional() @IsString() @MaxLength(60) targetType?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @IsOptional() @IsString() @MaxLength(120) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}

export class PlatformAuditExportQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) from!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) to!: string;
  @IsOptional() @IsIn(['csv', 'json']) format?: 'csv' | 'json';
}

export class InvitePlatformUserDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(2) @MaxLength(120) fullName!: string;
  @IsIn(Object.values(PlatformRole)) role!: PlatformRole;
}

export class UpdatePlatformUserDto {
  @IsOptional() @IsIn(Object.values(PlatformRole)) role?: PlatformRole;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) ipAllowlist?: string[];
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) fullName?: string;
}

export class CreateCouponDto {
  @IsString() @MinLength(3) @MaxLength(32) code!: string;
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(1) @Max(100) percentOff?: number | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(1) @Max(2_000_000_000) amountOffKobo?: number | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(1) @Max(120) durationMonths?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) planCodes?: string[];
  @IsOptional() @IsArray() @IsIn(['MONTHLY', 'YEARLY'], { each: true }) intervals?: ('MONTHLY' | 'YEARLY')[];
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(1) maxRedemptions?: number | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsDateString() validFrom?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsDateString() validUntil?: string | null;
}

export class UpdateCouponDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsDateString() validUntil?: string | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(1) maxRedemptions?: number | null;
}

export class CouponListQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  active?: boolean;
}

export class FailedJobsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

export class JobIdsDto {
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) jobIds?: string[];
}

// ---------------------------------------------------------------------------
// Offboarding (NDPA)
// ---------------------------------------------------------------------------

@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformOnly()
@Controller('platform')
export class PlatformOffboardingController {
  constructor(private readonly offboarding: OffboardingService) {}

  @Post('tenants/:id/offboard')
  @PlatformPermissionRequired('tenants.manage')
  @RequireStepUp()
  @ApiOperation({ summary: 'Suspend, export and schedule deletion of a tenant (30-day grace)' })
  offboard(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OffboardDto, @ClientIp() ip?: string) {
    return this.offboarding.start(p, id, dto, ip);
  }

  @Get('tenants/:id/offboarding')
  @PlatformPermissionRequired('tenants.view')
  forTenant(@Param('id', ParseUUIDPipe) id: string) {
    return this.offboarding.forTenant(id);
  }

  @Get('offboardings')
  @PlatformPermissionRequired('tenants.view')
  list(@Query() q: OffboardingListQueryDto) {
    return this.offboarding.list(q.status);
  }

  @Post('offboardings/:id/cancel')
  @PlatformPermissionRequired('tenants.manage')
  @RequireStepUp()
  @HttpCode(200)
  cancel(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelOffboardingDto, @ClientIp() ip?: string) {
    return this.offboarding.cancel(p, id, dto.reason, ip);
  }

  @Post('offboardings/:id/delete-now')
  @SuperAdminOnly()
  @RequireStepUp()
  @HttpCode(200)
  deleteNow(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.offboarding.deleteNow(p, id, ip);
  }
}

// ---------------------------------------------------------------------------
// Platform audit log
// ---------------------------------------------------------------------------

@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformOnly()
@Controller('platform/audit')
export class PlatformAuditController {
  constructor(private readonly audit: PlatformAuditService) {}

  @Get()
  @PlatformPermissionRequired('audit.view')
  list(@Query() q: PlatformAuditQueryDto) {
    return this.audit.list(q);
  }

  @Get('export')
  @PlatformPermissionRequired('audit.view')
  async export(@CurrentPlatformUser() p: PlatformPrincipal, @Query() q: PlatformAuditExportQueryDto, @Res() res: Response, @ClientIp() ip?: string) {
    const file = await this.audit.export(p, q, ip);
    res.setHeader('Content-Type', `${file.contentType}; charset=utf-8`);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.body);
  }
}

// ---------------------------------------------------------------------------
// Platform users
// ---------------------------------------------------------------------------

@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformOnly()
@PlatformPermissionRequired('platform_users.manage')
@Controller('platform/users')
export class PlatformUsersController {
  constructor(
    private readonly users: PlatformUsersService,
    private readonly auth: PlatformAuthService,
  ) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Post()
  invite(@CurrentPlatformUser() p: PlatformPrincipal, @Body() dto: InvitePlatformUserDto) {
    return this.users.invite(p, dto);
  }

  @Patch(':id')
  update(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlatformUserDto) {
    return this.users.update(p, id, dto);
  }

  @Post(':id/reset-mfa')
  @RequireStepUp()
  @HttpCode(200)
  resetMfa(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.resetMfa(p, id);
  }

  @Post(':id/unlock')
  @HttpCode(200)
  unlock(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.unlock(id);
  }

  @Post(':id/resend-invite')
  @HttpCode(200)
  resend(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.resendInvite(p, id);
  }

  @Delete(':id')
  @RequireStepUp()
  remove(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.deactivate(p, id);
  }

  @Get(':id/sessions')
  sessions(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.auth.sessions(p, id);
  }

  @Delete(':id/sessions/:sessionId')
  revokeSession(
    @CurrentPlatformUser() p: PlatformPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Req() req: AppRequest,
  ) {
    return this.auth.revokeSession(p, sessionId, meta(req), id);
  }
}

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformOnly()
@Controller('platform/coupons')
export class PlatformCouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get()
  @PlatformPermissionRequired('billing.view')
  list(@Query() q: CouponListQueryDto) {
    return this.coupons.list(q.active);
  }

  @Post()
  @PlatformPermissionRequired('billing.manage')
  create(@CurrentPlatformUser() p: PlatformPrincipal, @Body() dto: CreateCouponDto) {
    return this.coupons.create(p, dto);
  }

  @Patch(':id')
  @PlatformPermissionRequired('billing.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCouponDto) {
    return this.coupons.update(id, dto);
  }

  @Get(':id/redemptions')
  @PlatformPermissionRequired('billing.view')
  redemptions(@Param('id', ParseUUIDPipe) id: string) {
    return this.coupons.redemptions(id);
  }
}

// ---------------------------------------------------------------------------
// System health
// ---------------------------------------------------------------------------

@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformOnly()
@PlatformPermissionRequired('system.view')
@Controller('platform/system')
export class PlatformSystemController {
  constructor(private readonly health: SystemHealthService) {}

  @Get('health')
  get() {
    return this.health.health();
  }

  @Get('queues/:name/failed')
  failed(@Param('name') name: string, @Query() q: FailedJobsQueryDto) {
    return this.health.failedJobs(name, q.limit ?? 50);
  }

  @Post('queues/:name/retry')
  @RequireStepUp()
  @HttpCode(200)
  retry(@Param('name') name: string, @Body() dto: JobIdsDto) {
    return this.health.retry(name, dto.jobIds);
  }

  @Post('queues/:name/clean')
  @RequireStepUp()
  @HttpCode(200)
  clean(@Param('name') name: string, @Body() dto: JobIdsDto) {
    return this.health.clean(name, dto.jobIds);
  }
}
