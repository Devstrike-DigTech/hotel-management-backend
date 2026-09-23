import type { PaymentMode, ReservationStatus } from '../../generated/prisma/enums.js';
import { addDays, dateRange, humanDate, lagosDate } from '../../common/time/lagos.js';
import { computeCharge, type TaxComponent } from '../folios/tax.logic.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const HOLD_MINUTES = 20;
export const QUOTE_TTL_MINUTES = 15;
export const MAX_ONLINE_NIGHTS = 30;
export const MAX_ADVANCE_DAYS = 365;
/** Manage-booking links stay valid this long after departure. */
export const TRIP_TOKEN_DAYS_AFTER_DEPARTURE = 90;
export const REVIEW_WINDOW_DAYS = 30;

export type BookingChannel = 'MARKETPLACE' | 'BOOKING_SITE';

// -----------------------------------------------------------------------------
// Price breakdown (authoritative quote)
// -----------------------------------------------------------------------------

export interface TaxLineView {
  code: 'VAT' | 'CONSUMPTION' | 'SERVICE_CHARGE';
  label: string;
  rateBps: number;
  inclusive: boolean;
  amountKobo: number;
}

export interface PriceBreakdown {
  currency: 'NGN';
  unit: 'NIGHT' | 'HOUR';
  rateKobo: number;
  units: number;
  lines: { date: string; description: string; amountKobo: number }[];
  roomSubtotalKobo: number;
  discountKobo: number;
  taxes: TaxLineView[];
  taxTotalKobo: number;
  totalKobo: number;
  firstNightTotalKobo: number;
}

/**
 * Prices a stay exactly the way the folio will post it: one charge per night
 * (or one day-use block), each run through the M2 tax model, so the quote the
 * guest accepts equals what check-in and the night audit will post.
 */
export function priceStay(input: {
  stayType: 'NIGHTLY' | 'DAY_USE';
  rateKobo: number;
  roomTypeName: string;
  components: TaxComponent[];
  /** NIGHTLY: first night and number of nights. */
  arrivalDate?: string;
  nights?: number;
  /** DAY_USE: date and billable hours. */
  date?: string;
  hours?: number;
}): PriceBreakdown {
  const taxes = new Map<string, TaxLineView>();
  const lines: PriceBreakdown['lines'] = [];
  let net = 0;
  let first = 0;
  const add = (date: string, description: string, entered: number) => {
    const b = computeCharge(entered, input.components);
    lines.push({ date, description, amountKobo: entered });
    net += b.netKobo;
    if (lines.length === 1) first = b.grossKobo;
    for (const l of b.lines) {
      const cur = taxes.get(l.code);
      if (cur) cur.amountKobo += l.amountKobo;
      else taxes.set(l.code, { code: l.code, label: l.label, rateBps: l.rateBps, inclusive: l.inclusive, amountKobo: l.amountKobo });
    }
  };
  if (input.stayType === 'NIGHTLY') {
    const nights = input.nights ?? 1;
    const start = input.arrivalDate!;
    for (const d of dateRange(start, addDays(start, nights - 1))) {
      add(d, `${input.roomTypeName}, night of ${humanDate(d)}`, input.rateKobo);
    }
  } else {
    const hours = input.hours ?? 2;
    add(input.date!, `${input.roomTypeName}, day use ${hours} h`, input.rateKobo * hours);
  }
  const taxList = input.components.map((c) => taxes.get(c.code)).filter((t): t is TaxLineView => !!t && t.amountKobo !== 0);
  const taxTotal = taxList.reduce((a, t) => a + t.amountKobo, 0);
  return {
    currency: 'NGN',
    unit: input.stayType === 'NIGHTLY' ? 'NIGHT' : 'HOUR',
    rateKobo: input.rateKobo,
    units: input.stayType === 'NIGHTLY' ? (input.nights ?? 1) : (input.hours ?? 2),
    lines,
    roomSubtotalKobo: net,
    discountKobo: 0,
    taxes: taxList,
    taxTotalKobo: taxTotal,
    totalKobo: net + taxTotal,
    firstNightTotalKobo: first,
  };
}

// -----------------------------------------------------------------------------
// Commission
// -----------------------------------------------------------------------------

/** Half away from zero, to the kobo. */
function round(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/** Commission rate that applies to a booking: marketplace pays the plan rate, the hotel's own site pays nothing. */
export function effectiveCommissionBps(channel: BookingChannel, planCommissionBps: number | null | undefined): number {
  if (channel === 'BOOKING_SITE') return 0;
  return Math.max(0, planCommissionBps ?? 0);
}

/** Commission on the room + tax total. */
export function commissionFor(baseKobo: number, bps: number): number {
  if (bps <= 0 || baseKobo <= 0) return 0;
  return round((baseKobo * bps) / 10_000);
}

/**
 * Share of a collected commission to reverse when `refundKobo` of `paidKobo`
 * goes back to the guest, never more than what is left un-reversed.
 */
export function commissionReversal(collectedKobo: number, alreadyReversedKobo: number, refundKobo: number, paidKobo: number): number {
  if (collectedKobo <= 0 || refundKobo <= 0 || paidKobo <= 0) return 0;
  const share = refundKobo >= paidKobo ? collectedKobo : round((collectedKobo * refundKobo) / paidKobo);
  return Math.max(0, Math.min(share, collectedKobo - alreadyReversedKobo));
}

// -----------------------------------------------------------------------------
// Cancellation policy
// -----------------------------------------------------------------------------

export interface PolicyInput {
  freeCancellationHours: number;
  lateCancellationFeePct: number;
  noShowFeePct: number;
}

export function policySummary(p: PolicyInput): string {
  const first = p.lateCancellationFeePct >= 100 ? 'the first night is charged' : p.lateCancellationFeePct <= 0 ? 'there is no charge' : `${p.lateCancellationFeePct}% of the first night is charged`;
  const free = p.freeCancellationHours <= 0 ? 'Free cancellation until check-in time.' : `Free cancellation until ${p.freeCancellationHours} hours before check-in.`;
  if (p.lateCancellationFeePct <= 0) return 'Free cancellation until check-in time.';
  return `${free} After that, ${first}.`;
}

export function policyView(p: PolicyInput) {
  return { freeCancellationHours: p.freeCancellationHours, lateCancellationFeePct: p.lateCancellationFeePct, noShowFeePct: p.noShowFeePct, summary: policySummary(p) };
}

export function freeCancellationUntil(arrivalAt: Date, p: PolicyInput, now = new Date()): Date | null {
  const until = new Date(arrivalAt.getTime() - p.freeCancellationHours * 3_600_000);
  return until > now ? until : null;
}

export interface CancellationOutcome {
  free: boolean;
  freeCancellationUntil: string | null;
  paidKobo: number;
  /** Fee kept by the hotel (<= paid). */
  feeKobo: number;
  refundKobo: number;
}

/**
 * Guest cancellation: free before `arrivalAt - freeCancellationHours`, then
 * `lateCancellationFeePct` of the first night (room + its taxes). The fee can
 * only come out of what was paid online; pay-at-hotel bookings (nothing paid)
 * cancel without a fee.
 */
export function cancellationOutcome(input: {
  now: Date;
  arrivalAt: Date;
  policy: PolicyInput;
  paidKobo: number;
  firstNightTotalKobo: number;
  paymentMode: PaymentMode | null;
}): CancellationOutcome {
  const until = freeCancellationUntil(input.arrivalAt, input.policy, input.now);
  const free = until !== null;
  let fee = 0;
  if (!free && input.paymentMode === 'ONLINE' && input.paidKobo > 0) {
    fee = round((input.firstNightTotalKobo * input.policy.lateCancellationFeePct) / 100);
    fee = Math.min(fee, input.paidKobo);
  }
  return {
    free,
    freeCancellationUntil: until?.toISOString() ?? null,
    paidKobo: input.paidKobo,
    feeKobo: fee,
    refundKobo: Math.max(0, input.paidKobo - fee),
  };
}

// -----------------------------------------------------------------------------
// Guest-facing status
// -----------------------------------------------------------------------------

export type BookingDisplayStatus = 'AWAITING_PAYMENT' | 'CONFIRMED' | 'CHECKED_IN' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW' | 'EXPIRED';

export function displayStatus(r: { status: ReservationStatus; cancelReason: string | null; holdExpiresAt: Date | null; paymentMode: PaymentMode | null }, now = new Date()): BookingDisplayStatus {
  switch (r.status) {
    case 'PENDING':
      if (r.paymentMode === 'ONLINE') return r.holdExpiresAt && r.holdExpiresAt <= now ? 'EXPIRED' : 'AWAITING_PAYMENT';
      return 'CONFIRMED';
    case 'CONFIRMED':
      return 'CONFIRMED';
    case 'CHECKED_IN':
      return 'CHECKED_IN';
    case 'CHECKED_OUT':
      return 'COMPLETED';
    case 'NO_SHOW':
      return 'NO_SHOW';
    case 'CANCELLED':
      return r.cancelReason === HOLD_EXPIRED_REASON ? 'EXPIRED' : 'CANCELLED';
  }
}

export const HOLD_EXPIRED_REASON = 'HOLD_EXPIRED';

/** Validates public stay dates; returns an error message or null. */
export function checkStayDates(checkIn: string, checkOut: string, now = new Date()): string | null {
  const today = lagosDate(now);
  if (checkIn < today) return 'Check-in cannot be in the past';
  if (checkOut <= checkIn) return 'Check-out must be after check-in';
  const nights = Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);
  if (nights > MAX_ONLINE_NIGHTS) return `Online bookings are for at most ${MAX_ONLINE_NIGHTS} nights`;
  if (checkIn > addDays(today, MAX_ADVANCE_DAYS)) return `Bookings open ${MAX_ADVANCE_DAYS} days ahead`;
  return null;
}

/** "https://www.google.com/maps/search/?api=1&query=..." from the hotel address. */
export function mapUrl(p: { name: string; address: string; area: string; city: string; state: string }): string {
  const q = [p.name, p.address, p.area, p.city, p.state].filter((x) => x && x.trim()).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

/** Masks all but the last 4 characters of an email local part / phone for logs. */
export function maskRecipient(to: string): string {
  if (to.includes('@')) {
    const [local, domain] = to.split('@');
    return `${local.slice(0, 1)}•••@${domain}`;
  }
  return to.length < 8 ? '•••' : `${to.slice(0, 7)}•••${to.slice(-4)}`;
}
