import { addMonths, defaultMemberPrefix, earnPoints, maxRedeemable, memberNumber, nextTier, redeemProblem, spreadDiscount, tierFor } from './loyalty.logic.js';

const tiers = [
  { id: 'm', name: 'Member', minNights: 0, bonusBps: 0 },
  { id: 's', name: 'Silver', minNights: 10, bonusBps: 1000 },
  { id: 'g', name: 'Gold', minNights: 25, bonusBps: 2500 },
];
const rules = { earnPointsPer1000: 10, pointValueKobo: 100, minRedeemPoints: 1000, maxRedeemBps: 5000 };

describe('loyalty rules', () => {
  it('earns 10 points per ₦1,000 of pre-tax spend, plus the tier bonus', () => {
    expect(earnPoints(18_000_000, 10)).toBe(1800); // ₦180,000
    expect(earnPoints(18_000_000, 10, 1000)).toBe(1980);
    expect(earnPoints(99_999, 10)).toBe(9); // ₦999.99
    expect(earnPoints(9_999, 10)).toBe(0);
    expect(earnPoints(-500, 10)).toBe(0);
  });

  it('places members by nights in the last 12 months', () => {
    expect(tierFor(tiers, 0)?.name).toBe('Member');
    expect(tierFor(tiers, 12)?.name).toBe('Silver');
    expect(tierFor(tiers, 25)?.name).toBe('Gold');
    expect(nextTier(tiers, 12)).toEqual({ name: 'Gold', nightsNeeded: 13 });
    expect(nextTier(tiers, 30)).toBeNull();
  });

  it('limits redemptions to the balance, the minimum and half the charges', () => {
    // Charges ₦50,000 -> at most ₦25,000 = 25,000 points.
    expect(maxRedeemable(40_000, 5_000_000, rules)).toBe(25_000);
    expect(maxRedeemable(3_000, 5_000_000, rules)).toBe(3_000);
    expect(redeemProblem(5_000, 4_000, 5_000_000, rules)).toEqual({ code: 'LOYALTY_INSUFFICIENT_POINTS', balance: 4_000 });
    expect(redeemProblem(500, 4_000, 5_000_000, rules)).toEqual({ code: 'LOYALTY_REDEMPTION_LIMIT', minPoints: 1000, maxPoints: 4_000 });
    expect(redeemProblem(30_000, 40_000, 5_000_000, rules)).toMatchObject({ code: 'LOYALTY_REDEMPTION_LIMIT', maxPoints: 25_000 });
    expect(redeemProblem(2_000, 4_000, 5_000_000, rules)).toBeNull();
  });

  it('spreads an online redemption over the nights after promo discounts', () => {
    const parts = spreadDiscount([{ rateKobo: 5_000_000 }, { rateKobo: 6_000_000, discountKobo: 1_000_000 }, { rateKobo: 5_000_000 }], 1_000_000);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1_000_000);
    expect(parts).toEqual([333_334, 333_333, 333_333]);
    expect(spreadDiscount([{ rateKobo: 100 }], 500)).toEqual([100]);
  });

  it('numbers members and adds months', () => {
    expect(memberNumber('PWC', 123)).toBe('PWC-000123');
    expect(defaultMemberPrefix('Palmwine Circle')).toBe('PC');
    expect(addMonths(new Date('2026-01-31T10:00:00Z'), 24).toISOString().slice(0, 10)).toBe('2028-01-31');
  });
});
