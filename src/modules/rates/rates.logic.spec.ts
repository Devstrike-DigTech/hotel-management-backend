import { describe, expect, it } from 'vitest';
import type { TaxComponent } from '../folios/tax.logic.js';
import {
  applyAdjustment,
  barForNight,
  dayOfWeek,
  planPrice,
  planUnavailable,
  promoDiscounts,
  promoStaticProblem,
  resolveNights,
  restrictionHits,
  restrictionOn,
  stayDates,
  VIRTUAL_BAR,
  winningRule,
  type PlanLike,
  type PromoLike,
  type RuleLike,
} from './rates.logic.js';

const RT = { id: 'rt-1', basePriceKobo: 5_000_000 };
const VAT: TaxComponent[] = [{ code: 'VAT', label: 'VAT', rateBps: 750, inclusive: false }];

function rule(p: Partial<RuleLike>): RuleLike {
  return {
    id: p.id ?? 'r',
    name: p.name ?? 'Rule',
    roomTypeIds: [],
    dateFrom: '2026-01-01',
    dateTo: '2027-12-31',
    daysOfWeek: [],
    adjustmentType: 'PERCENT',
    adjustmentValue: 1_000,
    priority: 0,
    active: true,
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...p,
  };
}

function plan(p: Partial<PlanLike>): PlanLike {
  return { ...VIRTUAL_BAR, id: 'p', code: 'P', name: 'Plan', kind: 'NON_REFUNDABLE', isBar: false, ...p };
}

const weekend = rule({ id: 'wk', name: 'Weekend +10%', daysOfWeek: [5, 6], priority: 10 });
const december = rule({ id: 'dd', name: 'Detty December +35%', dateFrom: '2026-12-15', dateTo: '2027-01-05', adjustmentValue: 3_500, priority: 50 });

describe('rate resolution', () => {
  it('knows the day of the week of a Lagos date', () => {
    expect(dayOfWeek('2026-09-25')).toBe(5); // Friday
    expect(dayOfWeek('2026-09-27')).toBe(0); // Sunday
  });

  it('applies percent (bps), amount and fixed adjustments, rounded to whole naira and never negative', () => {
    expect(applyAdjustment(5_000_000, 'PERCENT', 1_000)).toBe(5_500_000);
    expect(applyAdjustment(5_000_000, 'PERCENT', -1_500)).toBe(4_250_000);
    expect(applyAdjustment(3_333_333, 'PERCENT', 1_000)).toBe(3_666_700);
    expect(applyAdjustment(5_000_000, 'AMOUNT', -750_000)).toBe(4_250_000);
    expect(applyAdjustment(5_000_000, 'AMOUNT', -9_000_000)).toBe(0);
    expect(applyAdjustment(5_000_000, 'FIXED', 4_200_000)).toBe(4_200_000);
    expect(applyAdjustment(5_000_000, null, null)).toBe(5_000_000);
  });

  it('matches a rule only on its days of the week', () => {
    expect(winningRule([weekend], RT.id, '2026-09-25')?.id).toBe('wk'); // Fri
    expect(winningRule([weekend], RT.id, '2026-09-26')?.id).toBe('wk'); // Sat
    expect(winningRule([weekend], RT.id, '2026-09-27')).toBeNull(); // Sun
  });

  it('lets the highest priority rule win, ties going to the most recently updated', () => {
    // Fri 18 Dec 2026 matches both the weekend and December rules.
    expect(winningRule([weekend, december], RT.id, '2026-12-18')?.id).toBe('dd');
    const older = rule({ id: 'old', priority: 5, updatedAt: new Date('2026-01-01T00:00:00Z') });
    const newer = rule({ id: 'new', priority: 5, updatedAt: new Date('2026-06-01T00:00:00Z') });
    expect(winningRule([older, newer], RT.id, '2026-10-01')?.id).toBe('new');
    expect(winningRule([newer, older], RT.id, '2026-10-01')?.id).toBe('new');
  });

  it('ignores inactive rules, rules outside their dates and rules for other room types', () => {
    expect(winningRule([rule({ active: false })], RT.id, '2026-10-01')).toBeNull();
    expect(winningRule([december], RT.id, '2027-01-06')).toBeNull();
    expect(winningRule([rule({ roomTypeIds: ['rt-2'] })], RT.id, '2026-10-01')).toBeNull();
  });

  it('prices BAR as override, else winning rule, else base price', () => {
    const overrides = new Map([[`${RT.id}|2026-12-31`, 13_500_000]]);
    expect(barForNight(RT, '2026-12-31', [weekend, december], overrides)).toEqual({ baseRateKobo: 13_500_000, source: 'OVERRIDE', ruleId: null, ruleName: null });
    expect(barForNight(RT, '2026-12-30', [weekend, december], overrides)).toMatchObject({ baseRateKobo: 6_750_000, source: 'RULE', ruleName: 'Detty December +35%' });
    expect(barForNight(RT, '2026-09-28', [weekend, december], overrides)).toMatchObject({ baseRateKobo: 5_000_000, source: 'BASE' });
  });

  it('derives plan prices from BAR and uses fixed prices per room type', () => {
    expect(planPrice(VIRTUAL_BAR, RT.id, 5_500_000)).toBe(5_500_000);
    expect(planPrice(plan({ adjustmentType: 'PERCENT', adjustmentValue: -1_000 }), RT.id, 5_500_000)).toBe(4_950_000);
    const corp = plan({ pricing: 'FIXED', fixedPrices: [{ roomTypeId: RT.id, rateKobo: 4_800_000 }] });
    expect(planPrice(corp, RT.id, 9_999_900)).toBe(4_800_000);
    expect(planPrice(corp, 'rt-2', 5_000_000)).toBeNull();
    expect(planPrice(plan({ roomTypeIds: ['rt-2'] }), RT.id, 5_000_000)).toBeNull();
  });

  it('resolves every night of a stay on its own (weekend nights cost more)', () => {
    const nrf = plan({ adjustmentType: 'PERCENT', adjustmentValue: -1_000 });
    const nights = resolveNights({ roomType: RT, plan: nrf, dates: stayDates('2026-09-24', '2026-09-28'), rules: [weekend], overrides: new Map() })!;
    expect(nights.map((n) => [n.date, n.rateKobo, n.baseRateKobo, n.source])).toEqual([
      ['2026-09-24', 4_500_000, 5_000_000, 'BASE'],
      ['2026-09-25', 4_950_000, 5_500_000, 'RULE'],
      ['2026-09-26', 4_950_000, 5_500_000, 'RULE'],
      ['2026-09-27', 4_500_000, 5_000_000, 'BASE'],
    ]);
    expect(nights.every((n) => n.discountKobo === 0)).toBe(true);
  });

  it('marks fixed-price nights as FIXED and returns null when the plan does not sell the type', () => {
    const corp = plan({ pricing: 'FIXED', fixedPrices: [{ roomTypeId: RT.id, rateKobo: 4_800_000 }] });
    const n = resolveNights({ roomType: RT, plan: corp, dates: ['2026-12-31'], rules: [december], overrides: new Map() })!;
    expect(n[0]).toMatchObject({ rateKobo: 4_800_000, source: 'FIXED', ruleId: null });
    expect(resolveNights({ roomType: { id: 'rt-2', basePriceKobo: 1 }, plan: corp, dates: ['2026-12-31'], rules: [], overrides: new Map() })).toBeNull();
  });

  it('checks plan eligibility: channel, room type, min and max nights', () => {
    const long = plan({ minNights: 7, channels: ['BOOKING_SITE'] });
    expect(planUnavailable(long, RT.id, 7, 'BOOKING_SITE')).toBeNull();
    expect(planUnavailable(long, RT.id, 6, 'BOOKING_SITE')).toBe('MIN_NIGHTS');
    expect(planUnavailable(long, RT.id, 7, 'MARKETPLACE')).toBe('CHANNEL');
    expect(planUnavailable(plan({ maxNights: 3 }), RT.id, 4, 'FRONT_DESK')).toBe('MAX_NIGHTS');
    expect(planUnavailable(plan({ active: false }), RT.id, 1, 'FRONT_DESK')).toBe('INACTIVE');
  });
});

describe('restrictions', () => {
  const list = [
    { roomTypeId: null, date: '2026-12-31', closedToArrival: false, closedToDeparture: false, stopSell: false, minNights: 3 },
    { roomTypeId: RT.id, date: '2026-12-31', closedToArrival: false, closedToDeparture: false, stopSell: false, minNights: 2 },
    { roomTypeId: null, date: '2026-12-24', closedToArrival: true, closedToDeparture: false, stopSell: false, minNights: null },
    { roomTypeId: RT.id, date: '2026-10-10', closedToArrival: false, closedToDeparture: false, stopSell: true, minNights: null },
    { roomTypeId: null, date: '2026-10-20', closedToArrival: false, closedToDeparture: true, stopSell: false, minNights: null },
  ];

  it('combines all-types and type rows, keeping the strictest minimum stay', () => {
    expect(restrictionOn(list, RT.id, '2026-12-31')).toMatchObject({ minNights: 3 });
    expect(restrictionOn(list, RT.id, '2026-11-01')).toBeNull();
  });

  it('reports each broken restriction', () => {
    expect(restrictionHits(list, RT.id, '2026-12-31', '2027-01-02').map((h) => h.reason)).toEqual(['MIN_NIGHTS']);
    expect(restrictionHits(list, RT.id, '2026-12-31', '2027-01-03')).toEqual([]);
    expect(restrictionHits(list, RT.id, '2026-12-24', '2026-12-26').map((h) => h.reason)).toEqual(['CLOSED_TO_ARRIVAL']);
    expect(restrictionHits(list, RT.id, '2026-10-09', '2026-10-12').map((h) => h.reason)).toEqual(['STOP_SELL']);
    expect(restrictionHits(list, 'rt-2', '2026-10-09', '2026-10-12')).toEqual([]);
    expect(restrictionHits(list, RT.id, '2026-10-18', '2026-10-20').map((h) => h.reason)).toEqual(['CLOSED_TO_DEPARTURE']);
    // A stay that passes through (not arriving on) the closed-to-arrival date is fine.
    expect(restrictionHits(list, RT.id, '2026-12-23', '2026-12-26')).toEqual([]);
  });
});

describe('promo codes', () => {
  const base: PromoLike = {
    code: 'WELCOME10',
    description: '',
    type: 'PERCENT',
    value: 1_000,
    validFrom: '2026-09-01',
    validTo: '2026-12-31',
    stayFrom: null,
    stayTo: null,
    minNights: null,
    maxUses: null,
    perGuestLimit: null,
    channels: ['BOOKING_SITE', 'MARKETPLACE'],
    roomTypeIds: [],
    firstBookingOnly: false,
    active: true,
  };
  const stay = { today: '2026-09-23', arrivalDate: '2026-10-01', departureDate: '2026-10-03', channel: 'BOOKING_SITE' as const, roomTypeId: RT.id, taken: 0 };

  it('accepts a valid code', () => {
    expect(promoStaticProblem(base, stay)).toBeNull();
  });

  it('rejects by booking window, stay window, nights, channel, room type and uses', () => {
    expect(promoStaticProblem({ ...base, active: false }, stay)).toBe('INACTIVE');
    expect(promoStaticProblem(base, { ...stay, today: '2026-08-31' })).toBe('NOT_STARTED');
    expect(promoStaticProblem(base, { ...stay, today: '2027-01-01' })).toBe('EXPIRED');
    expect(promoStaticProblem({ ...base, stayFrom: '2026-10-02' }, stay)).toBe('STAY_DATES');
    expect(promoStaticProblem({ ...base, stayTo: '2026-10-01' }, stay)).toBe('STAY_DATES');
    expect(promoStaticProblem({ ...base, stayTo: '2026-10-02' }, stay)).toBeNull(); // last night is 2 Oct
    expect(promoStaticProblem({ ...base, minNights: 3 }, stay)).toBe('MIN_NIGHTS');
    expect(promoStaticProblem(base, { ...stay, channel: 'FRONT_DESK' })).toBe('CHANNEL');
    expect(promoStaticProblem({ ...base, roomTypeIds: ['rt-2'] }, stay)).toBe('ROOM_TYPE');
    expect(promoStaticProblem({ ...base, maxUses: 3 }, { ...stay, taken: 3 })).toBe('USED_UP');
    expect(promoStaticProblem({ ...base, maxUses: 3 }, { ...stay, taken: 2 })).toBeNull();
    expect(promoStaticProblem({ ...base, type: 'FREE_NIGHT', value: 4 }, stay)).toBe('MIN_NIGHTS');
  });

  it('discounts percent codes per night on the net price', () => {
    expect(promoDiscounts({ type: 'PERCENT', value: 1_000 }, [{ rateKobo: 5_000_000 }, { rateKobo: 5_500_000 }], VAT)).toEqual([500_000, 550_000]);
  });

  it('spreads amount codes across nights and never beyond the room price', () => {
    expect(promoDiscounts({ type: 'AMOUNT', value: 1_000_000 }, [{ rateKobo: 5_000_000 }, { rateKobo: 5_000_000 }], VAT)).toEqual([500_000, 500_000]);
    expect(promoDiscounts({ type: 'AMOUNT', value: 99_000_000 }, [{ rateKobo: 5_000_000 }], VAT)).toEqual([5_000_000]);
  });

  it('gives the cheapest night free once the stay is long enough', () => {
    const nights = [{ rateKobo: 5_500_000 }, { rateKobo: 5_000_000 }, { rateKobo: 5_500_000 }, { rateKobo: 5_000_000 }];
    expect(promoDiscounts({ type: 'FREE_NIGHT', value: 4 }, nights, VAT)).toEqual([0, 5_000_000, 0, 0]);
    expect(promoDiscounts({ type: 'FREE_NIGHT', value: 4 }, nights.slice(0, 3), VAT)).toEqual([0, 0, 0]);
  });

  it('discounts the net of an inclusive price', () => {
    const inclusive: TaxComponent[] = [{ code: 'VAT', label: 'VAT', rateBps: 750, inclusive: true }];
    const [d] = promoDiscounts({ type: 'PERCENT', value: 1_000 }, [{ rateKobo: 5_375_000 }], inclusive);
    expect(d).toBe(500_000);
  });
});
