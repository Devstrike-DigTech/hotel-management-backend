import type { Request } from 'express';
import type { StaffRole } from '../generated/prisma/enums.js';

export const STAFF_AUDIENCE = 'hotel';
export const PLATFORM_AUDIENCE = 'platform';
export const GUEST_AUDIENCE = 'guest';
/** M6: short-lived token between the password and the TOTP step of platform sign-in. */
export const PLATFORM_MFA_AUDIENCE = 'platform-mfa';

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
  /** M6: impersonation session id (support viewing as this staff member). */
  imp?: string;
}

/** Claims inside a platform console access token. */
export interface PlatformTokenPayload {
  sub: string;
  email: string;
  role: string;
  name: string;
  /** M6: platform session id (revocable; checked on every request). */
  sid: string;
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
  /**
   * M5: the property this request runs in (X-Property-Id or the user's
   * default) and every property the user may access, set by PermissionGuard.
   */
  propertyId?: string;
  propertyIds?: string[];
  allProperties?: boolean;
  /** M5: the property used without a header (saved default, else the first accessible). */
  defaultPropertyId?: string;
  /** M5: an inaccessible X-Property-Id was ignored on a group-wide route. */
  propertyHeaderIgnored?: boolean;
  /** M6: set when Devstrike support is signed in as this user. */
  impersonation?: ImpersonationPrincipal;
  /** M6: set when the request comes through the partner API with an API key. */
  apiKey?: { id: string; name: string; environment: 'LIVE' | 'TEST' };
}

export interface ImpersonationPrincipal {
  sessionId: string;
  platformUserId: string;
  platformUserName: string;
  mode: 'READ_ONLY' | 'WRITE';
  expiresAt: Date;
}

export interface PlatformPrincipal {
  platformUserId: string;
  email: string;
  role: string;
  fullName: string;
  /** M6 */
  sessionId?: string;
  permissions?: ReadonlySet<string>;
  stepUpAt?: Date | null;
}

export interface AppRequest extends Request {
  user?: AuthUser;
  platformUser?: PlatformPrincipal;
  guest?: GuestPrincipal;
  /** Per-request memo of the tenant's entitlements (see EntitlementsService). */
  entitlementsCache?: Map<string, unknown>;
  rawBody?: Buffer;
  /** M6: X-Request-Id of this request. */
  requestId?: string;
}
