import { AppException } from '../../common/errors/app-exception.js';
import { EntitlementsService } from './entitlements.service.js';
import { defaultState, fakeDb, TENANT_ID } from '../../testing/entitlements.fakes.js';

async function caught(p: Promise<unknown> | (() => void)): Promise<AppException> {
  try {
    if (typeof p === 'function') p();
    else await p;
  } catch (e) {
    return e as AppException;
  }
  throw new Error('expected an exception');
}

describe('EntitlementsService', () => {
  it('computes features as plan features plus overrides', async () => {
    const svc = new EntitlementsService(
      fakeDb(
        defaultState({
          overrides: [
            { featureCode: 'pos', enabled: true },
            { featureCode: 'housekeeping', enabled: false },
          ],
        }),
      ),
    );
    const ent = await svc.getEntitlements(TENANT_ID);
    expect(ent.features).toEqual(['front_desk', 'pos']);
    expect(ent.limits).toEqual({ max_rooms: 60, max_staff: 15, max_properties: 1 });
    expect(ent.subscription.planCode).toBe('growth');
    expect(ent.writeBlocked).toBe(false);
  });

  it('assertFeature throws FEATURE_LOCKED with the cheapest plan that has it', async () => {
    const svc = new EntitlementsService(fakeDb(defaultState({ planCode: 'starter', planFeatures: ['front_desk'] })));
    const ent = await svc.getEntitlements(TENANT_ID);
    const err = await caught(svc.assertFeature(ent, 'housekeeping'));
    expect(err).toBeInstanceOf(AppException);
    expect(err.getStatus()).toBe(403);
    expect(err.code).toBe('FEATURE_LOCKED');
    expect(err.details).toEqual({ feature: 'housekeeping', requiredPlan: 'growth' });
  });

  it('assertFeature passes when an add-on override grants the feature', async () => {
    const svc = new EntitlementsService(
      fakeDb(defaultState({ planCode: 'starter', planFeatures: ['front_desk'], overrides: [{ featureCode: 'housekeeping', enabled: true }] })),
    );
    const ent = await svc.getEntitlements(TENANT_ID);
    await expect(svc.assertFeature(ent, 'housekeeping')).resolves.toBeUndefined();
  });

  it('assertWithinLimit throws LIMIT_REACHED with usage and upgrade plan', async () => {
    const svc = new EntitlementsService(
      fakeDb(defaultState({ limits: { max_rooms: 60 }, usage: { rooms: 60, staff: 1, properties: 1 } })),
    );
    const ent = await svc.getEntitlements(TENANT_ID);
    const err = await caught(svc.assertWithinLimit(ent, 'max_rooms', 1));
    expect(err.code).toBe('LIMIT_REACHED');
    expect(err.getStatus()).toBe(403);
    expect(err.details).toEqual({ limit: 'max_rooms', max: 60, current: 60, upgradePlan: 'pro' });
  });

  it('assertWithinLimit accounts for bulk additions', async () => {
    const svc = new EntitlementsService(
      fakeDb(defaultState({ limits: { max_rooms: 60 }, usage: { rooms: 55, staff: 1, properties: 1 } })),
    );
    const ent = await svc.getEntitlements(TENANT_ID);
    await expect(svc.assertWithinLimit(ent, 'max_rooms', 5)).resolves.toBeUndefined();
    const err = await caught(svc.assertWithinLimit(ent, 'max_rooms', 6));
    expect(err.code).toBe('LIMIT_REACHED');
  });

  it('treats -1 as unlimited', async () => {
    const svc = new EntitlementsService(
      fakeDb(defaultState({ limits: { max_rooms: -1 }, usage: { rooms: 5000, staff: 1, properties: 1 } })),
    );
    const ent = await svc.getEntitlements(TENANT_ID);
    await expect(svc.assertWithinLimit(ent, 'max_rooms', 100)).resolves.toBeUndefined();
  });

  it('assertWritable throws SUBSCRIPTION_READ_ONLY (402) for READ_ONLY and SUSPENDED', async () => {
    for (const status of ['READ_ONLY', 'SUSPENDED']) {
      const svc = new EntitlementsService(fakeDb(defaultState({ status })));
      const ent = await svc.getEntitlements(TENANT_ID);
      const err = await caught(() => svc.assertWritable(ent));
      expect(err.getStatus()).toBe(402);
      expect(err.code).toBe('SUBSCRIPTION_READ_ONLY');
    }
  });

  it('assertWritable allows PAST_DUE', async () => {
    const svc = new EntitlementsService(fakeDb(defaultState({ status: 'PAST_DUE' })));
    const ent = await svc.getEntitlements(TENANT_ID);
    expect(() => svc.assertWritable(ent)).not.toThrow();
  });
});
