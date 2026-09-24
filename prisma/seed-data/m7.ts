/**
 * M7 demo data: booking-site themes, booking forms (with a second version on
 * Lekki), paid extras, pickup points, transport companies and train routes,
 * transfers today in every live state, bookings carrying answers and extras,
 * and the setup wizard (every hotel complete except Wuse Garden Suites, which
 * is part-way through).
 *
 * Idempotent: rows are keyed by natural keys (names, notes, property ids) and
 * a reservation that already has answers or add-ons is left alone. Runs
 * against the shared database, or against Harmattan's dedicated database once
 * it has moved (the caller passes that client). All people, phone numbers and
 * plates are fictional.
 */
import type { Extra, PickupPoint, Prisma, PrismaClient, Reservation } from '../../src/generated/prisma/client.js';
import { addDays, diffDays, lagosDate, lagosDateTime } from '../../src/common/time/lagos.js';
import { normalisePhone } from '../../src/common/utils/phone.js';
import { buildPreset, formDiff, normaliseFields, storable, validateBuilder } from '../../src/modules/booking-form/form.logic.js';
import type { FormField, PresetId } from '../../src/modules/booking-form/form.catalogue.js';
import {
  detailsSummary,
  priceExtra,
  quoteTransfer,
  type ExtraAvailability,
  type ExtraLike,
  type PickupKindCode,
  type PickupPointLike,
  type StayInfo,
  type VehicleOption,
} from '../../src/modules/extras/extras.logic.js';
import type { TaxComponent } from '../../src/modules/folios/tax.logic.js';
import { appliedFor, gateViolation, normaliseDraft, switchTemplate, type ThemeDraft } from '../../src/modules/site/theme.logic.js';
import { templateById, type TemplateId } from '../../src/modules/site/site.registry.js';
import { PLANS } from './catalogue.js';
import { taxComponents } from './pro.js';

const NAIRA = 100;
const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// Platform lists (shared database only)
// ---------------------------------------------------------------------------

export const TRANSPORT_COMPANIES: { id: string; name: string; shortName: string | null }[] = [
  { id: 'gig-mobility', name: 'GIG Mobility (God is Good Motors)', shortName: 'GIGM' },
  { id: 'abc-transport', name: 'ABC Transport', shortName: 'ABC' },
  { id: 'peace-mass-transit', name: 'Peace Mass Transit', shortName: 'PMT' },
  { id: 'chisco', name: 'Chisco Transport', shortName: 'Chisco' },
  { id: 'young-shall-grow', name: 'Young Shall Grow Motors', shortName: 'YSG' },
  { id: 'libra-motors', name: 'Libra Motors', shortName: 'Libra' },
  { id: 'guo-transport', name: 'GUO Transport', shortName: 'GUO' },
  { id: 'efex-executive', name: 'Efex Executive', shortName: 'Efex' },
  { id: 'area-motors', name: 'Area Motors', shortName: null },
  { id: 'ifesinachi', name: 'Ifesinachi Transport', shortName: null },
  { id: 'cross-country', name: 'Cross Country Limited', shortName: 'CCL' },
  { id: 'agofure', name: 'Agofure Motors', shortName: null },
];

export const TRAIN_ROUTES: { id: string; name: string; operator: string; stations: string[]; services: string[] }[] = [
  {
    id: 'lagos-ibadan', name: 'Lagos - Ibadan (Obafemi Awolowo line)', operator: 'Nigerian Railway Corporation',
    stations: ['Mobolaji Johnson Station, Ebute Metta', 'Babatunde Raji Fashola Station, Agege', 'Lateef Jakande Station, Agbado', 'Professor Wole Soyinka Station, Abeokuta', 'Obafemi Awolowo Station, Moniya'],
    services: ['Express', 'Regular'],
  },
  {
    id: 'abuja-kaduna', name: 'Abuja - Kaduna', operator: 'Nigerian Railway Corporation',
    stations: ['Idu', 'Kubwa', 'Jere', 'Katari', 'Rijana', 'Rigasa (Kaduna)'],
    services: ['AK1 Morning', 'AK3 Afternoon', 'Standard class', 'First class'],
  },
  {
    id: 'warri-itakpe', name: 'Warri - Itakpe', operator: 'Nigerian Railway Corporation',
    stations: ['Ujevwu (Warri)', 'Agbor', 'Uromi', 'Ajaokuta', 'Itakpe'],
    services: ['Standard class', 'First class'],
  },
  {
    id: 'lagos-red-line', name: 'Lagos Red Line (Agbado - Oyingbo)', operator: 'Lagos Metropolitan Area Transport Authority',
    stations: ['Agbado', 'Iju', 'Agege', 'Ikeja', 'Oshodi', 'Mushin', 'Yaba', 'Ebute Metta', 'Oyingbo'],
    services: ['Peak', 'Off-peak'],
  },
  {
    id: 'lagos-blue-line', name: 'Lagos Blue Line (Marina - Mile 2)', operator: 'Lagos Metropolitan Area Transport Authority',
    stations: ['Marina', 'National Theatre', 'Iganmu', 'Alaba', 'Mile 2'],
    services: ['Peak', 'Off-peak'],
  },
  {
    id: 'abuja-light-rail', name: 'Abuja Light Rail (Metro - Airport)', operator: 'Abuja Metropolitan Management Council',
    stations: ['Abuja Metro', 'Stadium', 'Kukwaba', 'Wupa', 'Idu', 'Nnamdi Azikiwe International Airport'],
    services: ['Standard'],
  },
];

export async function seedTransportLists(prisma: PrismaClient): Promise<number> {
  for (const [i, c] of TRANSPORT_COMPANIES.entries()) {
    await prisma.transportCompany.upsert({ where: { id: c.id }, create: { ...c, sortOrder: i }, update: { name: c.name, shortName: c.shortName, sortOrder: i, active: true } });
  }
  for (const [i, r] of TRAIN_ROUTES.entries()) {
    await prisma.trainRoute.upsert({ where: { id: r.id }, create: { ...r, sortOrder: i }, update: { name: r.name, operator: r.operator, stations: r.stations, services: r.services, sortOrder: i, active: true } });
  }
  return TRANSPORT_COMPANIES.length + TRAIN_ROUTES.length;
}

// ---------------------------------------------------------------------------
// Catalogues per hotel
// ---------------------------------------------------------------------------

interface ExtraSeed {
  name: string;
  description: string;
  category: Extra['category'];
  kind?: Extra['kind'];
  pricing: Extra['pricing'];
  priceKobo: number;
  maxUnits?: number | null;
  taxable?: boolean;
  channels?: string[];
  availability?: ExtraAvailability;
  dailyCap?: number | null;
  leadTimeHours?: number;
}

const EXTRAS: Record<string, ExtraSeed> = {
  breakfast: { name: 'Breakfast for two', description: 'Continental or Nigerian breakfast (akara, yam and egg sauce, fresh fruit) for two, every morning of your stay.', category: 'FOOD', pricing: 'PER_NIGHT', priceKobo: 15_000 * NAIRA },
  early: { name: 'Early check-in from 10:00', description: 'Your room ready from 10:00 on the day you arrive.', category: 'EARLY_LATE', kind: 'EARLY_CHECK_IN', pricing: 'PER_STAY', priceKobo: 20_000 * NAIRA, availability: { earlyFrom: '10:00' }, dailyCap: 3 },
  late: { name: 'Late check-out until 16:00', description: 'Keep your room until 16:00 on the day you leave.', category: 'EARLY_LATE', kind: 'LATE_CHECK_OUT', pricing: 'PER_STAY', priceKobo: 20_000 * NAIRA, availability: { lateUntil: '16:00' }, dailyCap: 3 },
  cake: { name: 'Birthday cake & decoration', description: 'A one-kilo cake from our pastry kitchen, balloons and a decorated room. Tell us the name for the cake in special requests.', category: 'CELEBRATION', pricing: 'PER_STAY', priceKobo: 45_000 * NAIRA, leadTimeHours: 48, dailyCap: 2, channels: ['MARKETPLACE', 'BOOKING_SITE', 'FRONT_DESK'] },
  wine: { name: 'Bottle of wine on arrival', description: 'A chilled bottle of South African red or white waiting in your room.', category: 'FOOD', pricing: 'PER_UNIT', priceKobo: 25_000 * NAIRA, maxUnits: 3, leadTimeHours: 4 },
  laundry: { name: 'Laundry bundle', description: 'Up to eight pieces washed, ironed and returned the same day (in by 10:00).', category: 'OTHER', pricing: 'PER_UNIT', priceKobo: 8_000 * NAIRA, maxUnits: 4, channels: ['BOOKING_SITE', 'FRONT_DESK'] },
  breakfastPerPerson: { name: 'Breakfast buffet', description: 'Our full buffet, per guest, every morning of your stay.', category: 'FOOD', pricing: 'PER_PERSON_PER_NIGHT', priceKobo: 9_500 * NAIRA },
  spa: { name: 'Couples massage (60 minutes)', description: 'Sixty minutes in the spa for two, any afternoon of your stay.', category: 'WELLNESS', pricing: 'PER_STAY', priceKobo: 60_000 * NAIRA, leadTimeHours: 24 },
};

interface PointSeed {
  name: string;
  shortName: string;
  kind: PickupKindCode;
  city: string;
  address: string;
  priceKobo: number;
  dropOffPriceKobo?: number | null;
  vehicles?: VehicleOption[];
  leadTimeHours?: number;
  operatingHours?: { open: string; close: string } | null;
  notesForGuest?: string;
}

const LAGOS_VEHICLES: VehicleOption[] = [
  { id: 'saloon', name: 'Saloon car', maxPassengers: 3, priceKobo: null },
  { id: 'suv', name: 'SUV', maxPassengers: 4, priceKobo: 35_000 * NAIRA },
  { id: 'bus', name: 'Toyota Hiace bus', maxPassengers: 10, priceKobo: 50_000 * NAIRA },
];

const POINTS_LAGOS: PointSeed[] = [
  { name: 'Murtala Muhammed International Airport', shortName: 'MMIA', kind: 'AIRPORT', city: 'Lagos', address: 'Ikeja, Lagos', priceKobo: 25_000 * NAIRA, dropOffPriceKobo: 22_000 * NAIRA, vehicles: LAGOS_VEHICLES, leadTimeHours: 6, notesForGuest: 'Your driver waits at the arrivals exit holding a board with your name. Allow 60 to 90 minutes to Lekki.' },
  { name: 'Murtala Muhammed Airport Terminal 2 (domestic)', shortName: 'MMA2', kind: 'AIRPORT', city: 'Lagos', address: 'Ikeja, Lagos', priceKobo: 22_000 * NAIRA, dropOffPriceKobo: 20_000 * NAIRA, vehicles: LAGOS_VEHICLES, leadTimeHours: 6, notesForGuest: 'Meet your driver by the MMA2 car park exit.' },
  { name: 'Jibowu Motor Park', shortName: 'Jibowu', kind: 'MOTOR_PARK', city: 'Lagos', address: 'Ikorodu Road, Jibowu, Yaba', priceKobo: 15_000 * NAIRA, vehicles: LAGOS_VEHICLES.slice(0, 2), leadTimeHours: 4, operatingHours: { open: '06:00', close: '21:00' }, notesForGuest: 'Call the driver when your bus passes Ojota, about 20 minutes out, so he is at the Jibowu gate when you get in.' },
  { name: 'Ojota New Garage', shortName: 'Ojota', kind: 'MOTOR_PARK', city: 'Lagos', address: 'Ojota Interchange, Lagos', priceKobo: 18_000 * NAIRA, vehicles: LAGOS_VEHICLES.slice(0, 2), leadTimeHours: 4, operatingHours: { open: '06:00', close: '20:00' } },
  { name: 'Mobolaji Johnson Station, Ebute Metta', shortName: 'Ebute Metta station', kind: 'TRAIN_STATION', city: 'Lagos', address: 'Ebute Metta, Lagos', priceKobo: 15_000 * NAIRA, vehicles: LAGOS_VEHICLES.slice(0, 2), leadTimeHours: 6, operatingHours: { open: '07:00', close: '20:00' } },
  { name: 'Maza-Maza Park', shortName: 'Maza-Maza', kind: 'MOTOR_PARK', city: 'Lagos', address: 'Old Ojo Road, Maza-Maza', priceKobo: 20_000 * NAIRA, vehicles: LAGOS_VEHICLES.slice(0, 2), leadTimeHours: 6, operatingHours: { open: '06:00', close: '19:00' } },
  { name: 'Marina jetty (CMS)', shortName: 'Marina jetty', kind: 'JETTY', city: 'Lagos', address: 'Marina, Lagos Island', priceKobo: 12_000 * NAIRA, vehicles: LAGOS_VEHICLES.slice(0, 1), leadTimeHours: 3, operatingHours: { open: '07:00', close: '18:30' }, notesForGuest: 'Boats run in daylight only. Tell us which ferry you are on.' },
];

const ABUJA_VEHICLES: VehicleOption[] = [
  { id: 'saloon', name: 'Saloon car', maxPassengers: 3, priceKobo: null },
  { id: 'suv', name: 'SUV', maxPassengers: 4, priceKobo: 45_000 * NAIRA },
];

const POINTS_ABUJA: PointSeed[] = [
  { name: 'Nnamdi Azikiwe International Airport', shortName: 'Abuja airport', kind: 'AIRPORT', city: 'Abuja', address: 'Airport Road, Abuja', priceKobo: 35_000 * NAIRA, dropOffPriceKobo: 30_000 * NAIRA, vehicles: ABUJA_VEHICLES, leadTimeHours: 6, notesForGuest: 'Your driver waits at the arrivals hall exit. About 40 minutes to Maitama.' },
  { name: 'Utako Motor Park', shortName: 'Utako', kind: 'MOTOR_PARK', city: 'Abuja', address: 'Utako District, Abuja', priceKobo: 10_000 * NAIRA, vehicles: ABUJA_VEHICLES, leadTimeHours: 3, operatingHours: { open: '06:00', close: '21:00' } },
  { name: 'Jabi Park', shortName: 'Jabi', kind: 'MOTOR_PARK', city: 'Abuja', address: 'Jabi, Abuja', priceKobo: 10_000 * NAIRA, vehicles: ABUJA_VEHICLES, leadTimeHours: 3, operatingHours: { open: '06:00', close: '20:00' } },
  { name: 'Idu station (Abuja - Kaduna)', shortName: 'Idu station', kind: 'TRAIN_STATION', city: 'Abuja', address: 'Idu Industrial Area, Abuja', priceKobo: 15_000 * NAIRA, vehicles: ABUJA_VEHICLES, leadTimeHours: 4, operatingHours: { open: '06:00', close: '21:00' } },
  { name: 'Kubwa station', shortName: 'Kubwa', kind: 'TRAIN_STATION', city: 'Abuja', address: 'Kubwa, Abuja', priceKobo: 18_000 * NAIRA, vehicles: ABUJA_VEHICLES, leadTimeHours: 4, operatingHours: { open: '06:00', close: '20:00' } },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function featuresOf(prisma: PrismaClient, tenantId: string): Promise<{ features: string[]; formLimit: number }> {
  const sub = await prisma.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
  const plan = PLANS.find((p) => p.code === sub?.plan.code) ?? PLANS[0];
  return { features: plan.features, formLimit: plan.limits.max_custom_form_fields };
}

async function upsertExtras(prisma: PrismaClient, tenantId: string, propertyId: string, keys: (keyof typeof EXTRAS)[]): Promise<Extra[]> {
  const out: Extra[] = [];
  for (const [i, k] of keys.entries()) {
    const e = EXTRAS[k];
    const data = {
      description: e.description,
      category: e.category,
      kind: e.kind ?? 'STANDARD',
      pricing: e.pricing,
      priceKobo: e.priceKobo,
      maxUnits: e.maxUnits ?? null,
      taxable: e.taxable ?? true,
      channels: e.channels ?? ['MARKETPLACE', 'BOOKING_SITE', 'FRONT_DESK'],
      availability: (e.availability ?? {}) as Prisma.InputJsonValue,
      dailyCap: e.dailyCap ?? null,
      leadTimeHours: e.leadTimeHours ?? 0,
      sortOrder: i,
      active: true,
    };
    out.push(await prisma.extra.upsert({ where: { propertyId_name: { propertyId, name: e.name } }, create: { tenantId, propertyId, name: e.name, ...data }, update: data }));
  }
  return out;
}

async function upsertPoints(prisma: PrismaClient, tenantId: string, propertyId: string, points: PointSeed[]): Promise<PickupPoint[]> {
  const out: PickupPoint[] = [];
  for (const [i, p] of points.entries()) {
    const data = {
      shortName: p.shortName,
      kind: p.kind,
      city: p.city,
      address: p.address,
      priceKobo: p.priceKobo,
      dropOffPriceKobo: p.dropOffPriceKobo ?? null,
      vehicleOptions: (p.vehicles ?? []) as unknown as Prisma.InputJsonValue,
      leadTimeHours: p.leadTimeHours ?? 6,
      operatingHours: (p.operatingHours ?? undefined) as Prisma.InputJsonValue | undefined,
      notesForGuest: p.notesForGuest ?? null,
      taxable: true,
      active: true,
      sortOrder: i,
    };
    out.push(await prisma.pickupPoint.upsert({ where: { propertyId_name: { propertyId, name: p.name } }, create: { tenantId, propertyId, name: p.name, ...data }, update: data }));
  }
  return out;
}

function extraLike(e: Extra): ExtraLike {
  return {
    id: e.id, name: e.name, category: e.category, kind: e.kind, pricing: e.pricing, priceKobo: e.priceKobo, maxUnits: e.maxUnits, taxable: e.taxable,
    channels: e.channels, availability: (e.availability ?? {}) as ExtraAvailability, dailyCap: e.dailyCap, leadTimeHours: e.leadTimeHours, active: e.active,
  };
}

function pointLike(p: PickupPoint): PickupPointLike {
  return {
    id: p.id, name: p.name, shortName: p.shortName, kind: p.kind, city: p.city, priceKobo: p.priceKobo, dropOffPriceKobo: p.dropOffPriceKobo,
    vehicleOptions: Array.isArray(p.vehicleOptions) ? (p.vehicleOptions as unknown as VehicleOption[]) : [], leadTimeHours: p.leadTimeHours,
    operatingHours: (p.operatingHours as { open: string; close: string } | null) ?? null, taxable: p.taxable, active: p.active,
  };
}

function stayOf(r: Reservation): StayInfo {
  const arrivalDate = lagosDate(r.arrivalAt);
  const departureDate = lagosDate(r.departureAt);
  return { arrivalDate, departureDate, arrivalAt: r.arrivalAt, nights: Math.max(1, diffDays(arrivalDate, departureDate)), adults: r.adults, children: r.children, dayUse: r.stayType === 'DAY_USE' };
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

interface ThemeStep {
  note: string;
  draft: ThemeDraft;
  daysAgo: number;
}

function draftFor(templateId: TemplateId, brand: Partial<ThemeDraft['brand']>, extra: Partial<Pick<ThemeDraft, 'colourMode'>> = {}): ThemeDraft {
  return normaliseDraft({ templateId, brand, ...extra });
}

/** Published steps in order (keyed by note), then the working draft. */
async function seedTheme(prisma: PrismaClient, tenantId: string, propertyId: string | null, steps: ThemeStep[], draft: ThemeDraft, by: string): Promise<void> {
  const { features } = await featuresOf(prisma, tenantId);
  for (const d of [...steps.map((s) => s.draft), draft]) {
    const gate = gateViolation(d, features);
    if (gate) throw new Error(`Seed theme ${d.templateId} needs ${gate}, which the plan lacks`);
  }
  let theme = await prisma.siteTheme.findFirst({ where: { tenantId, propertyId } });
  if (!theme) {
    theme = await prisma.siteTheme.create({ data: { tenantId, propertyId, scope: propertyId ? 'PROPERTY' : 'GROUP', draft: steps[0].draft as unknown as Prisma.InputJsonValue, draftUpdatedByName: by } });
  }
  let last: string | null = null;
  for (const s of steps) {
    const found = await prisma.siteThemeVersion.findFirst({ where: { themeId: theme.id, note: s.note } });
    if (found) {
      last = found.id;
      continue;
    }
    const max = await prisma.siteThemeVersion.aggregate({ where: { themeId: theme.id }, _max: { version: true } });
    const v = await prisma.siteThemeVersion.create({
      data: {
        tenantId, themeId: theme.id, version: (max._max.version ?? 0) + 1, note: s.note, publishedByName: by, publishedAt: new Date(Date.now() - s.daysAgo * 24 * HOUR),
        content: { ...s.draft, applied: appliedFor(s.draft) } as unknown as Prisma.InputJsonValue,
      },
    });
    last = v.id;
  }
  await prisma.siteTheme.update({ where: { id: theme.id }, data: { publishedVersionId: last, draft: draft as unknown as Prisma.InputJsonValue, draftUpdatedByName: by, draftUpdatedAt: new Date(Date.now() - 2 * HOUR) } });
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

interface FormStep {
  note: string;
  fields: FormField[];
  daysAgo: number;
}

function withEdits(fields: FormField[], edits: (list: FormField[]) => FormField[]): FormField[] {
  return normaliseFields(edits(fields.map((f) => ({ ...f }))).map((f, order) => ({ ...f, order })));
}

/** Moves the policy consent box back to the end after adding fields. */
function consentLast(list: FormField[]): FormField[] {
  const consent = list.find((f) => f.key === 'policyConsent');
  return consent ? [...list.filter((f) => f !== consent), consent] : list;
}

function withPickupWording(list: FormField[]): FormField[] {
  return list.map((f) => (f.key === 'arrivalPickup' ? { ...f, label: 'Pickup when you arrive', helpText: 'We can meet you at the airport, a motor park, the train station or the jetty. Priced per pickup point.' } : f));
}

async function seedForm(prisma: PrismaClient, tenantId: string, propertyId: string, presetId: PresetId, features: string[], steps: FormStep[], by: string): Promise<string> {
  for (const s of steps) {
    const check = validateBuilder(s.fields, features);
    if (check.issues.length) throw new Error(`Seed form "${s.note}" is invalid: ${check.issues.map((i) => `${i.path} ${i.code}`).join(', ')}`);
  }
  let form = await prisma.bookingForm.findUnique({ where: { propertyId } });
  if (!form) form = await prisma.bookingForm.create({ data: { tenantId, propertyId, presetId, draftFields: steps[0].fields.map(storable) as unknown as Prisma.InputJsonValue, draftUpdatedByName: by } });
  let last: { id: string; fields: FormField[] } | null = null;
  let prev: FormField[] | null = null;
  for (const s of steps) {
    const found = await prisma.bookingFormVersion.findFirst({ where: { formId: form.id, note: s.note } });
    if (found) {
      last = { id: found.id, fields: s.fields };
      prev = s.fields;
      continue;
    }
    const max = await prisma.bookingFormVersion.aggregate({ where: { formId: form.id }, _max: { version: true } });
    const v = await prisma.bookingFormVersion.create({
      data: {
        tenantId, propertyId, formId: form.id, version: (max._max.version ?? 0) + 1, note: s.note, publishedByName: by, publishedAt: new Date(Date.now() - s.daysAgo * 24 * HOUR),
        fields: s.fields.map(storable) as unknown as Prisma.InputJsonValue, diff: formDiff(s.fields, prev) as unknown as Prisma.InputJsonValue,
      },
    });
    last = { id: v.id, fields: s.fields };
    prev = s.fields;
  }
  await prisma.bookingForm.update({ where: { id: form.id }, data: { presetId, publishedVersionId: last!.id, draftFields: last!.fields.map(storable) as unknown as Prisma.InputJsonValue, draftUpdatedByName: by } });
  return last!.id;
}

// ---------------------------------------------------------------------------
// Bookings with answers, extras and transfers
// ---------------------------------------------------------------------------

interface Driver {
  name: string;
  phone: string;
  plate: string;
  vehicle: string;
}

interface TransferPlan {
  point: string;
  status: 'REQUESTED' | 'CONFIRMED' | 'DRIVER_ASSIGNED' | 'EN_ROUTE' | 'PICKED_UP' | 'COMPLETED';
  at: string;
  details: Record<string, unknown>;
  vehicle?: string;
  driver?: Driver;
  departure?: { point: string; at: string };
}

interface BookingPlan {
  answers: Record<string, unknown>;
  extras: { key: keyof typeof EXTRAS; quantity?: number }[];
  transfer?: TransferPlan;
}

const FLOW: TransferPlan['status'][] = ['REQUESTED', 'CONFIRMED', 'DRIVER_ASSIGNED', 'EN_ROUTE', 'PICKED_UP', 'COMPLETED'];
const NOTE: Record<TransferPlan['status'], string> = {
  REQUESTED: 'Requested with the booking',
  CONFIRMED: 'Confirmed by the front desk',
  DRIVER_ASSIGNED: 'Driver assigned',
  EN_ROUTE: 'Driver on the way',
  PICKED_UP: 'Guest picked up',
  COMPLETED: 'Arrived at the hotel',
};

async function attachBookings(
  prisma: PrismaClient,
  ctx: { tenantId: string; propertyId: string; formVersionId: string; fields: FormField[]; extras: Extra[]; points: PickupPoint[]; comps: TaxComponent[]; by: string },
  targets: { reservation: Reservation; plan: BookingPlan }[],
): Promise<{ bookings: number; extras: number; transfers: number }> {
  let bookings = 0;
  let extras = 0;
  let transfers = 0;
  const companies = new Map((await prisma.transportCompany.findMany()).map((c) => [c.id, c.name]));
  const routes = new Map((await prisma.trainRoute.findMany()).map((r) => [r.id, r.name]));
  const byKey = new Map(ctx.fields.map((f) => [f.key, f]));
  for (const { reservation: r, plan } of targets) {
    if (r.formVersionId) continue;
    const already = (await prisma.reservationExtra.count({ where: { reservationId: r.id } })) + (await prisma.transfer.count({ where: { reservationId: r.id } }));
    if (already) continue;
    const channel = r.source === 'MARKETPLACE' ? 'MARKETPLACE' : r.source === 'BOOKING_SITE' ? 'BOOKING_SITE' : 'FRONT_DESK';
    const stay = stayOf(r);
    const guest = await prisma.guest.findUnique({ where: { id: r.guestId } });
    const answers: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(plan.answers)) {
      const f = byKey.get(k);
      if (f && f.channels.includes(channel)) answers[k] = v;
    }
    const t = plan.transfer;
    const point = t ? ctx.points.find((p) => p.shortName === t.point) : null;
    if (t && point) {
      const vehicleOptionId = t.vehicle ?? (pointLike(point).vehicleOptions[0]?.id ?? 'standard');
      const scheduledAt = lagosDateTime(stay.arrivalDate, t.at);
      const depPoint = t.departure ? ctx.points.find((p) => p.shortName === t.departure!.point) ?? point : null;
      const details = { ...t.details } as Record<string, unknown>;
      if (typeof details.transportCompanyId === 'string') details.transportCompanyName = companies.get(details.transportCompanyId) ?? null;
      if (typeof details.trainRouteId === 'string') details.trainRouteName = routes.get(details.trainRouteId) ?? null;
      answers.arrivalPickup = {
        wanted: true, pickupPointId: point.id, vehicleOptionId, passengers: r.adults + r.children, luggage: 2, contactPhone: guest?.phone ?? null, scheduledAt: scheduledAt.toISOString(), details,
        departure: depPoint && t.departure ? { wanted: true, sameAsArrival: depPoint.id === point.id, pickupPointId: depPoint.id, scheduledAt: lagosDateTime(stay.departureDate, t.departure.at).toISOString() } : null,
        summary: [point.shortName || point.name, detailsSummary(point.kind as PickupKindCode, details, { company: (details.transportCompanyName as string) ?? null, route: (details.trainRouteName as string) ?? null })].filter(Boolean).join(': '),
      };
      const legs: { direction: 'ARRIVAL' | 'DEPARTURE'; p: PickupPoint; at: Date; status: TransferPlan['status']; details: Record<string, unknown> }[] = [{ direction: 'ARRIVAL', p: point, at: scheduledAt, status: t.status, details }];
      if (depPoint && t.departure) legs.push({ direction: 'DEPARTURE', p: depPoint, at: lagosDateTime(stay.departureDate, t.departure.at), status: 'CONFIRMED', details: {} });
      for (const leg of legs) {
        const q = quoteTransfer(pointLike(leg.p), { direction: leg.direction, pickupPointId: leg.p.id, vehicleOptionId, passengers: r.adults + r.children, scheduledAt: leg.at.toISOString() }, stay, leg.p.taxable ? ctx.comps : [], 'transfer', new Date(leg.at.getTime() - 3 * 24 * HOUR), { enforceLeadTime: false });
        if (!q.quoted) throw new Error(`Seed transfer for ${r.code} does not price: ${q.issues.map((i) => i.code).join(', ')}`);
        const steps = FLOW.slice(0, FLOW.indexOf(leg.status) + 1);
        const start = Math.min(leg.at.getTime() - 20 * HOUR, Date.now() - 20 * HOUR);
        const events = steps.map((s, i) => ({ at: new Date(i === 0 ? r.createdAt.getTime() : Math.min(Date.now() - (steps.length - i) * 15 * 60_000, start + i * HOUR)).toISOString(), status: s, note: NOTE[s], by: i === 0 ? (channel === 'FRONT_DESK' ? ctx.by : 'Guest') : ctx.by }));
        const assigned = leg.direction === 'ARRIVAL' && t.driver && FLOW.indexOf(leg.status) >= FLOW.indexOf('DRIVER_ASSIGNED');
        await prisma.transfer.create({
          data: {
            tenantId: ctx.tenantId, propertyId: ctx.propertyId, reservationId: r.id, direction: leg.direction, status: leg.status, pickupPointId: leg.p.id, pickupPointName: leg.p.name, kind: leg.p.kind,
            details: leg.details as Prisma.InputJsonValue, scheduledAt: leg.at, passengers: q.quoted.passengers, luggage: 2, vehicleOptionId: q.quoted.vehicleOptionId, vehicleName: q.quoted.vehicleName,
            vehicleMaxPassengers: q.quoted.vehicleMaxPassengers, amountKobo: q.quoted.amountKobo, netKobo: q.quoted.netKobo, taxKobo: q.quoted.taxKobo,
            taxComponents: (q.quoted.taxes.length ? ctx.comps : []) as unknown as Prisma.InputJsonValue, contactPhone: normalisePhone(guest?.phone ?? '') ?? null,
            source: channel === 'FRONT_DESK' ? 'FRONT_DESK' : 'ONLINE', events: events as unknown as Prisma.InputJsonValue,
            ...(assigned && { driverName: t.driver!.name, driverPhone: t.driver!.phone, vehiclePlate: t.driver!.plate, vehicleDescription: t.driver!.vehicle, assignedAt: new Date(events[2].at), lastNotifiedAt: new Date(events[2].at) }),
            createdAt: r.createdAt,
          },
        });
        transfers++;
      }
    }
    for (const sel of plan.extras) {
      const e = ctx.extras.find((x) => x.name === EXTRAS[sel.key].name);
      if (!e) continue;
      const q = priceExtra(extraLike(e), { extraId: e.id, quantity: sel.quantity }, stay, e.taxable ? ctx.comps : [], 'extras');
      if (!q.quoted) continue;
      await prisma.reservationExtra.create({
        data: {
          tenantId: ctx.tenantId, propertyId: ctx.propertyId, reservationId: r.id, extraId: e.id, name: q.quoted.name, category: e.category, pricing: q.quoted.pricing, quantity: q.quoted.quantity,
          persons: q.quoted.persons, nights: q.quoted.nights, unitPriceKobo: q.quoted.unitPriceKobo, amountKobo: q.quoted.amountKobo, netKobo: q.quoted.netKobo, taxKobo: q.quoted.taxKobo,
          taxComponents: (q.quoted.taxes.length ? ctx.comps : []) as unknown as Prisma.InputJsonValue, description: q.quoted.description, serviceDates: q.quoted.serviceDates,
          source: channel === 'FRONT_DESK' ? 'FRONT_DESK' : 'ONLINE', createdByName: channel === 'FRONT_DESK' ? ctx.by : null, createdAt: r.createdAt,
        },
      });
      extras++;
    }
    await prisma.reservation.update({
      where: { id: r.id },
      data: {
        formVersionId: ctx.formVersionId, formChannel: channel, formAnswers: answers as Prisma.InputJsonValue, formSubmittedAt: r.createdAt,
        ...(typeof answers.estimatedArrivalTime === 'string' && !r.expectedArrivalTime && { expectedArrivalTime: answers.estimatedArrivalTime }),
      },
    });
    bookings++;
  }
  return { bookings, extras, transfers };
}

/** CONFIRMED stays arriving from today, the soonest first. */
async function upcoming(prisma: PrismaClient, propertyId: string, take: number): Promise<Reservation[]> {
  const today = lagosDate();
  return prisma.reservation.findMany({
    where: { propertyId, status: 'CONFIRMED', stayType: 'NIGHTLY', arrivalAt: { gte: lagosDateTime(today, '00:00'), lt: lagosDateTime(addDays(today, 21), '00:00') } },
    orderBy: [{ arrivalAt: 'asc' }, { code: 'asc' }],
    take,
  });
}

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

async function completeSetup(prisma: PrismaClient, tenantId: string, propertyId: string, hotelType: string | null): Promise<void> {
  const data = { steps: {}, completedAt: new Date(Date.now() - 30 * 24 * HOUR), hotelType };
  await prisma.setupProgress.upsert({ where: { propertyId }, create: { tenantId, propertyId, startedAt: new Date(Date.now() - 31 * 24 * HOUR), ...data }, update: data });
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

const PALMWINE_DRIVERS: Driver[] = [
  { name: 'Sunday Okon', phone: '+2348031234567', plate: 'LSD 482 KJ', vehicle: 'Silver Toyota Corolla' },
  { name: 'Ibrahim Lawal', phone: '+2348067654321', plate: 'KJA 219 EX', vehicle: 'Black Toyota Highlander' },
];

/** Every hotel in the shared database (Harmattan too while it still lives there). */
export async function seedM7(prisma: PrismaClient): Promise<Record<string, number>> {
  const counts = { themes: 0, forms: 0, extras: 0, points: 0, bookings: 0, lines: 0, transfers: 0 };
  const add = (r: { bookings: number; extras: number; transfers: number }) => {
    counts.bookings += r.bookings;
    counts.lines += r.extras;
    counts.transfers += r.transfers;
  };
  const prop = (slug: string) => prisma.property.findUnique({ where: { slug } });

  // Setup: every seeded hotel is live, except Wuse Garden Suites (below).
  for (const p of await prisma.property.findMany({ select: { id: true, tenantId: true, slug: true } })) {
    if (p.slug === 'wuse-garden-suites') continue;
    const exists = await prisma.setupProgress.findUnique({ where: { propertyId: p.id } });
    if (!exists) await completeSetup(prisma, p.tenantId, p.id, null);
  }

  // The Palmwine House, Lekki (Pro): Editorial published, Boutique in the draft; boutique form, v2 adds pickups and a conditional question.
  const lekki = await prop('palmwine-house');
  if (lekki) {
    const { features, formLimit } = await featuresOf(prisma, lekki.tenantId);
    const brand = { primary: lekki.accentColor ?? '#B4452A', secondary: '#1F3B2D', logoUrl: lekki.logoUrl, fontPairingId: 'fraunces-schibsted' };
    const published = draftFor('editorial', brand, { colourMode: 'SYSTEM' });
    const boutique: ThemeDraft = { ...published, templateId: 'boutique', brand: { ...published.brand, fontPairingId: 'cormorant-manrope' }, sections: switchTemplate(published.sections, templateById('boutique')!) };
    await seedTheme(prisma, lekki.tenantId, lekki.id, [
      { note: 'First look: Editorial with our terracotta', draft: draftFor('editorial', { primary: brand.primary, logoUrl: lekki.logoUrl }), daysAgo: 60 },
      { note: 'Palm green secondary and Fraunces headings', draft: published, daysAgo: 21 },
    ], boutique, 'Tunde Bakare');
    counts.themes++;
    const v1 = buildPreset('boutique', features, formLimit).fields;
    const v2 = withEdits(v1, (list) => consentLast(withPickupWording([
      ...list,
      ...buildPreset('business', features, formLimit).fields.filter((f) => f.key === 'arrivalPickup'),
      {
        ...list.find((f) => f.key === 'c_occasion')!, key: 'c_occasion_note', type: 'SHORT_TEXT', label: 'Anything we should prepare for the occasion?', options: [], placeholder: 'e.g. Surprise for my wife, please keep it quiet',
        validation: { maxLength: 200 }, condition: { fieldKey: 'c_occasion', operator: 'IN', value: ['BIRTHDAY', 'ANNIVERSARY', 'HONEYMOON', 'PROPOSAL'] }, guestPurpose: null,
      },
    ])));
    const versionId = await seedForm(prisma, lekki.tenantId, lekki.id, 'boutique', features, [
      { note: 'Boutique preset', fields: v1, daysAgo: 45 },
      { note: 'Arrival pickup and occasion details', fields: v2, daysAgo: 12 },
    ], 'Tunde Bakare');
    counts.forms++;
    const extras = await upsertExtras(prisma, lekki.tenantId, lekki.id, ['breakfast', 'early', 'late', 'cake', 'wine', 'laundry']);
    const points = await upsertPoints(prisma, lekki.tenantId, lekki.id, POINTS_LAGOS);
    await prisma.localTransportCompany.upsert({ where: { tenantId_name: { tenantId: lekki.tenantId, name: 'Lekki Coastal Shuttle' } }, create: { tenantId: lekki.tenantId, name: 'Lekki Coastal Shuttle', shortName: 'LCS' }, update: {} });
    counts.extras += extras.length;
    counts.points += points.length;
    const list = await upcoming(prisma, lekki.id, 10);
    const plans: BookingPlan[] = [
      { answers: { estimatedArrivalTime: '13:30', c_occasion: 'BIRTHDAY', c_occasion_note: 'Her 40th, a cake that says "Happy birthday Ada"', bedPreference: 'KING', dietaryRequirements: ['NO_PORK'] }, extras: [{ key: 'cake' }, { key: 'breakfast' }], transfer: { point: 'MMIA', status: 'EN_ROUTE', at: '11:20', details: { airline: 'Air Peace', flightNumber: 'P4 7121', terminal: 'Terminal 2' }, vehicle: 'suv', driver: PALMWINE_DRIVERS[1], departure: { point: 'MMIA', at: '09:00' } } },
      { answers: { estimatedArrivalTime: '15:00', bedPreference: 'TWIN', howDidYouHear: 'INSTAGRAM' }, extras: [{ key: 'late' }], transfer: { point: 'Jibowu', status: 'DRIVER_ASSIGNED', at: '14:30', details: { transportCompanyId: 'gig-mobility', departureCity: 'Benin City', ticketReference: 'GIG-58213' }, driver: PALMWINE_DRIVERS[0] } },
      { answers: { estimatedArrivalTime: '16:00', specialRequests: 'Quiet room away from the lift, please.', dietaryRequirements: ['VEGETARIAN'] }, extras: [{ key: 'breakfast' }, { key: 'wine', quantity: 1 }], transfer: { point: 'Ebute Metta station', status: 'CONFIRMED', at: '16:45', details: { trainRouteId: 'lagos-ibadan', trainService: 'Express' } } },
      { answers: { estimatedArrivalTime: '18:00', c_occasion: 'ANNIVERSARY', c_occasion_note: 'Tenth anniversary, flowers if possible', bedPreference: 'KING' }, extras: [{ key: 'wine', quantity: 2 }], transfer: { point: 'Marina jetty', status: 'REQUESTED', at: '17:30', details: { details: 'Coming by ferry from Ikorodu, the 16:30 boat' } } },
      { answers: { estimatedArrivalTime: '12:00', c_occasion: 'BUSINESS', howDidYouHear: 'RETURNING_GUEST' }, extras: [{ key: 'early' }, { key: 'laundry', quantity: 2 }] },
      { answers: { estimatedArrivalTime: '20:00', bedPreference: 'NO_PREFERENCE' }, extras: [], transfer: { point: 'MMA2', status: 'REQUESTED', at: '19:10', details: { airline: 'Ibom Air', flightNumber: 'QI 0321' } } },
      { answers: { c_occasion: 'HONEYMOON', c_occasion_note: 'Rose petals on the bed would be lovely', dietaryRequirements: ['HALAL'] }, extras: [{ key: 'breakfast' }, { key: 'late' }] },
      { answers: { estimatedArrivalTime: '14:00', howDidYouHear: 'GOOGLE' }, extras: [{ key: 'breakfast' }] },
    ];
    const comps = await taxComponents(prisma, lekki.id);
    add(await attachBookings(prisma, { tenantId: lekki.tenantId, propertyId: lekki.id, formVersionId: versionId, fields: v2, extras, points, comps, by: 'Ngozi Eze' }, list.slice(0, plans.length).map((reservation, i) => ({ reservation, plan: plans[i] }))));
    await completeSetup(prisma, lekki.tenantId, lekki.id, 'boutique');
  }

  // Palmwine House Ikoyi (same Pro tenant): Business template, business form, a few extras and an airport pickup.
  const ikoyi = await prop('palmwine-house-ikoyi');
  if (ikoyi) {
    const { features, formLimit } = await featuresOf(prisma, ikoyi.tenantId);
    const d = draftFor('business', { primary: '#1D3557', secondary: '#B4452A', logoUrl: ikoyi.logoUrl, fontPairingId: 'spacegrotesk-plexsans' }, { colourMode: 'LIGHT' });
    await seedTheme(prisma, ikoyi.tenantId, ikoyi.id, [{ note: 'Business template for Ikoyi', draft: d, daysAgo: 30 }], d, 'Tunde Bakare');
    counts.themes++;
    const fields = withEdits(buildPreset('business', features, formLimit).fields, (l) => withPickupWording(l));
    const versionId = await seedForm(prisma, ikoyi.tenantId, ikoyi.id, 'business', features, [{ note: 'Business hotel preset', fields, daysAgo: 30 }], 'Tunde Bakare');
    counts.forms++;
    const extras = await upsertExtras(prisma, ikoyi.tenantId, ikoyi.id, ['breakfastPerPerson', 'late', 'laundry']);
    const points = await upsertPoints(prisma, ikoyi.tenantId, ikoyi.id, POINTS_LAGOS.slice(0, 2));
    counts.extras += extras.length;
    counts.points += points.length;
    const list = await upcoming(prisma, ikoyi.id, 2);
    const comps = await taxComponents(prisma, ikoyi.id);
    add(await attachBookings(prisma, { tenantId: ikoyi.tenantId, propertyId: ikoyi.id, formVersionId: versionId, fields, extras, points, comps, by: 'Kelechi Obi' }, [
      { answers: { estimatedArrivalTime: '15:30', purposeOfVisit: 'BUSINESS', companyName: 'Zenith Ventures Limited', companyTin: '12345678-0001', nationality: 'Nigerian' }, extras: [{ key: 'breakfastPerPerson' }], transfer: { point: 'MMIA', status: 'PICKED_UP', at: '13:05', details: { airline: 'British Airways', flightNumber: 'BA 075', terminal: 'Terminal 1' }, vehicle: 'saloon', driver: PALMWINE_DRIVERS[0] } },
      { answers: { purposeOfVisit: 'BUSINESS', nationality: 'Ghanaian' }, extras: [{ key: 'late' }] },
    ].slice(0, list.length).map((plan, i) => ({ reservation: list[i], plan: plan as BookingPlan }))));
    await completeSetup(prisma, ikoyi.tenantId, ikoyi.id, 'business');
  }

  // Eko Tides (Growth): Resort template and resort form.
  const eko = await prop('eko-tides');
  if (eko) {
    const { features, formLimit } = await featuresOf(prisma, eko.tenantId);
    const d = draftFor('resort', { primary: '#0E7490', secondary: '#F4A259', logoUrl: eko.logoUrl }, { colourMode: 'LIGHT' });
    await seedTheme(prisma, eko.tenantId, eko.id, [{ note: 'Resort template', draft: d, daysAgo: 18 }], d, 'Babajide Olatunji');
    counts.themes++;
    const fields = withEdits(buildPreset('resort', features, formLimit).fields, (l) => withPickupWording(l));
    const versionId = await seedForm(prisma, eko.tenantId, eko.id, 'resort', features, [{ note: 'Resort preset', fields, daysAgo: 18 }], 'Babajide Olatunji');
    counts.forms++;
    const extras = await upsertExtras(prisma, eko.tenantId, eko.id, ['breakfastPerPerson', 'early', 'cake', 'spa']);
    const points = await upsertPoints(prisma, eko.tenantId, eko.id, [POINTS_LAGOS[0], POINTS_LAGOS[6]]);
    counts.extras += extras.length;
    counts.points += points.length;
    const list = await upcoming(prisma, eko.id, 1);
    const comps = await taxComponents(prisma, eko.id);
    add(await attachBookings(prisma, { tenantId: eko.tenantId, propertyId: eko.id, formVersionId: versionId, fields, extras, points, comps, by: 'Front desk' }, list.map((reservation) => ({
      reservation,
      plan: { answers: { estimatedArrivalTime: '16:00', c_occasion: 'BIRTHDAY', childrenAges: reservation.children ? '6' : undefined, dietaryRequirements: ['NUT_ALLERGY'], bedPreference: 'KING' }, extras: [{ key: 'breakfastPerPerson' }], transfer: { point: 'MMIA', status: 'REQUESTED', at: '14:10', details: { airline: 'Arik Air', flightNumber: 'W3 0104' } } },
    }))));
    await completeSetup(prisma, eko.tenantId, eko.id, 'resort');
  }

  // Bodija Heights (Starter): Essentials and the standard form plus one custom question (within the 3-field limit).
  const bodija = await prop('bodija-heights');
  if (bodija) {
    const { features, formLimit } = await featuresOf(prisma, bodija.tenantId);
    const d = draftFor('essentials', { primary: '#8A4B1F', logoUrl: bodija.logoUrl }, { colourMode: 'LIGHT' });
    await seedTheme(prisma, bodija.tenantId, bodija.id, [{ note: 'Essentials template in kola brown', draft: d, daysAgo: 10 }], d, 'Owner');
    counts.themes++;
    const base = buildPreset('default', features, formLimit).fields;
    const occasion = buildPreset('boutique', ['form_fields_unlimited'], -1).fields.find((f) => f.key === 'c_occasion')!;
    const fields = withEdits(base, (l) => consentLast([...l, { ...occasion, label: 'Occasion' }]));
    await seedForm(prisma, bodija.tenantId, bodija.id, 'default', features, [{ note: 'Standard form with the occasion', fields, daysAgo: 10 }], 'Owner');
    counts.forms++;
    await completeSetup(prisma, bodija.tenantId, bodija.id, 'guesthouse');
  }

  // Wuse Garden Suites (Starter trial): part-way through the setup wizard.
  const wuse = await prop('wuse-garden-suites');
  if (wuse) {
    const at = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
    const data = { hotelType: 'guesthouse', steps: { hotel_type: { status: 'DONE', at: at(50) }, brand: { status: 'SKIPPED', at: at(49) } }, completedAt: null };
    await prisma.setupProgress.upsert({ where: { propertyId: wuse.id }, create: { tenantId: wuse.tenantId, propertyId: wuse.id, startedAt: new Date(Date.now() - 52 * HOUR), ...data }, update: data });
  }

  // Harmattan while it still lives in the shared database (copied on provisioning).
  const hh = await prisma.tenant.findUnique({ where: { slug: 'harmattan' } });
  const moved = hh ? (await prisma.tenantDatabase.findUnique({ where: { tenantId: hh.id } }))?.mode === 'DEDICATED' : false;
  if (hh && !moved && (await prisma.property.count({ where: { tenantId: hh.id } }))) {
    const r = await seedM7Harmattan(prisma, hh.id);
    counts.themes += r.themes;
    counts.forms += r.forms;
    counts.extras += r.extras;
    counts.points += r.points;
    add({ bookings: r.bookings, extras: r.lines, transfers: r.transfers });
  }
  return counts;
}

const HARMATTAN_DRIVER: Driver = { name: 'Musa Abdullahi', phone: '+2348091112233', plate: 'ABJ 614 KL', vehicle: 'White Toyota Prado' };

/** Harmattan (Enterprise): Heritage on every property and on the group root; Abuja has extras, pickups and transfers. */
export async function seedM7Harmattan(prisma: PrismaClient, tenantId: string): Promise<Record<string, number>> {
  const counts = { themes: 0, forms: 0, extras: 0, points: 0, bookings: 0, lines: 0, transfers: 0 };
  const { features, formLimit } = await featuresOf(prisma, tenantId);
  const brand = { primary: '#B4532A', secondary: '#2B2D42', fontPairingId: 'marcellus-karla' };
  const props = await prisma.property.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
  for (const p of props) {
    const d = draftFor('heritage', { ...brand, logoUrl: p.logoUrl }, { colourMode: 'LIGHT' });
    await seedTheme(prisma, tenantId, p.id, [{ note: 'Heritage template for the group', draft: d, daysAgo: 40 }], d, 'Amina Danjuma');
    counts.themes++;
    const exists = await prisma.setupProgress.findUnique({ where: { propertyId: p.id } });
    if (!exists) await completeSetup(prisma, tenantId, p.id, 'event_venue');
  }
  if (props.length) {
    const root = draftFor('heritage', { ...brand, logoUrl: props[0].logoUrl }, { colourMode: 'LIGHT' });
    await seedTheme(prisma, tenantId, null, [{ note: 'Group site: Heritage', draft: root, daysAgo: 40 }], root, 'Amina Danjuma');
    counts.themes++;
  }
  const abuja = props.find((p) => p.slug === 'harmattan-abuja');
  if (!abuja) return counts;
  const fields = withEdits(buildPreset('event_venue', features, formLimit).fields, (l) => consentLast(withPickupWording([...l, ...buildPreset('business', features, formLimit).fields.filter((f) => f.libraryKey === 'company' || f.key === 'purposeOfVisit')])));
  const versionId = await seedForm(prisma, tenantId, abuja.id, 'event_venue', features, [{ note: 'Events and business guests', fields, daysAgo: 35 }], 'Amina Danjuma');
  counts.forms++;
  const extras = await upsertExtras(prisma, tenantId, abuja.id, ['breakfastPerPerson', 'early', 'late', 'cake', 'laundry']);
  const points = await upsertPoints(prisma, tenantId, abuja.id, POINTS_ABUJA);
  counts.extras += extras.length;
  counts.points += points.length;
  const list = await upcoming(prisma, abuja.id, 3);
  const comps = await taxComponents(prisma, abuja.id);
  const plans: BookingPlan[] = [
    { answers: { c_event_name: 'Hauwa and Chidi\'s wedding', c_guest_of: 'BRIDE', estimatedArrivalTime: '15:00' }, extras: [{ key: 'breakfastPerPerson' }], transfer: { point: 'Abuja airport', status: 'DRIVER_ASSIGNED', at: '13:40', details: { airline: 'Air Peace', flightNumber: 'P4 7302' }, vehicle: 'suv', driver: HARMATTAN_DRIVER, departure: { point: 'Abuja airport', at: '10:00' } } },
    { answers: { purposeOfVisit: 'BUSINESS', companyName: 'Sahel Agro Processing Ltd', companyTin: '0987654321' }, extras: [{ key: 'late' }], transfer: { point: 'Idu station', status: 'CONFIRMED', at: '12:30', details: { trainRouteId: 'abuja-kaduna', trainService: 'AK1 Morning' } } },
    { answers: { c_event_name: 'Nigerian Agritech Summit', estimatedArrivalTime: '19:00' }, extras: [{ key: 'laundry', quantity: 1 }] },
  ];
  const r = await attachBookings(prisma, { tenantId, propertyId: abuja.id, formVersionId: versionId, fields, extras, points, comps, by: 'Front desk Abuja' }, list.slice(0, plans.length).map((reservation, i) => ({ reservation, plan: plans[i] })));
  counts.bookings += r.bookings;
  counts.lines += r.extras;
  counts.transfers += r.transfers;
  return counts;
}
