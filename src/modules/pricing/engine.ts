/**
 * Dynamic pricing engine (pure). For one room type and night it turns
 * occupancy on the books, pace against the last four same-weekday nights,
 * lead time, day of week, events and competitor prices into a price change,
 * then applies the guardrails and explains the result in plain language.
 */

export type FactorCode = 'OCCUPANCY' | 'PACE' | 'LEAD_TIME' | 'DAY_OF_WEEK' | 'EVENT' | 'COMPETITOR' | 'GUARDRAIL';

export interface Factor {
  code: FactorCode;
  label: string;
  effectBps: number;
}

export interface Guardrail {
  enabled: boolean;
  floorKobo: number;
  ceilingKobo: number;
  maxDailyChangeBps: number;
}

export interface EngineInput {
  date: string;
  /** Resolved BAR price for the night now (seasons and overrides included). */
  currentKobo: number;
  /** The room type's standard rate (BAR before seasons): cuts stay above it without strong evidence. */
  baseKobo?: number;
  capacity: number;
  /** Rooms of the type on the books for the night now. */
  sold: number;
  daysOut: number;
  /** Same weekday, last four weeks: rooms on the books at the same lead time, and finally sold. */
  reference: { otbAtLead: number; final: number }[];
  events: { name: string; upliftBps: number }[];
  competitorKobo: number[];
  guardrail: Guardrail;
  minChangeBps: number;
  frozen: boolean;
  manualOverride: boolean;
}

export interface EngineOutput {
  suggestedKobo: number;
  changeBps: number;
  factors: Factor[];
  reason: string;
  occupancy: { onTheBooks: number; forecast: number; paceDeltaPts: number; roomsSold: number; capacity: number; daysOut: number };
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  blockedBy: 'FROZEN' | 'MANUAL_OVERRIDE' | 'BELOW_MIN_CHANGE' | null;
}

export const ROUND_TO_KOBO = 50_000; // N500

const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (bps: number) => `${bps >= 0 ? '+' : '-'}${Math.abs(Math.round(bps / 100))}%`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** Competitor prices worth comparing: specific to the room type, or hotel-wide ones within a similar price band. */
export function relevantCompetitors(currentKobo: number, rows: { rateKobo: number; roomTypeId: string | null }[], roomTypeId: string): number[] {
  return rows
    .filter((r) => r.roomTypeId === roomTypeId || (r.roomTypeId === null && r.rateKobo >= currentKobo * 0.6 && r.rateKobo <= currentKobo * 1.6))
    .map((r) => r.rateKobo);
}

export function roundPrice(kobo: number): number {
  return Math.max(ROUND_TO_KOBO, Math.round(kobo / ROUND_TO_KOBO) * ROUND_TO_KOBO);
}

/**
 * Rules (each one explains itself in the reason):
 * - Increases need evidence ON THE BOOKS: occupancy already at 70/80/90%+,
 *   bookings well ahead of the usual pace (2+ rooms and 10+ points, with at
 *   least 30% booked), a busy weekend, or an event on that night. Higher
 *   competitor prices pull the price up only with 40%+ booked or an event.
 * - Low demand (forecast below 50%, not ahead of pace, no event) never
 *   raises the price; within 21 days it cuts (-5%, or -10% below 30%).
 * - The forecast adds the typical pickup (median of the same weekday in past
 *   weeks) to what is booked; it decides cuts, never increases.
 * - A cut does not go below the standard rate unless demand is clearly weak:
 *   history present, forecast under 30% and the night within 7 days.
 * - Guardrails (floor, ceiling, maximum change per run) apply last, then
 *   rounding to ₦500 and the minimum change.
 */
export function suggest(i: EngineInput): EngineOutput {
  const cap = Math.max(1, i.capacity);
  const onBooks = Math.min(1, i.sold / cap);
  const hasHistory = i.reference.length >= 2;
  const pickups = i.reference.map((r) => Math.max(0, r.final - r.otbAtLead));
  const pickup = hasHistory ? (median(pickups) ?? 0) : 0;
  const forecast = Math.min(1, (i.sold + pickup) / cap);
  const usual = hasHistory ? avg(i.reference.map((r) => r.otbAtLead)) : i.sold;
  const paceRooms = i.sold - usual;
  const paceDeltaPts = Math.max(-100, Math.min(100, Math.round((paceRooms / cap) * 100)));
  const paceMeaningful = hasHistory && i.daysOut <= 45 && Math.abs(paceRooms) >= 2 && Math.abs(paceDeltaPts) >= 10;
  const event = [...i.events].filter((e) => e.upliftBps > 0).sort((a, b) => b.upliftBps - a.upliftBps)[0] ?? null;
  const aheadOfPace = paceMeaningful && paceDeltaPts > 0 && onBooks >= 0.3;
  const lowDemand = forecast < 0.5 && !aheadOfPace && !event;
  const far = i.daysOut > 60;
  const factors: Factor[] = [];
  const phrases: string[] = [`${pct(onBooks)} booked ${i.daysOut} day${i.daysOut === 1 ? '' : 's'} out`];

  const up = onBooks >= 0.9 ? 2000 : onBooks >= 0.8 ? 1200 : onBooks >= 0.7 ? 600 : 0;
  if (up) factors.push({ code: 'OCCUPANCY', label: `${pct(onBooks)} already booked`, effectBps: far ? up / 2 : up });
  if (paceMeaningful) {
    const bps = Math.max(-1000, Math.min(1000, Math.round(paceDeltaPts / 2) * 100));
    const use = bps > 0 ? (aheadOfPace ? bps : 0) : i.daysOut <= 21 ? bps : 0;
    if (use) factors.push({ code: 'PACE', label: `${Math.abs(paceDeltaPts)} points ${paceDeltaPts > 0 ? 'ahead of' : 'behind'} usual pace`, effectBps: far ? Math.round(use / 2) : use });
    phrases[0] += `, ${Math.abs(paceDeltaPts)} points ${paceDeltaPts > 0 ? 'ahead of' : 'behind'} usual pace`;
  }
  if (lowDemand && i.daysOut <= 21) {
    const cut = forecast < 0.3 ? -1000 : -500;
    factors.push({ code: 'OCCUPANCY', label: `Forecast ${pct(forecast)} full`, effectBps: cut });
    phrases.push(`forecast ${pct(forecast)} with the usual late bookings`);
    if (i.daysOut <= 3 && forecast < 0.4) {
      factors.push({ code: 'LEAD_TIME', label: 'Last-minute night with rooms to fill', effectBps: -500 });
      phrases.push('rooms left close to arrival');
    }
  }
  const dow = new Date(`${i.date}T12:00:00Z`).getUTCDay();
  if ((dow === 5 || dow === 6) && onBooks > 0.6) factors.push({ code: 'DAY_OF_WEEK', label: 'Busy weekend night', effectBps: 300 });
  if (event) {
    factors.push({ code: 'EVENT', label: event.name, effectBps: event.upliftBps });
    phrases.push(`${event.name}: ${signed(event.upliftBps)}`);
  }
  const comp = median(i.competitorKobo);
  if (comp && i.currentKobo > 0) {
    const gap = (comp - i.currentKobo) / i.currentKobo;
    const eff = Math.max(-1000, Math.min(1000, Math.round((gap * 10_000) / 2)));
    // Competitors pull the price up only with demand on our own books (40%+ booked, or an event).
    if (Math.abs(gap) > 0.1 && !(eff > 0 && (lowDemand || (onBooks < 0.4 && !event)))) {
      factors.push({ code: 'COMPETITOR', label: `Competitors at ₦${Math.round(comp / 100).toLocaleString('en-NG')}`, effectBps: eff });
      phrases.push(`competitors ${gap > 0 ? 'higher' : 'lower'} at ₦${Math.round(comp / 100).toLocaleString('en-NG')}`);
    }
  }

  const occupancy = { onTheBooks: Math.round(onBooks * 10_000) / 10_000, forecast: Math.round(forecast * 10_000) / 10_000, paceDeltaPts, roomsSold: i.sold, capacity: i.capacity, daysOut: i.daysOut };
  const confidence: EngineOutput['confidence'] = !hasHistory ? 'LOW' : i.reference.length >= 4 && i.daysOut <= 30 ? 'HIGH' : 'MEDIUM';
  const blocked = i.frozen ? 'FROZEN' : i.manualOverride ? 'MANUAL_OVERRIDE' : null;

  let rawBps = factors.reduce((a, f) => a + f.effectBps, 0);
  if (lowDemand && rawBps > 0) rawBps = 0; // low demand holds at most
  let target = i.currentKobo * (1 + rawBps / 10_000);
  let capped: string | null = null;
  const strongLow = hasHistory && forecast < 0.3 && i.daysOut <= 7;
  const base = i.baseKobo ?? i.currentKobo;
  if (target < i.currentKobo && target < base && !strongLow) {
    target = Math.min(i.currentKobo, base);
    capped = target === i.currentKobo ? 'held: not enough evidence to go below the standard rate' : 'kept at the standard rate';
  }
  if (i.guardrail.enabled) {
    const maxUp = i.currentKobo * (1 + i.guardrail.maxDailyChangeBps / 10_000);
    const maxDown = i.currentKobo * (1 - i.guardrail.maxDailyChangeBps / 10_000);
    if (target > maxUp) {
      target = maxUp;
      capped = `capped at ${signed(i.guardrail.maxDailyChangeBps)} per day`;
    } else if (target < maxDown) {
      target = maxDown;
      capped = `capped at ${signed(-i.guardrail.maxDailyChangeBps)} per day`;
    }
    if (target > i.guardrail.ceilingKobo) {
      target = i.guardrail.ceilingKobo;
      capped = `at the ceiling of ₦${Math.round(i.guardrail.ceilingKobo / 100).toLocaleString('en-NG')}`;
    } else if (target < i.guardrail.floorKobo) {
      target = i.guardrail.floorKobo;
      capped = `at the floor of ₦${Math.round(i.guardrail.floorKobo / 100).toLocaleString('en-NG')}`;
    }
  }
  let suggested = roundPrice(target);
  if (i.guardrail.enabled) suggested = Math.min(Math.max(suggested, i.guardrail.floorKobo), i.guardrail.ceilingKobo);
  // Rounding never flips the direction of the change.
  if (rawBps <= 0 && suggested > i.currentKobo) suggested = i.currentKobo;
  if (rawBps >= 0 && suggested < i.currentKobo) suggested = i.currentKobo;
  const changeBps = i.currentKobo ? Math.round(((suggested - i.currentKobo) * 10_000) / i.currentKobo) : 0;
  const factorSum = factors.reduce((a, f) => a + f.effectBps, 0);
  if (capped && changeBps !== factorSum) factors.push({ code: 'GUARDRAIL', label: capped, effectBps: changeBps - factorSum });
  const reason = `${phrases.join('; ')} -> ${changeBps === 0 ? 'hold' : signed(changeBps)}${capped ? ` (${capped})` : ''}`;
  return {
    suggestedKobo: suggested,
    changeBps,
    factors,
    reason,
    occupancy,
    confidence,
    blockedBy: blocked ?? (Math.abs(changeBps) < i.minChangeBps ? 'BELOW_MIN_CHANGE' : null),
  };
}
