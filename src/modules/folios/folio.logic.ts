import type { FolioEntry } from '../../generated/prisma/client.js';
import { fromDbDate } from '../../common/time/lagos.js';
import { k } from '../ops/ops.helpers.js';

export const CHARGE_TYPES = ['ROOM', 'DAY_USE', 'EXTRA'] as const;

export interface FolioTotals {
  chargesKobo: number;
  discountsKobo: number;
  taxKobo: number;
  serviceChargeKobo: number;
  paymentsKobo: number;
  refundsKobo: number;
  balanceKobo: number;
}

/** Map of voided entry id -> the VOID entry that voids it. */
export function voidIndex(entries: FolioEntry[]): Map<string, FolioEntry> {
  const m = new Map<string, FolioEntry>();
  for (const e of entries) if (e.type === 'VOID' && e.refEntryId) m.set(e.refEntryId, e);
  return m;
}

/** Totals by category, net of voids. Balance is simply the sum of every line. */
export function folioTotals(entries: FolioEntry[]): FolioTotals {
  const voids = voidIndex(entries);
  const t: FolioTotals = { chargesKobo: 0, discountsKobo: 0, taxKobo: 0, serviceChargeKobo: 0, paymentsKobo: 0, refundsKobo: 0, balanceKobo: 0 };
  for (const e of entries) {
    const amt = k(e.amountKobo);
    t.balanceKobo += amt;
    if (e.type === 'VOID' || voids.has(e.id)) continue;
    switch (e.type) {
      case 'ROOM':
      case 'DAY_USE':
      case 'EXTRA':
        t.chargesKobo += amt;
        break;
      case 'DISCOUNT':
        t.discountsKobo += -amt;
        break;
      case 'TAX':
        t.taxKobo += amt;
        break;
      case 'SERVICE_CHARGE':
        t.serviceChargeKobo += amt;
        break;
      case 'PAYMENT':
        t.paymentsKobo += -amt;
        break;
      case 'REFUND':
        t.refundsKobo += amt;
        break;
    }
  }
  return t;
}

export function sortEntries(entries: FolioEntry[]): FolioEntry[] {
  return [...entries].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
}

export interface EntryViewContext {
  names: Map<string, string>;
  receipts: Map<string, { id: string; number: string }>;
}

export function entryViews(entries: FolioEntry[], ctx: EntryViewContext) {
  const sorted = sortEntries(entries);
  const voids = voidIndex(sorted);
  let running = 0;
  return sorted.map((e) => {
    running += k(e.amountKobo);
    const v = voids.get(e.id);
    const receipt = ctx.receipts.get(e.id);
    const ref = (id: string | null) => (id ? { id, fullName: ctx.names.get(id) ?? 'Former staff member' } : null);
    return {
      id: e.id,
      type: e.type,
      amountKobo: k(e.amountKobo),
      description: e.description,
      businessDate: fromDbDate(e.businessDate),
      parentEntryId: e.parentEntryId,
      refEntryId: e.refEntryId,
      taxCode: e.taxCode,
      rateBps: e.rateBps,
      inclusive: e.inclusive,
      paymentMethod: e.paymentMethod,
      paymentRef: e.paymentRef,
      shiftId: e.shiftId,
      receiptId: receipt?.id ?? null,
      receiptNumber: receipt?.number ?? null,
      reason: e.reason,
      approvedBy: ref(e.approvedById),
      voided: !!v,
      voidedByEntryId: v?.id ?? null,
      voidReason: v?.reason ?? null,
      createdBy: ref(e.createdById),
      createdAt: e.createdAt.toISOString(),
      clientCreatedAt: e.clientCreatedAt?.toISOString() ?? null,
      runningBalanceKobo: running,
    };
  });
}

/**
 * Discount base: undiscounted net value of live charges. With a target, the
 * target charge minus live discounts already on it.
 */
export function discountBase(entries: FolioEntry[], targetEntryId?: string): number {
  const voids = voidIndex(entries);
  const live = entries.filter((e) => e.type !== 'VOID' && !voids.has(e.id));
  if (targetEntryId) {
    const target = live.find((e) => e.id === targetEntryId);
    if (!target) return 0;
    const already = live.filter((e) => e.type === 'DISCOUNT' && e.parentEntryId === targetEntryId).reduce((a, e) => a + k(e.amountKobo), 0);
    return k(target.amountKobo) + already;
  }
  const charges = live.filter((e) => (CHARGE_TYPES as readonly string[]).includes(e.type)).reduce((a, e) => a + k(e.amountKobo), 0);
  const discounts = live.filter((e) => e.type === 'DISCOUNT').reduce((a, e) => a + k(e.amountKobo), 0);
  return charges + discounts;
}
