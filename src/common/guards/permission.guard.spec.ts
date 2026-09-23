import { Reflector } from '@nestjs/core';
import { AppException } from '../errors/app-exception.js';
import { ANY_PERMISSION_KEY, PERMISSIONS_KEY } from '../decorators/index.js';
import { httpContext } from '../../testing/entitlements.fakes.js';
import { PermissionGuard, type StaffAccess } from './permission.guard.js';

const handler = (key: string, codes: string[]) => {
  const h = () => undefined;
  Reflect.defineMetadata(key, codes, h);
  return h;
};

const user = () => ({ userId: 'u', tenantId: 't', role: 'FRONT_DESK' as const, email: 'x@y.ng', fullName: 'X' });

function guardFor(access: StaffAccess | null) {
  return PermissionGuard.withLoader(new Reflector(), async () => access);
}

const system = (role: StaffAccess['role']): StaffAccess => ({ role, isActive: true, customRoleId: null, customPermissions: null });

async function rejects(p: Promise<unknown>, status: number, code: string) {
  try {
    await p;
    throw new Error('should have thrown');
  } catch (e) {
    expect(e).toBeInstanceOf(AppException);
    expect((e as AppException).getStatus()).toBe(status);
    expect((e as AppException).code).toBe(code);
    return e as AppException;
  }
}

describe('PermissionGuard', () => {
  it('lets routes without a permission through and attaches the effective set', async () => {
    const req = { user: user() };
    await expect(guardFor(system('FRONT_DESK')).canActivate(httpContext(req))).resolves.toBe(true);
    expect((req.user as { permissions?: Set<string> }).permissions?.has('frontdesk.checkin')).toBe(true);
  });

  it('allows a role that holds the permission', async () => {
    const ctx = httpContext({ user: user() }, handler(PERMISSIONS_KEY, ['folio.void']));
    await expect(guardFor(system('MANAGER')).canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects a role without it with 403 FORBIDDEN naming the permission', async () => {
    const ctx = httpContext({ user: user() }, handler(PERMISSIONS_KEY, ['folio.void']));
    const e = await rejects(guardFor(system('FRONT_DESK')).canActivate(ctx), 403, 'FORBIDDEN');
    expect(e.details).toEqual({ permission: 'folio.void' });
  });

  it('uses the role read from the database, not the token', async () => {
    // Token says FRONT_DESK, database says ACCOUNTANT (role changed since login).
    const ctx = httpContext({ user: user() }, handler(PERMISSIONS_KEY, ['reports.financial']));
    await expect(guardFor(system('ACCOUNTANT')).canActivate(ctx)).resolves.toBe(true);
  });

  it('gives OWNER every permission', async () => {
    const ctx = httpContext({ user: user() }, handler(PERMISSIONS_KEY, ['payouts.manage', 'audit.export']));
    await expect(guardFor(system('OWNER')).canActivate(ctx)).resolves.toBe(true);
  });

  it('applies a custom role\'s stored permissions and ignores unknown codes', async () => {
    const access: StaffAccess = { role: 'CUSTOM', isActive: true, customRoleId: 'r', customPermissions: ['reports.view', 'made.up'] };
    const ok = httpContext({ user: user() }, handler(PERMISSIONS_KEY, ['reports.view']));
    await expect(guardFor(access).canActivate(ok)).resolves.toBe(true);
    const bad = httpContext({ user: user() }, handler(PERMISSIONS_KEY, ['made.up']));
    await rejects(guardFor(access).canActivate(bad), 403, 'FORBIDDEN');
  });

  it('AnyPermission needs at least one', async () => {
    const ctx = httpContext({ user: user() }, handler(ANY_PERMISSION_KEY, ['rooms.status', 'housekeeping.work']));
    await expect(guardFor(system('HOUSEKEEPING')).canActivate(ctx)).resolves.toBe(true);
    await rejects(guardFor(system('ACCOUNTANT')).canActivate(ctx), 403, 'FORBIDDEN');
  });

  it('locks out deactivated or deleted staff with 401', async () => {
    await rejects(guardFor({ ...system('OWNER'), isActive: false }).canActivate(httpContext({ user: user() })), 401, 'UNAUTHORIZED');
    await rejects(guardFor(null).canActivate(httpContext({ user: user() })), 401, 'UNAUTHORIZED');
  });

  it('ignores public and platform requests', async () => {
    await expect(guardFor(null).canActivate(httpContext({}))).resolves.toBe(true);
  });
});
