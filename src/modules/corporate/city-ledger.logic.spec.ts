import { agingBucket, allocateOldestFirst, creditCheck, invoiceStatus } from './city-ledger.logic.js';

describe('city ledger', () => {
  it('ages invoices 0-30, 31-60, 61-90, 90+ days', () => {
    expect([0, 30, 31, 60, 61, 90, 91, 400].map(agingBucket)).toEqual(['CURRENT', 'CURRENT', 'D31_60', 'D31_60', 'D61_90', 'D61_90', 'D90_PLUS', 'D90_PLUS']);
  });

  it('derives invoice status from payments', () => {
    expect(invoiceStatus(100, 0, false)).toBe('OPEN');
    expect(invoiceStatus(100, 40, false)).toBe('PARTIALLY_PAID');
    expect(invoiceStatus(100, 100, false)).toBe('PAID');
    expect(invoiceStatus(100, 0, true)).toBe('VOID');
  });

  it('allocates payments oldest invoice first and keeps the rest as credit', () => {
    expect(allocateOldestFirst(150, [{ id: 'a', balanceKobo: 100 }, { id: 'b', balanceKobo: 100 }])).toEqual({
      allocations: [{ invoiceId: 'a', amountKobo: 100 }, { invoiceId: 'b', amountKobo: 50 }],
      leftoverKobo: 0,
    });
    expect(allocateOldestFirst(250, [{ id: 'a', balanceKobo: 100 }, { id: 'b', balanceKobo: 0 }])).toEqual({ allocations: [{ invoiceId: 'a', amountKobo: 100 }], leftoverKobo: 150 });
  });

  it('allows a charge only within the credit limit', () => {
    expect(creditCheck(1_000, 700, 300)).toEqual({ ok: true, availableKobo: 300 });
    expect(creditCheck(1_000, 700, 301)).toEqual({ ok: false, availableKobo: 300 });
    expect(creditCheck(1_000, 1_200, 1).ok).toBe(false);
  });
});
