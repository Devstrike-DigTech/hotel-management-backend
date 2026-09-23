import { computeCharge, type TaxComponent, type TaxLine } from '../folios/tax.logic.js';

/** Items: the tax flags of a line and the outlet's service-charge flag decide its components. */
export interface LineTaxFlags {
  vat: boolean;
  consumption: boolean;
}

export interface PriceRuleLike {
  id: string;
  name: string;
  active: boolean;
  outletIds: string[];
  categoryIds: string[];
  itemIds: string[];
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  adjustmentType: 'PERCENT' | 'AMOUNT' | 'FIXED';
  value: number;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Whether a happy-hour window is on at Lagos weekday `dow` (0 = Sunday) and
 * time `hhmm`. A window whose end is before its start spans midnight; its
 * weekday is the day it started.
 */
export function ruleActiveAt(rule: Pick<PriceRuleLike, 'active' | 'daysOfWeek' | 'startTime' | 'endTime'>, dow: number, hhmm: string): boolean {
  if (!rule.active) return false;
  const now = minutes(hhmm);
  const start = minutes(rule.startTime);
  const end = minutes(rule.endTime);
  const days = rule.daysOfWeek;
  const dayOk = (d: number) => !days.length || days.includes(d);
  if (start === end) return false;
  if (start < end) return dayOk(dow) && now >= start && now < end;
  // Spans midnight: the evening part belongs to today, the early part to yesterday.
  if (now >= start) return dayOk(dow);
  if (now < end) return dayOk((dow + 6) % 7);
  return false;
}

/** Price of an item under a rule (never below zero). */
export function adjustedPrice(priceKobo: number, rule: Pick<PriceRuleLike, 'adjustmentType' | 'value'>): number {
  switch (rule.adjustmentType) {
    case 'PERCENT':
      return Math.max(0, Math.round((priceKobo * (10_000 - rule.value)) / 10_000));
    case 'AMOUNT':
      return Math.max(0, priceKobo - rule.value);
    case 'FIXED':
      return Math.max(0, rule.value);
  }
}

/**
 * The item price now: the lowest price among the rules that apply to this
 * outlet / category / item and are on at this moment (null = base price).
 */
export function happyHourPrice(
  basePriceKobo: number,
  rules: PriceRuleLike[],
  at: { outletId: string; categoryId: string; itemId: string; dow: number; hhmm: string },
): { priceKobo: number; rule: PriceRuleLike | null } {
  let best: { priceKobo: number; rule: PriceRuleLike | null } = { priceKobo: basePriceKobo, rule: null };
  for (const r of rules) {
    if (r.outletIds.length && !r.outletIds.includes(at.outletId)) continue;
    if (r.categoryIds.length && !r.categoryIds.includes(at.categoryId)) continue;
    if (r.itemIds.length && !r.itemIds.includes(at.itemId)) continue;
    if (!ruleActiveAt(r, at.dow, at.hhmm)) continue;
    const p = adjustedPrice(basePriceKobo, r);
    if (p < best.priceKobo) best = { priceKobo: p, rule: r };
  }
  return best;
}

/** Tax components of a POS line (property settings + item flags + outlet service charge). */
export function lineComponents(all: TaxComponent[], flags: LineTaxFlags, serviceChargeApplies: boolean): TaxComponent[] {
  return all.filter((c) => (c.code === 'VAT' ? flags.vat : c.code === 'CONSUMPTION' ? flags.consumption : serviceChargeApplies));
}

export interface TotalsLine extends LineTaxFlags {
  id?: string;
  name: string;
  quantity: number;
  lineTotalKobo: number;
}

export interface PostingGroup {
  key: string;
  comps: TaxComponent[];
  lines: TotalsLine[];
  enteredKobo: number;
  netKobo: number;
  taxLines: TaxLine[];
  discountKobo: number;
  discountTaxLines: TaxLine[];
}

export interface PosTotals {
  itemsKobo: number;
  discountKobo: number;
  netKobo: number;
  taxes: TaxLine[];
  taxTotalKobo: number;
  totalKobo: number;
}

/**
 * Totals of an order exactly as the ledger will post them: one EXTRA per
 * group of lines sharing tax components (computeCharge on the entered sum),
 * the order discount (on the net) spread over the groups pro rata with
 * mirrored, exclusive tax lines, like any folio discount.
 */
export function orderTotals(
  lines: TotalsLine[],
  all: TaxComponent[],
  serviceChargeApplies: boolean,
  discount: { mode: 'AMOUNT' | 'PERCENT'; value: number } | null,
): { totals: PosTotals; groups: PostingGroup[] } {
  const groups = new Map<string, PostingGroup>();
  for (const l of lines) {
    if (l.lineTotalKobo <= 0) continue;
    const comps = lineComponents(all, l, serviceChargeApplies);
    const key = comps.map((c) => c.code).join('+') || 'NONE';
    const g = groups.get(key) ?? { key, comps, lines: [], enteredKobo: 0, netKobo: 0, taxLines: [], discountKobo: 0, discountTaxLines: [] };
    g.lines.push(l);
    g.enteredKobo += l.lineTotalKobo;
    groups.set(key, g);
  }
  const list = [...groups.values()];
  for (const g of list) {
    const b = computeCharge(g.enteredKobo, g.comps);
    g.netKobo = b.netKobo;
    g.taxLines = b.lines;
  }
  const netBase = list.reduce((a, g) => a + g.netKobo, 0);
  let discountKobo = 0;
  if (discount && netBase > 0) {
    discountKobo = discount.mode === 'PERCENT' ? Math.round((netBase * discount.value) / 10_000) : discount.value;
    discountKobo = Math.min(discountKobo, netBase);
    let left = discountKobo;
    list.forEach((g, i) => {
      const share = i === list.length - 1 ? left : Math.round((discountKobo * g.netKobo) / netBase);
      g.discountKobo = Math.min(share, left);
      left -= g.discountKobo;
      g.discountTaxLines = g.discountKobo > 0 ? computeCharge(-g.discountKobo, g.comps.map((c) => ({ ...c, inclusive: false }))).lines : [];
    });
  }
  const taxes = new Map<string, TaxLine>();
  for (const g of list) {
    for (const t of [...g.taxLines, ...g.discountTaxLines]) {
      const cur = taxes.get(t.code);
      taxes.set(t.code, cur ? { ...cur, amountKobo: cur.amountKobo + t.amountKobo } : { ...t });
    }
  }
  const taxList = [...taxes.values()].filter((t) => t.amountKobo !== 0);
  const itemsKobo = lines.reduce((a, l) => a + Math.max(0, l.lineTotalKobo), 0);
  const netKobo = netBase - discountKobo;
  const taxTotalKobo = taxList.reduce((a, t) => a + t.amountKobo, 0);
  return {
    totals: { itemsKobo, discountKobo, netKobo, taxes: taxList, taxTotalKobo, totalKobo: netKobo + taxTotalKobo },
    groups: list,
  };
}

/**
 * Room-charge name check: the surname (last word) the waiter typed must
 * appear in the guest's name, ignoring case and punctuation. Without a
 * typed name there is nothing to check.
 */
export function guestNameMatches(typed: string | undefined | null, fullName: string): boolean {
  if (!typed || !typed.trim()) return true;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
  const guest = new Set(norm(fullName));
  const words = norm(typed);
  if (!words.length) return true;
  return guest.has(words[words.length - 1]);
}

/** "A. Okafor" for error details: never the full name. */
export function initialAndSurname(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

/** Severity of a void after send. */
export function voidSeverity(valueKobo: number, approvalMissing: boolean): 'MEDIUM' | 'HIGH' {
  return valueKobo >= 2_000_000 || approvalMissing ? 'HIGH' : 'MEDIUM';
}

/** Stock count check: shortage value >= ₦10,000, or a line short by >= 10% of an expected 5+ units. */
export function stockVariance(lines: { expected: number; counted: number; unitCostKobo: number }[]): {
  shortageKobo: number;
  flagged: boolean;
  severity: 'MEDIUM' | 'HIGH';
} {
  let shortage = 0;
  let pct = false;
  for (const l of lines) {
    const diff = l.counted - l.expected;
    if (diff < 0) {
      shortage += Math.round(-diff * l.unitCostKobo);
      if (l.expected >= 5 && -diff >= l.expected * 0.1) pct = true;
    }
  }
  return { shortageKobo: shortage, flagged: shortage >= 1_000_000 || pct, severity: shortage >= 5_000_000 ? 'HIGH' : 'MEDIUM' };
}

/** KDS transitions (plus bump). */
export const KDS_TRANSITIONS: Record<string, string[]> = {
  NEW: ['PREPARING'],
  PREPARING: ['READY', 'NEW'],
  READY: ['SERVED', 'PREPARING'],
  SERVED: [],
  CANCELLED: [],
};

export function nextBump(status: string): string | null {
  if (status === 'NEW' || status === 'PREPARING') return 'READY';
  if (status === 'READY') return 'SERVED';
  return null;
}
