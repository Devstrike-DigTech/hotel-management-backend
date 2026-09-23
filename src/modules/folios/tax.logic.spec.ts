import { componentsFrom, computeCharge, roundKobo, type TaxSettingsLike } from './tax.logic.js';

const base: TaxSettingsLike = {
  vatEnabled: true, vatRateBps: 750, vatInclusive: false,
  consumptionEnabled: false, consumptionRateBps: 500, consumptionInclusive: false, consumptionLabel: 'Lagos consumption tax',
  serviceChargeEnabled: false, serviceChargeRateBps: 1000, serviceChargeInclusive: false,
};

describe('computeCharge', () => {
  it('adds exclusive VAT 7.5% on top', () => {
    const r = computeCharge(5_000_000, componentsFrom(base));
    expect(r.netKobo).toBe(5_000_000);
    expect(r.lines).toEqual([{ code: 'VAT', label: 'VAT', rateBps: 750, inclusive: false, amountKobo: 375_000 }]);
    expect(r.grossKobo).toBe(5_375_000);
  });

  it('carves inclusive VAT out of the entered amount exactly', () => {
    const r = computeCharge(5_375_000, componentsFrom({ ...base, vatInclusive: true }));
    expect(r.netKobo).toBe(5_000_000);
    expect(r.lines[0].amountKobo).toBe(375_000);
    expect(r.grossKobo).toBe(5_375_000);
  });

  it('keeps net + inclusive taxes equal to the entered amount when rounding', () => {
    const comps = componentsFrom({ ...base, vatInclusive: true, consumptionEnabled: true, consumptionInclusive: true });
    for (const amount of [1, 99, 12_345, 3_333_333, 7_777_777]) {
      const r = computeCharge(amount, comps);
      expect(r.netKobo + r.lines.reduce((a, l) => a + l.amountKobo, 0)).toBe(amount);
      expect(r.grossKobo).toBe(amount);
    }
  });

  it('computes every component on the net (no tax on tax) with mixed inclusivity', () => {
    const comps = componentsFrom({
      ...base,
      serviceChargeEnabled: true, serviceChargeInclusive: false,
      consumptionEnabled: true, consumptionInclusive: true,
    });
    // entered 10,500.00 includes 5% consumption -> net 10,000.00
    const r = computeCharge(1_050_000, comps);
    expect(r.netKobo).toBe(1_000_000);
    const by = Object.fromEntries(r.lines.map((l) => [l.code, l.amountKobo]));
    expect(by).toEqual({ SERVICE_CHARGE: 100_000, VAT: 75_000, CONSUMPTION: 50_000 });
    expect(r.grossKobo).toBe(1_050_000 + 100_000 + 75_000);
    expect(r.lines.map((l) => l.code)).toEqual(['SERVICE_CHARGE', 'VAT', 'CONSUMPTION']);
  });

  it('mirrors negative amounts (discounts) exactly', () => {
    const comps = componentsFrom({ ...base, serviceChargeEnabled: true });
    const pos = computeCharge(1_234_567, comps);
    const neg = computeCharge(-1_234_567, comps);
    expect(neg.netKobo).toBe(-pos.netKobo);
    expect(neg.lines.map((l) => l.amountKobo)).toEqual(pos.lines.map((l) => -l.amountKobo));
    expect(neg.grossKobo).toBe(-pos.grossKobo);
  });

  it('posts no tax lines when every component is off', () => {
    const r = computeCharge(250_000, componentsFrom({ ...base, vatEnabled: false }));
    expect(r.lines).toEqual([]);
    expect(r.grossKobo).toBe(250_000);
  });

  it('omits zero-kobo tax lines on tiny amounts', () => {
    const r = computeCharge(5, componentsFrom(base));
    expect(r.lines).toEqual([]);
  });

  it('rejects fractional kobo', () => {
    expect(() => computeCharge(10.5, componentsFrom(base))).toThrow();
  });
});

describe('roundKobo', () => {
  it('rounds halves away from zero symmetrically', () => {
    expect(roundKobo(2.5)).toBe(3);
    expect(roundKobo(-2.5)).toBe(-3);
    expect(roundKobo(2.4)).toBe(2);
  });
});
