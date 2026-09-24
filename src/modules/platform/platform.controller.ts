import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TrustedThrottlerGuard } from '../../common/guards/trusted-throttler.guard.js';
import type { AppRequest, PlatformPrincipal } from '../../common/auth-types.js';
import { PLATFORM_PERMISSIONS, PLATFORM_ROLES, PlatformPermissionRequired, RequireStepUp, STEP_UP_SECONDS } from './security/platform-permissions.js';
import { stepUpRequired } from './security/platform-permission.guard.js';
import {
  ClientIp,
  CurrentPlatformUser,
  PlatformOnly,
  Public,
} from '../../common/decorators/index.js';
import { DunningService } from '../billing/dunning.service.js';
import {
  AcceptInviteDto,
  ChangePasswordDto,
  DevTotpQueryDto,
  IpAllowlistDto,
  MfaCodeDto,
  MfaTokenDto,
  MfaVerifyDto,
  PlatformRefreshDto,
  StepUpDto,
  PlatformLoginDto,
  ApplyCouponDto,
  CreateTenantDto,
  ExtendTrialDto,
  ReasonDto,
  SetFeatureOverrideDto,
  TenantListQueryDto,
  UpdatePlanDto,
  UpdateTenantSubscriptionDto,
} from './platform.dto.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformService } from './platform.service.js';
import { PlatformJobsService } from './console/platform-jobs.service.js';

@ApiTags('Platform auth')
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @Post('login')
  @Public()
  @UseGuards(TrustedThrottlerGuard)
  @HttpCode(200)
  @ApiOperation({ summary: 'Password step: returns an MFA challenge (TOTP or enrolment), never a token' })
  login(@Body() dto: PlatformLoginDto, @Req() req: AppRequest) {
    return this.auth.login(dto.email, dto.password, meta(req));
  }

  @Post('mfa/enrol/start')
  @Public()
  @UseGuards(TrustedThrottlerGuard)
  @HttpCode(200)
  enrolStart(@Body() dto: MfaTokenDto) {
    return this.auth.enrolStart(dto.mfaToken);
  }

  @Post('mfa/enrol/verify')
  @Public()
  @UseGuards(TrustedThrottlerGuard)
  @HttpCode(200)
  enrolVerify(@Body() dto: MfaCodeDto, @Req() req: AppRequest) {
    return this.auth.enrolVerify(dto.mfaToken, dto.code, meta(req));
  }

  @Post('mfa/verify')
  @Public()
  @UseGuards(TrustedThrottlerGuard)
  @HttpCode(200)
  verify(@Body() dto: MfaVerifyDto, @Req() req: AppRequest) {
    return this.auth.verify(dto.mfaToken, { code: dto.code, recoveryCode: dto.recoveryCode }, meta(req));
  }

  @Post('refresh')
  @Public()
  @UseGuards(TrustedThrottlerGuard)
  @HttpCode(200)
  refresh(@Body() dto: PlatformRefreshDto, @Req() req: AppRequest) {
    return this.auth.refresh(dto.refreshToken, meta(req));
  }

  @Get('invite/:token')
  @Public()
  invite(@Param('token') token: string) {
    return this.auth.invite(token);
  }

  @Post('invite/accept')
  @Public()
  @UseGuards(TrustedThrottlerGuard)
  @HttpCode(200)
  acceptInvite(@Body() dto: AcceptInviteDto, @Req() req: AppRequest) {
    return this.auth.acceptInvite(dto.token, dto.password, dto.fullName, meta(req));
  }

  @Get('dev/totp')
  @Public()
  @ApiOperation({ summary: 'Development only: current TOTP code of an enrolled platform user (404 in production)' })
  devTotp(@Query() q: DevTotpQueryDto) {
    return this.auth.devTotp(q.email);
  }

  @Post('logout')
  @PlatformOnly()
  @ApiBearerAuth()
  @HttpCode(200)
  logout(@CurrentPlatformUser() p: PlatformPrincipal, @Req() req: AppRequest) {
    return this.auth.logout(p, meta(req));
  }

  @Get('me')
  @PlatformOnly()
  @ApiBearerAuth()
  me(@CurrentPlatformUser() p: PlatformPrincipal) {
    return this.auth.me(p);
  }

  @Post('step-up')
  @PlatformOnly()
  @ApiBearerAuth()
  @HttpCode(200)
  stepUp(@CurrentPlatformUser() p: PlatformPrincipal, @Body() dto: StepUpDto, @Req() req: AppRequest) {
    return this.auth.stepUp(p, dto, meta(req));
  }

  @Get('sessions')
  @PlatformOnly()
  @ApiBearerAuth()
  sessions(@CurrentPlatformUser() p: PlatformPrincipal) {
    return this.auth.sessions(p);
  }

  @Post('sessions/revoke-others')
  @PlatformOnly()
  @ApiBearerAuth()
  @HttpCode(200)
  revokeOthers(@CurrentPlatformUser() p: PlatformPrincipal, @Req() req: AppRequest) {
    return this.auth.revokeOthers(p, meta(req));
  }

  @Delete('sessions/:id')
  @PlatformOnly()
  @ApiBearerAuth()
  revokeSession(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @Req() req: AppRequest) {
    return this.auth.revokeSession(p, id, meta(req));
  }

  @Post('mfa/recovery-codes')
  @PlatformOnly()
  @RequireStepUp()
  @ApiBearerAuth()
  @HttpCode(200)
  recoveryCodes(@CurrentPlatformUser() p: PlatformPrincipal, @Req() req: AppRequest) {
    return this.auth.regenerateRecoveryCodes(p, meta(req));
  }

  @Post('password')
  @PlatformOnly()
  @RequireStepUp()
  @ApiBearerAuth()
  @HttpCode(200)
  password(@CurrentPlatformUser() p: PlatformPrincipal, @Body() dto: ChangePasswordDto, @Req() req: AppRequest) {
    return this.auth.changePassword(p, dto.currentPassword, dto.newPassword, meta(req));
  }

  @Put('ip-allowlist')
  @PlatformOnly()
  @RequireStepUp()
  @ApiBearerAuth()
  ipAllowlist(@CurrentPlatformUser() p: PlatformPrincipal, @Body() dto: IpAllowlistDto, @Req() req: AppRequest) {
    return this.auth.setIpAllowlist(p, dto.cidrs, meta(req));
  }
}

/** Client address and user agent of a request, for sessions and the audit log. */
export function meta(req: AppRequest) {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: Array.isArray(ua) ? ua[0] : ua };
}

@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformOnly()
@Controller('platform')
export class PlatformPermissionsController {
  @Get('permissions')
  permissions() {
    return { permissions: PLATFORM_PERMISSIONS, roles: PLATFORM_ROLES };
  }
}

@ApiTags('Platform console')
@ApiBearerAuth()
@PlatformOnly()
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly dunning: DunningService,
    private readonly jobs: PlatformJobsService,
  ) {}

  @Get('metrics')
  @PlatformPermissionRequired('tenants.view')
  metrics() {
    return this.platform.metrics();
  }

  @Get('overview')
  @PlatformPermissionRequired('tenants.view')
  @ApiOperation({ summary: 'MRR, GMV, churn, signups and system health for the console home' })
  overview() {
    return this.platform.overview();
  }

  @Post('tenants')
  @PlatformPermissionRequired('tenants.manage')
  @ApiOperation({ summary: 'Create a tenant (Enterprise onboarding); the owner gets a set-up link' })
  createTenant(@CurrentPlatformUser() p: PlatformPrincipal, @Body() dto: CreateTenantDto, @ClientIp() ip?: string) {
    return this.platform.createTenant(p, dto, ip);
  }

  @Post('tenants/:id/extend-trial')
  @PlatformPermissionRequired('tenants.manage')
  @HttpCode(200)
  extendTrial(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ExtendTrialDto, @ClientIp() ip?: string) {
    return this.platform.extendTrial(p, id, dto.days, dto.reason, ip);
  }

  @Post('tenants/:id/suspend')
  @PlatformPermissionRequired('tenants.manage')
  @HttpCode(200)
  suspend(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @ClientIp() ip?: string) {
    return this.platform.suspend(p, id, dto.reason, ip);
  }

  @Post('tenants/:id/reinstate')
  @PlatformPermissionRequired('tenants.manage')
  @HttpCode(200)
  reinstate(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @ClientIp() ip?: string) {
    return this.platform.reinstate(p, id, dto.reason, ip);
  }

  @Post('tenants/:id/coupon')
  @PlatformPermissionRequired('billing.manage')
  @HttpCode(200)
  applyCoupon(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ApplyCouponDto, @ClientIp() ip?: string) {
    return this.platform.applyCoupon(p, id, dto.code, ip);
  }

  @Delete('tenants/:id/coupon')
  @PlatformPermissionRequired('billing.manage')
  removeCoupon(@CurrentPlatformUser() p: PlatformPrincipal, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.platform.removeCoupon(p, id, ip);
  }


  @Get('tenants')
  @PlatformPermissionRequired('tenants.view')
  tenants(@Query() q: TenantListQueryDto) {
    return this.platform.tenants(q);
  }

  @Get('tenants/:id')
  @PlatformPermissionRequired('tenants.view')
  tenant(@Param('id', ParseUUIDPipe) id: string) {
    return this.platform.tenant(id);
  }

  @Patch('tenants/:id/subscription')
  @PlatformPermissionRequired('tenants.manage')
  updateSubscription(
    @CurrentPlatformUser() p: PlatformPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTenantSubscriptionDto,
    @ClientIp() ip?: string,
  ) {
    return this.platform.updateSubscription(p, id, dto, ip);
  }

  @Put('tenants/:id/features')
  @PlatformPermissionRequired('tenants.manage')
  @ApiOperation({ summary: 'Grant (enabled=true) or revoke (false) a feature for one tenant' })
  setFeature(
    @CurrentPlatformUser() p: PlatformPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetFeatureOverrideDto,
    @ClientIp() ip?: string,
  ) {
    return this.platform.setFeatureOverride(p, id, dto, ip);
  }

  @Delete('tenants/:id/features/:featureCode')
  @PlatformPermissionRequired('tenants.manage')
  @ApiOperation({ summary: 'Remove an override so the tenant falls back to its plan' })
  removeFeature(
    @CurrentPlatformUser() p: PlatformPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('featureCode') featureCode: string,
    @ClientIp() ip?: string,
  ) {
    return this.platform.removeFeatureOverride(p, id, featureCode, ip);
  }

  @Get('plans')
  @PlatformPermissionRequired('tenants.view')
  plans() {
    return this.platform.plans();
  }

  @Patch('plans/:code')
  @PlatformPermissionRequired('plans.manage')
  updatePlan(
    @CurrentPlatformUser() p: PlatformPrincipal,
    @Param('code') code: string,
    @Body() dto: UpdatePlanDto,
    @ClientIp() ip?: string,
  ) {
    return this.platform.updatePlan(p, code, dto, ip);
  }

  @Post('jobs/dunning/run')
  @PlatformPermissionRequired('system.view')
  @HttpCode(200)
  @ApiOperation({ summary: 'Run the dunning job now (normally daily at 02:00 Lagos)' })
  runDunning() {
    return this.dunning.run();
  }

  /**
   * Named jobs (M6, step-up). The M1/M3 routes `jobs/dunning/run` and
   * `jobs/guest-notifications/run` share this path shape and keep their old
   * behaviour (no step-up, bare result) for existing clients.
   */
  @Post('jobs/:name/run')
  @PlatformPermissionRequired('system.view')
  @HttpCode(200)
  @ApiOperation({ summary: 'Run a named scheduled job now' })
  async runJob(@CurrentPlatformUser() p: PlatformPrincipal, @Param('name') name: string) {
    if (name === 'dunning') return this.dunning.run();
    if (name === 'guest-notifications') return this.jobs.run(name);
    if (Date.now() - (p.stepUpAt?.getTime() ?? 0) > STEP_UP_SECONDS * 1000) throw stepUpRequired();
    return { result: await this.jobs.run(name) };
  }
}
