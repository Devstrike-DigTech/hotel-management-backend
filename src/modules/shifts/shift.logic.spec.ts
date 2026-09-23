import { denominationTotalKobo, expectedTotals, variance } from './shift.logic.js';

describe('expectedTotals', () => {
  it('adds cash payments to the float and ignores other methods for cash', () => {
    const e = expectedTotals(2_000_000, [
      { type: 'PAYMENT', method: 'CASH', amountKobo: -5_000_000 },
      { type: 'PAYMENT', method: 'POS', amountKobo: -3_000_000 },
      { type: 'PAYMENT', method: 'TRANSFER', amountKobo: -1_000_000 },
      { type: 'REFUND', method: 'CASH', amountKobo: 500_000 },
    ]);
    expect(e).toEqual({
      expectedCashKobo: 2_000_000 + 5_000_000 - 500_000,
      expectedPosKobo: 3_000_000,
      expectedTransferKobo: 1_000_000,
      paymentsCount: 3,
    });
  });

  it('cancels voided payments', () => {
    const e = expectedTotals(0, [
      { type: 'PAYMENT', method: 'CASH', amountKobo: -1_000_000 },
      { type: 'VOID', method: 'CASH', amountKobo: 1_000_000 },
    ]);
    expect(e.expectedCashKobo).toBe(0);
  });
});

describe('variance', () => {
  it('is counted minus expected (negative = short)', () => {
    const v = variance(
      { expectedCashKobo: 7_000_000, expectedPosKobo: 3_000_000, expectedTransferKobo: 0, paymentsCount: 2 },
      { countedCashKobo: 6_900_000, declaredPosKobo: 3_000_000, declaredTransferKobo: 20_000 },
    );
    expect(v).toEqual({ varianceCashKobo: -100_000, variancePosKobo: 0, varianceTransferKobo: 20_000, varianceTotalKobo: -80_000 });
  });
});

describe('denominationTotalKobo', () => {
  it('sums naira notes into kobo', () => {
    expect(denominationTotalKobo({ '1000': 12, '500': 3, '200': 1, '100': 0, '50': 2 })).toBe((12_000 + 1_500 + 200 + 100) * 100);
  });
});
