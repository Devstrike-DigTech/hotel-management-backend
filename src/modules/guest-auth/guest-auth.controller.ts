import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { GuestPrincipal } from '../../common/auth-types.js';
import { CurrentGuest, GuestOnly, Public, RateLimitIp } from '../../common/decorators/index.js';
import { EmailStartDto, EmailVerifyDto, GuestRefreshDto, OtpStartDto, OtpVerifyDto, UpdateGuestMeDto } from './guest-auth.dto.js';
import { GuestAuthService } from './guest-auth.service.js';

@ApiTags('Guest accounts')
@Public()
@Controller('public/auth')
export class GuestAuthController {
  constructor(private readonly svc: GuestAuthService) {}

  @Post('otp/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a 6-digit sign-in code by SMS or WhatsApp' })
  otpStart(@Body() dto: OtpStartDto, @RateLimitIp() ip?: string) {
    return this.svc.otpStart(dto.phone, dto.channel, ip);
  }

  @Post('otp/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify the code; creates the account on first sign-in' })
  otpVerify(@Body() dto: OtpVerifyDto, @RateLimitIp() ip?: string) {
    return this.svc.otpVerify(dto.challengeId, dto.code, ip);
  }

  @Post('email/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Email a magic sign-in link (always answers { sent: true })' })
  emailStart(@Body() dto: EmailStartDto, @RateLimitIp() ip?: string) {
    return this.svc.emailStart(dto.email, ip);
  }

  @Post('email/verify')
  @HttpCode(200)
  emailVerify(@Body() dto: EmailVerifyDto) {
    return this.svc.emailVerify(dto.token);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: GuestRefreshDto, @RateLimitIp() ip?: string) {
    return this.svc.refresh(dto.refreshToken, ip);
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Body() dto: GuestRefreshDto) {
    return this.svc.logout(dto.refreshToken);
  }
}

@ApiTags('Guest accounts')
@ApiBearerAuth()
@GuestOnly()
@Controller('guest')
export class GuestController {
  constructor(private readonly svc: GuestAuthService) {}

  @Get('me')
  me(@CurrentGuest() g: GuestPrincipal) {
    return this.svc.me(g);
  }

  @Patch('me')
  update(@CurrentGuest() g: GuestPrincipal, @Body() dto: UpdateGuestMeDto) {
    return this.svc.updateMe(g, dto);
  }

  @Get('trips')
  @ApiOperation({ summary: 'Upcoming and past stays across hotels' })
  trips(@CurrentGuest() g: GuestPrincipal) {
    return this.svc.trips(g);
  }
}
