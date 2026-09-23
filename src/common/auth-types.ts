import type { Request } from 'express';
import type { StaffRole } from '../generated/prisma/enums.js';

export const STAFF_AUDIENCE = 'hotel';
export const PLATFORM_AUDIENCE = 'platform';
export const GUEST_AUDIENCE = 'guest';

/** Claims inside a guest (platform-level account) access token. */
export interface GuestTokenPayload {
  sub: string;
  phone: string;
}

export interface GuestPrincipal {
  guestAccountId: string;
  phone: string;
}

/** Claims inside a hotel staff access token. */
export interface StaffTokenPayload {
  sub: string;
  tid: string;
  role: StaffRole;
  email: string;
  name: string;
}

/** Claims inside a platform console access token. */
export interface PlatformTokenPayload {
  sub: string;
  email: string;
  role: string;
  name: string;
}

export interface AuthUser {
  userId: string;
  tenantId: string;
  role: StaffRole;
  email: string;
  fullName: string;
  /**
   * Effective permissions, loaded from the database by PermissionGuard on
   * every staff request (so custom-role edits apply at once). When absent
   * (jobs, internal calls) the system role's set is used.
   */
  permissions?: ReadonlySet<string>;
  customRoleId?: string | null;
}

export interface PlatformPrincipal {
  platformUserId: string;
  email: string;
  role: string;
  fullName: string;
}

export interface AppRequest extends Request {
  user?: AuthUser;
  platformUser?: PlatformPrincipal;
  guest?: GuestPrincipal;
  /** Per-request memo of the tenant's entitlements (see EntitlementsService). */
  entitlementsCache?: Map<string, unknown>;
  rawBody?: Buffer;
}
