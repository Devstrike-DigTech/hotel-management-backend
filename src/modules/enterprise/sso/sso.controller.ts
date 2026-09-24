import { Body, Controller, Delete, Get, Headers, HttpCode, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import type { Response } from 'express';
import type { AppRequest, AuthUser } from '../../../common/auth-types.js';
import { AllowWhenReadOnly, ClientIp, CurrentUser, GroupWide, Public, RequirePermission } from '../../../common/decorators/index.js';
import { TrustedThrottlerGuard } from '../../../common/guards/trusted-throttler.guard.js';
import { RequireFeature } from '../../entitlements/entitlements.decorators.js';
import { MockOidcService } from './mock-oidc.service.js';
import { SsoService } from './sso.service.js';

export class SsoConfigDto {
  @IsIn(['GOOGLE', 'MICROSOFT', 'OIDC']) provider!: 'GOOGLE' | 'MICROSOFT' | 'OIDC';
  @IsOptional() @IsString() @MaxLength(500) issuer?: string;
  @IsString() @MinLength(1) @MaxLength(300) clientId!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(500) clientSecret?: string;
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) allowedDomains!: string[];
  @IsIn(['JIT', 'EXISTING_ONLY']) provisioning!: 'JIT' | 'EXISTING_ONLY';
  @IsString() @MaxLength(40) defaultRole!: string;
  @IsBoolean() enforced!: boolean;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsUUID() breakGlassUserId?: string | null;
  @IsBoolean() enabled!: boolean;
}

export class SsoCodeDto {
  @IsString() @MinLength(10) @MaxLength(200) code!: string;
}

export class SsoDiscoverDto {
  @IsEmail() @MaxLength(254) email!: string;
}

const meta = (req: AppRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

@ApiTags('SSO')
@ApiBearerAuth()
@RequireFeature('sso')
@GroupWide()
@Controller('sso')
export class SsoConfigController {
  constructor(private readonly sso: SsoService) {}

  @Get() @RequirePermission('sso.manage')
  get(@CurrentUser() u: AuthUser) {
    return this.sso.get(u);
  }

  @Put() @RequirePermission('sso.manage')
  put(@CurrentUser() u: AuthUser, @Body() dto: SsoConfigDto, @ClientIp() ip?: string) {
    return this.sso.put(u, dto, ip);
  }

  @Delete() @RequirePermission('sso.manage')
  remove(@CurrentUser() u: AuthUser, @ClientIp() ip?: string) {
    return this.sso.remove(u, ip);
  }

  @Post('test') @RequirePermission('sso.manage') @HttpCode(200)
  test(@CurrentUser() u: AuthUser) {
    return this.sso.test(u);
  }
}

@ApiTags('Auth')
@Public()
@AllowWhenReadOnly()
@Controller('auth/sso')
export class SsoAuthController {
  constructor(private readonly sso: SsoService) {}

  @Get('start')
  async start(@Query('tenant') tenant: string, @Query('returnTo') returnTo: string | undefined, @Res() res: Response) {
    res.redirect(302, await this.sso.start(String(tenant ?? ''), typeof returnTo === 'string' ? returnTo : undefined));
  }

  @Post('discover')
  @UseGuards(TrustedThrottlerGuard)
  @HttpCode(200)
  discover(@Body() dto: SsoDiscoverDto) {
    return this.sso.discoverByEmail(dto.email);
  }

  @Get('callback')
  async callback(@Query() q: { code?: string; state?: string; error?: string }, @Req() req: AppRequest, @Res() res: Response) {
    res.redirect(302, await this.sso.callback({ code: q.code, state: q.state, error: q.error }, meta(req)));
  }

  @Post('exchange')
  @UseGuards(TrustedThrottlerGuard)
  @HttpCode(200)
  exchange(@Body() dto: SsoCodeDto, @Req() req: AppRequest) {
    return this.sso.exchange(dto.code, meta(req));
  }
}

/** Development OIDC provider (never in production). */
@ApiExcludeController()
@Public()
@Controller('dev/oidc')
export class MockOidcController {
  constructor(private readonly mock: MockOidcService) {}

  @Get('.well-known/openid-configuration')
  discovery() {
    this.mock.assertEnabled();
    return this.mock.discovery();
  }

  @Get('jwks')
  jwks() {
    this.mock.assertEnabled();
    return this.mock.jwks();
  }

  @Get('authorize')
  async authorize(@Query() q: Record<string, string | undefined>, @Res() res: Response) {
    this.mock.assertEnabled();
    if (q.login_hint) {
      res.redirect(302, this.mock.authorize(q, q.login_hint));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(this.mock.signInPage(q, await this.mock.knownEmails()));
  }

  @Post('token')
  @HttpCode(200)
  token(@Body() body: Record<string, string | undefined>, @Headers('authorization') auth?: string) {
    this.mock.assertEnabled();
    return this.mock.token(body, auth);
  }

  @Get('userinfo')
  userinfo(@Headers('authorization') auth?: string) {
    this.mock.assertEnabled();
    return this.mock.userinfo(auth);
  }
}
