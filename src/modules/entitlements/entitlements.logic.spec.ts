import {
  computeFeatures,
  exceedsLimit,
  isWriteBlocked,
  normaliseLimits,
  requiredPlanFor,
  upgradePlanFor,
  type PlanLike,
} from './entitlements.logic.js';

const plans: PlanLike[] = [
  { code: 'starter', sortOrder: 1, isActive: true, limits: { max_rooms: 20, max_staff: 3 }, features: ['front_desk'] },
  { code: 'growth', sortOrder: 2, isActive: true, limits: { max_rooms: 60, max_staff: 15 }, features: ['front_desk', 'housekeeping'] },
  { code: 'pro', sortOrder: 3, isActive: true, limits: { max_rooms: 200, max_staff: 50 }, features: ['front_desk', 'housekeeping', 'pos'] },
  { code: 'enterprise', sortOrder: 4, isActive: true, limits: { max_rooms: -1, max_staff: -1 }, features: ['front_desk', 'housekeeping', 'pos', 'api_access'] },
];

describe('computeFeatures', () => {
  it('returns plan features when there are no overrides', () => {
    expect(computeFeatures(['b', 'a'], [])).toEqual(['a', 'b']);
  });

  it('adds enabled overrides and removes disabled ones', () => {
    expect(
      computeFeatures(
        ['front_desk', 'housekeeping'],
        [
          { featureCode: 'pos', enabled: true },
          { featureCode: 'housekeeping', enabled: false },
        ],
      ),
    ).toEqual(['front_desk', 'pos']);
  });

  it('does not duplicate a feature already in the plan', () => {
    expect(computeFeatures(['pos'], [{ featureCode: 'pos', enabled: true }])).toEqual(['pos']);
  });
});

describe('exceedsLimit', () => {
  it('treats -1 and missing limits as unlimited', () => {
    expect(exceedsLimit(-1, 10_000)).toBe(false);
    expect(exceedsLimit(undefined, 10_000)).toBe(false);
  });

  it('allows reaching the max but not passing it', () => {
    expect(exceedsLimit(20, 19)).toBe(false);
    expect(exceedsLimit(20, 20)).toBe(true);
    expect(exceedsLimit(20, 15, 5)).toBe(false);
    expect(exceedsLimit(20, 15, 6)).toBe(true);
  });
});

describe('requiredPlanFor / upgradePlanFor', () => {
  it('finds the cheapest plan with a feature', () => {
    expect(requiredPlanFor('housekeeping', plans)).toBe('growth');
    expect(requiredPlanFor('api_access', plans)).toBe('enterprise');
    expect(requiredPlanFor('nope', plans)).toBeNull();
  });

  it('ignores inactive plans', () => {
    const withInactive = plans.map((p) => (p.code === 'growth' ? { ...p, isActive: false } : p));
    expect(requiredPlanFor('housekeeping', withInactive)).toBe('pro');
  });

  it('suggests the next plan whose limit fits', () => {
    expect(upgradePlanFor('max_rooms', 21, 'starter', plans)).toBe('growth');
    expect(upgradePlanFor('max_rooms', 61, 'starter', plans)).toBe('pro');
    expect(upgradePlanFor('max_rooms', 500, 'growth', plans)).toBe('enterprise');
    expect(upgradePlanFor('max_rooms', 500, 'enterprise', plans)).toBeNull();
  });
});

describe('isWriteBlocked', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  it('blocks READ_ONLY and SUSPENDED', () => {
    expect(isWriteBlocked('READ_ONLY', null, now)).toBe(true);
    expect(isWriteBlocked('SUSPENDED', null, now)).toBe(true);
  });
  it('allows TRIALING, ACTIVE and PAST_DUE', () => {
    for (const s of ['TRIALING', 'ACTIVE', 'PAST_DUE'] as const) {
      expect(isWriteBlocked(s, null, now)).toBe(false);
    }
  });
  it('blocks CANCELLED only after the paid period ends', () => {
    expect(isWriteBlocked('CANCELLED', new Date('2026-06-10T00:00:00Z'), now)).toBe(false);
    expect(isWriteBlocked('CANCELLED', new Date('2026-05-10T00:00:00Z'), now)).toBe(true);
  });
});

describe('normaliseLimits', () => {
  it('keeps numeric values and drops junk', () => {
    expect(normaliseLimits({ a: 1, b: '2', c: 'x', d: null })).toEqual({ a: 1, b: 2 });
    expect(normaliseLimits(null)).toEqual({});
    expect(normaliseLimits([1, 2])).toEqual({});
  });
});
