import {
  isDayUseOverstay,
  isLateRegistration,
  isOccupiedWithoutStay,
  isRepeatedVoids,
  ruleEnabled,
  shiftVarianceSeverity,
  voidedPaymentSeverity,
} from './guard.logic.js';

const now = new Date('2026-09-23T15:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe('ruleEnabled', () => {
  const basic = ['revenue_guard_basic'];
  const full = ['revenue_guard_basic', 'revenue_guard_full'];
  it('enables basic rules on Starter', () => {
    expect(ruleEnabled('SHIFT_VARIANCE', basic)).toBe(true);
    expect(ruleEnabled('VOIDED_PAYMENT', basic)).toBe(true);
    expect(ruleEnabled('CHECKOUT_WITH_BALANCE', basic)).toBe(true);
  });
  it('locks full rules without revenue_guard_full, except the discount fallback', () => {
    expect(ruleEnabled('OCCUPIED_WITHOUT_STAY', basic)).toBe(false);
    expect(ruleEnabled('ROOM_STATUS_FLIP', basic)).toBe(false);
    expect(ruleEnabled('DISCOUNT_OVER_THRESHOLD', basic)).toBe(true);
    expect(ruleEnabled('OCCUPIED_WITHOUT_STAY', full)).toBe(true);
  });
  it('disables everything without any Revenue Guard feature', () => {
    expect(ruleEnabled('SHIFT_VARIANCE', ['front_desk'])).toBe(false);
  });
});

describe('shiftVarianceSeverity', () => {
  const v = (cash: number, pos = 0, transfer = 0) => ({
    varianceCashKobo: cash, variancePosKobo: pos, varianceTransferKobo: transfer, varianceTotalKobo: cash + pos + transfer,
  });
  it('tolerates up to and including ₦500', () => {
    expect(shiftVarianceSeverity(v(0))).toBeNull();
    expect(shiftVarianceSeverity(v(-50_000))).toBeNull();
    expect(shiftVarianceSeverity(v(50_000))).toBeNull();
  });
  it('flags beyond ₦500 on any method, HIGH beyond ₦5,000', () => {
    expect(shiftVarianceSeverity(v(-50_001))).toBe('MEDIUM');
    expect(shiftVarianceSeverity(v(0, 60_000))).toBe('MEDIUM');
    expect(shiftVarianceSeverity(v(0, 0, -500_001))).toBe('HIGH');
  });
  it('does not let a surplus on one method hide a shortage on another', () => {
    expect(shiftVarianceSeverity(v(-200_000, 200_000))).toBe('MEDIUM');
  });
});

describe('time-based rules', () => {
  it('day-use overstay only after the 30 minute grace', () => {
    expect(isDayUseOverstay(minutesAgo(30), now)).toBe(false);
    expect(isDayUseOverstay(minutesAgo(31), now)).toBe(true);
  });
  it('late registration after one hour without a register', () => {
    expect(isLateRegistration(minutesAgo(59), null, now)).toBe(false);
    expect(isLateRegistration(minutesAgo(61), null, now)).toBe(true);
    expect(isLateRegistration(minutesAgo(120), minutesAgo(100), now)).toBe(false);
    expect(isLateRegistration(minutesAgo(180), minutesAgo(30), now)).toBe(true);
  });
  it('repeated voids: three within 24 hours', () => {
    expect(isRepeatedVoids([minutesAgo(5), minutesAgo(10)], now)).toBe(false);
    expect(isRepeatedVoids([minutesAgo(5), minutesAgo(10), minutesAgo(60 * 23)], now)).toBe(true);
    expect(isRepeatedVoids([minutesAgo(5), minutesAgo(10), minutesAgo(60 * 25)], now)).toBe(false);
  });
});

describe('isOccupiedWithoutStay', () => {
  it('flags an OCCUPIED room with no checked-in stay', () => {
    expect(isOccupiedWithoutStay({ status: 'OCCUPIED', hasCheckedInStay: false, hasRecentCheckout: false })).toBe(true);
    expect(isOccupiedWithoutStay({ status: 'OCCUPIED', hasCheckedInStay: true, hasRecentCheckout: false })).toBe(false);
  });
  it('flags a dirty room nobody checked out of', () => {
    expect(isOccupiedWithoutStay({ status: 'VACANT_DIRTY', hasCheckedInStay: false, hasRecentCheckout: false })).toBe(true);
    expect(isOccupiedWithoutStay({ status: 'VACANT_DIRTY', hasCheckedInStay: false, hasRecentCheckout: true })).toBe(false);
  });
  it('ignores clean and out-of-order rooms', () => {
    expect(isOccupiedWithoutStay({ status: 'VACANT_CLEAN', hasCheckedInStay: false, hasRecentCheckout: false })).toBe(false);
    expect(isOccupiedWithoutStay({ status: 'OUT_OF_ORDER', hasCheckedInStay: false, hasRecentCheckout: false })).toBe(false);
  });
});

describe('voidedPaymentSeverity', () => {
  it('is HIGH from ₦50,000', () => {
    expect(voidedPaymentSeverity(-4_999_999)).toBe('MEDIUM');
    expect(voidedPaymentSeverity(-5_000_000)).toBe('HIGH');
  });
});
