import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { AppConfigService } from '../../config/app-config.service.js';
import { httpContext } from '../../testing/entitlements.fakes.js';
import type { AppRequest } from '../auth-types.js';
import { IS_PLATFORM_KEY, IS_PUBLIC_KEY } from '../decorators/index.js';
import { AppException } from '../errors/app-exception.js';
import { AuthGuard } from './auth.guard.js';
import type { PlatformSessionService } from '../../modules/platform/security/platform-session.service.js';
import type { ImpersonationGate } from '../../modules/platform/security/impersonation-gate.js';

// M6: the platform session behind a token is checked on every request.
const sessions = {
  validate: async (sid: string | undefined, sub: string) => {
    if (sid !== 's1') throw new AppException(401, 'SESSION_REVOKED', 'ended');
    return { platformUserId: sub, role: 'SUPER_ADMIN', email: 'a@x.ng', fullName: 'A', sessionId: sid };
  },
} as unknown as PlatformSessionService;
const gate = {
  check: async (sessionId: string) => ({ id: sessionId, platformUserId: 'p1', platformUserName: 'A', mode: sessionId === 'imp-rw' ? 'WRITE' : 'READ_ONLY', expiresAt: new Date(Date.now() + 60_000) }),
} as unknown as ImpersonationGate;

const env: Record<string, string> = {
  JWT_ACCESS_SECRET: 'access-secret-access-secret-access-secret',
  JWT_PLATFORM_SECRET: 'platform-secret-platform-secret-platform',
  APP_DOMAIN: 'hotelos.test',
};
const config = { get: (k: string) => env[k] } as unknown as AppConfigService;
const jwt = new JwtService();

const marked = (key: string) => {
  const h = () => undefined;
  Reflect.defineMetadata(key, true, h);
  return h;
};

const staffToken = () =>
  jwt.signAsync(
    { sub: 'u1', tid: 't1', role: 'OWNER', email: 'o@x.ng', name: 'O' },
    { secret: env.JWT_ACCESS_SECRET, audience: 'hotel', issuer: env.APP_DOMAIN, expiresIn: '5m' },
  );
const impToken = (imp: string) =>
  jwt.signAsync(
    { sub: 'u1', tid: 't1', role: 'OWNER', email: 'o@x.ng', name: 'O', imp },
    { secret: env.JWT_ACCESS_SECRET, audience: 'hotel', issuer: env.APP_DOMAIN, expiresIn: '5m' },
  );
const platformToken = (sid = 's1') =>
  jwt.signAsync(
    { sub: 'p1', role: 'SUPER_ADMIN', email: 'a@x.ng', name: 'A', sid },
    { secret: env.JWT_PLATFORM_SECRET, audience: 'platform', issuer: env.APP_DOMAIN, expiresIn: '5m' },
  );

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as AppException).code;
  }
  return 'NO_ERROR';
}

describe('AuthGuard', () => {
  const guard = new AuthGuard(new Reflector(), jwt, config, sessions, gate);

  it('lets @Public routes through without a token', async () => {
    await expect(guard.canActivate(httpContext({ headers: {} }, marked(IS_PUBLIC_KEY)))).resolves.toBe(true);
  });

  it('rejects a missing token', async () => {
    expect(await code(guard.canActivate(httpContext({ headers: {} })))).toBe('UNAUTHORIZED');
  });

  it('accepts a staff token on hotel routes and attaches the user', async () => {
    const req: Partial<AppRequest> = { headers: { authorization: `Bearer ${await staffToken()}` } };
    await guard.canActivate(httpContext(req));
    expect(req.user).toMatchObject({ userId: 'u1', tenantId: 't1', role: 'OWNER' });
  });

  it('rejects a platform token on hotel routes', async () => {
    const req = { headers: { authorization: `Bearer ${await platformToken()}` } };
    expect(await code(guard.canActivate(httpContext(req)))).toBe('UNAUTHORIZED');
  });

  it('rejects a staff token on platform routes', async () => {
    const req = { headers: { authorization: `Bearer ${await staffToken()}` } };
    expect(await code(guard.canActivate(httpContext(req, marked(IS_PLATFORM_KEY))))).toBe('UNAUTHORIZED');
  });

  it('accepts a platform token on platform routes', async () => {
    const req: Partial<AppRequest> = { headers: { authorization: `Bearer ${await platformToken()}` } };
    await guard.canActivate(httpContext(req, marked(IS_PLATFORM_KEY)));
    expect(req.platformUser).toMatchObject({ platformUserId: 'p1', role: 'SUPER_ADMIN' });
  });

  it('rejects a platform token whose session was revoked', async () => {
    const req = { headers: { authorization: `Bearer ${await platformToken('gone')}` } };
    expect(await code(guard.canActivate(httpContext(req, marked(IS_PLATFORM_KEY))))).toBe('SESSION_REVOKED');
  });

  it('refuses writes in a read-only support session and allows reads', async () => {
    const write: Partial<AppRequest> = { method: 'POST', url: '/api/v1/rooms', headers: { authorization: `Bearer ${await impToken('imp-ro')}` } };
    expect(await code(guard.canActivate(httpContext(write)))).toBe('IMPERSONATION_READ_ONLY');
    const read: Partial<AppRequest> = { method: 'GET', url: '/api/v1/rooms', headers: { authorization: `Bearer ${await impToken('imp-ro')}` } };
    await guard.canActivate(httpContext(read));
    expect(read.user?.impersonation).toMatchObject({ sessionId: 'imp-ro', mode: 'READ_ONLY' });
    const end: Partial<AppRequest> = { method: 'POST', url: '/api/v1/impersonation/end', headers: { authorization: `Bearer ${await impToken('imp-ro')}` } };
    await expect(guard.canActivate(httpContext(end))).resolves.toBe(true);
    const rw: Partial<AppRequest> = { method: 'POST', url: '/api/v1/rooms', headers: { authorization: `Bearer ${await impToken('imp-rw')}` } };
    await expect(guard.canActivate(httpContext(rw))).resolves.toBe(true);
  });
});
