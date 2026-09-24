/**
 * Paid extras and transfers (M7): pricing engine, availability rules,
 * pickup lead time / operating hours, PICKUP answer details and the transfer
 * status machine. Pure (no database), unit tested.
 */
import { addDays, dateRange, humanDate, lagosClock, lagosDate } from '../../common/time/lagos.js';
import { computeCharge, type TaxComponent, type TaxLine } from '../folios/tax.logic.js';
import type { ValidationIssue } from '../booking-form/form.logic.js';
import type { PriceBreakdown } from '../booking/booking.logic.js';

export type Pricing = 'PER_STAY' | 'PER_NIGHT' | 'PER_PERSON' | 'PER_PERSON_PER_NIGHT' | 'PER_UNIT';
export type Kind = 'STANDARD' | 'EARLY_CHECK_IN' | 'LATE_CHECK_OUT';
export type PickupKindCode = 'AIRPORT' | 'MOTOR_PARK' | 'TRAIN_STATION' | 'JETTY' | 'OTHER';
export type Direction = 'ARRIVAL' | 'DEPARTURE';
export type ChannelCode = 'MARKETPLACE' | 'BOOKING_SITE' | 'FRONT_DESK';

export interface ExtraAvailability {
  validFrom?: string | null;
  validTo?: string | null;
  daysOfWeek?: number[] | null;
  minNights?: number | null;
  earlyFrom?: string | null;
  lateUntil?: string | null;
}

export interface ExtraLike {
  id: string;
  name: string;
  category: string;
  kind: Kind;
  pricing: Pricing;
  priceKobo: number;
  maxUnits: number | null;
  taxable: boolean;
  channels: string[];
  availability: ExtraAvailability;
  dailyCap: number | null;
  leadTimeHours: number;
  active: boolean;
}

export interface StayInfo {
  arrivalDate: string;
  departureDate: string;
  arrivalAt: Date;
  nights: number;
  adults: number;
  children: number;
  dayUse: boolean;
}

export interface ExtraSelection {
  extraId: string;
  quantity?: number;
}

export interface QuotedTaxLine extends TaxLine {}

export interface QuotedExtra {
  extraId: string;
  name: string;
  category: string;
  pricing: Pricing;
  quantity: number;
  persons: number | null;
  nights: number | null;
  unitPriceKobo: number;
  amountKobo: number;
  netKobo: number;
  taxKobo: number;
  totalKobo: number;
  taxes: QuotedTaxLine[];
  description: string;
  serviceDates: string[];
}

export function isoWeekday(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Tax the entered amount like the folio will post it. */
export function taxed(amountKobo: number, comps: TaxComponent[]): { netKobo: number; taxKobo: number; totalKobo: number; taxes: QuotedTaxLine[] } {
  const b = computeCharge(amountKobo, comps);
  const taxKobo = b.lines.reduce((a, l) => a + l.amountKobo, 0);
  return { netKobo: b.netKobo, taxKobo, totalKobo: b.netKobo + taxKobo, taxes: b.lines.map((l) => ({ ...l })) };
}

/**
 * Prices one extra for a stay. `quantity` is units (PER_UNIT) or persons
 * (PER_PERSON*); ignored otherwise. Returns issues instead of a price when
 * the selection is not possible (the caller adds availability and caps).
 */
export function priceExtra(e: ExtraLike, sel: ExtraSelection, stay: StayInfo, comps: TaxComponent[], path: string): { quoted?: QuotedExtra; issues: ValidationIssue[] } {
  const issue = (code: string, message: string, meta?: Record<string, unknown>) => ({ issues: [{ path, fieldKey: 'extras', code, message, ...(meta && { meta }) }] });
  const guests = stay.adults + stay.children;
  const nights = stay.dayUse ? 1 : Math.max(1, stay.nights);
  let quantity = 1;
  let persons: number | null = null;
  let multiplier = 1;
  switch (e.pricing) {
    case 'PER_STAY':
      break;
    case 'PER_NIGHT':
      multiplier = nights;
      break;
    case 'PER_PERSON':
    case 'PER_PERSON_PER_NIGHT': {
      const p = sel.quantity ?? guests;
      if (!Number.isInteger(p) || p < 1) return issue('MIN', `${e.name}: choose at least one person`, { min: 1 });
      if (p > guests) return issue('MAX', `${e.name}: at most ${plural(guests, 'guest')} on this booking`, { max: guests });
      persons = p;
      quantity = p;
      multiplier = e.pricing === 'PER_PERSON' ? p : p * nights;
      break;
    }
    case 'PER_UNIT': {
      const u = sel.quantity ?? 1;
      const max = e.maxUnits ?? 1;
      if (!Number.isInteger(u) || u < 1) return issue('MIN', `${e.name}: choose at least one`, { min: 1 });
      if (u > max) return issue('MAX', `${e.name}: at most ${max} per booking`, { max });
      quantity = u;
      multiplier = u;
      break;
    }
  }
  const amountKobo = e.priceKobo * multiplier;
  const t = taxed(amountKobo, e.taxable ? comps : []);
  const perNight = e.pricing === 'PER_NIGHT' || e.pricing === 'PER_PERSON_PER_NIGHT';
  const description = [
    e.name,
    e.pricing === 'PER_UNIT' && quantity > 1 ? `x${quantity}` : null,
    persons !== null ? plural(persons, 'person', 'people') : null,
    perNight && !stay.dayUse ? `x ${plural(nights, 'night')}` : null,
  ].filter(Boolean).join(', ').replace(', x ', ' x ');
  const serviceDates = perNight && !stay.dayUse ? dateRange(stay.arrivalDate, addDays(stay.departureDate, -1)) : [stay.arrivalDate];
  return {
    quoted: {
      extraId: e.id,
      name: e.name,
      category: e.category,
      pricing: e.pricing,
      quantity,
      persons,
      nights: perNight ? nights : null,
      unitPriceKobo: e.priceKobo,
      amountKobo,
      ...t,
      description,
      serviceDates,
    },
    issues: [],
  };
}

/** Rules that need no database: active, channel, window, weekday, minimum nights, lead time. */
export function extraRuleIssue(e: ExtraLike, channel: ChannelCode, stay: StayInfo, now: Date, opts: { enforceLeadTime: boolean }): { code: string; message: string } | null {
  if (!e.active) return { code: 'INACTIVE', message: `${e.name} is no longer offered` };
  if (!e.channels.includes(channel)) return { code: 'NOT_AVAILABLE', message: `${e.name} cannot be booked here` };
  const a = e.availability ?? {};
  if (a.validFrom && stay.arrivalDate < a.validFrom) return { code: 'OUT_OF_WINDOW', message: `${e.name} is available for stays from ${humanDate(a.validFrom)}` };
  if (a.validTo && stay.arrivalDate > a.validTo) return { code: 'OUT_OF_WINDOW', message: `${e.name} is available for stays until ${humanDate(a.validTo)}` };
  if (a.daysOfWeek && a.daysOfWeek.length && !a.daysOfWeek.includes(isoWeekday(stay.arrivalDate))) return { code: 'OUT_OF_WINDOW', message: `${e.name} is not available for arrivals on this day of the week` };
  if (a.minNights && !stay.dayUse && stay.nights < a.minNights) return { code: 'OUT_OF_WINDOW', message: `${e.name} needs a stay of at least ${plural(a.minNights, 'night')}` };
  if (stay.dayUse && (e.kind === 'EARLY_CHECK_IN' || e.kind === 'LATE_CHECK_OUT')) return { code: 'NOT_AVAILABLE', message: `${e.name} is for overnight stays` };
  if (opts.enforceLeadTime && e.leadTimeHours > 0 && stay.arrivalAt.getTime() - now.getTime() < e.leadTimeHours * 3_600_000) {
    return { code: 'LEAD_TIME', message: `${e.name} must be booked at least ${plural(e.leadTimeHours, 'hour')} before arrival` };
  }
  return null;
}

/** Sold units per service date of the selection would exceed the daily cap? */
export function capIssue(e: ExtraLike, q: QuotedExtra, soldByDate: Map<string, number>): { code: string; message: string; meta: Record<string, unknown> } | null {
  if (e.dailyCap === null || e.dailyCap === undefined) return null;
  const units = e.pricing === 'PER_UNIT' ? q.quantity : 1;
  for (const d of q.serviceDates) {
    const sold = soldByDate.get(d) ?? 0;
    if (sold + units > e.dailyCap) {
      return { code: 'SOLD_OUT', message: `${e.name} is sold out for ${humanDate(d)}`, meta: { date: d, remaining: Math.max(0, e.dailyCap - sold) } };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pickup points and transfers
// ---------------------------------------------------------------------------

export interface VehicleOption {
  id: string;
  name: string;
  maxPassengers: number;
  priceKobo: number | null;
}

export interface PickupPointLike {
  id: string;
  name: string;
  shortName: string | null;
  kind: PickupKindCode;
  city: string;
  priceKobo: number;
  dropOffPriceKobo: number | null;
  vehicleOptions: VehicleOption[];
  leadTimeHours: number;
  operatingHours: { open: string; close: string } | null;
  taxable: boolean;
  active: boolean;
}

export interface TransferSelection {
  direction: Direction;
  pickupPointId: string;
  vehicleOptionId?: string | null;
  passengers: number;
  scheduledAt: string;
}

export interface QuotedTransfer {
  direction: Direction;
  pickupPointId: string;
  pickupPointName: string;
  kind: PickupKindCode;
  vehicleOptionId: string | null;
  vehicleName: string;
  vehicleMaxPassengers: number;
  passengers: number;
  scheduledAt: string;
  amountKobo: number;
  netKobo: number;
  taxKobo: number;
  totalKobo: number;
  taxes: QuotedTaxLine[];
  description: string;
}

export const STANDARD_VEHICLE: VehicleOption = { id: 'standard', name: 'Standard car', maxPassengers: 4, priceKobo: null };

export function vehiclesOf(p: Pick<PickupPointLike, 'vehicleOptions'>): VehicleOption[] {
  return p.vehicleOptions.length ? p.vehicleOptions : [STANDARD_VEHICLE];
}

/** One-way price for a vehicle of a pickup point. */
export function transferPrice(p: PickupPointLike, v: VehicleOption, direction: Direction): number {
  if (v.priceKobo !== null && v.priceKobo !== undefined) return v.priceKobo;
  return direction === 'DEPARTURE' ? (p.dropOffPriceKobo ?? p.priceKobo) : p.priceKobo;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

/** Inside operating hours ("close" before "open" = overnight). */
export function withinHours(hours: { open: string; close: string } | null, at: Date): boolean {
  if (!hours) return true;
  const t = minutes(lagosClock(at).hhmm);
  const o = minutes(hours.open);
  const c = minutes(hours.close);
  return o <= c ? t >= o && t <= c : t >= o || t <= c;
}

const DIRECTION_TEXT: Record<Direction, string> = { ARRIVAL: 'pickup', DEPARTURE: 'drop-off' };

export function transferDescription(p: Pick<PickupPointLike, 'name' | 'shortName' | 'kind'>, vehicle: string, direction: Direction): string {
  const where = p.shortName || p.name;
  const what = direction === 'ARRIVAL' ? (p.kind === 'AIRPORT' ? 'Airport pickup' : 'Arrival pickup') : p.kind === 'AIRPORT' ? 'Airport drop-off' : 'Departure drop-off';
  return `${what}: ${where}, ${vehicle}`;
}

/**
 * Validates and prices a transfer selection. `now` for the lead time (the
 * desk passes enforceLeadTime false). Windows: an arrival pickup from the
 * day before check-in to the end of check-in day; a drop-off on check-out day.
 */
export function quoteTransfer(
  p: PickupPointLike | null,
  sel: TransferSelection,
  stay: StayInfo,
  comps: TaxComponent[],
  path: string,
  now: Date,
  opts: { enforceLeadTime: boolean; hotelPhone?: string | null },
): { quoted?: QuotedTransfer; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const add = (sub: string, code: string, message: string, meta?: Record<string, unknown>) => issues.push({ path: sub ? `${path}.${sub}` : path, fieldKey: 'arrivalPickup', code, message, ...(meta && { meta }) });
  if (!p || !p.active) {
    add('pickupPointId', 'INACTIVE', 'This pickup point is not available');
    return { issues };
  }
  if (sel.direction !== 'ARRIVAL' && sel.direction !== 'DEPARTURE') {
    add('direction', 'INVALID_OPTION', 'Choose an arrival pickup or a departure drop-off');
    return { issues };
  }
  const vehicles = vehiclesOf(p);
  const v = sel.vehicleOptionId ? vehicles.find((x) => x.id === sel.vehicleOptionId) : vehicles[0];
  if (!v) {
    add('vehicleOptionId', 'INACTIVE', 'Choose one of the vehicles offered');
    return { issues };
  }
  if (!Number.isInteger(sel.passengers) || sel.passengers < 1) add('passengers', 'MIN', 'At least one passenger', { min: 1 });
  else if (sel.passengers > v.maxPassengers) {
    const bigger = vehicles.filter((x) => x.maxPassengers >= sel.passengers).map((x) => x.name);
    add('passengers', 'TOO_MANY_PASSENGERS', `A ${v.name} takes up to ${plural(v.maxPassengers, 'passenger')}.${bigger.length ? ` Choose the ${bigger.join(' or the ')}.` : ' Call the hotel to arrange a bigger vehicle.'}`, { max: v.maxPassengers });
  }
  const at = new Date(sel.scheduledAt);
  if (!sel.scheduledAt || Number.isNaN(at.getTime())) {
    add('scheduledAt', 'INVALID_TIME', sel.direction === 'ARRIVAL' ? 'Tell us when you expect to arrive' : 'Tell us when to pick you up at the hotel');
  } else {
    const day = lagosDate(at);
    const where = p.shortName || p.name;
    if (sel.direction === 'ARRIVAL') {
      const from = stay.dayUse ? stay.arrivalDate : addDays(stay.arrivalDate, -1);
      if (day < from || day > stay.arrivalDate) add('scheduledAt', 'OUT_OF_WINDOW', stay.dayUse ? 'The pickup must be on the day of your stay' : 'The pickup must be on your arrival day (or the evening before)', { from, to: stay.arrivalDate });
    } else {
      const d = stay.dayUse ? stay.arrivalDate : stay.departureDate;
      if (day !== d) add('scheduledAt', 'OUT_OF_WINDOW', 'The drop-off must be on your check-out day', { date: d });
    }
    if (opts.enforceLeadTime && at.getTime() - now.getTime() < p.leadTimeHours * 3_600_000) {
      const earliest = new Date(now.getTime() + p.leadTimeHours * 3_600_000);
      add(
        'scheduledAt',
        'LEAD_TIME',
        `${DIRECTION_TEXT[sel.direction] === 'pickup' ? 'Pickups' : 'Drop-offs'} ${sel.direction === 'ARRIVAL' ? 'from' : 'to'} ${where} need ${plural(p.leadTimeHours, 'hour')}' notice.${opts.hotelPhone ? ` For anything sooner, please call the hotel on ${opts.hotelPhone}.` : ''}`.replace("hours' notice", "hours' notice").replace("1 hour' notice", "1 hour's notice"),
        { earliestAt: earliest.toISOString(), leadTimeHours: p.leadTimeHours },
      );
    }
    if (!withinHours(p.operatingHours, at)) {
      add('scheduledAt', 'OUTSIDE_HOURS', `Our drivers work at ${where} between ${p.operatingHours!.open} and ${p.operatingHours!.close}. Choose a time in that window or call the hotel.`, { open: p.operatingHours!.open, close: p.operatingHours!.close });
    }
  }
  if (issues.length) return { issues };
  const amountKobo = transferPrice(p, v, sel.direction);
  const t = taxed(amountKobo, p.taxable ? comps : []);
  return {
    quoted: {
      direction: sel.direction,
      pickupPointId: p.id,
      pickupPointName: p.name,
      kind: p.kind,
      vehicleOptionId: v.id === STANDARD_VEHICLE.id && !p.vehicleOptions.length ? null : v.id,
      vehicleName: v.name,
      vehicleMaxPassengers: v.maxPassengers,
      passengers: sel.passengers,
      scheduledAt: at.toISOString(),
      amountKobo,
      ...t,
      description: transferDescription(p, v.name, sel.direction),
    },
    issues,
  };
}

// ---------------------------------------------------------------------------
// PICKUP answer details (by kind)
// ---------------------------------------------------------------------------

export const FLIGHT_RE = /^[A-Z0-9]{2}\s?\d{1,4}[A-Z]?$/i;

export interface PickupDetailsContext {
  transportCompanyIds: Set<string>;
  trainRouteIds: Set<string>;
}

/** Validates and cleans the kind-specific details of a PICKUP answer. */
export function checkPickupDetails(kind: PickupKindCode, raw: unknown, path: string, ctx: PickupDetailsContext): { value: Record<string, unknown>; issues: ValidationIssue[] } {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  const add = (k: string, code: string, message: string) => issues.push({ path: `${path}.${k}`, fieldKey: 'arrivalPickup', code, message });
  const text = (k: string, min: number, max: number, required: boolean, label: string): string | null => {
    const v = d[k];
    if (v === undefined || v === null || v === '') {
      if (required) add(k, 'REQUIRED', `${label} is required`);
      return null;
    }
    if (typeof v !== 'string') {
      add(k, 'TYPE', `${label}: enter text`);
      return null;
    }
    const s = v.trim();
    if (s.length < min || s.length > max) {
      add(k, 'TOO_LONG', `${label} is ${min} to ${max} characters`);
      return null;
    }
    return s;
  };
  const out: Record<string, unknown> = {};
  switch (kind) {
    case 'AIRPORT': {
      out.airline = text('airline', 2, 60, true, 'Airline');
      const fn = text('flightNumber', 3, 8, true, 'Flight number');
      if (fn && !FLIGHT_RE.test(fn)) add('flightNumber', 'PATTERN', 'Enter the flight number, e.g. P4 7121');
      out.flightNumber = fn ? fn.toUpperCase() : null;
      out.terminal = text('terminal', 1, 30, false, 'Terminal');
      break;
    }
    case 'MOTOR_PARK': {
      const id = d.transportCompanyId;
      if (id !== undefined && id !== null && id !== '') {
        if (typeof id !== 'string' || !ctx.transportCompanyIds.has(id)) add('transportCompanyId', 'INVALID_OPTION', 'Choose a transport company from the list, or Other');
        out.transportCompanyId = id;
        out.transportCompanyOther = null;
      } else {
        out.transportCompanyId = null;
        out.transportCompanyOther = text('transportCompanyOther', 2, 60, true, 'Transport company');
      }
      out.departureCity = text('departureCity', 2, 60, true, 'Departure city');
      out.ticketReference = text('ticketReference', 2, 40, false, 'Ticket reference');
      out.vehicleDescription = text('vehicleDescription', 2, 120, false, 'Bus or vehicle description');
      break;
    }
    case 'TRAIN_STATION': {
      const id = d.trainRouteId;
      if (id !== undefined && id !== null && id !== '') {
        if (typeof id !== 'string' || !ctx.trainRouteIds.has(id)) add('trainRouteId', 'INVALID_OPTION', 'Choose a route from the list, or Other');
        out.trainRouteId = id;
        out.routeOther = null;
      } else {
        out.trainRouteId = null;
        out.routeOther = text('routeOther', 2, 80, true, 'Train route');
      }
      out.trainService = text('trainService', 1, 40, false, 'Train or service');
      break;
    }
    default:
      out.details = text('details', 3, 500, true, 'Details');
  }
  return { value: out, issues };
}

/** One line for boards and messages. */
export function detailsSummary(kind: PickupKindCode, d: Record<string, unknown>, names: { company?: string | null; route?: string | null } = {}): string {
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  switch (kind) {
    case 'AIRPORT':
      return [[s(d.airline), s(d.flightNumber)].filter(Boolean).join(' '), s(d.terminal) ? `Terminal ${s(d.terminal)!.replace(/^terminal\s*/i, '')}` : null].filter(Boolean).join(', ');
    case 'MOTOR_PARK':
      return [
        [names.company ?? s(d.transportCompanyOther), s(d.departureCity) ? `from ${s(d.departureCity)}` : null].filter(Boolean).join(' '),
        s(d.ticketReference) ? `ticket ${s(d.ticketReference)}` : null,
        s(d.vehicleDescription),
      ].filter(Boolean).join(', ');
    case 'TRAIN_STATION':
      return [names.route ?? s(d.routeOther), s(d.trainService)].filter(Boolean).join(', ');
    default:
      return s(d.details) ?? '';
  }
}

// ---------------------------------------------------------------------------
// Transfer status machine
// ---------------------------------------------------------------------------

export type TransferStatusCode = 'REQUESTED' | 'CONFIRMED' | 'DRIVER_ASSIGNED' | 'EN_ROUTE' | 'PICKED_UP' | 'COMPLETED' | 'NO_SHOW' | 'CANCELLED';

export const TRANSFER_FLOW: Record<TransferStatusCode, TransferStatusCode[]> = {
  REQUESTED: ['CONFIRMED', 'DRIVER_ASSIGNED', 'CANCELLED'],
  CONFIRMED: ['DRIVER_ASSIGNED', 'CANCELLED'],
  DRIVER_ASSIGNED: ['EN_ROUTE', 'PICKED_UP', 'NO_SHOW', 'CANCELLED'],
  EN_ROUTE: ['PICKED_UP', 'NO_SHOW', 'CANCELLED'],
  PICKED_UP: ['COMPLETED'],
  COMPLETED: [],
  NO_SHOW: [],
  CANCELLED: [],
};

export function canMove(from: TransferStatusCode, to: TransferStatusCode): boolean {
  return TRANSFER_FLOW[from].includes(to);
}

export const LIVE_TRANSFER: TransferStatusCode[] = ['REQUESTED', 'CONFIRMED', 'DRIVER_ASSIGNED', 'EN_ROUTE', 'PICKED_UP'];

// ---------------------------------------------------------------------------
// Quote integration
// ---------------------------------------------------------------------------

export interface AddOnLine {
  kind: 'EXTRA' | 'TRANSFER';
  refId: string;
  description: string;
  amountKobo: number;
  netKobo: number;
  taxKobo: number;
  totalKobo: number;
  taxes: QuotedTaxLine[];
}

/**
 * Adds extras and transfers to a room breakdown: the room part keeps its
 * numbers (`roomTotalKobo`), taxes are summed per component, the total grows.
 * Without add-ons the result equals the input plus zeroed add-on fields.
 */
export function withAddOns(b: PriceBreakdown, lines: AddOnLine[]): PriceBreakdown & { roomTotalKobo: number; addOns: Omit<AddOnLine, 'taxes'>[]; addOnsSubtotalKobo: number; addOnsTaxKobo: number } {
  const roomTotal = (b as { roomTotalKobo?: number }).roomTotalKobo ?? b.totalKobo;
  const net = lines.reduce((a, l) => a + l.netKobo, 0);
  const tax = lines.reduce((a, l) => a + l.taxKobo, 0);
  const taxes = b.taxes.map((t) => ({ ...t }));
  for (const l of lines) {
    for (const t of l.taxes) {
      const cur = taxes.find((x) => x.code === t.code && x.rateBps === t.rateBps && x.inclusive === t.inclusive);
      if (cur) cur.amountKobo += t.amountKobo;
      else taxes.push({ code: t.code as 'VAT' | 'CONSUMPTION' | 'SERVICE_CHARGE', label: t.label, rateBps: t.rateBps, inclusive: t.inclusive, amountKobo: t.amountKobo });
    }
  }
  return {
    ...b,
    taxes: taxes.filter((t) => t.amountKobo !== 0),
    taxTotalKobo: b.taxTotalKobo + tax,
    totalKobo: roomTotal + net + tax,
    roomTotalKobo: roomTotal,
    addOns: lines.map(({ taxes: _t, ...rest }) => {
      void _t;
      return rest;
    }),
    addOnsSubtotalKobo: net,
    addOnsTaxKobo: tax,
  };
}
