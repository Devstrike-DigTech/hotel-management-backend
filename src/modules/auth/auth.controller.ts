import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TrustedThrottlerGuard } from '../../common/guards/trusted-throttler.guard.js';
import type { AppRequest } from '../../common/auth-types.js';
import { AllowWhenReadOnly, Public } from '../../common/decorators/index.js';
import { LoginDto, RefreshDto, SignupDto } from './auth.dto.js';
import { AuthService, type RequestMeta } from './auth.service.js';

const meta = (req: AppRequest): RequestMeta => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'],
});

@ApiTags('Auth')
@Public()
@AllowWhenReadOnly()
@UseGuards(TrustedThrottlerGuard)
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  @ApiOperation({
    summary: 'Create a hotel account (tenant, owner, property) on a Growth trial',
  })
  signup(@Body() dto: SignupDto, @Req() req: AppRequest) {
    return this.auth.signup(dto, meta(req));
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() req: AppRequest) {
    return this.auth.login(dto, meta(req));
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate a refresh token' })
  refresh(@Body() dto: RefreshDto, @Req() req: AppRequest) {
    return this.auth.refresh(dto.refreshToken, meta(req));
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Body() dto: RefreshDto, @Req() req: AppRequest) {
    await this.auth.logout(dto.refreshToken, meta(req));
    return { success: true };
  }
}
