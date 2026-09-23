/** City Ledger maths: aging buckets, invoice status, allocation of payments. */

export type AgingBucket = 'CURRENT' | 'D31_60' | 'D61_90' | 'D90_PLUS';
export const BUCKETS: AgingBucket[] = ['CURRENT', 'D31_60', 'D61_90', 'D90_PLUS'];

/** Bucket by days since the invoice was issued: 0-30, 31-60, 61-90, 90+. */
export function agingBucket(daysOutstanding: number): AgingBucket {
  if (daysOutstanding <= 30) return 'CURRENT';
  if (daysOutstanding <= 60) return 'D31_60';
  if (daysOutstanding <= 90) return 'D61_90';
  return 'D90_PLUS';
}

export function emptyAging(): Record<AgingBucket, number> {
  return { CURRENT: 0, D31_60: 0, D61_90: 0, D90_PLUS: 0 };
}

export function invoiceStatus(totalKobo: number, paidKobo: number, voided: boolean): 'OPEN' | 'PARTIALLY_PAID' | 'PAID' | 'VOID' {
  if (voided) return 'VOID';
  if (paidKobo >= totalKobo) return 'PAID';
  return paidKobo > 0 ? 'PARTIALLY_PAID' : 'OPEN';
}

/**
 * Spreads a payment over open invoices, oldest first. Returns the allocations
 * and what is left over (account credit).
 */
export function allocateOldestFirst(amountKobo: number, open: { id: string; balanceKobo: number }[]): { allocations: { invoiceId: string; amountKobo: number }[]; leftoverKobo: number } {
  let left = amountKobo;
  const allocations: { invoiceId: string; amountKobo: number }[] = [];
  for (const inv of open) {
    if (left <= 0) break;
    const take = Math.min(left, inv.balanceKobo);
    if (take > 0) {
      allocations.push({ invoiceId: inv.id, amountKobo: take });
      left -= take;
    }
  }
  return { allocations, leftoverKobo: left };
}

/** A check-out charge fits when the account's outstanding plus the new charge stays within the limit. */
export function creditCheck(creditLimitKobo: number, outstandingKobo: number, chargeKobo: number) {
  const availableKobo = creditLimitKobo - outstandingKobo;
  return { ok: outstandingKobo + chargeKobo <= creditLimitKobo, availableKobo };
}
