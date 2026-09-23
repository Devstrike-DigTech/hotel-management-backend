/**
 * Rate resolution, restrictions and promo discounts: pure functions shared by
 * admin reservations, public availability / quotes / price calendar / search
 * and the night audit (through RatesService.resolveNightlyRates).
 */
import { addDays, dateRange, diffDays } from '../../common/time/lagos.js';
import { computeCharge, type TaxComponent } from '../folios/tax.logic.js';

export type AdjustmentKind = 'PERCENT' | 'AMOUNT' | 'FIXED';
export type RateChannel = 'FRONT_DESK' | 'BOOKING_SITE' | 'MARKETPLACE';
export const RATE_CHANNELS: RateChannel[] = ['FRONT_DESK', 'BOOKING_SITE', 'MARKETPLACE'];
export type RateSource = 'BASE' | 'RULE' | 'OVERRIDE' | 'FIXED' | 'MANUAL';

export interface PlanLike {
  id: string | null;
  code: string;
  name: string;
  kind: 'BAR' | 'NON_REFUNDABLE' | 'CORPORATE' | 'LONG_STAY' | 'PACKAGE';
  isBar: boolean;
  pricing: 'DERIVED' | 'FIXED';
  adjustmentType: AdjustmentKind | null;
  adjustmentValue: number | null;
  fixedPrices: { roomTypeId: string; rateKobo: number }[];
  minNights: number | null;
  maxNights: number | null;
  channels: string[];
  roomTypeIds: string[];
  active: boolean;
  includesBreakfast: boolean;
  cancelPolicy: CancelPolicyOverride | null;
  description?: string;
}

export interface CancelPolicyOverride {
  nonRefundable: boolean;
  freeCancellationHours: number;
  lateCancellationFeePct: number;
}

export interface RuleLike {
  id: string;
  name: string;
  roomTypeIds: string[];
  dateFrom: string;
  dateTo: string;
  daysOfWeek: number[];
  adjustmentType: AdjustmentKind;
  adjustmentValue: number;
  priority: number;
  active: boolean;
  updatedAt: Date;
}

export interface NightlyRate {
  date: string;
  /** Entered nightly price for this night (after the rate plan). */
  rateKobo: number;
  /** BAR for this night before the plan's adjustment. */
  baseRateKobo: number;
  source: RateSource;
  ruleId: string | null;
  ruleName: string | null;
  /** Promo discount for this night, net of tax, >= 0. */
  discountKobo: number;
}

export interface RestrictionLike {
  roomTypeId: string | null;
  date: string;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  stopSell: boolean;
  minNights: number | null;
}

/** The virtual BAR plan used when a hotel has no plan rows (or no `promotions`). */
export const VIRTUAL_BAR: PlanLike = {
  id: null,
  code: 'BAR',
  name: 'Best Available Rate',
  kind: 'BAR',
  isBar: true,
  pricing: 'DERIVED',
  adjustmentType: null,
  adjustmentValue: null,
  fixedPrices: [],
  minNights: null,
  maxNights: null,
  channels: RATE_CHANNELS,
  roomTypeIds: [],
  active: true,
  includesBreakfast: false,
  cancelPolicy: null,
};

/** 0 = Sunday .. 6 = Saturday for a YYYY-MM-DD date. */
export function dayOfWeek(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** Prices are kept in whole naira and never go below zero. */
export function roundNaira(kobo: number): number {
  return Math.max(0, Math.round(kobo / 100) * 100);
}

/** PERCENT value in bps (signed), AMOUNT in kobo (signed), FIXED = the price. */
export function applyAdjustment(base: number, type: AdjustmentKind | null, value: number | null): number {
  if (!type || value === null) return base;
  if (type === 'FIXED') return roundNaira(value);
  if (type === 'AMOUNT') return roundNaira(base + value);
  return roundNaira(base + (base * value) / 10_000);
}

function ruleMatches(r: RuleLike, roomTypeId: string, date: string): boolean {
  if (!r.active) return false;
  if (date < r.dateFrom || date > r.dateTo) return false;
  if (r.roomTypeIds.length && !r.roomTypeIds.includes(roomTypeId)) return false;
  if (r.daysOfWeek.length && !r.daysOfWeek.includes(dayOfWeek(date))) return false;
  return true;
}

/** Highest priority wins; ties go to the most recently updated rule. */
export function winningRule(rules: RuleLike[], roomTypeId: string, date: string): RuleLike | null {
  let best: RuleLike | null = null;
  for (const r of rules) {
    if (!ruleMatches(r, roomTypeId, date)) continue;
    if (!best || r.priority > best.priority || (r.priority === best.priority && r.updatedAt.getTime() > best.updatedAt.getTime())) best = r;
  }
  return best;
}

/** BAR for one night: override, else the winning season rule, else the base price. */
export function barForNight(
  roomType: { id: string; basePriceKobo: number },
  date: string,
  rules: RuleLike[],
  overrides: ReadonlyMap<string, number>,
): Pick<NightlyRate, 'baseRateKobo' | 'source' | 'ruleId' | 'ruleName'> {
  const o = overrides.get(`${roomType.id}|${date}`);
  if (o !== undefined) return { baseRateKobo: o, source: 'OVERRIDE', ruleId: null, ruleName: null };
  const rule = winningRule(rules, roomType.id, date);
  if (rule) {
    return { baseRateKobo: applyAdjustment(roomType.basePriceKobo, rule.adjustmentType, rule.adjustmentValue), source: 'RULE', ruleId: rule.id, ruleName: rule.name };
  }
  return { baseRateKobo: roomType.basePriceKobo, source: 'BASE', ruleId: null, ruleName: null };
}

/** The plan's nightly price from BAR, or null when the plan does not sell this room type. */
export function planPrice(plan: PlanLike, roomTypeId: string, bar: number): number | null {
  if (plan.roomTypeIds.length && !plan.roomTypeIds.includes(roomTypeId)) return null;
  if (plan.pricing === 'FIXED') {
    const f = plan.fixedPrices.find((x) => x.roomTypeId === roomTypeId);
    return f ? f.rateKobo : null;
  }
  if (plan.isBar) return bar;
  return applyAdjustment(bar, plan.adjustmentType, plan.adjustmentValue);
}

/**
 * The one pricing function: per-night prices for a room type and plan over
 * the given nights. Returns null when the plan does not sell this type.
 */
export function resolveNights(input: {
  roomType: { id: string; basePriceKobo: number };
  plan: PlanLike;
  dates: string[];
  rules: RuleLike[];
  overrides: ReadonlyMap<string, number>;
}): NightlyRate[] | null {
  const out: NightlyRate[] = [];
  for (const date of input.dates) {
    const bar = barForNight(input.roomType, date, input.rules, input.overrides);
    const price = planPrice(input.plan, input.roomType.id, bar.baseRateKobo);
    if (price === null) return null;
    const fixed = input.plan.pricing === 'FIXED';
    out.push({
      date,
      rateKobo: price,
      baseRateKobo: bar.baseRateKobo,
      source: fixed ? 'FIXED' : bar.source,
      ruleId: fixed ? null : bar.ruleId,
      ruleName: fixed ? null : bar.ruleName,
      discountKobo: 0,
    });
  }
  return out;
}

/** Nights of a stay: arrival date .. departure date - 1. */
export function stayDates(arrivalDate: string, departureDate: string): string[] {
  if (departureDate <= arrivalDate) return [];
  return dateRange(arrivalDate, addDays(departureDate, -1));
}

// -----------------------------------------------------------------------------
// Plan eligibility and restrictions
// -----------------------------------------------------------------------------

export type PlanUnavailableReason = 'INACTIVE' | 'CHANNEL' | 'MIN_NIGHTS' | 'MAX_NIGHTS' | 'ROOM_TYPE';

export function planUnavailable(plan: PlanLike, roomTypeId: string, nights: number, channel: RateChannel): PlanUnavailableReason | null {
  if (!plan.active) return 'INACTIVE';
  if (!plan.channels.includes(channel)) return 'CHANNEL';
  if (plan.roomTypeIds.length && !plan.roomTypeIds.includes(roomTypeId)) return 'ROOM_TYPE';
  if (plan.pricing === 'FIXED' && !plan.fixedPrices.some((f) => f.roomTypeId === roomTypeId)) return 'ROOM_TYPE';
  if (plan.minNights && nights < plan.minNights) return 'MIN_NIGHTS';
  if (plan.maxNights && nights > plan.maxNights) return 'MAX_NIGHTS';
  return null;
}

/** Restriction for a room type on a date: type-specific and all-types rows combined. */
export function restrictionOn(list: RestrictionLike[], roomTypeId: string, date: string): Omit<RestrictionLike, 'roomTypeId' | 'date'> | null {
  const rows = list.filter((r) => r.date === date && (r.roomTypeId === null || r.roomTypeId === roomTypeId));
  if (!rows.length) return null;
  const mins = rows.map((r) => r.minNights).filter((x): x is number => x !== null);
  return {
    closedToArrival: rows.some((r) => r.closedToArrival),
    closedToDeparture: rows.some((r) => r.closedToDeparture),
    stopSell: rows.some((r) => r.stopSell),
    minNights: mins.length ? Math.max(...mins) : null,
  };
}

export type RestrictionReason = 'CLOSED_TO_ARRIVAL' | 'CLOSED_TO_DEPARTURE' | 'STOP_SELL' | 'MIN_NIGHTS';
export interface RestrictionHit {
  reason: RestrictionReason;
  date: string;
  minNights?: number;
  message: string;
}

/** Every restriction the stay breaks (arrival closed, departure closed, stop-sell nights, minimum stay). */
export function restrictionHits(list: RestrictionLike[], roomTypeId: string, arrivalDate: string, departureDate: string): RestrictionHit[] {
  const hits: RestrictionHit[] = [];
  const nights = diffDays(arrivalDate, departureDate);
  const onArrival = restrictionOn(list, roomTypeId, arrivalDate);
  if (onArrival?.closedToArrival) hits.push({ reason: 'CLOSED_TO_ARRIVAL', date: arrivalDate, message: 'Arrivals are closed on this date' });
  if (onArrival?.minNights && nights < onArrival.minNights) {
    hits.push({ reason: 'MIN_NIGHTS', date: arrivalDate, minNights: onArrival.minNights, message: `Stays arriving on this date need at least ${onArrival.minNights} nights` });
  }
  const onDeparture = restrictionOn(list, roomTypeId, departureDate);
  if (onDeparture?.closedToDeparture) hits.push({ reason: 'CLOSED_TO_DEPARTURE', date: departureDate, message: 'Departures are closed on this date' });
  for (const d of stayDates(arrivalDate, departureDate)) {
    if (restrictionOn(list, roomTypeId, d)?.stopSell) {
      hits.push({ reason: 'STOP_SELL', date: d, message: 'This room type is not on sale for one of the nights' });
      break;
    }
  }
  return hits;
}

// -----------------------------------------------------------------------------
// Promo codes
// -----------------------------------------------------------------------------

export type PromoInvalidReason =
  | 'NOT_FOUND'
  | 'INACTIVE'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'STAY_DATES'
  | 'MIN_NIGHTS'
  | 'CHANNEL'
  | 'ROOM_TYPE'
  | 'USED_UP'
  | 'PER_GUEST_LIMIT'
  | 'FIRST_BOOKING_ONLY'
  | 'NO_DISCOUNT';

export interface PromoLike {
  code: string;
  description: string;
  type: 'PERCENT' | 'AMOUNT' | 'FREE_NIGHT';
  value: number;
  validFrom: string | null;
  validTo: string | null;
  stayFrom: string | null;
  stayTo: string | null;
  minNights: number | null;
  maxUses: number | null;
  perGuestLimit: number | null;
  channels: string[];
  roomTypeIds: string[];
  firstBookingOnly: boolean;
  active: boolean;
}

/**
 * Checks that do not need the guest: active, booking window, stay dates,
 * nights, channel, room type and remaining uses (held + confirmed).
 */
export function promoStaticProblem(
  p: PromoLike,
  s: { today: string; arrivalDate: string; departureDate: string; channel: RateChannel; roomTypeId: string; taken: number },
): PromoInvalidReason | null {
  if (!p.active) return 'INACTIVE';
  if (p.validFrom && s.today < p.validFrom) return 'NOT_STARTED';
  if (p.validTo && s.today > p.validTo) return 'EXPIRED';
  const lastNight = addDays(s.departureDate, -1);
  if ((p.stayFrom && s.arrivalDate < p.stayFrom) || (p.stayTo && lastNight > p.stayTo)) return 'STAY_DATES';
  const nights = diffDays(s.arrivalDate, s.departureDate);
  if (p.minNights && nights < p.minNights) return 'MIN_NIGHTS';
  if (p.type === 'FREE_NIGHT' && nights < p.value) return 'MIN_NIGHTS';
  if (!p.channels.includes(s.channel)) return 'CHANNEL';
  if (p.roomTypeIds.length && !p.roomTypeIds.includes(s.roomTypeId)) return 'ROOM_TYPE';
  if (p.maxUses !== null && s.taken >= p.maxUses) return 'USED_UP';
  return null;
}

/** Guest-readable reason. */
export function promoMessage(p: Pick<PromoLike, 'code' | 'validFrom' | 'validTo' | 'stayFrom' | 'stayTo' | 'minNights' | 'type' | 'value'> | null, code: string, reason: PromoInvalidReason, human: (d: string) => string): string {
  const c = code.toUpperCase();
  switch (reason) {
    case 'NOT_FOUND':
      return `${c} is not a valid promo code`;
    case 'INACTIVE':
      return `${c} is no longer available`;
    case 'NOT_STARTED':
      return p?.validFrom ? `${c} can be used from ${human(p.validFrom)}` : `${c} cannot be used yet`;
    case 'EXPIRED':
      return `${c} has expired`;
    case 'STAY_DATES':
      if (p?.stayFrom && p.stayTo) return `${c} is valid for stays from ${human(p.stayFrom)} to ${human(p.stayTo)}`;
      if (p?.stayFrom) return `${c} is valid for stays from ${human(p.stayFrom)}`;
      return p?.stayTo ? `${c} is valid for stays until ${human(p.stayTo)}` : `${c} is not valid for these dates`;
    case 'MIN_NIGHTS': {
      const n = p?.type === 'FREE_NIGHT' ? Math.max(p.value, p.minNights ?? 0) : (p?.minNights ?? 0);
      return `${c} needs at least ${n} nights`;
    }
    case 'CHANNEL':
      return `${c} cannot be used for this kind of booking`;
    case 'ROOM_TYPE':
      return `${c} is not valid for this room type`;
    case 'USED_UP':
      return `${c} has been fully used`;
    case 'PER_GUEST_LIMIT':
      return `You have already used ${c}`;
    case 'FIRST_BOOKING_ONLY':
      return `${c} is for a guest's first stay with us`;
    case 'NO_DISCOUNT':
      return `${c} gives no discount on this stay`;
  }
}

/**
 * Per-night promo discount, net of tax (what the folio posts as the DISCOUNT
 * line of that night):
 * - PERCENT: round(net x bps) each night;
 * - AMOUNT: the amount spread over the nights in proportion to their net
 *   price (the last night takes the rounding), never more than the total;
 * - FREE_NIGHT: the cheapest night (by net) is free when nights >= value.
 */
export function promoDiscounts(p: Pick<PromoLike, 'type' | 'value'>, nights: Pick<NightlyRate, 'rateKobo'>[], components: TaxComponent[]): number[] {
  const nets = nights.map((n) => computeCharge(n.rateKobo, components).netKobo);
  const total = nets.reduce((a, b) => a + b, 0);
  if (!nets.length || total <= 0) return nets.map(() => 0);
  if (p.type === 'PERCENT') {
    const bps = Math.min(10_000, Math.max(0, p.value));
    return nets.map((n) => Math.round((n * bps) / 10_000));
  }
  if (p.type === 'FREE_NIGHT') {
    if (nights.length < p.value) return nets.map(() => 0);
    let idx = 0;
    nets.forEach((n, i) => {
      if (n < nets[idx]) idx = i;
    });
    return nets.map((n, i) => (i === idx ? n : 0));
  }
  const amount = Math.min(p.value, total);
  const out = nets.map((n) => Math.floor((amount * n) / total));
  const rest = amount - out.reduce((a, b) => a + b, 0);
  out[out.length - 1] += rest;
  return out.map((d, i) => Math.min(d, nets[i]));
}
