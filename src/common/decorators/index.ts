import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { StaffRole } from '../../generated/prisma/enums.js';
import type {
  AppRequest,
  AuthUser,
  GuestPrincipal,
  PlatformPrincipal,
} from '../auth-types.js';
import { AppException } from '../errors/app-exception.js';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const IS_PLATFORM_KEY = 'auth:isPlatform';
export const ROLES_KEY = 'auth:roles';
export const IS_GUEST_KEY = 'auth:isGuest';
export const OPTIONAL_GUEST_KEY = 'auth:optionalGuest';
export const ALLOW_READ_ONLY_KEY = 'billing:allowReadOnly';

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

/** Restrict a hotel route to the given staff roles. */
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Allow a mutating route even when the tenant's subscription is READ_ONLY or
 * SUSPENDED (e.g. paying the bill, logging out).
 */
export const AllowWhenReadOnly = () => SetMetadata(ALLOW_READ_ONLY_KEY, true);

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
