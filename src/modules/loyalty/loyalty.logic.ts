/**
 * Loyalty rules (pure): points earned on eligible spend, tiers by nights in
 * the last 12 months, redemption limits and spreading a redemption over the
 * nights of an online booking.
 */

export interface ProgrammeRules {
  earnPointsPer1000: number;
  pointValueKobo: number;
  minRedeemPoints: number;
  maxRedeemBps: number;
}

export interface TierLike {
  id: string;
  name: string;
  minNights: number;
  bonusBps: number;
  sortOrder?: number;
}

/** Points for eligible spend (kobo, pre-tax, net of discounts) with the tier bonus. */
export function earnPoints(eligibleKobo: number, earnPointsPer1000: number, bonusBps = 0): number {
  if (eligibleKobo <= 0 || earnPointsPer1000 <= 0) return 0;
  const base = Math.floor((eligibleKobo * earnPointsPer1000) / 100_000);
  return Math.floor((base * (10_000 + Math.max(0, bonusBps))) / 10_000);
}

/** The highest tier whose minimum nights are met (null when none is). */
export function tierFor<T extends TierLike>(tiers: T[], nights: number): T | null {
  let best: T | null = null;
  for (const t of tiers) if (nights >= t.minNights && (!best || t.minNights > best.minNights)) best = t;
  return best;
}

/** The next tier up and the nights still needed. */
export function nextTier<T extends TierLike>(tiers: T[], nights: number): { name: string; nightsNeeded: number } | null {
  const up = tiers.filter((t) => t.minNights > nights).sort((a, b) => a.minNights - b.minNights)[0];
  return up ? { name: up.name, nightsNeeded: up.minNights - nights } : null;
}

/**
 * Most points redeemable against `baseKobo` of charges: the balance, capped
 * by `maxRedeemBps` of the charges at `pointValueKobo` per point.
 */
export function maxRedeemable(balance: number, baseKobo: number, rules: Pick<ProgrammeRules, 'pointValueKobo' | 'maxRedeemBps'>): number {
  if (rules.pointValueKobo <= 0 || baseKobo <= 0) return 0;
  const capKobo = Math.floor((baseKobo * rules.maxRedeemBps) / 10_000);
  return Math.max(0, Math.min(balance, Math.floor(capKobo / rules.pointValueKobo)));
}

export type RedeemProblem =
  | { code: 'LOYALTY_INSUFFICIENT_POINTS'; balance: number }
  | { code: 'LOYALTY_REDEMPTION_LIMIT'; minPoints: number; maxPoints: number }
  | null;

export function redeemProblem(points: number, balance: number, baseKobo: number, rules: ProgrammeRules): RedeemProblem {
  if (points > balance) return { code: 'LOYALTY_INSUFFICIENT_POINTS', balance };
  const max = maxRedeemable(balance, baseKobo, rules);
  if (points < rules.minRedeemPoints || points > max) return { code: 'LOYALTY_REDEMPTION_LIMIT', minPoints: rules.minRedeemPoints, maxPoints: max };
  return null;
}

/**
 * Spreads a discount over nights in proportion to what is left of each
 * night after other discounts (largest remainder, never more than a night).
 */
export function spreadDiscount(nights: { rateKobo: number; discountKobo?: number }[], totalKobo: number): number[] {
  const room = nights.map((n) => Math.max(0, n.rateKobo - (n.discountKobo ?? 0)));
  const sum = room.reduce((a, b) => a + b, 0);
  if (sum <= 0 || totalKobo <= 0) return nights.map(() => 0);
  const target = Math.min(totalKobo, sum);
  const raw = room.map((r) => (r * target) / sum);
  const out = raw.map(Math.floor);
  let left = target - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (left <= 0) break;
    if (out[i] < room[i]) {
      out[i]++;
      left--;
    }
  }
  return out;
}

/** "PWC-000123" */
export function memberNumber(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}

/** Initials-based prefix for a programme name, e.g. "Palmwine Circle" -> "PC". */
export function defaultMemberPrefix(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join('')
    .replace(/[^A-Z]/g, '');
  return (letters || 'MBR').slice(0, 4);
}

/** Adds calendar months (expiry of earned points). */
export function addMonths(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

export const TIER_COLORS = ['palm', 'brass', 'laterite', 'adire', 'ochre'] as const;

/** Label of loyalty discount lines: "<programme name> points". */
export async function pointsLabel(tx: { loyaltyProgramme: { findFirst(args: { where: { tenantId: string }; select: { name: true } }): Promise<{ name: string } | null> } }, tenantId: string): Promise<string> {
  const p = await tx.loyaltyProgramme.findFirst({ where: { tenantId }, select: { name: true } });
  return `${p?.name ?? 'Loyalty'} points`;
}
