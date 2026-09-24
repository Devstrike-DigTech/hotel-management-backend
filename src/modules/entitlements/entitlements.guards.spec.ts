import { Reflector } from '@nestjs/core';
import type { AppRequest, AuthUser } from '../../common/auth-types.js';
import { ALLOW_READ_ONLY_KEY } from '../../common/decorators/index.js';
import { AppException } from '../../common/errors/app-exception.js';
import { CHECK_LIMIT_KEY, REQUIRE_FEATURE_KEY } from './entitlements.decorators.js';
import { FeatureGuard, LimitGuard, SubscriptionGuard } from './entitlements.guards.js';
import { EntitlementsService } from './entitlements.service.js';
import { defaultState, fakeDb, httpContext, TENANT_ID, type FakeState } from '../../testing/entitlements.fakes.js';

const user: AuthUser = {
  userId: '22222222-2222-4222-8222-222222222222',
  tenantId: TENANT_ID,
  role: 'OWNER',
  email: 'o@example.ng',
  fullName: 'Owner',
};

function handlerWith(meta: Record<string, unknown>) {
  const handler = () => undefined;
  for (const [k, v] of Object.entries(meta)) Reflect.defineMetadata(k, v, handler);
  return handler;
}

function setup(state: FakeState) {
  const service = new EntitlementsService(fakeDb(state));
  const spy = vi.spyOn(service, 'getEntitlements');
  const reflector = new Reflector();
  return {
    spy,
    feature: new FeatureGuard(reflector, service),
    limit: new LimitGuard(reflector, service),
    sub: new SubscriptionGuard(reflector, service, fakeDb(state)),
  };
}

async function rejection(p: Promise<unknown>): Promise<AppException> {
  try {
    await p;
  } catch (e) {
    return e as AppException;
  }
  throw new Error('expected rejection');
}

describe('FeatureGuard', () => {
  it('passes routes without @RequireFeature', async () => {
    const { feature, spy } = setup(defaultState());
    await expect(feature.canActivate(httpContext({ user, method: 'GET' }))).resolves.toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes when the feature is included', async () => {
    const { feature } = setup(defaultState());
    const ctx = httpContext({ user, method: 'GET' }, handlerWith({ [REQUIRE_FEATURE_KEY]: ['housekeeping'] }));
    await expect(feature.canActivate(ctx)).resolves.toBe(true);
  });

  it('throws FEATURE_LOCKED when the plan lacks the feature', async () => {
    const { feature } = setup(defaultState({ planCode: 'starter', planFeatures: ['front_desk'] }));
    const ctx = httpContext({ user, method: 'GET' }, handlerWith({ [REQUIRE_FEATURE_KEY]: ['housekeeping'] }));
    const err = await rejection(feature.canActivate(ctx));
    expect(err.code).toBe('FEATURE_LOCKED');
    expect(err.details).toEqual({ feature: 'housekeeping', requiredPlan: 'growth' });
  });
});

describe('LimitGuard', () => {
  it('throws LIMIT_REACHED at the maximum', async () => {
    const { limit } = setup(defaultState({ limits: { max_staff: 3 }, usage: { rooms: 0, staff: 3, properties: 1 } }));
    const ctx = httpContext({ user, method: 'POST' }, handlerWith({ [CHECK_LIMIT_KEY]: 'max_staff' }));
    const err = await rejection(limit.canActivate(ctx));
    expect(err.code).toBe('LIMIT_REACHED');
    expect(err.details).toMatchObject({ limit: 'max_staff', max: 3, current: 3 });
  });

  it('passes below the maximum', async () => {
    const { limit } = setup(defaultState({ limits: { max_staff: 3 }, usage: { rooms: 0, staff: 2, properties: 1 } }));
    const ctx = httpContext({ user, method: 'POST' }, handlerWith({ [CHECK_LIMIT_KEY]: 'max_staff' }));
    await expect(limit.canActivate(ctx)).resolves.toBe(true);
  });
});

describe('SubscriptionGuard', () => {
  it('lets reads through even when read-only', async () => {
    const { sub, spy } = setup(defaultState({ status: 'READ_ONLY' }));
    await expect(sub.canActivate(httpContext({ user, method: 'GET' }))).resolves.toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('blocks writes when READ_ONLY with 402', async () => {
    const { sub } = setup(defaultState({ status: 'READ_ONLY' }));
    const err = await rejection(sub.canActivate(httpContext({ user, method: 'POST' })));
    expect(err.getStatus()).toBe(402);
    expect(err.code).toBe('SUBSCRIPTION_READ_ONLY');
  });

  it('honours @AllowWhenReadOnly', async () => {
    const { sub } = setup(defaultState({ status: 'SUSPENDED' }));
    const ctx = httpContext({ user, method: 'POST' }, handlerWith({ [ALLOW_READ_ONLY_KEY]: true }));
    await expect(sub.canActivate(ctx)).resolves.toBe(true);
  });

  it('ignores unauthenticated (public) requests', async () => {
    const { sub } = setup(defaultState({ status: 'SUSPENDED' }));
    await expect(sub.canActivate(httpContext({ method: 'POST' }))).resolves.toBe(true);
  });
});

describe('entitlements memoisation', () => {
  it('loads entitlements once per request across guards', async () => {
    const { sub, feature, limit, spy } = setup(defaultState());
    const req: Partial<AppRequest> = { user, method: 'POST' };
    const handler = handlerWith({ [REQUIRE_FEATURE_KEY]: ['front_desk'], [CHECK_LIMIT_KEY]: 'max_rooms' });
    await sub.canActivate(httpContext(req, handler));
    await feature.canActivate(httpContext(req, handler));
    await limit.canActivate(httpContext(req, handler));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
