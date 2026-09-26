/**
 * Concierge (M8) pure rules: categories, the request status machine, service
 * questions (M7 form-field engine), pricing, availability and slots, SLA,
 * commission, discretion labels, folio wording and WhatsApp YES / NO parsing.
 * No I/O; unit tested in concierge.logic.spec.ts.
 */
import { addDays, humanDateTime, lagosClock, lagosDate, lagosDateTime } from '../../common/time/lagos.js';
import type { FormField } from '../booking-form/form.catalogue.js';
import { checkValue, validateAnswers, validateBuilder, type ValidationIssue } from '../booking-form/form.logic.js';
import { taxed } from '../extras/extras.logic.js';
import type { TaxComponent } from '../folios/tax.logic.js';

// ---------------------------------------------------------------------------
// Catalogue constants
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  { code: 'WELLNESS', label: 'Wellness and spa', description: 'Massage by licensed therapists, spa treatments, fitness sessions' },
  { code: 'DINING', label: 'Dining', description: 'Private chef, in-room dining set-ups, special menus' },
  { code: 'ROMANCE_AND_CELEBRATION', label: 'Celebrations', description: 'Flowers, candles, cake and room decoration for birthdays, anniversaries and proposals' },
  { code: 'GROOMING', label: 'Grooming and beauty', description: 'Barber, hair and make-up, nails' },
  { code: 'TRANSPORT', label: 'Transport', description: 'Car with driver, airport runs, city errands' },
  { code: 'SECURITY', label: 'Security', description: 'Licensed security escorts and protocol' },
  { code: 'TOURS_AND_EXPERIENCES', label: 'Tours and experiences', description: 'City tours, art galleries, beaches, markets' },
  { code: 'FAMILY', label: 'Family and children', description: 'Vetted babysitters, children\'s activities' },
  { code: 'SHOPPING', label: 'Shopping', description: 'Personal shopping, tailoring, market runs' },
  { code: 'PHOTOGRAPHY', label: 'Photography', description: 'Photo shoots and videography' },
  { code: 'EVENTS', label: 'Events', description: 'Small events, meeting set-ups, decorations' },
  { code: 'NIGHTLIFE_RESERVATIONS', label: 'Table reservations', description: 'Table bookings at restaurants, lounges and clubs' },
  { code: 'BUSINESS', label: 'Business services', description: 'Printing, meeting set-up, interpreters' },
  { code: 'LAUNDRY_EXPRESS', label: 'Express laundry', description: 'Same-day laundry and pressing' },
  { code: 'OTHER', label: 'Something else', description: 'Anything lawful we can arrange' },
] as const;
export type CategoryCode = (typeof CATEGORIES)[number]['code'];
export const CATEGORY_CODES = CATEGORIES.map((c) => c.code) as CategoryCode[];
export const categoryLabel = (c: string) => CATEGORIES.find((x) => x.code === c)?.label ?? 'Something else';

export const PRICINGS = ['FIXED', 'FROM', 'PER_HOUR', 'PER_PERSON', 'FREE'] as const;
export type PricingCode = (typeof PRICINGS)[number];
export const LOCATIONS = ['IN_ROOM', 'ON_PROPERTY', 'OFF_PROPERTY'] as const;
export type LocationCode = (typeof LOCATIONS)[number];
export const SERVICE_CHANNELS = ['BOOKING_FLOW', 'TRIP_PAGE', 'FRONT_DESK'] as const;
export type ServiceChannel = (typeof SERVICE_CHANNELS)[number];
export const CONTACT_PREFERENCES = ['WHATSAPP', 'SMS', 'EMAIL', 'IN_APP'] as const;
export type ContactPreference = (typeof CONTACT_PREFERENCES)[number];
export const SOURCES = ['BOOKING_FLOW', 'TRIP_PAGE', 'WHATSAPP', 'FRONT_DESK'] as const;
export type RequestSource = (typeof SOURCES)[number];

export const STATUSES = ['NEW', 'QUOTED', 'AWAITING_GUEST', 'CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'CANCELLED'] as const;
export type RequestStatus = (typeof STATUSES)[number];
export const FINAL_STATUSES: readonly RequestStatus[] = ['COMPLETED', 'DECLINED', 'CANCELLED'];
export const OPEN_STATUSES: readonly RequestStatus[] = STATUSES.filter((s) => !FINAL_STATUSES.includes(s));

/** Allowed status transitions (409 INVALID_STATE otherwise). QUOTED -> QUOTED is a new quote. */
export const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  NEW: ['QUOTED', 'AWAITING_GUEST', 'CONFIRMED', 'SCHEDULED', 'DECLINED', 'CANCELLED'],
  QUOTED: ['QUOTED', 'AWAITING_GUEST', 'CONFIRMED', 'DECLINED', 'CANCELLED'],
  AWAITING_GUEST: ['CONFIRMED', 'QUOTED', 'DECLINED', 'CANCELLED'],
  CONFIRMED: ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DECLINED'],
  SCHEDULED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  DECLINED: [],
  CANCELLED: [],
};

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Plain, warm labels for guests. */
export const GUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  NEW: "Received - we'll get back to you shortly",
  QUOTED: 'Your price is ready',
  AWAITING_GUEST: 'Waiting for you',
  CONFIRMED: 'Confirmed',
  SCHEDULED: 'Booked in',
  IN_PROGRESS: 'Happening now',
  COMPLETED: 'Done - we hope you enjoyed it',
  DECLINED: "We couldn't arrange this",
  CANCELLED: 'Cancelled',
};

export const PRIVACY_NOTE = 'Only the concierge team sees this. Private requests are never shown on shared screens or named on your bill.';
export const FREE_FORM_TITLE = 'Something else';
export const PRIVATE_TITLE = 'Private request';

// ---------------------------------------------------------------------------
// Service questions (M7 form-field engine)
// ---------------------------------------------------------------------------

export const QUESTION_TYPES = ['SHORT_TEXT', 'LONG_TEXT', 'NUMBER', 'DATE', 'TIME', 'SELECT', 'MULTI_SELECT', 'YES_NO', 'CHECKBOX'] as const;
export const MAX_QUESTIONS = 12;

function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'question';
}

/**
 * The stored question list from an editor submission: CUSTOM fields with
 * `c_*` keys (assigned when missing), every channel, one section, orders
 * renumbered.
 */
export function normaliseQuestions(input: Partial<FormField>[] | null | undefined): FormField[] {
  const used = new Set<string>();
  const out: FormField[] = [];
  for (const [i, raw] of (Array.isArray(input) ? input : []).entries()) {
    if (!raw || typeof raw !== 'object') continue;
    let key = typeof raw.key === 'string' && raw.key.trim() ? raw.key.trim() : '';
    if (!key) {
      const base = `c_${slug(String(raw.label ?? 'question'))}`;
      key = base;
      for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
    }
    used.add(key);
    out.push({
      key,
      source: 'CUSTOM',
      libraryKey: null,
      recommended: false,
      type: raw.type as FormField['type'],
      label: typeof raw.label === 'string' ? raw.label.trim() : '',
      helpText: raw.helpText ?? null,
      placeholder: raw.placeholder ?? null,
      required: raw.required ?? 'OPTIONAL',
      options: Array.isArray(raw.options) ? raw.options.map((o) => ({ value: String(o?.value ?? '').trim(), label: String(o?.label ?? '').trim() })) : [],
      validation: raw.validation && typeof raw.validation === 'object' ? { ...raw.validation } : {},
      section: 'Your request',
      order: typeof raw.order === 'number' ? raw.order : i,
      channels: ['MARKETPLACE', 'BOOKING_SITE', 'FRONT_DESK'],
      condition: raw.condition ?? null,
      purpose: raw.purpose ?? null,
      guestPurpose: raw.guestPurpose ?? null,
      sensitive: !!raw.sensitive,
    });
  }
  return out
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.order - b.f.order || a.i - b.i)
    .map(({ f }, order) => ({ ...f, order }));
}

/**
 * Builder checks of the M7 engine plus the concierge limits. Issues come back
 * at `questions[i].<prop>`; `lockedFeature` is set when conditions are used
 * without `form_conditional_logic`.
 */
export function validateQuestions(fields: FormField[], features: readonly string[]): { issues: ValidationIssue[]; warnings: { questionKey: string; code: 'ID_LIKE'; message: string }[]; lockedFeature: string | null } {
  const res = validateBuilder(fields, features);
  const issues = res.issues.map((x) => ({ ...x, path: x.path.replace(/^fields/, 'questions') }));
  if (fields.length > MAX_QUESTIONS) issues.push({ path: 'questions', fieldKey: null, code: 'MAX', message: `A service can ask at most ${MAX_QUESTIONS} questions`, meta: { max: MAX_QUESTIONS } });
  fields.forEach((f, i) => {
    if (!(QUESTION_TYPES as readonly string[]).includes(f.type)) {
      issues.push({ path: `questions[${i}].type`, fieldKey: f.key, code: 'NOT_ALLOWED', message: 'Service questions can be text, number, date, time, choices, yes / no or a tick box' });
    }
    if (!f.key.startsWith('c_')) issues.push({ path: `questions[${i}].key`, fieldKey: f.key, code: 'PATTERN', message: 'Question keys start with "c_"' });
  });
  return { issues, warnings: res.warnings.map((w) => ({ questionKey: w.fieldKey, code: 'ID_LIKE' as const, message: w.message })), lockedFeature: res.lockedFeature };
}

/** Validates a guest's answers to a service's questions (M7 rules). Issues at `answers.<key>`. */
export function validateServiceAnswers(fields: FormField[], answers: Record<string, unknown> | null | undefined): { issues: ValidationIssue[]; stored: Record<string, unknown> } {
  const r = validateAnswers(fields, answers ?? {}, { channel: 'BOOKING_SITE', checkGuest: false });
  return { issues: r.issues, stored: r.stored };
}

/** Texts of a question list, for the content screen. */
export function questionTexts(fields: FormField[]): string[] {
  return fields.flatMap((f) => [f.label, f.helpText ?? '', f.placeholder ?? '', ...f.options.map((o) => o.label)]);
}

/** Free text inside the answers (for the content screen). */
export function answerTexts(fields: FormField[], stored: Record<string, unknown>): string[] {
  return fields.filter((f) => f.type === 'SHORT_TEXT' || f.type === 'LONG_TEXT').map((f) => stored[f.key]).filter((v): v is string => typeof v === 'string');
}

export { checkValue };

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export interface ServiceVariant {
  id: string;
  name: string;
  priceKobo: number;
  durationMinutes: number | null;
}

export interface ServiceLike {
  id: string;
  name: string;
  pricing: PricingCode;
  priceKobo: number | null;
  variants: ServiceVariant[];
  durationMinutes: number | null;
  leadTimeHours: number;
  availability: Availability;
  requiresSlot: boolean;
  slotCapacity: number | null;
  taxable: boolean;
}

export type Availability = { days: number[]; from: string; to: string } | null;

export interface PriceSelection {
  variantId?: string | null;
  partySize?: number | null;
  hours?: number | null;
}

export interface QuotedPrice {
  amountKobo: number;
  netKobo: number;
  taxKobo: number;
  totalKobo: number;
  taxes: { code: string; label: string; rateBps: number; inclusive: boolean; amountKobo: number }[];
  description: string;
}

const nairaText = (kobo: number) => `₦${(kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

/** "₦25,000", "From ₦40,000", "₦8,000 per hour", "₦15,000 per person", "Free". */
export function priceLabel(s: Pick<ServiceLike, 'pricing' | 'priceKobo' | 'variants'>): string {
  const prices = s.variants.map((v) => v.priceKobo).filter((p) => p > 0);
  const base = prices.length ? Math.min(...prices) : s.priceKobo;
  const from = prices.length > 1 ? 'From ' : '';
  switch (s.pricing) {
    case 'FREE':
      return 'Free';
    case 'FROM':
      return base ? `From ${nairaText(base)}` : 'Price on request';
    case 'PER_HOUR':
      return base ? `${from}${nairaText(base)} per hour` : 'Price on request';
    case 'PER_PERSON':
      return base ? `${from}${nairaText(base)} per person` : 'Price on request';
    default:
      return base ? `${from}${nairaText(base)}` : 'Price on request';
  }
}

/** Service definition checks (VALIDATION issues at the DTO paths). */
export function serviceIssues(s: ServiceLike): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const add = (path: string, code: string, message: string) => out.push({ path, fieldKey: null, code, message });
  const hasVariantPrices = s.variants.length > 0 && s.variants.every((v) => v.priceKobo > 0);
  if ((s.pricing === 'FIXED' || s.pricing === 'PER_HOUR' || s.pricing === 'PER_PERSON') && !(s.priceKobo && s.priceKobo > 0) && !hasVariantPrices) {
    add('priceKobo', 'REQUIRED', 'Give a price (or a price for every option)');
  }
  if (s.pricing === 'FREE' && s.priceKobo) add('priceKobo', 'NOT_ALLOWED', 'A free service has no price');
  if (s.variants.length > 10) add('variants', 'MAX', 'At most 10 options');
  const names = new Set<string>();
  s.variants.forEach((v, i) => {
    if (!v.name || v.name.length > 60) add(`variants[${i}].name`, 'TOO_LONG', 'Option names are 1 to 60 characters');
    if (names.has(v.name.toLowerCase())) add(`variants[${i}].name`, 'DUPLICATE_KEY', `"${v.name}" appears twice`);
    names.add(v.name.toLowerCase());
    if (s.pricing !== 'FREE' && s.pricing !== 'FROM' && !(v.priceKobo > 0)) add(`variants[${i}].priceKobo`, 'REQUIRED', 'Give each option a price');
    if (v.durationMinutes !== null && (v.durationMinutes < 15 || v.durationMinutes > 1440)) add(`variants[${i}].durationMinutes`, 'MAX', 'Durations are 15 minutes to 24 hours');
  });
  if (s.requiresSlot && !s.availability) add('availability', 'REQUIRED', 'Services with time slots need opening hours');
  if (s.availability) {
    const a = s.availability;
    if (!a.days.length || a.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) add('availability.days', 'INVALID_OPTION', 'Choose at least one day');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(a.from) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(a.to) || a.from === a.to) add('availability.from', 'INVALID_TIME', 'Give opening and closing times like 09:00 and 21:00');
  }
  return out;
}

/** Duration of a request: the variant's, else the service's, else 60 minutes. */
export function durationOf(s: ServiceLike, variantId?: string | null): number {
  const v = variantId ? s.variants.find((x) => x.id === variantId) : undefined;
  return v?.durationMinutes ?? s.durationMinutes ?? 60;
}

/**
 * Prices a selection. `requiresQuote` for FROM services; issues (at
 * `variantId`, `partySize`, `hours`) when the selection is incomplete.
 */
export function priceService(s: ServiceLike, sel: PriceSelection, comps: TaxComponent[]): { price: QuotedPrice | null; requiresQuote: boolean; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const issue = (path: string, code: string, message: string, meta?: Record<string, unknown>) => issues.push({ path, fieldKey: null, code, message, ...(meta && { meta }) });
  let variant: ServiceVariant | undefined;
  if (s.variants.length) {
    if (!sel.variantId) issue('variantId', 'REQUIRED', `Choose an option for ${s.name}`);
    else {
      variant = s.variants.find((v) => v.id === sel.variantId);
      if (!variant) issue('variantId', 'INVALID_OPTION', 'This option is not available');
    }
  } else if (sel.variantId) {
    issue('variantId', 'INVALID_OPTION', 'This service has no options');
  }
  if (s.pricing === 'PER_PERSON') {
    if (!sel.partySize) issue('partySize', 'REQUIRED', 'How many people is this for?');
    else if (sel.partySize < 1 || sel.partySize > 50) issue('partySize', sel.partySize < 1 ? 'MIN' : 'MAX', 'Between 1 and 50 people', { min: 1, max: 50 });
  }
  if (sel.hours !== undefined && sel.hours !== null && (sel.hours < 1 || sel.hours > 24 || !Number.isInteger(sel.hours))) issue('hours', 'MAX', 'Between 1 and 24 hours', { min: 1, max: 24 });
  if (issues.length) return { price: null, requiresQuote: s.pricing === 'FROM', issues };
  if (s.pricing === 'FROM') return { price: null, requiresQuote: true, issues };
  const unit = variant?.priceKobo ?? s.priceKobo ?? 0;
  const label = variant ? `${s.name}, ${variant.name}` : s.name;
  let amount = 0;
  let description = label;
  switch (s.pricing) {
    case 'FIXED':
      amount = unit;
      break;
    case 'PER_HOUR': {
      const hours = sel.hours ?? Math.max(1, Math.ceil(durationOf(s, sel.variantId) / 60));
      amount = unit * hours;
      description = `${label} x ${hours} hour${hours === 1 ? '' : 's'}`;
      break;
    }
    case 'PER_PERSON': {
      const n = sel.partySize ?? 1;
      amount = unit * n;
      description = `${label} x ${n} ${n === 1 ? 'person' : 'people'}`;
      break;
    }
    case 'FREE':
      amount = 0;
      break;
  }
  const t = amount > 0 ? taxed(amount, s.taxable ? comps : []) : { netKobo: 0, taxKobo: 0, totalKobo: 0, taxes: [] };
  return { price: { amountKobo: amount, netKobo: t.netKobo, taxKobo: t.taxKobo, totalKobo: t.totalKobo, taxes: t.taxes, description }, requiresQuote: false, issues };
}

/** A staff quote: entered amount through the tax model. */
export function quotePrice(amountKobo: number, taxable: boolean, comps: TaxComponent[], description: string): QuotedPrice {
  const t = taxed(amountKobo, taxable ? comps : []);
  return { amountKobo, netKobo: t.netKobo, taxKobo: t.taxKobo, totalKobo: t.totalKobo, taxes: t.taxes, description };
}

// ---------------------------------------------------------------------------
// Availability, lead time, slots
// ---------------------------------------------------------------------------

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** True when `at` (Lagos wall clock) is inside the opening hours; windows past midnight count for the day they open. */
export function withinHours(a: Availability, at: Date, durationMinutes = 0): boolean {
  if (!a) return true;
  const { dow, hhmm } = lagosClock(at);
  const m = toMin(hhmm);
  const from = toMin(a.from);
  const to = toMin(a.to);
  if (from < to) return a.days.includes(dow) && m >= from && m + durationMinutes <= to;
  // Overnight window (e.g. 18:00 - 02:00): the evening part belongs to today, the early part to yesterday.
  if (m >= from) return a.days.includes(dow) && m + durationMinutes <= 24 * 60 + to;
  const yesterday = (dow + 6) % 7;
  return a.days.includes(yesterday) && m + durationMinutes <= to;
}

export interface TimeIssue {
  code: 'LEAD_TIME' | 'OUTSIDE_HOURS';
  message: string;
  meta: Record<string, unknown>;
}

/** Lead time and opening hours of a requested start (null = fine). */
export function timeIssue(s: ServiceLike, start: Date, now: Date, opts: { enforceLeadTime: boolean; durationMinutes?: number }): TimeIssue | null {
  if (opts.enforceLeadTime && s.leadTimeHours > 0) {
    const earliest = new Date(now.getTime() + s.leadTimeHours * 3_600_000);
    if (start < earliest) {
      return { code: 'LEAD_TIME', message: `Please ask at least ${s.leadTimeHours} hour${s.leadTimeHours === 1 ? '' : 's'} ahead for ${s.name}. The earliest time is ${humanDateTime(earliest)}.`, meta: { earliestAt: earliest.toISOString(), leadTimeHours: s.leadTimeHours } };
    }
  } else if (opts.enforceLeadTime && start.getTime() < now.getTime() - 5 * 60_000) {
    return { code: 'LEAD_TIME', message: 'Choose a time that has not passed yet', meta: { earliestAt: now.toISOString(), leadTimeHours: 0 } };
  }
  if (!withinHours(s.availability, start, opts.durationMinutes ?? 0)) {
    const a = s.availability!;
    return { code: 'OUTSIDE_HOURS', message: `${s.name} is available ${daysText(a.days)} between ${a.from} and ${a.to}. Choose a time in that window.`, meta: { open: a.from, close: a.to, days: a.days } };
  }
  return null;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function daysText(days: number[]): string {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.length === 7) return 'every day';
  if (d.join(',') === '1,2,3,4,5') return 'Monday to Friday';
  if (d.join(',') === '0,6') return 'at weekends';
  return `on ${d.map((x) => DAY_NAMES[x]).join(', ')}`;
}

export interface Slot {
  start: string;
  end: string;
  available: boolean;
  reason: 'LEAD_TIME' | 'FULL' | 'CLOSED' | null;
}

/**
 * The day's slots: 30-minute steps inside the opening hours (or the whole
 * day without hours), each `durationMinutes` long; `busy` are live requests
 * of the service that day.
 */
export function slotsFor(s: ServiceLike, date: string, now: Date, busy: { start: Date; end: Date }[], durationMinutes = durationOf(s)): Slot[] {
  const out: Slot[] = [];
  const dayStart = lagosDateTime(date, '00:00').getTime();
  const earliest = now.getTime() + s.leadTimeHours * 3_600_000;
  const capacity = s.slotCapacity ?? (s.requiresSlot ? 1 : null);
  for (let m = 0; m < 24 * 60; m += 30) {
    const start = new Date(dayStart + m * 60_000);
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    if (!withinHours(s.availability, start, durationMinutes)) continue;
    let reason: Slot['reason'] = null;
    if (start.getTime() < earliest) reason = 'LEAD_TIME';
    else if (capacity !== null && busy.filter((b) => b.start < end && start < b.end).length >= capacity) reason = 'FULL';
    out.push({ start: start.toISOString(), end: end.toISOString(), available: reason === null, reason });
  }
  return out;
}

export { addDays, lagosDate };

// ---------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------

export interface SlaSettings {
  slaInStayMinutes: number;
  slaPreArrivalMinutes: number;
  escalateAfterMinutes: number;
}

export function slaDueAt(createdAt: Date, target: 'IN_STAY' | 'PRE_ARRIVAL', s: SlaSettings): Date {
  return new Date(createdAt.getTime() + (target === 'IN_STAY' ? s.slaInStayMinutes : s.slaPreArrivalMinutes) * 60_000);
}

export function slaView(r: { slaDueAt: Date; firstResponseAt: Date | null; escalatedAt: Date | null; slaTarget: string; status: string }, now = new Date()) {
  const open = !r.firstResponseAt && !(FINAL_STATUSES as readonly string[]).includes(r.status);
  return {
    dueAt: r.slaDueAt.toISOString(),
    firstResponseAt: r.firstResponseAt?.toISOString() ?? null,
    overdue: open && now > r.slaDueAt,
    minutesLeft: open ? Math.round((r.slaDueAt.getTime() - now.getTime()) / 60_000) : null,
    escalatedAt: r.escalatedAt?.toISOString() ?? null,
    target: r.slaTarget as 'IN_STAY' | 'PRE_ARRIVAL',
  };
}

/** Due for escalation: unanswered, past the SLA plus the grace, not escalated yet. */
export function dueForEscalation(r: { slaDueAt: Date; firstResponseAt: Date | null; escalatedAt: Date | null; status: string }, graceMinutes: number, now = new Date()): boolean {
  return !r.firstResponseAt && !r.escalatedAt && !(FINAL_STATUSES as readonly string[]).includes(r.status) && now.getTime() > r.slaDueAt.getTime() + graceMinutes * 60_000;
}

// ---------------------------------------------------------------------------
// Commission, folio wording, discretion
// ---------------------------------------------------------------------------

export function commissionOf(type: string | null | undefined, value: number | null | undefined, netKobo: number): { commissionKobo: number; vendorPayableKobo: number } | null {
  if (!type || type === 'NONE' || !value) return null;
  const c = type === 'PERCENT' ? Math.round((netKobo * value) / 10_000) : Math.min(value, netKobo);
  return { commissionKobo: c, vendorPayableKobo: Math.max(0, netKobo - c) };
}

/** Folio line: the service by name, or the hotel's neutral wording for private requests. */
export function folioDescription(r: { discreet: boolean; serviceName: string; variantName?: string | null; location?: string | null; number: string }, labels: { inRoom: string; other: string }): string {
  if (r.discreet) return `${r.location === 'IN_ROOM' ? labels.inRoom : labels.other} (${r.number})`;
  return `${r.variantName ? `${r.serviceName}, ${r.variantName}` : r.serviceName} (${r.number})`;
}

/** "Private request · Room 204 · assigned to Amaka Nwosu" / "In-room massage · Room 204 · Adaeze O." */
export function requestLabel(p: { masked: boolean; title: string; roomNumber: string | null; assigneeName: string | null; guestName: string | null }): string {
  const parts = [p.masked ? PRIVATE_TITLE : p.title];
  if (p.roomNumber) parts.push(`Room ${p.roomNumber}`);
  if (p.masked) {
    if (p.assigneeName) parts.push(`assigned to ${p.assigneeName}`);
  } else if (p.guestName) parts.push(shortName(p.guestName));
  return parts.join(' · ');
}

/** "Adaeze Okafor" -> "Adaeze O." */
export function shortName(full: string): string {
  const w = full.trim().split(/\s+/);
  return w.length > 1 ? `${w[0]} ${w[w.length - 1]![0]!.toUpperCase()}.` : (w[0] ?? '');
}

export function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] || 'there';
}

// ---------------------------------------------------------------------------
// WhatsApp replies to quotes
// ---------------------------------------------------------------------------

export interface QuoteReply {
  answer: 'YES' | 'NO';
  /** Request number digits when given ("YES CR-000123", "yes 123"). */
  seq: number | null;
}

const YES = /^(yes|y|yeah|yep|ok|okay|accept|accepted|confirm|confirmed)(\s+please)?\b/;
const NO = /^(no|n|nope|decline|declined|cancel)(\s+thanks|\s+thank you)?\b/;

/** Parses a guest's reply to a quote; null when it is not a YES / NO. */
export function parseQuoteReply(text: string): QuoteReply | null {
  const t = text.trim().toLowerCase().replace(/[.!,]+$/g, '').replace(/\s+/g, ' ');
  if (!t || t.length > 60) return null;
  const m = YES.exec(t) ?? NO.exec(t);
  if (!m) return null;
  const answer = YES.test(t) ? 'YES' : 'NO';
  const rest = t.slice(m[0].length).trim();
  if (!rest) return { answer, seq: null };
  const num = /^(?:for\s+)?(?:cr[-\s]?)?#?0*(\d{1,6})$/.exec(rest);
  if (num) return { answer, seq: Number(num[1]) };
  return null;
}

export function formatNumber(seq: number): string {
  return `CR-${String(seq).padStart(6, '0')}`;
}
