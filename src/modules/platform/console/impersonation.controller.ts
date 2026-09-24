import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { AuthUser, PlatformPrincipal } from '../../../common/auth-types.js';
import { AllowWhenReadOnly, ClientIp, CurrentPlatformUser, CurrentUser, GroupWide, PlatformOnly, Public, RequirePermission } from '../../../common/decorators/index.js';
import { TrustedThrottlerGuard } from '../../../common/guards/trusted-throttler.guard.js';
import { PlatformPermissionRequired, RequireStepUp } from '../security/platform-permissions.js';
import { ImpersonationService, MAX_IMPERSONATION_MINUTES } from './impersonation.service.js';

export class StartImpersonationDto {
  @IsUUID() tenantId!: string;
  @IsUUID() userId!: string;
  @IsString() @MinLength(10) @MaxLength(500) reason!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(MAX_IMPERSONATION_MINUTES) durationMinutes?: number;
  @IsOptional() @IsUUID() supportRequestId?: string;
}

export class WriteModeDto {
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class ImpersonationListQueryDto {
  @IsOptional() @IsUUID() tenantId?: string;
  @IsOptional() @IsIn(['true', 'false']) active?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class ExchangeDto {
  @IsString() @MinLength(20) @MaxLength(200) code!: string;
}

@ApiTags('Platform: impersonation')
@ApiBearerAuth()
@PlatformOnly()
@Controller('platform/impersonations')
export class PlatformImpersonationController {
  constructor(private readonly sessions: ImpersonationService) {}

  @Post() @PlatformPermissionRequired('impersonate') @RequireStepUp()
  start(@CurrentPlatformUser() p: PlatformPrincipal, @Body() dto: StartImpersonationDto, @ClientIp() ip?: string) {
    return this.sessions.start(p, dto, ip);
  }

  @Get() @PlatformPermissionRequired('tenants.view')
  list(@Query() q: ImpersonationListQueryDto) {
    return this.sessions.list(q);
  }

  @Get(':id') @PlatformPermissionRequired('tenants.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.get(id);
  }

  @Post(':id/write-mode') @PlatformPermissionRequired('impersonate') @RequireStepUp() @HttpCode(200)
  writeMode(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: WriteModeDto, @ClientIp() ip?: string) {
    return this.sessions.setWriteMode(p, id, dto.enabled, dto.reason, ip);
  }

  @Post(':id/end') @PlatformPermissionRequired('impersonate') @HttpCode(200)
  end(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.sessions.end(id, { kind: 'PLATFORM', p }, ip);
  }
}

@ApiTags('Impersonation')
@Controller('auth/impersonation')
export class ImpersonationExchangeController {
  constructor(private readonly sessions: ImpersonationService) {}

  @Post('exchange') @Public() @UseGuards(TrustedThrottlerGuard) @HttpCode(200)
  exchange(@Body() dto: ExchangeDto, @ClientIp() ip?: string) {
    return this.sessions.exchange(dto.code, ip);
  }
}

@ApiTags('Impersonation')
@ApiBearerAuth()
@GroupWide()
@AllowWhenReadOnly()
@Controller()
export class HotelImpersonationController {
  constructor(private readonly sessions: ImpersonationService) {}

  @Get('impersonation/current')
  current(@CurrentUser() u: AuthUser) {
    return this.sessions.current(u);
  }

  @Post('impersonation/end') @HttpCode(200)
  async endOwn(@CurrentUser() u: AuthUser, @ClientIp() ip?: string) {
    if (!u.impersonation) return { success: true };
    await this.sessions.hotelEnd(u, u.impersonation.sessionId, ip);
    return { success: true };
  }

  @Get('support-sessions') @RequirePermission('support.sessions.view')
  list(@CurrentUser() u: AuthUser, @Query() q: ImpersonationListQueryDto) {
    return this.sessions.hotelList(u, q);
  }

  @Post('support-sessions/:id/end') @RequirePermission('support.sessions.view') @HttpCode(200)
  end(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.sessions.hotelEnd(u, id, ip);
  }
}
