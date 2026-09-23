import { Reflector } from '@nestjs/core';
import { AppException } from '../errors/app-exception.js';
import { ROLES_KEY } from '../decorators/index.js';
import { httpContext } from '../../testing/entitlements.fakes.js';
import { RolesGuard } from './roles.guard.js';

const handlerWithRoles = (roles: string[]) => {
  const h = () => undefined;
  Reflect.defineMetadata(ROLES_KEY, roles, h);
  return h;
};

const user = (role: 'OWNER' | 'FRONT_DESK') => ({
  userId: 'u',
  tenantId: 't',
  role,
  email: 'x@y.ng',
  fullName: 'X',
});

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('allows routes without @Roles', () => {
    expect(guard.canActivate(httpContext({ user: user('FRONT_DESK') }))).toBe(true);
  });

  it('allows a listed role', () => {
    const ctx = httpContext({ user: user('OWNER') }, handlerWithRoles(['OWNER', 'MANAGER']));
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects other roles with 403 FORBIDDEN', () => {
    const ctx = httpContext({ user: user('FRONT_DESK') }, handlerWithRoles(['OWNER', 'MANAGER']));
    try {
      guard.canActivate(ctx);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppException);
      expect((e as AppException).getStatus()).toBe(403);
      expect((e as AppException).code).toBe('FORBIDDEN');
    }
  });
});
