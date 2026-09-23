import type { TaxComponent } from '../folios/tax.logic.js';
import { guestNameMatches, happyHourPrice, initialAndSurname, nextBump, orderTotals, ruleActiveAt, stockVariance, voidSeverity } from './pos.logic.js';

const comps: TaxComponent[] = [
  { code: 'VAT', label: 'VAT', rateBps: 750, inclusive: false },
  { code: 'CONSUMPTION', label: 'Consumption tax', rateBps: 500, inclusive: false },
  { code: 'SERVICE_CHARGE', label: 'Service charge', rateBps: 1000, inclusive: false },
];
const rule = { id: 'r', name: 'Happy hour', active: true, outletIds: ['bar'], categoryIds: ['beer'], itemIds: [], daysOfWeek: [], startTime: '17:00', endTime: '19:00', adjustmentType: 'PERCENT' as const, value: 2000 };

describe('POS rules', () => {
  it('applies happy hour in its window, outlet and category only', () => {
    expect(happyHourPrice(200_000, [rule], { outletId: 'bar', categoryId: 'beer', itemId: 'star', dow: 3, hhmm: '17:30' })).toMatchObject({ priceKobo: 160_000 });
    expect(happyHourPrice(200_000, [rule], { outletId: 'bar', categoryId: 'beer', itemId: 'star', dow: 3, hhmm: '19:00' }).rule).toBeNull();
    expect(happyHourPrice(200_000, [rule], { outletId: 'yard', categoryId: 'beer', itemId: 'star', dow: 3, hhmm: '18:00' }).rule).toBeNull();
    // A window across midnight belongs to the day it started.
    const late = { ...rule, startTime: '22:00', endTime: '02:00', daysOfWeek: [5] };
    expect(ruleActiveAt(late, 5, '23:00')).toBe(true);
    expect(ruleActiveAt(late, 6, '01:00')).toBe(true);
    expect(ruleActiveAt(late, 6, '23:00')).toBe(false);
  });

  it('totals an order the way the ledger posts it (service charge only where the outlet applies it)', () => {
    const lines = [
      { name: 'Jollof', quantity: 2, lineTotalKobo: 1_900_000, vat: true, consumption: true },
      { name: 'Water', quantity: 1, lineTotalKobo: 80_000, vat: false, consumption: false },
    ];
    const bar = orderTotals(lines, comps, false, null);
    expect(bar.groups.map((g) => g.key)).toEqual(['VAT+CONSUMPTION', 'NONE']);
    expect(bar.totals).toMatchObject({ itemsKobo: 1_980_000, netKobo: 1_980_000, taxTotalKobo: 237_500, totalKobo: 2_217_500 });
    const yard = orderTotals(lines, comps, true, { mode: 'PERCENT', value: 1000 });
    expect(yard.totals.discountKobo).toBe(198_000);
    expect(yard.totals.totalKobo).toBe(yard.totals.netKobo + yard.totals.taxTotalKobo);
  });

  it('checks the surname on room charges without leaking the full name', () => {
    expect(guestNameMatches('Mrs Okafor', 'Adaeze Okafor')).toBe(true);
    expect(guestNameMatches('okafor', 'Adaeze Chioma Okafor')).toBe(true);
    expect(guestNameMatches('Bello', 'Adaeze Okafor')).toBe(false);
    expect(guestNameMatches('', 'Adaeze Okafor')).toBe(true);
    expect(initialAndSurname('Adaeze Chioma Okafor')).toBe('A. Okafor');
  });

  it('rates voids, stock shortages and bumps', () => {
    expect(voidSeverity(500_000, false)).toBe('MEDIUM');
    expect(voidSeverity(2_000_000, false)).toBe('HIGH');
    expect(voidSeverity(500_000, true)).toBe('HIGH');
    expect(stockVariance([{ expected: 5, counted: 3, unitCostKobo: 4_800_000 }])).toEqual({ shortageKobo: 9_600_000, flagged: true, severity: 'HIGH' });
    expect(stockVariance([{ expected: 60, counted: 58, unitCostKobo: 100_000 }]).flagged).toBe(false);
    expect(nextBump('NEW')).toBe('READY');
    expect(nextBump('READY')).toBe('SERVED');
    expect(nextBump('SERVED')).toBeNull();
  });
});
