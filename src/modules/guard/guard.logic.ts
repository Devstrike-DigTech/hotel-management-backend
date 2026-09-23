import type { GuardRule, GuardSeverity } from '../../generated/prisma/enums.js';
import { VARIANCE_HIGH_KOBO, VARIANCE_THRESHOLD_KOBO, type ShiftVariance } from '../shifts/shift.logic.js';

export type GuardTier = 'basic' | 'full' | 'pro';

export interface RuleInfo {
  rule: GuardRule;
  tier: GuardTier;
  title: string;
  description: string;
  defaultSeverity: GuardSeverity;
  /** M5: the feature that enables the rule (revenue guard tier for M2-M4 rules). */
  feature?: string;
}

export const RULES: RuleInfo[] = [
  { rule: 'SHIFT_VARIANCE', tier: 'basic', defaultSeverity: 'MEDIUM', title: 'Shift variance', description: 'A cashier shift closed with cash, POS or transfer more than ₦500 away from what the ledger expects.' },
  { rule: 'VOIDED_PAYMENT', tier: 'basic', defaultSeverity: 'MEDIUM', title: 'Voided payment', description: 'A recorded payment was voided.' },
  { rule: 'CHECKOUT_WITH_BALANCE', tier: 'basic', defaultSeverity: 'HIGH', title: 'Check-out with balance', description: 'A guest was checked out by manager override while still owing money (city ledger).' },
  { rule: 'OCCUPIED_WITHOUT_STAY', tier: 'full', defaultSeverity: 'HIGH', title: 'Room sold off the books', description: 'A room is occupied or was used (dirty) with no checked-in stay behind it.' },
  { rule: 'DISCOUNT_OVER_THRESHOLD', tier: 'full', defaultSeverity: 'MEDIUM', title: 'Discount over threshold', description: 'A discount above the approval threshold was posted without a second key.' },
  { rule: 'DIRTY_OVERRIDE_CHECKIN', tier: 'full', defaultSeverity: 'LOW', title: 'Check-in to a dirty room', description: 'A manager overrode the clean-room rule at check-in.' },
  { rule: 'DAY_USE_OVERSTAY', tier: 'full', defaultSeverity: 'MEDIUM', title: 'Day-use overstay', description: 'A day-use guest is still in the room 30 minutes after the booked end time.' },
  { rule: 'LATE_REGISTRATION', tier: 'full', defaultSeverity: 'LOW', title: 'Late registration', description: 'A guest was checked in without the register completed within one hour.' },
  { rule: 'REPEATED_VOIDS_BY_USER', tier: 'full', defaultSeverity: 'HIGH', title: 'Repeated voids', description: 'One staff member posted three or more voids within 24 hours.' },
  { rule: 'PAYMENT_ORPHANED', tier: 'basic', defaultSeverity: 'HIGH', title: 'Orphaned online payment', description: 'A guest paid online but the payment could not be applied to a booking (late after the hold, amount mismatch or duplicate); it is refunded automatically.' },
  { rule: 'ROOM_STATUS_FLIP', tier: 'full', defaultSeverity: 'HIGH', title: 'Occupied room flipped to dirty', description: 'An occupied room was set to dirty by hand, without a check-out.' },
  // M5 (Pro): each needs its own feature and any Revenue Guard tier.
  { rule: 'POS_VOID_AFTER_SEND', tier: 'pro', feature: 'pos', defaultSeverity: 'MEDIUM', title: 'Item voided after it was sent', description: 'A POS item was voided after the kitchen or bar had the ticket.' },
  { rule: 'ROOM_CHARGE_NO_GUEST', tier: 'pro', feature: 'pos', defaultSeverity: 'HIGH', title: 'Room charge without a matching guest', description: 'A POS bill was charged to a room by manager override although the guest name did not match the stay.' },
  { rule: 'STOCK_VARIANCE', tier: 'pro', feature: 'pos', defaultSeverity: 'MEDIUM', title: 'Stock count shortage', description: 'A stock count found less than the records say (value or share of the expected quantity above the limit).' },
  { rule: 'POS_OPEN_TABS_AT_SHIFT_CLOSE', tier: 'pro', feature: 'pos', defaultSeverity: 'MEDIUM', title: 'Open tabs at shift close', description: 'A cashier closed their shift with POS orders still open.' },
  { rule: 'OVERBOOKED', tier: 'pro', feature: 'channel_manager', defaultSeverity: 'HIGH', title: 'Overbooked by an OTA', description: 'An OTA booking arrived for nights with no free room of its type; a guest needs relocating.' },
  { rule: 'LOYALTY_ADJUSTMENT', tier: 'pro', feature: 'loyalty', defaultSeverity: 'MEDIUM', title: 'Large loyalty adjustment', description: 'Loyalty points were added or removed by hand above the programme limit.' },
];

export const RULE_INFO = new Map(RULES.map((r) => [r.rule, r]));

export const DAY_USE_GRACE_MS = 30 * 60 * 1000;
export const LATE_REGISTRATION_MS = 60 * 60 * 1000;
export const REPEATED_VOIDS_COUNT = 3;
export const REPEATED_VOIDS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const LARGE_VOID_KOBO = 5_000_000; // ₦50,000

/**
 * Whether a rule is active for a tenant. DISCOUNT_OVER_THRESHOLD is live on
 * every plan with Revenue Guard: without revenue_guard_full there is no
 * approval flow, so over-threshold discounts are flagged instead.
 */
export function ruleEnabled(rule: GuardRule, features: readonly string[]): boolean {
  if (!features.includes('revenue_guard_basic') && !features.includes('revenue_guard_full')) return false;
  const info = RULE_INFO.get(rule);
  if (!info) return false;
  if (info.tier === 'pro') return !!info.feature && features.includes(info.feature);
  if (info.tier === 'basic' || rule === 'DISCOUNT_OVER_THRESHOLD') return true;
  return features.includes('revenue_guard_full');
}

/** null when within tolerance. */
export function shiftVarianceSeverity(v: ShiftVariance): GuardSeverity | null {
  const worst = Math.max(Math.abs(v.varianceCashKobo), Math.abs(v.variancePosKobo), Math.abs(v.varianceTransferKobo));
  if (worst <= VARIANCE_THRESHOLD_KOBO) return null;
  return worst > VARIANCE_HIGH_KOBO ? 'HIGH' : 'MEDIUM';
}

export function voidedPaymentSeverity(amountKobo: number): GuardSeverity {
  return Math.abs(amountKobo) >= LARGE_VOID_KOBO ? 'HIGH' : 'MEDIUM';
}

export function isDayUseOverstay(departureAt: Date, now: Date): boolean {
  return now.getTime() > departureAt.getTime() + DAY_USE_GRACE_MS;
}

export function isLateRegistration(checkedInAt: Date, registrationCompletedAt: Date | null, now: Date): boolean {
  const deadline = checkedInAt.getTime() + LATE_REGISTRATION_MS;
  if (registrationCompletedAt) return registrationCompletedAt.getTime() > deadline;
  return now.getTime() > deadline;
}

export function isRepeatedVoids(voidTimes: Date[], now: Date): boolean {
  const since = now.getTime() - REPEATED_VOIDS_WINDOW_MS;
  return voidTimes.filter((t) => t.getTime() >= since).length >= REPEATED_VOIDS_COUNT;
}

/**
 * OCCUPIED_WITHOUT_STAY: a room is OCCUPIED with no CHECKED_IN stay, or
 * VACANT_DIRTY with neither a CHECKED_IN stay nor a check-out / room move out
 * of it in the last 24 hours.
 */
export function isOccupiedWithoutStay(input: {
  status: string;
  hasCheckedInStay: boolean;
  hasRecentCheckout: boolean;
}): boolean {
  if (input.hasCheckedInStay) return false;
  if (input.status === 'OCCUPIED') return true;
  if (input.status === 'VACANT_DIRTY') return !input.hasRecentCheckout;
  return false;
}
