import type { FolioEntry } from '../../generated/prisma/client.js';
import { discountBase, entryViews, folioTotals } from './folio.logic.js';

let seq = 0;
function e(type: FolioEntry['type'], amount: number, extra: Partial<FolioEntry> = {}): FolioEntry {
  seq++;
  return {
    id: `e${seq}`,
    tenantId: 't',
    propertyId: 'p',
    folioId: 'f',
    type,
    amountKobo: BigInt(amount),
    description: type,
    businessDate: new Date('2026-09-23T00:00:00Z'),
    parentEntryId: null,
    refEntryId: null,
    taxCode: null,
    rateBps: null,
    inclusive: null,
    paymentMethod: null,
    paymentRef: null,
    shiftId: null,
    reason: null,
    approvedById: null,
    createdById: null,
    clientCreatedAt: null,
    createdAt: new Date(Date.UTC(2026, 8, 23, 10, 0, seq)),
    ...extra,
  };
}

describe('folio math', () => {
  it('computes totals net of voids and a running balance', () => {
    const room = e('ROOM', 5_000_000);
    const vat = e('TAX', 375_000, { parentEntryId: room.id, taxCode: 'VAT' });
    const pay = e('PAYMENT', -2_000_000, { paymentMethod: 'CASH' });
    const voidPay = e('VOID', 2_000_000, { refEntryId: pay.id, paymentMethod: 'CASH', reason: 'wrong folio' });
    const pay2 = e('PAYMENT', -5_375_000, { paymentMethod: 'POS' });
    const entries = [room, vat, pay, voidPay, pay2];
    const t = folioTotals(entries);
    expect(t).toEqual({
      chargesKobo: 5_000_000,
      discountsKobo: 0,
      taxKobo: 375_000,
      serviceChargeKobo: 0,
      paymentsKobo: 5_375_000,
      refundsKobo: 0,
      balanceKobo: 0,
    });
    const views = entryViews(entries, { names: new Map(), receipts: new Map() });
    expect(views.map((v) => v.runningBalanceKobo)).toEqual([5_000_000, 5_375_000, 3_375_000, 5_375_000, 0]);
    expect(views[2].voided).toBe(true);
    expect(views[2].voidReason).toBe('wrong folio');
  });

  it('finds the discount base for the whole folio or one charge', () => {
    const room = e('ROOM', 5_000_000);
    const extra = e('EXTRA', 1_000_000);
    const d = e('DISCOUNT', -500_000, { parentEntryId: room.id });
    expect(discountBase([room, extra, d])).toBe(5_500_000);
    expect(discountBase([room, extra, d], room.id)).toBe(4_500_000);
    expect(discountBase([room, extra, d], 'missing')).toBe(0);
  });
});
