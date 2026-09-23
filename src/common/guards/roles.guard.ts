import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { StaffRole } from '../../generated/prisma/enums.js';
import type { AppRequest } from '../auth-types.js';
import { ROLES_KEY } from '../decorators/index.js';
import { AppException } from '../errors/app-exception.js';

/** Enforces `@Roles(...)` on hotel routes. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<StaffRole[] | undefined>(
      ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!roles || roles.length === 0) return true;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!req.user) return true; // platform/public routes are not role-gated
    if (!roles.includes(req.user.role)) {
      throw AppException.forbidden(
        `This action requires one of these roles: ${roles.join(', ')}`,
      );
    }
    return true;
  }
}
