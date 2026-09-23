import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AppConfigService } from '../../config/app-config.service.js';
import {
  PLATFORM_AUDIENCE,
  STAFF_AUDIENCE,
  type AppRequest,
  type PlatformTokenPayload,
  type StaffTokenPayload,
} from '../auth-types.js';
import { IS_PLATFORM_KEY, IS_PUBLIC_KEY } from '../decorators/index.js';
import { AppException } from '../errors/app-exception.js';

/**
 * Global authentication guard.
 *  - `@Public()` routes pass through.
 *  - `@PlatformOnly()` routes need a platform token (aud=platform, own secret).
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
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const token = extractBearer(req);
    if (!token) throw AppException.unauthorized();

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
}

function extractBearer(req: AppRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
}
