import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type {
  AppRequest,
  AuthUser,
  GuestPrincipal,
  PlatformPrincipal,
} from '../auth-types.js';
import { AppException } from '../errors/app-exception.js';
import { rateLimitIp } from '../trusted-ip.js';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const IS_PLATFORM_KEY = 'auth:isPlatform';
export const PERMISSIONS_KEY = 'auth:permissions';
export const ANY_PERMISSION_KEY = 'auth:anyPermission';
export const IS_GUEST_KEY = 'auth:isGuest';
export const OPTIONAL_GUEST_KEY = 'auth:optionalGuest';
export const ALLOW_READ_ONLY_KEY = 'billing:allowReadOnly';
export const GROUP_WIDE_KEY = 'property:groupWide';

/** Route needs no authentication. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Route requires a platform console token (separate audience and secret). */
export const PlatformOnly = () => SetMetadata(IS_PLATFORM_KEY, true);

/** Route requires a guest token (audience `guest`, own secret). */
export const GuestOnly = () => SetMetadata(IS_GUEST_KEY, true);

/**
 * Public route that also reads a guest token when one is sent (bookings made
 * while signed in). An invalid or expired token is ignored: the request is
 * handled as anonymous.
 */
export const OptionalGuest = () => SetMetadata(OPTIONAL_GUEST_KEY, true);

/**
 * Restrict a hotel route to staff holding EVERY listed permission (see the
 * catalogue in common/permissions). Enforced by PermissionGuard; a missing
 * permission is 403 FORBIDDEN { permission }.
 */
export const RequirePermission = (...permissions: string[]) => SetMetadata(PERMISSIONS_KEY, permissions);

/** Restrict a hotel route to staff holding AT LEAST ONE of the permissions. */
export const AnyPermission = (...permissions: string[]) => SetMetadata(ANY_PERMISSION_KEY, permissions);

/**
 * Allow a mutating route even when the tenant's subscription is READ_ONLY or
 * SUSPENDED (e.g. paying the bill, logging out).
 */
export const AllowWhenReadOnly = () => SetMetadata(ALLOW_READ_ONLY_KEY, true);

/**
 * M5: a tenant-wide route (the hotel group). An `X-Property-Id` the user
 * cannot access is ignored here (the request runs in their default property)
 * instead of answering 403 PROPERTY_ACCESS_DENIED.
 */
export const GroupWide = () => SetMetadata(GROUP_WIDE_KEY, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!req.user) throw AppException.unauthorized();
    return req.user;
  },
);

export const CurrentPlatformUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PlatformPrincipal => {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!req.platformUser) throw AppException.unauthorized();
    return req.platformUser;
  },
);

/** Best-effort client IP for audit records. */
export const ClientIp = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    return req.ip;
  },
);

/**
 * Client IP for rate limiting: the X-Client-IP of a trusted web server (see
 * common/trusted-ip.ts), else the socket IP.
 */
export const RateLimitIp = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  const secret = process.env.TRUSTED_PROXY_SECRET?.trim();
  return rateLimitIp(req, secret && secret.length >= 16 ? secret : undefined);
});

export const CurrentGuest = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): GuestPrincipal => {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (!req.guest) throw AppException.unauthorized();
    return req.guest;
  },
);

/** The signed-in guest on an @OptionalGuest() route, or undefined. */
export const MaybeGuest = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): GuestPrincipal | undefined =>
    ctx.switchToHttp().getRequest<AppRequest>().guest,
);
