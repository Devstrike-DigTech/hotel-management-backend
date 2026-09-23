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
  /** Resolved BAR price for the night now. */
  currentKobo: number;
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

function occupancyStep(forecast: number, daysOut: number): number {
  if (forecast >= 0.9) return 2000;
  if (forecast >= 0.8) return 1200;
  if (forecast >= 0.7) return 600;
  if (forecast >= 0.5) return 0;
  if (daysOut > 21) return 0; // no cuts far out
  return forecast >= 0.3 ? -500 : -1000;
}

export function roundPrice(kobo: number): number {
  return Math.max(ROUND_TO_KOBO, Math.round(kobo / ROUND_TO_KOBO) * ROUND_TO_KOBO);
}

export function suggest(i: EngineInput): EngineOutput {
  const cap = Math.max(1, i.capacity);
  const onBooks = Math.min(1, i.sold / cap);
  const hasHistory = i.reference.length > 0;
  const pickup = hasHistory ? Math.max(0, avg(i.reference.map((r) => r.final - r.otbAtLead))) : 0;
  const forecast = Math.min(1, (i.sold + pickup) / cap);
  const usual = hasHistory ? avg(i.reference.map((r) => r.otbAtLead)) : i.sold;
  const paceDeltaPts = Math.round(((i.sold - usual) / cap) * 100);
  const factors: Factor[] = [];
  const phrases: string[] = [`${pct(onBooks)} booked ${i.daysOut} day${i.daysOut === 1 ? '' : 's'} out`];

  let occBps = occupancyStep(forecast, i.daysOut);
  let paceBps = hasHistory ? Math.max(-1000, Math.min(1000, Math.round(paceDeltaPts / 2) * 100)) : 0;
  if (i.daysOut > 60) {
    occBps = Math.round(occBps / 2);
    paceBps = Math.round(paceBps / 2);
  }
  if (occBps) factors.push({ code: 'OCCUPANCY', label: `Forecast ${pct(forecast)} full`, effectBps: occBps });
  if (paceBps) {
    factors.push({ code: 'PACE', label: `${Math.abs(paceDeltaPts)} points ${paceDeltaPts > 0 ? 'ahead of' : 'behind'} usual pace`, effectBps: paceBps });
  }
  if (Math.abs(paceDeltaPts) >= 5 && hasHistory) phrases[0] += `, ${Math.abs(paceDeltaPts)} points ${paceDeltaPts > 0 ? 'ahead of' : 'behind'} usual pace`;
  if (i.daysOut <= 3 && forecast < 0.6) {
    factors.push({ code: 'LEAD_TIME', label: 'Last-minute night with rooms to fill', effectBps: -500 });
    phrases.push('rooms left close to arrival');
  }
  const dow = new Date(`${i.date}T12:00:00Z`).getUTCDay();
  if ((dow === 5 || dow === 6) && forecast > 0.6) {
    factors.push({ code: 'DAY_OF_WEEK', label: 'Weekend night', effectBps: 300 });
  }
  const event = [...i.events].sort((a, b) => b.upliftBps - a.upliftBps)[0];
  if (event && event.upliftBps) {
    factors.push({ code: 'EVENT', label: event.name, effectBps: event.upliftBps });
    phrases.push(`${event.name}: ${signed(event.upliftBps)}`);
  }
  const comp = median(i.competitorKobo);
  if (comp && i.currentKobo > 0) {
    const gap = (comp - i.currentKobo) / i.currentKobo;
    if (Math.abs(gap) > 0.1) {
      const eff = Math.max(-1000, Math.min(1000, Math.round((gap * 10_000) / 2)));
      factors.push({ code: 'COMPETITOR', label: `Competitors at ₦${Math.round(comp / 100).toLocaleString('en-NG')}`, effectBps: eff });
      phrases.push(`competitors ${gap > 0 ? 'higher' : 'lower'} at ₦${Math.round(comp / 100).toLocaleString('en-NG')}`);
    }
  }

  const occupancy = { onTheBooks: Math.round(onBooks * 10_000) / 10_000, forecast: Math.round(forecast * 10_000) / 10_000, paceDeltaPts, roomsSold: i.sold, capacity: i.capacity, daysOut: i.daysOut };
  const confidence: EngineOutput['confidence'] = !hasHistory ? 'LOW' : i.reference.length >= 4 && i.daysOut <= 30 ? 'HIGH' : 'MEDIUM';
  const blocked = i.frozen ? 'FROZEN' : i.manualOverride ? 'MANUAL_OVERRIDE' : null;

  const rawBps = factors.reduce((a, f) => a + f.effectBps, 0);
  let target = i.currentKobo * (1 + rawBps / 10_000);
  let capped: string | null = null;
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
  const changeBps = i.currentKobo ? Math.round(((suggested - i.currentKobo) * 10_000) / i.currentKobo) : 0;
  if (capped) factors.push({ code: 'GUARDRAIL', label: capped, effectBps: changeBps - rawBps });
  const reason = `${phrases.join('; ')} -> ${signed(changeBps)}${capped ? ` (${capped})` : ''}`;
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
