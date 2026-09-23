import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AppConfigService } from '../../config/app-config.service.js';
import {
  GUEST_AUDIENCE,
  PLATFORM_AUDIENCE,
  STAFF_AUDIENCE,
  type AppRequest,
  type GuestTokenPayload,
  type PlatformTokenPayload,
  type StaffTokenPayload,
} from '../auth-types.js';
import { IS_GUEST_KEY, IS_PLATFORM_KEY, IS_PUBLIC_KEY, OPTIONAL_GUEST_KEY } from '../decorators/index.js';
import { AppException } from '../errors/app-exception.js';

/**
 * Global authentication guard.
 *  - `@Public()` routes pass through.
 *  - `@PlatformOnly()` routes need a platform token (aud=platform, own secret).
 *  - `@GuestOnly()` routes need a guest token (aud=guest, own secret);
 *    `@Public() @OptionalGuest()` routes read one if present.
 *  - everything else needs a hotel staff token (aud=hotel).
 * A staff token is never accepted on a platform route and vice versa, because
 * both the signing secret and the audience differ.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      if (this.reflector.getAllAndOverride<boolean>(OPTIONAL_GUEST_KEY, targets)) {
        const t = extractBearer(req);
        if (t) {
          try {
            await this.verifyGuest(req, t);
          } catch {
            // Anonymous booking: a stale guest token must not block it.
          }
        }
      }
      return true;
    }
    const token = extractBearer(req);
    if (!token) throw AppException.unauthorized();

    if (this.reflector.getAllAndOverride<boolean>(IS_GUEST_KEY, targets)) {
      try {
        await this.verifyGuest(req, token);
      } catch {
        throw AppException.unauthorized('Invalid or expired access token');
      }
      return true;
    }

    const platform = this.reflector.getAllAndOverride<boolean>(
      IS_PLATFORM_KEY,
      targets,
    );

    try {
      if (platform) {
        const p = await this.jwt.verifyAsync<PlatformTokenPayload>(token, {
          secret: this.config.get('JWT_PLATFORM_SECRET'),
          audience: PLATFORM_AUDIENCE,
          issuer: this.config.get('APP_DOMAIN'),
        });
        req.platformUser = {
          platformUserId: p.sub,
          email: p.email,
          role: p.role,
          fullName: p.name,
        };
      } else {
        const p = await this.jwt.verifyAsync<StaffTokenPayload>(token, {
          secret: this.config.get('JWT_ACCESS_SECRET'),
          audience: STAFF_AUDIENCE,
          issuer: this.config.get('APP_DOMAIN'),
        });
        req.user = {
          userId: p.sub,
          tenantId: p.tid,
          role: p.role,
          email: p.email,
          fullName: p.name,
        };
      }
    } catch {
      throw AppException.unauthorized('Invalid or expired access token');
    }
    return true;
  }

  private async verifyGuest(req: AppRequest, token: string): Promise<void> {
    const p = await this.jwt.verifyAsync<GuestTokenPayload>(token, {
      secret: this.config.get('GUEST_JWT_SECRET'),
      audience: GUEST_AUDIENCE,
      issuer: this.config.get('APP_DOMAIN'),
    });
    req.guest = { guestAccountId: p.sub, phone: p.phone };
  }
}

function extractBearer(req: AppRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
}
