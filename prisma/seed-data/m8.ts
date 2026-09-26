/**
 * M8 demo data: the concierge (lawful services only). The Palmwine House
 * (Lekki) accepts the acceptable-use policy, switches the concierge on, keeps
 * twelve services and five vendors, and has requests in every status today
 * (two private ones, a free-form one, one held by the content screen, an
 * overdue one, a quote waiting for a WhatsApp YES, completed and rated
 * ones). Harmattan Abuja gets a smaller catalogue (in its dedicated
 * database). Eko Tides has a lawful security-escort service that the word
 * "escort" sends to the platform review queue.
 *
 * Idempotent: services, vendors and settings are upserted by natural keys;
 * the demo requests are deleted and rebuilt (the operations seed rebuilds
 * the stays they belong to). All people, companies and phone numbers are
 * fictional.
 */
import type { Prisma, PrismaClient, Reservation } from '../../src/generated/prisma/client.js';
import { addDays, lagosDate, lagosDateTime, humanDateTime, dbDate } from '../../src/common/time/lagos.js';
import { computeCharge, type TaxComponent } from '../../src/modules/folios/tax.logic.js';
import type { FormField } from '../../src/modules/booking-form/form.catalogue.js';
import { AUP_VERSION } from '../../src/modules/concierge/aup.js';
import { formatNumber, normaliseQuestions, priceService, quotePrice, slaDueAt, type ServiceLike, type ServiceVariant } from '../../src/modules/concierge/concierge.logic.js';
import { screen } from '../../src/modules/concierge/denylist.js';
import { taxComponents } from './pro.js';

const NAIRA = 100;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

type Category = Prisma.ConciergeServiceCreateInput['category'];

interface VendorSeed {
  key: string;
  name: string;
  category: Category;
  contactName: string;
  phone: string;
  email: string;
  commissionType: 'NONE' | 'PERCENT' | 'FIXED';
  commissionValue: number;
  payoutNotes: string;
}

interface ServiceSeed {
  key: string;
  name: string;
  description: string;
  category: Category;
  pricing: 'FIXED' | 'FROM' | 'PER_HOUR' | 'PER_PERSON' | 'FREE';
  priceNaira?: number;
  variants?: { id: string; name: string; priceNaira: number; durationMinutes: number | null }[];
  durationMinutes?: number;
  leadTimeHours: number;
  availability?: { days: number[]; from: string; to: string } | null;
  requiresSlot?: boolean;
  slotCapacity?: number;
  location: 'IN_ROOM' | 'ON_PROPERTY' | 'OFF_PROPERTY';
  vendor?: string;
  discreetEligible?: boolean;
  questions?: Partial<FormField>[];
  channels?: string[];
  sortOrder: number;
}

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const opt = (pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

const PALMWINE_VENDORS: VendorSeed[] = [
  { key: 'spa', name: 'Oasis Touch Spa', category: 'WELLNESS', contactName: 'Ifeoma Nnaji', phone: '+2348025550301', email: 'bookings@oasistouchspa.ng', commissionType: 'PERCENT', commissionValue: 1500, payoutNotes: 'Paid every Monday by transfer (account details on file). Licensed therapists only.' },
  { key: 'chef', name: 'Chef Tobi Kitchens', category: 'DINING', contactName: 'Tobi Adebayo', phone: '+2348035550302', email: 'hello@cheftobikitchens.ng', commissionType: 'PERCENT', commissionValue: 1000, payoutNotes: 'Paid within 7 days of the dinner. Food handler certificate on file.' },
  { key: 'car', name: 'Eko Executive Car Hire', category: 'TRANSPORT', contactName: 'Sani Garba', phone: '+2348055550303', email: 'dispatch@ekoexecutive.ng', commissionType: 'FIXED', commissionValue: 5_000 * NAIRA, payoutNotes: 'Settled weekly. Drivers carry a hotel letter and an ID card.' },
  { key: 'photo', name: 'Lens & Light Studio', category: 'PHOTOGRAPHY', contactName: 'Kemi Olatunji', phone: '+2348065550304', email: 'studio@lensandlight.ng', commissionType: 'PERCENT', commissionValue: 1200, payoutNotes: 'Paid after the edited photos are delivered.' },
  { key: 'tours', name: 'Lagos Heritage Tours', category: 'TOURS_AND_EXPERIENCES', contactName: 'Femi Ajayi', phone: '+2348075550305', email: 'tours@lagosheritage.ng', commissionType: 'PERCENT', commissionValue: 1000, payoutNotes: 'Settled monthly. Registered tour operator.' },
];

const PALMWINE_SERVICES: ServiceSeed[] = [
  {
    key: 'massage', name: 'In-room massage', sortOrder: 1, category: 'WELLNESS', pricing: 'FIXED', location: 'IN_ROOM', vendor: 'spa', discreetEligible: true,
    description: 'A relaxing massage in your room by a licensed therapist from Oasis Touch Spa. Towels, oils and a portable table are brought to you.',
    variants: [{ id: '60-minutes', name: '60 minutes', priceNaira: 35_000, durationMinutes: 60 }, { id: '90-minutes', name: '90 minutes', priceNaira: 48_000, durationMinutes: 90 }],
    leadTimeHours: 2, availability: { days: EVERY_DAY, from: '10:00', to: '22:00' }, requiresSlot: true, slotCapacity: 2,
    questions: [
      { key: 'c_massage_type', type: 'SELECT', label: 'Massage type', required: 'REQUIRED', options: opt([['SWEDISH', 'Swedish (relaxing)'], ['DEEP_TISSUE', 'Deep tissue'], ['HOT_STONE', 'Hot stone'], ['AROMATHERAPY', 'Aromatherapy']]) },
      { key: 'c_therapist_preference', type: 'SELECT', label: 'Therapist gender preference (for comfort)', required: 'OPTIONAL', options: opt([['FEMALE', 'Female therapist'], ['MALE', 'Male therapist'], ['NO_PREFERENCE', 'No preference']]) },
      { key: 'c_pressure', type: 'SELECT', label: 'Pressure preference', required: 'OPTIONAL', options: opt([['LIGHT', 'Light'], ['MEDIUM', 'Medium'], ['FIRM', 'Firm']]) },
      { key: 'c_allergies', type: 'SHORT_TEXT', label: 'Any allergies we should know about?', required: 'OPTIONAL', validation: { maxLength: 200 } },
    ],
  },
  {
    key: 'chef', name: 'Private chef dinner', sortOrder: 2, category: 'DINING', pricing: 'FROM', priceNaira: 120_000, location: 'ON_PROPERTY', vendor: 'chef', discreetEligible: true,
    description: 'Chef Tobi cooks a three-course dinner in your suite or on the terrace: Nigerian favourites, continental, or a bit of both. We send you a price for your party and menu.',
    durationMinutes: 180, leadTimeHours: 24, availability: { days: EVERY_DAY, from: '17:00', to: '22:00' },
    questions: [
      { key: 'c_cuisine', type: 'SELECT', label: 'Cuisine', required: 'REQUIRED', options: opt([['NIGERIAN', 'Nigerian'], ['CONTINENTAL', 'Continental'], ['MIXED', 'A bit of both']]) },
      { key: 'c_guests', type: 'NUMBER', label: 'Number of guests', required: 'REQUIRED', validation: { min: 1, max: 12 } },
      { key: 'c_dietary', type: 'MULTI_SELECT', label: 'Dietary needs', required: 'OPTIONAL', options: opt([['VEGETARIAN', 'Vegetarian'], ['HALAL', 'Halal'], ['NO_PORK', 'No pork'], ['NUT_ALLERGY', 'Nut allergy'], ['GLUTEN_FREE', 'Gluten free']]) },
      { key: 'c_occasion', type: 'SELECT', label: 'Occasion', required: 'OPTIONAL', options: opt([['BIRTHDAY', 'Birthday'], ['ANNIVERSARY', 'Anniversary'], ['BUSINESS', 'Business dinner'], ['OTHER', 'Something else']]) },
    ],
  },
  {
    key: 'romance', name: 'Romantic room set-up', sortOrder: 3, category: 'ROMANCE_AND_CELEBRATION', pricing: 'FIXED', priceNaira: 65_000, location: 'IN_ROOM', discreetEligible: true,
    description: 'Fresh roses, candles (flameless) and a small celebration cake, set up in your room while you are out. Tell us the occasion and the message for the cake.',
    leadTimeHours: 6, availability: { days: EVERY_DAY, from: '09:00', to: '21:00' },
    questions: [
      { key: 'c_occasion', type: 'SELECT', label: 'Occasion', required: 'REQUIRED', options: opt([['BIRTHDAY', 'Birthday'], ['ANNIVERSARY', 'Anniversary'], ['PROPOSAL', 'Proposal'], ['HONEYMOON', 'Honeymoon']]) },
      { key: 'c_cake_message', type: 'SHORT_TEXT', label: 'Message on the cake', required: 'OPTIONAL', placeholder: 'e.g. Happy anniversary, Ada', validation: { maxLength: 40 } },
      { key: 'c_flowers', type: 'SELECT', label: 'Flower colours', required: 'OPTIONAL', options: opt([['RED', 'Red roses'], ['WHITE', 'White roses'], ['MIXED', 'Mixed bouquet']]) },
    ],
  },
  {
    key: 'barber', name: 'Barber in-room', sortOrder: 4, category: 'GROOMING', pricing: 'FIXED', priceNaira: 15_000, location: 'IN_ROOM', discreetEligible: false,
    description: 'Haircut and beard trim in your room by our barber, with clean tools for every guest.', durationMinutes: 45, leadTimeHours: 2,
    availability: { days: EVERY_DAY, from: '08:00', to: '20:00' }, requiresSlot: true, slotCapacity: 1,
    questions: [{ key: 'c_cut', type: 'SELECT', label: 'What would you like?', required: 'REQUIRED', options: opt([['HAIRCUT', 'Haircut'], ['BEARD', 'Beard trim'], ['BOTH', 'Haircut and beard trim']]) }],
  },
  {
    key: 'makeup', name: 'Hair and make-up', sortOrder: 5, category: 'GROOMING', pricing: 'PER_PERSON', priceNaira: 30_000, location: 'IN_ROOM', discreetEligible: false,
    description: 'A make-up artist and hairstylist come to your room: a natural look, full glam or bridal.', durationMinutes: 90, leadTimeHours: 12,
    availability: { days: EVERY_DAY, from: '06:00', to: '18:00' },
    questions: [{ key: 'c_look', type: 'SELECT', label: 'Look', required: 'REQUIRED', options: opt([['NATURAL', 'Natural'], ['GLAM', 'Full glam'], ['BRIDAL', 'Bridal']]) }],
  },
  {
    key: 'car', name: 'Car with driver', sortOrder: 6, category: 'TRANSPORT', pricing: 'FIXED', location: 'OFF_PROPERTY', vendor: 'car', discreetEligible: true,
    description: 'An air-conditioned saloon or SUV with a professional driver from Eko Executive Car Hire, for meetings, shopping or a day out in Lagos. Fuel included.',
    variants: [{ id: 'half-day', name: 'Half day (5 hours)', priceNaira: 55_000, durationMinutes: 300 }, { id: 'full-day', name: 'Full day (10 hours)', priceNaira: 95_000, durationMinutes: 600 }],
    leadTimeHours: 4, availability: { days: EVERY_DAY, from: '06:00', to: '20:00' },
    questions: [
      { key: 'c_vehicle', type: 'SELECT', label: 'Vehicle', required: 'OPTIONAL', options: opt([['SALOON', 'Saloon car'], ['SUV', 'SUV']]) },
      { key: 'c_destination', type: 'SHORT_TEXT', label: 'Where are you going?', required: 'OPTIONAL', placeholder: 'e.g. Victoria Island, then Lekki Market', validation: { maxLength: 160 } },
    ],
  },
  {
    key: 'tour', name: 'Lekki - Ikoyi city tour', sortOrder: 7, category: 'TOURS_AND_EXPERIENCES', pricing: 'PER_PERSON', priceNaira: 25_000, location: 'OFF_PROPERTY', vendor: 'tours',
    description: 'A four-hour guided tour: the Lekki Conservation Centre canopy walk, Nike Art Gallery, the Lekki - Ikoyi link bridge and a stop at a Victoria Island bookshop cafe.',
    durationMinutes: 240, leadTimeHours: 24, availability: { days: [0, 2, 3, 4, 5, 6], from: '09:00', to: '16:00' }, requiresSlot: true, slotCapacity: 3,
    questions: [{ key: 'c_language', type: 'SELECT', label: 'Preferred language', required: 'OPTIONAL', options: opt([['ENGLISH', 'English'], ['YORUBA', 'Yoruba'], ['FRENCH', 'French']]) }],
  },
  {
    key: 'babysitting', name: 'Babysitting', sortOrder: 8, category: 'FAMILY', pricing: 'PER_HOUR', priceNaira: 6_000, location: 'IN_ROOM',
    description: 'A vetted, first-aid trained sitter looks after your children in your room. Priced per hour.',
    durationMinutes: 180, leadTimeHours: 4, availability: { days: EVERY_DAY, from: '08:00', to: '23:30' },
    questions: [
      { key: 'c_children_ages', type: 'SHORT_TEXT', label: "Children's ages", required: 'REQUIRED', placeholder: 'e.g. 4, 7', validation: { maxLength: 40 } },
      { key: 'c_allergies', type: 'SHORT_TEXT', label: 'Any allergies we should know about?', required: 'OPTIONAL', validation: { maxLength: 200 } },
    ],
  },
  {
    key: 'table', name: 'Table reservation in Victoria Island', sortOrder: 9, category: 'NIGHTLIFE_RESERVATIONS', pricing: 'FREE', location: 'OFF_PROPERTY', discreetEligible: true,
    description: 'We book a table for you at a Victoria Island restaurant or lounge we trust, and arrange the car if you like. No booking fee; you pay the venue.',
    leadTimeHours: 3, availability: { days: EVERY_DAY, from: '12:00', to: '23:00' },
    questions: [
      { key: 'c_venue', type: 'SELECT', label: 'What kind of place?', required: 'REQUIRED', options: opt([['FINE_DINING', 'Fine dining'], ['LOUNGE', 'Lounge'], ['ROOFTOP', 'Rooftop'], ['LIVE_MUSIC', 'Live music']]) },
      { key: 'c_guests', type: 'NUMBER', label: 'Number of guests', required: 'REQUIRED', validation: { min: 1, max: 20 } },
    ],
  },
  {
    key: 'photographer', name: 'Photographer (1-hour shoot)', sortOrder: 10, category: 'PHOTOGRAPHY', pricing: 'FIXED', priceNaira: 75_000, location: 'ON_PROPERTY', vendor: 'photo',
    description: 'A one-hour shoot at the hotel or nearby with a photographer from Lens & Light Studio; 25 edited photos within three days.',
    durationMinutes: 60, leadTimeHours: 24, availability: { days: EVERY_DAY, from: '07:00', to: '19:00' }, requiresSlot: true, slotCapacity: 1,
    questions: [
      { key: 'c_occasion', type: 'SELECT', label: 'Occasion', required: 'OPTIONAL', options: opt([['BIRTHDAY', 'Birthday'], ['COUPLE', 'Couple shoot'], ['FAMILY', 'Family'], ['BUSINESS', 'Business portraits']]) },
      { key: 'c_outfits', type: 'NUMBER', label: 'Number of outfits', required: 'OPTIONAL', validation: { min: 1, max: 5 } },
    ],
  },
  {
    key: 'laundry', name: 'Express laundry', sortOrder: 11, category: 'LAUNDRY_EXPRESS', pricing: 'FIXED', priceNaira: 12_000, location: 'IN_ROOM',
    description: 'Up to eight items washed, pressed and back in your room within four hours.', leadTimeHours: 0, availability: { days: EVERY_DAY, from: '07:00', to: '18:00' },
  },
  {
    key: 'fasttrack', name: 'Airport fast-track (protocol)', sortOrder: 12, category: 'TRANSPORT', pricing: 'FIXED', priceNaira: 45_000, location: 'OFF_PROPERTY',
    description: 'A protocol officer meets you at Murtala Muhammed International Airport and helps you through immigration, baggage and customs, or through check-in when you leave.',
    leadTimeHours: 24,
    questions: [
      { key: 'c_direction', type: 'SELECT', label: 'Arriving or leaving?', required: 'REQUIRED', options: opt([['ARRIVAL', 'Arriving'], ['DEPARTURE', 'Leaving']]) },
      { key: 'c_airline', type: 'SHORT_TEXT', label: 'Airline and flight number', required: 'REQUIRED', placeholder: 'e.g. Air Peace P4 7121', validation: { maxLength: 60 } },
    ],
  },
];

async function upsertVendors(prisma: PrismaClient, tenantId: string, propertyId: string, vendors: VendorSeed[]) {
  const out = new Map<string, { id: string; name: string; commissionType: string; commissionValue: number }>();
  for (const v of vendors) {
    const data = {
      category: v.category, contactName: v.contactName, phone: v.phone, whatsapp: v.phone, email: v.email,
      commissionType: v.commissionType, commissionValue: v.commissionValue, payoutNotes: v.payoutNotes, active: true,
      // Ratings are rebuilt from the seeded requests.
      ratingSum: 0, ratingCount: 0,
    };
    const row = await prisma.conciergeVendor.upsert({ where: { propertyId_name: { propertyId, name: v.name } }, create: { tenantId, propertyId, name: v.name, ...data }, update: data });
    out.set(v.key, row);
  }
  return out;
}

function like(s: ServiceSeed): ServiceLike {
  return {
    id: s.key,
    name: s.name,
    pricing: s.pricing,
    priceKobo: s.priceNaira ? s.priceNaira * NAIRA : null,
    variants: (s.variants ?? []).map((v) => ({ id: v.id, name: v.name, priceKobo: v.priceNaira * NAIRA, durationMinutes: v.durationMinutes })),
    durationMinutes: s.durationMinutes ?? null,
    leadTimeHours: s.leadTimeHours,
    availability: s.availability ?? null,
    requiresSlot: !!s.requiresSlot,
    slotCapacity: s.slotCapacity ?? null,
    taxable: true,
  };
}

async function upsertServices(prisma: PrismaClient, tenantId: string, propertyId: string, services: ServiceSeed[], vendors: Map<string, { id: string }>) {
  const out = new Map<string, { id: string; seed: ServiceSeed; questions: FormField[] }>();
  for (const s of services) {
    const questions = normaliseQuestions(s.questions ?? []);
    const variants: ServiceVariant[] = like(s).variants;
    const hit = screen([s.name, s.description, ...variants.map((v) => v.name), ...questions.flatMap((q) => [q.label, ...q.options.map((o) => o.label)])]);
    const data = {
      description: s.description,
      category: s.category,
      pricing: s.pricing,
      priceKobo: s.priceNaira ? s.priceNaira * NAIRA : null,
      variants: variants as unknown as Prisma.InputJsonValue,
      durationMinutes: s.durationMinutes ?? null,
      leadTimeHours: s.leadTimeHours,
      availability: (s.availability ?? null) as unknown as Prisma.InputJsonValue,
      requiresSlot: !!s.requiresSlot,
      slotCapacity: s.slotCapacity ?? (s.requiresSlot ? 1 : null),
      location: s.location,
      fulfilledBy: s.vendor ? 'VENDOR' : 'STAFF',
      vendorId: s.vendor ? vendors.get(s.vendor)!.id : null,
      discreetEligible: !!s.discreetEligible,
      questions: questions as unknown as Prisma.InputJsonValue,
      taxable: true,
      channels: s.channels ?? ['BOOKING_FLOW', 'TRIP_PAGE', 'FRONT_DESK'],
      active: true,
      sortOrder: s.sortOrder,
      reviewStatus: hit.flagged ? ('PENDING_REVIEW' as const) : ('LIVE' as const),
      flaggedTerms: hit.terms,
      flagMatches: hit.matches as unknown as Prisma.InputJsonValue,
      submittedAt: hit.flagged ? new Date(Date.now() - 5 * HOUR) : null,
      reviewReason: null,
      reviewedAt: null,
      reviewedByName: null,
    };
    const row = await prisma.conciergeService.upsert({ where: { propertyId_name: { propertyId, name: s.name } }, create: { tenantId, propertyId, name: s.name, ...data }, update: data });
    out.set(s.key, { id: row.id, seed: s, questions });
  }
  return out;
}

async function acceptPolicy(prisma: PrismaClient, tenantId: string, by: { id: string; fullName: string } | null, daysAgo: number) {
  const at = new Date(Date.now() - daysAgo * DAY);
  const data = { aupVersion: AUP_VERSION, aupAcceptedAt: at, aupAcceptedById: by?.id ?? null, aupAcceptedByName: by?.fullName ?? 'Owner', aupAcceptedIp: '102.89.34.12', suspendedAt: null, suspendedReason: null, suspendedByName: null };
  await prisma.conciergeAccount.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
}

async function enable(prisma: PrismaClient, tenantId: string, propertyId: string, intro: string) {
  const data = { enabled: true, intro, updatedByName: 'Seed' };
  await prisma.conciergeSettings.upsert({ where: { propertyId }, create: { tenantId, propertyId, ...data }, update: data });
}

/** Posts an EXTRA line and its tax lines to a folio (the ledger rules, seed-side). */
async function postLine(prisma: PrismaClient, tenantId: string, propertyId: string, folioId: string, description: string, enteredKobo: number, comps: TaxComponent[], at: Date, by: string | null) {
  const b = computeCharge(enteredKobo, comps);
  const base = { tenantId, propertyId, folioId, businessDate: dbDate(lagosDate(at)), createdById: by, createdAt: at };
  const main = await prisma.folioEntry.create({ data: { ...base, type: 'EXTRA', amountKobo: BigInt(b.netKobo), description } });
  for (const line of b.lines) {
    await prisma.folioEntry.create({
      data: { ...base, type: line.code === 'SERVICE_CHARGE' ? 'SERVICE_CHARGE' : 'TAX', amountKobo: BigInt(line.amountKobo), description: line.label, parentEntryId: main.id, taxCode: line.code, rateBps: line.rateBps, inclusive: line.inclusive },
    });
  }
  return main.id;
}

type Stay = Reservation & { guest: { id: string; fullName: string; phone: string | null; email: string | null }; folio: { id: string; status: string } | null; room: { number: string } | null };

interface RequestPlan {
  service: string | null;
  stay: Stay;
  status: Prisma.ConciergeRequestCreateInput['status'];
  source: 'BOOKING_FLOW' | 'TRIP_PAGE' | 'WHATSAPP' | 'FRONT_DESK';
  createdAgoMin: number;
  variantId?: string;
  answers?: Record<string, unknown>;
  requestText?: string;
  notes?: string;
  start?: Date;
  partySize?: number;
  hours?: number;
  discreet?: boolean;
  contact?: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'IN_APP';
  payment?: 'FOLIO' | 'ONLINE' | 'NONE';
  post?: boolean;
  quoteNaira?: number;
  quoteNote?: string;
  assignee?: { id: string; fullName: string } | null;
  vendor?: string;
  vendorSentAgoMin?: number;
  respondedAfterMin?: number;
  rating?: [number, string | null];
  vendorRating?: number;
  cancelReason?: string;
  declineReason?: string;
  flagged?: boolean;
  internalNotes?: string;
}

/** Palmwine (Lekki): policy, settings, vendors, services and today's requests. */
export async function seedM8(prisma: PrismaClient, passwordHash: string): Promise<Record<string, number>> {
  const counts = { services: 0, vendors: 0, requests: 0, pendingReview: 0 };
  const webUrl = process.env.WEB_URL ?? 'http://localhost:3000';
  const lekki = await prisma.property.findUnique({ where: { slug: 'palmwine-house' } });
  if (lekki) {
    const tenantId = lekki.tenantId;
    const owner = await prisma.user.findFirst({ where: { tenantId, role: 'OWNER' }, orderBy: { createdAt: 'asc' } });
    await acceptPolicy(prisma, tenantId, owner, 12);
    await enable(prisma, tenantId, lekki.id, 'Tell us what would make your stay special: a massage, a private dinner, a car for the day. Only the concierge team sees your requests.');
    // Amaka, the concierge (Lekki only).
    const amaka = await prisma.user.upsert({
      where: { email: 'amaka@palmwine.ng' },
      create: { tenantId, email: 'amaka@palmwine.ng', fullName: 'Amaka Nwosu', phone: '+2348185550111', role: 'CONCIERGE', passwordHash, createdAt: new Date(Date.now() - 20 * DAY) },
      update: { tenantId, fullName: 'Amaka Nwosu', phone: '+2348185550111', role: 'CONCIERGE', passwordHash, isActive: true, customRoleId: null },
    });
    await prisma.userPropertyAccess.deleteMany({ where: { userId: amaka.id } });
    await prisma.user.update({ where: { id: amaka.id }, data: { allProperties: false, defaultPropertyId: lekki.id } });
    await prisma.userPropertyAccess.create({ data: { tenantId, userId: amaka.id, propertyId: lekki.id } });

    const vendors = await upsertVendors(prisma, tenantId, lekki.id, PALMWINE_VENDORS);
    const services = await upsertServices(prisma, tenantId, lekki.id, PALMWINE_SERVICES, vendors);
    counts.vendors += vendors.size;
    counts.services += services.size;

    // Today's requests on real stays (the operations seed rebuilt them).
    const include = { guest: { select: { id: true, fullName: true, phone: true, email: true } }, folio: { select: { id: true, status: true } }, room: { select: { number: true } } } as const;
    const inHouse = (await prisma.reservation.findMany({ where: { propertyId: lekki.id, status: 'CHECKED_IN' }, include, orderBy: { arrivalAt: 'asc' } })) as Stay[];
    const upcoming = (await prisma.reservation.findMany({ where: { propertyId: lekki.id, status: 'CONFIRMED', arrivalAt: { gt: new Date() } }, include, orderBy: { arrivalAt: 'asc' }, take: 4 })) as Stay[];
    const withPhone = inHouse.filter((s) => s.guest.phone && s.folio?.status === 'OPEN');
    if (withPhone.length >= 6 && upcoming.length >= 2) {
      const g = (i: number) => withPhone[i % withPhone.length]!;
      const today = lagosDate();
      const at = (date: string, time: string) => lagosDateTime(date, time);
      const tomorrow = addDays(today, 1);
      const yesterday = addDays(today, -1);
      const plans: RequestPlan[] = [
        { service: 'photographer', stay: g(0), status: 'COMPLETED', source: 'TRIP_PAGE', createdAgoMin: 30 * 60, start: at(yesterday, '16:00'), partySize: 2, answers: { c_occasion: 'COUPLE', c_outfits: 2 }, contact: 'WHATSAPP', payment: 'FOLIO', post: true, vendor: 'photo', vendorSentAgoMin: 29 * 60, respondedAfterMin: 6, rating: [5, 'Kemi was brilliant and the photos came back the next morning.'], vendorRating: 5, assignee: amaka },
        { service: 'massage', stay: g(1), status: 'COMPLETED', source: 'TRIP_PAGE', createdAgoMin: 26 * 60, variantId: '90-minutes', start: at(yesterday, '20:00'), answers: { c_massage_type: 'DEEP_TISSUE', c_therapist_preference: 'FEMALE', c_pressure: 'FIRM' }, discreet: true, contact: 'WHATSAPP', payment: 'FOLIO', post: true, vendor: 'spa', vendorSentAgoMin: 25 * 60, respondedAfterMin: 4, rating: [5, null], vendorRating: 4, assignee: amaka },
        { service: 'table', stay: g(2), status: 'CANCELLED', source: 'TRIP_PAGE', createdAgoMin: 22 * 60, start: at(yesterday, '21:00'), answers: { c_venue: 'ROOFTOP', c_guests: 3 }, contact: 'SMS', payment: 'NONE', respondedAfterMin: 9, cancelReason: 'Cancelled by the guest' },
        { service: 'laundry', stay: g(3), status: 'IN_PROGRESS', source: 'TRIP_PAGE', createdAgoMin: 80, contact: 'WHATSAPP', payment: 'FOLIO', respondedAfterMin: 0, notes: 'Two agbada and three shirts, please press the shirts lightly.' },
        { service: 'tour', stay: g(4), status: 'SCHEDULED', source: 'TRIP_PAGE', createdAgoMin: 5 * 60, start: at(tomorrow, '10:00'), partySize: 2, answers: { c_language: 'ENGLISH' }, contact: 'EMAIL', payment: 'FOLIO', vendor: 'tours', vendorSentAgoMin: 4 * 60, respondedAfterMin: 11, assignee: amaka },
        { service: 'barber', stay: g(5), status: 'CONFIRMED', source: 'FRONT_DESK', createdAgoMin: 3 * 60, start: at(today, '18:00'), answers: { c_cut: 'BOTH' }, contact: 'SMS', payment: 'FOLIO', respondedAfterMin: 0, assignee: amaka },
        { service: 'car', stay: upcoming[0]!, status: 'AWAITING_GUEST', source: 'BOOKING_FLOW', createdAgoMin: 2 * 60, variantId: 'full-day', start: at(addDays(lagosDate(upcoming[0]!.arrivalAt), 1), '08:00'), answers: { c_vehicle: 'SUV', c_destination: 'Meetings in Victoria Island, then the Lekki Arts and Crafts Market' }, contact: 'EMAIL', payment: 'ONLINE', respondedAfterMin: 0, vendor: 'car' },
        { service: 'chef', stay: g(6), status: 'QUOTED', source: 'TRIP_PAGE', createdAgoMin: 95, start: at(tomorrow, '19:30'), answers: { c_cuisine: 'NIGERIAN', c_guests: 4, c_dietary: ['NO_PORK'], c_occasion: 'BIRTHDAY' }, contact: 'WHATSAPP', quoteNaira: 180_000, quoteNote: 'Three courses: pepper soup, ofada rice with ayamase and grilled croaker, then a coconut and lime tart. Chef Tobi will arrive at 17:30 to set up.', respondedAfterMin: 18, vendor: 'chef', assignee: amaka },
        { service: null, stay: g(7), status: 'NEW', source: 'TRIP_PAGE', createdAgoMin: 8, requestText: 'Could you arrange a surprise proposal on the rooftop terrace tomorrow evening: a violinist for 20 minutes and a small table with flowers? Please keep it quiet.', discreet: true, contact: 'WHATSAPP' },
        { service: null, stay: g(8), status: 'NEW', source: 'TRIP_PAGE', createdAgoMin: 45, requestText: 'Please could you find a tailor to take in the waist of a kaftan before Friday?', contact: 'SMS' },
        { service: null, stay: g(9), status: 'NEW', source: 'WHATSAPP', createdAgoMin: 12, requestText: 'Please could you find us some weed for tonight? Thank you.', contact: 'WHATSAPP', flagged: true },
        { service: 'massage', stay: upcoming[1]!, status: 'CONFIRMED', source: 'BOOKING_FLOW', createdAgoMin: 6 * 60, variantId: '60-minutes', start: at(lagosDate(upcoming[1]!.arrivalAt), '19:00'), answers: { c_massage_type: 'SWEDISH', c_therapist_preference: 'NO_PREFERENCE' }, contact: 'WHATSAPP', payment: 'FOLIO', respondedAfterMin: 0, vendor: 'spa' },
        { service: 'babysitting', stay: g(2), status: 'DECLINED', source: 'TRIP_PAGE', createdAgoMin: 7 * 60, start: at(today, '23:00'), hours: 3, answers: { c_children_ages: '3, 6' }, contact: 'SMS', respondedAfterMin: 7, declineReason: 'Our sitters work until 23:30, so we cannot cover 23:00 to 02:00. We can do 20:00 to 23:00 instead.' },
      ];
      counts.requests += await buildRequests(prisma, { tenantId, propertyId: lekki.id, services, vendors, webUrl, plans });
    }
  }

  // Eko Tides (Growth): policy accepted, one live service and a lawful security escort the word "escort" sends to review.
  const eko = await prisma.property.findUnique({ where: { slug: 'eko-tides' } });
  if (eko) {
    const owner = await prisma.user.findFirst({ where: { tenantId: eko.tenantId, role: 'OWNER' } });
    await acceptPolicy(prisma, eko.tenantId, owner, 3);
    await enable(prisma, eko.tenantId, eko.id, 'Beach days, dinners and drivers: ask and we will arrange it.');
    const svc = await upsertServices(prisma, eko.tenantId, eko.id, [
      { key: 'cabana', name: 'Beach cabana for the day', sortOrder: 1, category: 'TOURS_AND_EXPERIENCES', pricing: 'FIXED', priceNaira: 30_000, location: 'ON_PROPERTY', description: 'A shaded cabana on our beach with loungers, towels, chilled water and a fruit platter.', leadTimeHours: 12, availability: { days: EVERY_DAY, from: '08:00', to: '18:00' } },
      { key: 'escort', name: 'Police escort for the airport run', sortOrder: 2, category: 'SECURITY', pricing: 'FIXED', priceNaira: 85_000, location: 'OFF_PROPERTY', description: 'A licensed security company provides a marked escort vehicle with police officers for the drive between Murtala Muhammed International Airport and the hotel. Arranged a day ahead.', leadTimeHours: 24 },
    ], new Map());
    counts.services += svc.size;
    counts.pendingReview += [...svc.values()].filter((s) => s.seed.key === 'escort').length;
  }

  // Harmattan while it still lives in the shared database (copied on provisioning).
  const hh = await prisma.tenant.findUnique({ where: { slug: 'harmattan' } });
  const moved = hh ? (await prisma.tenantDatabase.findUnique({ where: { tenantId: hh.id } }))?.mode === 'DEDICATED' : false;
  if (hh && !moved) {
    const r = await seedM8Harmattan(prisma, hh.id);
    counts.services += r.services;
    counts.vendors += r.vendors;
    counts.requests += r.requests;
  }
  return counts;
}

async function buildRequests(
  prisma: PrismaClient,
  ctx: {
    tenantId: string;
    propertyId: string;
    services: Map<string, { id: string; seed: ServiceSeed; questions: FormField[] }>;
    vendors: Map<string, { id: string; name: string; commissionType: string; commissionValue: number }>;
    webUrl: string;
    plans: RequestPlan[];
  },
): Promise<number> {
  const { tenantId, propertyId } = ctx;
  await prisma.$executeRawUnsafe(`DELETE FROM concierge_payments WHERE property_id = $1::uuid`, propertyId);
  await prisma.$executeRawUnsafe(`DELETE FROM concierge_requests WHERE property_id = $1::uuid`, propertyId);
  const comps = await taxComponents(prisma, propertyId);
  const sla = { slaInStayMinutes: 15, slaPreArrivalMinutes: 120, escalateAfterMinutes: 0 };
  const order = [...ctx.plans].sort((a, b) => b.createdAgoMin - a.createdAgoMin);
  let seq = 0;
  for (const p of order) {
    seq++;
    const number = formatNumber(seq);
    const created = new Date(Date.now() - p.createdAgoMin * MIN);
    const svc = p.service ? ctx.services.get(p.service)! : null;
    const s = svc?.seed ?? null;
    const variant = s?.variants?.find((v) => v.id === p.variantId) ?? null;
    const price = s && s.pricing !== 'FROM' ? priceService(like(s), { variantId: p.variantId, partySize: p.partySize, hours: p.hours }, comps).price : null;
    const quote = p.quoteNaira ? quotePrice(p.quoteNaira * NAIRA, true, comps, s?.name ?? 'Request') : null;
    const charge = quote ?? price;
    const target = p.stay.status === 'CHECKED_IN' ? 'IN_STAY' : 'PRE_ARRIVAL';
    const responded = p.respondedAfterMin !== undefined ? new Date(created.getTime() + p.respondedAfterMin * MIN) : null;
    const vendor = p.vendor ? ctx.vendors.get(p.vendor)! : null;
    const title = s?.name ?? 'Something else';
    const tl: { at: string; type: string; status: string | null; note: string | null; by: string | null; guestVisible: boolean }[] = [
      { at: created.toISOString(), type: 'created', status: 'NEW', note: p.source === 'WHATSAPP' ? 'From a WhatsApp message' : null, by: p.source === 'FRONT_DESK' ? 'Ngozi Eze' : 'Guest', guestVisible: true },
    ];
    const ev = (minAfter: number, type: string, status: string | null, note: string | null, by: string, guestVisible = true) => tl.push({ at: new Date(created.getTime() + minAfter * MIN).toISOString(), type, status, note, by, guestVisible });
    if (p.flagged) ev(0, 'flagged', null, 'Held for review: weed', 'Content screen', false);
    if (quote) ev(p.respondedAfterMin ?? 15, 'quote_sent', 'QUOTED', `Your price: N${(quote.totalKobo / 100).toLocaleString('en-NG')}, held until ${humanDateTime(new Date(created.getTime() + 24 * HOUR))}`, 'Amaka Nwosu');
    if (['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED'].includes(p.status as string)) ev(p.respondedAfterMin ?? 0, 'status', 'CONFIRMED', p.payment === 'FOLIO' ? 'Added to your bill' : null, p.respondedAfterMin ? 'Amaka Nwosu' : 'Automatic');
    if (p.status === 'AWAITING_GUEST') ev(0, 'status', 'AWAITING_GUEST', 'Pay online to confirm', 'Automatic');
    if (vendor && p.vendorSentAgoMin !== undefined) tl.push({ at: new Date(Date.now() - p.vendorSentAgoMin * MIN).toISOString(), type: 'vendor_sent', status: null, note: `Job sent to ${vendor.name} by WhatsApp`, by: 'Amaka Nwosu', guestVisible: false });
    if (['SCHEDULED', 'IN_PROGRESS', 'COMPLETED'].includes(p.status as string) && p.start) ev((p.respondedAfterMin ?? 0) + 5, 'status', 'SCHEDULED', `Booked in for ${humanDateTime(p.start)}`, 'Amaka Nwosu');
    if (p.status === 'IN_PROGRESS') tl.push({ at: new Date(Date.now() - 50 * MIN).toISOString(), type: 'status', status: 'IN_PROGRESS', note: 'Your request is under way.', by: 'Blessing Nwachukwu', guestVisible: true });
    const completedAt = p.status === 'COMPLETED' && p.start ? new Date(p.start.getTime() + ((variant?.durationMinutes ?? s?.durationMinutes ?? 60) + 10) * MIN) : null;
    if (completedAt) tl.push({ at: completedAt.toISOString(), type: 'status', status: 'COMPLETED', note: null, by: 'Amaka Nwosu', guestVisible: true });
    if (p.rating && completedAt) tl.push({ at: new Date(completedAt.getTime() + 3 * HOUR).toISOString(), type: 'rated', status: null, note: `Rated ${p.rating[0]} of 5`, by: 'Guest', guestVisible: false });
    if (p.cancelReason) ev(p.respondedAfterMin! + 60, 'status', 'CANCELLED', 'You cancelled this request', 'Guest');
    if (p.declineReason) ev(p.respondedAfterMin!, 'status', 'DECLINED', p.declineReason, 'Amaka Nwosu');
    const folioLabel = p.discreet ? `${s?.location === 'IN_ROOM' ? 'In-room service' : 'Guest service'} (${number})` : `${variant ? `${title}, ${variant.name}` : title} (${number})`;
    let folioEntryId: string | null = null;
    if (p.post && charge && p.stay.folio?.status === 'OPEN' && completedAt) {
      folioEntryId = await postLine(prisma, tenantId, propertyId, p.stay.folio.id, folioLabel, charge.amountKobo, comps, completedAt, null);
    }
    const commission = vendor && folioEntryId && charge && vendor.commissionType !== 'NONE'
      ? (() => {
          const c = vendor.commissionType === 'PERCENT' ? Math.round((charge.netKobo * vendor.commissionValue) / 10_000) : Math.min(vendor.commissionValue, charge.netKobo);
          return { commissionKobo: c, vendorPayableKobo: charge.netKobo - c };
        })()
      : null;
    const row = await prisma.conciergeRequest.create({
      data: {
        tenantId,
        propertyId,
        seq,
        number,
        reservationId: p.stay.id,
        guestId: p.stay.guestId,
        serviceId: svc?.id ?? null,
        serviceName: title,
        category: s?.category ?? 'OTHER',
        pricing: s?.pricing ?? null,
        location: s?.location ?? null,
        variantId: variant?.id ?? null,
        variantName: variant?.name ?? null,
        hours: p.hours ?? null,
        questions: (svc?.questions ?? []) as unknown as Prisma.InputJsonValue,
        answers: (p.answers ?? {}) as Prisma.InputJsonValue,
        requestText: p.requestText ?? null,
        preferredStart: p.start ?? null,
        preferredEnd: p.start ? new Date(p.start.getTime() + (variant?.durationMinutes ?? s?.durationMinutes ?? 60) * MIN) : null,
        partySize: p.partySize ?? null,
        notes: p.notes ?? null,
        internalNotes: p.internalNotes ?? null,
        discreet: !!p.discreet,
        contactPreference: p.contact ?? 'SMS',
        contactPhone: p.stay.guest.phone,
        contactEmail: p.stay.guest.email,
        status: p.status,
        source: p.source,
        flagged: !!p.flagged,
        flagTerms: p.flagged ? ['weed'] : [],
        flagCategories: p.flagged ? ['DRUGS'] : [],
        flagStatus: p.flagged ? 'PENDING' : null,
        ...(price && { priceAmountKobo: price.amountKobo, priceNetKobo: price.netKobo, priceTaxKobo: price.taxKobo, priceTaxes: price.taxes as unknown as Prisma.InputJsonValue, priceDescription: price.description }),
        taxComponents: comps as unknown as Prisma.InputJsonValue,
        ...(quote && {
          quoteVersion: 1,
          quoteAmountKobo: quote.amountKobo,
          quoteNetKobo: quote.netKobo,
          quoteTaxKobo: quote.taxKobo,
          quoteTaxes: quote.taxes as unknown as Prisma.InputJsonValue,
          quoteValidUntil: new Date(created.getTime() + 24 * HOUR),
          quoteNote: p.quoteNote ?? null,
          quoteSentAt: responded,
          quoteSentByName: 'Amaka Nwosu',
          quoteChannel: 'WHATSAPP',
        }),
        paymentMethod: p.payment === 'ONLINE' ? 'ONLINE' : (p.payment ?? null),
        paymentStatus: folioEntryId ? 'POSTED' : p.payment === 'ONLINE' ? 'PENDING' : 'NONE',
        folioId: folioEntryId ? p.stay.folio!.id : null,
        folioEntryId,
        postedAt: folioEntryId ? completedAt : null,
        folioDescription: folioEntryId ? folioLabel : null,
        assigneeId: p.assignee?.id ?? null,
        assigneeName: p.assignee?.fullName ?? null,
        vendorId: vendor?.id ?? null,
        vendorName: vendor?.name ?? null,
        vendorSentAt: vendor && p.vendorSentAgoMin !== undefined ? new Date(Date.now() - p.vendorSentAgoMin * MIN) : null,
        vendorSentVia: vendor && p.vendorSentAgoMin !== undefined ? 'WHATSAPP' : null,
        ...(vendor && vendor.commissionType !== 'NONE' && { commissionType: vendor.commissionType, commissionValue: vendor.commissionValue }),
        ...commission,
        slaTarget: target,
        slaDueAt: slaDueAt(created, target, sla),
        firstResponseAt: responded,
        scheduledAt: ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED'].includes(p.status as string) ? (p.start ?? null) : null,
        startedAt: p.status === 'IN_PROGRESS' ? new Date(Date.now() - 50 * MIN) : completedAt && p.start ? p.start : null,
        completedAt,
        cancelledAt: p.cancelReason ? new Date(created.getTime() + (p.respondedAfterMin! + 60) * MIN) : null,
        cancelReason: p.cancelReason ?? null,
        declineReason: p.declineReason ?? null,
        rating: p.rating?.[0] ?? null,
        ratingComment: p.rating?.[1] ?? null,
        ratedAt: p.rating && completedAt ? new Date(completedAt.getTime() + 3 * HOUR) : null,
        vendorRating: p.vendorRating ?? null,
        timeline: tl.sort((a, b) => a.at.localeCompare(b.at)) as unknown as Prisma.InputJsonValue,
        createdByName: p.source === 'FRONT_DESK' ? 'Ngozi Eze' : null,
        createdAt: created,
      },
    });
    if (p.payment === 'ONLINE' && charge) {
      const reference = `CRQ_seed${String(seq).padStart(4, '0')}${propertyId.slice(0, 8)}`;
      await prisma.conciergePayment.create({
        data: { tenantId, propertyId, requestId: row.id, reference, amountKobo: charge.totalKobo, email: p.stay.guest.email ?? 'guest@example.ng', authorizationUrl: `${ctx.webUrl}/pay/mock?reference=${reference}&kind=concierge` },
      });
      await prisma.conciergeRequest.update({ where: { id: row.id }, data: { paymentReference: reference } });
    }
    if (vendor && p.vendorRating) await prisma.conciergeVendor.update({ where: { id: vendor.id }, data: { ratingSum: { increment: p.vendorRating }, ratingCount: { increment: 1 } } });
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO document_counters (tenant_id, kind, year, scope, last_value) VALUES ($1::uuid, 'CONCIERGE_REQUEST', 0, $2, $3)
     ON CONFLICT (tenant_id, kind, year, scope) DO UPDATE SET last_value = EXCLUDED.last_value`,
    tenantId,
    propertyId,
    seq,
  );
  return order.length;
}

/** Harmattan Abuja (Enterprise, dedicated database): a smaller catalogue and two requests. */
export async function seedM8Harmattan(prisma: PrismaClient, tenantId: string): Promise<{ services: number; vendors: number; requests: number }> {
  const abuja = await prisma.property.findFirst({ where: { tenantId, slug: 'harmattan-abuja' } });
  if (!abuja) return { services: 0, vendors: 0, requests: 0 };
  const owner = await prisma.user.findFirst({ where: { tenantId, role: 'OWNER' } });
  await acceptPolicy(prisma, tenantId, owner, 30);
  await enable(prisma, tenantId, abuja.id, 'Our concierge desk can arrange drivers, city tours and business services across Abuja.');
  const vendors = await upsertVendors(prisma, tenantId, abuja.id, [
    { key: 'car', name: 'Capital Chauffeurs Ltd', category: 'TRANSPORT', contactName: 'Ibrahim Bello', phone: '+2348095550401', email: 'dispatch@capitalchauffeurs.ng', commissionType: 'PERCENT', commissionValue: 1000, payoutNotes: 'Monthly statement, paid by transfer.' },
  ]);
  const services = await upsertServices(prisma, tenantId, abuja.id, [
    { key: 'massage', name: 'In-room massage', sortOrder: 1, category: 'WELLNESS', pricing: 'FIXED', priceNaira: 40_000, durationMinutes: 60, location: 'IN_ROOM', discreetEligible: true, description: 'A 60-minute massage in your room by a licensed therapist.', leadTimeHours: 3, availability: { days: EVERY_DAY, from: '10:00', to: '21:00' }, requiresSlot: true, slotCapacity: 1 },
    { key: 'car', name: 'Car with driver', sortOrder: 2, category: 'TRANSPORT', pricing: 'FIXED', location: 'OFF_PROPERTY', vendor: 'car', description: 'A chauffeur-driven car for meetings across Abuja: Maitama, Wuse, the Central Business District.', variants: [{ id: 'half-day', name: 'Half day (5 hours)', priceNaira: 60_000, durationMinutes: 300 }, { id: 'full-day', name: 'Full day (10 hours)', priceNaira: 100_000, durationMinutes: 600 }], leadTimeHours: 4 },
    { key: 'tour', name: 'Abuja city tour', sortOrder: 3, category: 'TOURS_AND_EXPERIENCES', pricing: 'PER_PERSON', priceNaira: 30_000, location: 'OFF_PROPERTY', description: 'Aso Rock viewpoint, the National Mosque and National Christian Centre, Millennium Park and sunset at Jabi Lake.', durationMinutes: 240, leadTimeHours: 24, availability: { days: [0, 5, 6], from: '09:00', to: '15:00' } },
    { key: 'laundry', name: 'Express laundry', sortOrder: 4, category: 'LAUNDRY_EXPRESS', pricing: 'FIXED', priceNaira: 14_000, location: 'IN_ROOM', description: 'Up to eight items back within four hours.', leadTimeHours: 0 },
    { key: 'printing', name: 'Business centre printing', sortOrder: 5, category: 'BUSINESS', pricing: 'FROM', priceNaira: 2_000, location: 'ON_PROPERTY', description: 'Printing, binding and scanning for your meetings, delivered to your room or the meeting room.', leadTimeHours: 1 },
  ], vendors);
  await prisma.$executeRawUnsafe(`DELETE FROM concierge_payments WHERE property_id = $1::uuid`, abuja.id);
  await prisma.$executeRawUnsafe(`DELETE FROM concierge_requests WHERE property_id = $1::uuid`, abuja.id);
  const include = { guest: { select: { id: true, fullName: true, phone: true, email: true } }, folio: { select: { id: true, status: true } }, room: { select: { number: true } } } as const;
  const stays = (await prisma.reservation.findMany({ where: { propertyId: abuja.id, status: { in: ['CHECKED_IN', 'CONFIRMED'] } }, include, orderBy: { arrivalAt: 'asc' }, take: 2 })) as Stay[];
  let n = 0;
  if (stays.length) {
    const today = lagosDate();
    n = await buildRequests(prisma, {
      tenantId,
      propertyId: abuja.id,
      services,
      vendors,
      webUrl: process.env.WEB_URL ?? 'http://localhost:3000',
      plans: [
        { service: 'car', stay: stays[0]!, status: 'CONFIRMED', source: 'FRONT_DESK', createdAgoMin: 4 * 60, variantId: 'half-day', start: lagosDateTime(addDays(today, 1), '09:00'), contact: 'SMS', payment: stays[0]!.folio?.status === 'OPEN' ? 'FOLIO' : 'NONE', respondedAfterMin: 0, vendor: 'car' },
        { service: 'printing', stay: stays[stays.length - 1]!, status: 'NEW', source: 'TRIP_PAGE', createdAgoMin: 25, contact: 'EMAIL', notes: 'Twenty copies of a 30-page report, spiral bound, before 8am tomorrow.' },
      ],
    });
  }
  return { services: services.size, vendors: vendors.size, requests: n };
}
