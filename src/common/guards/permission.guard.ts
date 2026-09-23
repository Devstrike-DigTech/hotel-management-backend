import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { StaffRole } from '../../generated/prisma/enums.js';
import { DbService } from '../../prisma/db.service.js';
import type { AppRequest } from '../auth-types.js';
import { ANY_PERMISSION_KEY, GROUP_WIDE_KEY, PERMISSIONS_KEY } from '../decorators/index.js';
import { AppException } from '../errors/app-exception.js';
import { forbidden } from '../permissions/can.js';
import { permissionsFor } from '../permissions/catalogue.js';

export interface StaffAccess {
  role: StaffRole;
  isActive: boolean;
  customRoleId: string | null;
  customPermissions: string[] | null;
  /** M5: property access. Optional so unit-test loaders can omit it. */
  allProperties?: boolean;
  grantedPropertyIds?: string[];
  defaultPropertyId?: string | null;
  /** Every property of the tenant, oldest first. */
  tenantPropertyIds?: string[];
}

export const PROPERTY_HEADER = 'x-property-id';

/** Properties a staff member may access (OWNER: all), oldest first. */
export function accessibleProperties(a: Pick<StaffAccess, 'role' | 'allProperties' | 'grantedPropertyIds' | 'tenantPropertyIds'>): string[] {
  const all = a.tenantPropertyIds ?? [];
  if (a.role === 'OWNER' || a.allProperties !== false) return all;
  const granted = new Set(a.grantedPropertyIds ?? []);
  return all.filter((id) => granted.has(id));
}

/**
 * The property a request runs in: the header if accessible (403 otherwise),
 * else the saved default if still accessible, else the first accessible.
 */
export function resolveRequestProperty(accessible: string[], header: string | undefined, defaultId: string | null | undefined): string {
  if (header !== undefined && header !== '') {
    const id = header.trim().toLowerCase();
    if (!accessible.includes(id)) throw propertyAccessDenied(header);
    return id;
  }
  if (defaultId && accessible.includes(defaultId)) return defaultId;
  if (!accessible.length) throw propertyAccessDenied(null);
  return accessible[0];
}

export function propertyAccessDenied(propertyId: string | null) {
  return new AppException(HttpStatus.FORBIDDEN, 'PROPERTY_ACCESS_DENIED', 'You do not have access to this property', {
    propertyId,
  });
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
          select: {
            role: true, isActive: true, customRoleId: true, customRole: { select: { permissions: true } },
            allProperties: true, defaultPropertyId: true, propertyAccess: { select: { propertyId: true } },
          },
        });
        if (!u) return null;
        const props = await tx.property.findMany({ where: { tenantId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } });
        return {
          role: u.role, isActive: u.isActive, customRoleId: u.customRoleId, customPermissions: u.customRole?.permissions ?? null,
          allProperties: u.allProperties, defaultPropertyId: u.defaultPropertyId,
          grantedPropertyIds: u.propertyAccess.map((x) => x.propertyId),
          tenantPropertyIds: props.map((x) => x.id),
        };
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

    // M5: property scope (after the permission check, as documented).
    if (access.tenantPropertyIds) {
      const accessible = accessibleProperties(access);
      const raw = req.headers[PROPERTY_HEADER];
      const header = Array.isArray(raw) ? raw[0] : raw;
      req.user.propertyIds = accessible;
      req.user.allProperties = access.role === 'OWNER' || access.allProperties !== false;
      const groupWide = this.reflector.getAllAndOverride<boolean | undefined>(GROUP_WIDE_KEY, targets);
      const usable = groupWide && header && !accessible.includes(header.trim().toLowerCase()) ? undefined : header;
      req.user.propertyId = resolveRequestProperty(accessible, usable, access.defaultPropertyId);
      req.user.propertyHeaderIgnored = usable !== header;
      req.user.defaultPropertyId = resolveRequestProperty(accessible, undefined, access.defaultPropertyId);
    }
    return true;
  }
}
