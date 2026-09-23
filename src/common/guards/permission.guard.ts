import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { StaffRole } from '../../generated/prisma/enums.js';
import { DbService } from '../../prisma/db.service.js';
import type { AppRequest } from '../auth-types.js';
import { ANY_PERMISSION_KEY, PERMISSIONS_KEY } from '../decorators/index.js';
import { AppException } from '../errors/app-exception.js';
import { forbidden } from '../permissions/can.js';
import { permissionsFor } from '../permissions/catalogue.js';

export interface StaffAccess {
  role: StaffRole;
  isActive: boolean;
  customRoleId: string | null;
  customPermissions: string[] | null;
}

/** Loads a staff member's current role and custom-role permissions. */
export type StaffAccessLoader = (tenantId: string, userId: string) => Promise<StaffAccess | null>;

/**
 * Authorises hotel staff requests by permission (replaces the M1-M3 role
 * checks). For every staff request it re-reads the user's role, active flag
 * and custom role from the database, so a deactivated user is locked out and
 * an edited custom role applies on the next request, then attaches the
 * effective permission set to `req.user.permissions` for services.
 *
 * `@RequirePermission(a, b)` needs every listed permission;
 * `@AnyPermission(a, b)` needs at least one. Platform, guest and public
 * routes are not affected.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly load: StaffAccessLoader;

  constructor(
    private readonly reflector: Reflector,
    db: DbService,
  ) {
    this.load = (tenantId, userId) =>
      db.tenant(tenantId, async (tx) => {
        const u = await tx.user.findFirst({
          where: { id: userId, tenantId },
          select: { role: true, isActive: true, customRoleId: true, customRole: { select: { permissions: true } } },
        });
        return u ? { role: u.role, isActive: u.isActive, customRoleId: u.customRoleId, customPermissions: u.customRole?.permissions ?? null } : null;
      });
  }

  /** For unit tests: a guard with a stubbed loader. */
  static withLoader(reflector: Reflector, loader: StaffAccessLoader): PermissionGuard {
    const g = Object.create(PermissionGuard.prototype) as PermissionGuard;
    Object.assign(g, { reflector, load: loader });
    return g;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!req.user) return true; // public, guest and platform routes
    const access = await this.load(req.user.tenantId, req.user.userId);
    if (!access || !access.isActive) throw AppException.unauthorized('This account is no longer active');
    const perms = permissionsFor(access.role, access.customPermissions);
    req.user.role = access.role;
    req.user.customRoleId = access.customRoleId;
    req.user.permissions = perms;

    const targets = [ctx.getHandler(), ctx.getClass()];
    const all = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, targets);
    const any = this.reflector.getAllAndOverride<string[] | undefined>(ANY_PERMISSION_KEY, targets);
    for (const code of all ?? []) {
      if (!perms.has(code)) throw forbidden(code);
    }
    if (any?.length && !any.some((c) => perms.has(c))) throw forbidden(any.join(' or '));
    return true;
  }
}
