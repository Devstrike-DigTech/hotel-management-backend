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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TrustedThrottlerGuard } from '../../common/guards/trusted-throttler.guard.js';
import type { PlatformPrincipal } from '../../common/auth-types.js';
import {
  ClientIp,
  CurrentPlatformUser,
  PlatformOnly,
  Public,
} from '../../common/decorators/index.js';
import { DunningService } from '../billing/dunning.service.js';
import {
  PlatformLoginDto,
  SetFeatureOverrideDto,
  TenantListQueryDto,
  UpdatePlanDto,
  UpdateTenantSubscriptionDto,
} from './platform.dto.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformService } from './platform.service.js';

@ApiTags('Platform auth')
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @Post('login')
  @Public()
  @UseGuards(TrustedThrottlerGuard)
  @HttpCode(200)
  login(@Body() dto: PlatformLoginDto, @ClientIp() ip?: string) {
    return this.auth.login(dto.email, dto.password, ip);
  }

  @Get('me')
  @PlatformOnly()
  @ApiBearerAuth()
  me(@CurrentPlatformUser() p: PlatformPrincipal) {
    return this.auth.me(p);
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
  ) {}

  @Get('metrics')
  metrics() {
    return this.platform.metrics();
  }

  @Get('tenants')
  tenants(@Query() q: TenantListQueryDto) {
    return this.platform.tenants(q);
  }

  @Get('tenants/:id')
  tenant(@Param('id', ParseUUIDPipe) id: string) {
    return this.platform.tenant(id);
  }

  @Patch('tenants/:id/subscription')
  updateSubscription(
    @CurrentPlatformUser() p: PlatformPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTenantSubscriptionDto,
    @ClientIp() ip?: string,
  ) {
    return this.platform.updateSubscription(p, id, dto, ip);
  }

  @Put('tenants/:id/features')
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
  plans() {
    return this.platform.plans();
  }

  @Patch('plans/:code')
  updatePlan(
    @CurrentPlatformUser() p: PlatformPrincipal,
    @Param('code') code: string,
    @Body() dto: UpdatePlanDto,
    @ClientIp() ip?: string,
  ) {
    return this.platform.updatePlan(p, code, dto, ip);
  }

  @Post('jobs/dunning/run')
  @HttpCode(200)
  @ApiOperation({ summary: 'Run the dunning job now (normally daily at 02:00 Lagos)' })
  runDunning() {
    return this.dunning.run();
  }
}
