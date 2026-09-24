import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AppRequest } from '../../../common/auth-types.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { PLATFORM_PERMISSION_KEY, PLATFORM_SUPER_KEY, STEP_UP_KEY, STEP_UP_SECONDS, type PlatformPermission } from './platform-permissions.js';

export function platformForbidden(permission: string) {
  return new AppException(HttpStatus.FORBIDDEN, 'PLATFORM_FORBIDDEN', 'Your console role does not allow this', { permission });
}

export function stepUpRequired() {
  return new AppException(HttpStatus.FORBIDDEN, 'STEP_UP_REQUIRED', 'Enter a code from your authenticator app to continue', { maxAgeSeconds: STEP_UP_SECONDS });
}

/**
 * Platform console authorisation (M6): `@PlatformPermissionRequired(...)`,
 * `@SuperAdminOnly()` and `@RequireStepUp()` (a code re-entered within the
 * last 10 minutes on this session). Hotel, guest and public routes pass.
 */
@Injectable()
export class PlatformPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const p = req.platformUser;
    if (!p) return true;
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PLATFORM_SUPER_KEY, targets) && p.role !== 'SUPER_ADMIN') throw platformForbidden('SUPER_ADMIN');
    const needed = this.reflector.getAllAndOverride<PlatformPermission[] | undefined>(PLATFORM_PERMISSION_KEY, targets) ?? [];
    for (const code of needed) {
      if (!p.permissions?.has(code)) throw platformForbidden(code);
    }
    if (this.reflector.getAllAndOverride<boolean>(STEP_UP_KEY, targets)) {
      const at = p.stepUpAt?.getTime() ?? 0;
      if (Date.now() - at > STEP_UP_SECONDS * 1000) throw stepUpRequired();
    }
    return true;
  }
}
