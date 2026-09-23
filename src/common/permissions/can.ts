import type { AuthUser } from '../auth-types.js';
import { AppException } from '../errors/app-exception.js';
import { HttpStatus } from '@nestjs/common';
import { permissionsFor } from './catalogue.js';

/** The user's effective permissions (request-loaded, else the system role's). */
export function permsOf(user: Pick<AuthUser, 'role' | 'permissions'>): ReadonlySet<string> {
  return user.permissions ?? permissionsFor(user.role);
}

/** True when the user holds `permission`. */
export function can(user: Pick<AuthUser, 'role' | 'permissions'>, permission: string): boolean {
  return permsOf(user).has(permission);
}

/** True when the user holds at least one of `permissions`. */
export function canAny(user: Pick<AuthUser, 'role' | 'permissions'>, ...permissions: string[]): boolean {
  const held = permsOf(user);
  return permissions.some((x) => held.has(x));
}

export function forbidden(permission: string, message?: string): AppException {
  return new AppException(
    HttpStatus.FORBIDDEN,
    'FORBIDDEN',
    message ?? `You need the "${permission}" permission for this`,
    { permission },
  );
}

/** Throws 403 FORBIDDEN { permission } unless the user holds it. */
export function assertCan(user: Pick<AuthUser, 'role' | 'permissions'>, permission: string, message?: string): void {
  if (!can(user, permission)) throw forbidden(permission, message);
}
