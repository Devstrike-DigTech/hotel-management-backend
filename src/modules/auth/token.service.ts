import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomBytes } from 'node:crypto';
import type { StaffRole } from '../../generated/prisma/enums.js';
import {
  PLATFORM_AUDIENCE,
  STAFF_AUDIENCE,
  type PlatformTokenPayload,
  type StaffTokenPayload,
} from '../../common/auth-types.js';
import { AppConfigService } from '../../config/app-config.service.js';

/** Signs access tokens and derives refresh-token secrets and hashes. */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  signStaffAccess(user: {
    id: string;
    tenantId: string;
    role: StaffRole;
    email: string;
    fullName: string;
  }): Promise<string> {
    const payload: StaffTokenPayload = {
      sub: user.id,
      tid: user.tenantId,
      role: user.role,
      email: user.email,
      name: user.fullName,
    };
    return this.jwt.signAsync(payload, {
      secret: this.config.get('JWT_ACCESS_SECRET'),
      audience: STAFF_AUDIENCE,
      issuer: this.config.get('APP_DOMAIN'),
      expiresIn: this.config.get('JWT_ACCESS_TTL') as never,
    });
  }

  signPlatformAccess(user: {
    id: string;
    email: string;
    role: string;
    fullName: string;
  }): Promise<string> {
    const payload: PlatformTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      name: user.fullName,
    };
    return this.jwt.signAsync(payload, {
      secret: this.config.get('JWT_PLATFORM_SECRET'),
      audience: PLATFORM_AUDIENCE,
      issuer: this.config.get('APP_DOMAIN'),
      expiresIn: '8h',
    });
  }

  /** 256 bits of randomness, URL-safe. Only its HMAC is ever stored. */
  newRefreshSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Keyed hash of a refresh token. A database dump alone is not enough to
   * mint or recognise valid tokens without JWT_REFRESH_SECRET.
   */
  hashRefresh(token: string): string {
    return createHmac('sha256', this.config.get('JWT_REFRESH_SECRET'))
      .update(token)
      .digest('hex');
  }

  refreshExpiry(from = new Date()): Date {
    const days = this.config.get('REFRESH_TOKEN_TTL_DAYS');
    return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  }
}
