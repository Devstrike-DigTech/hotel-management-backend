/**
 * M2 demo data for The Palmwine House: 30 days of stays, folios, payments,
 * cashier shifts, invoices, receipts, Revenue Guard flags, night audit runs,
 * daily statistics and owner digests, plus a live "today" (arrivals, guests
 * in house, departures, a day-use stay and an open cashier shift).
 *
 * Everything is generated relative to the moment the seed runs, from a fixed
 * pseudo-random sequence, so every run produces the same shape of data. The
 * demo hotel's operational rows are rebuilt on each run (see resetTenant).
 * All people, phone numbers and ID numbers are fictional.
 */
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import type {
  FolioEntry,
  Guest,
  Prisma,
  PrismaClient,
  Reservation,
  Room,
  RoomType,
} from '../../src/generated/prisma/client.js';
import type {
  GuardRule,
  GuardSeverity,
  GuardStatus,
  PaymentMethod,
  ReservationSource,
  ReservationStatus,
  StayType,
  VisitPurpose,
} from '../../src/generated/prisma/enums.js';
import { FieldCipher, last4Of } from '../../src/common/crypto/field-cipher.js';
import {
  addDays,
  dateRange,
  dbDate,
  humanDate,
  lagosDate,
  roomNightLabel,
  lagosDateTime,
  lagosYear,
} from '../../src/common/time/lagos.js';
import { CODE_ALPHABET } from '../../src/common/utils/codes.js';
import { renderDigest, type DigestData } from '../../src/modules/digest/digest.render.js';
import { componentsFrom, computeCharge } from '../../src/modules/folios/tax.logic.js';
import {
  buildInvoiceDocument,
  buildReceiptDocument,
  type HotelHeader,
} from '../../src/modules/invoices/document.builder.js';
import { computeDailyFlashes, finalise, type DailyFlash } from '../../src/modules/reports/stats.compute.js';
import { expectedTotals, variance } from '../../src/modules/shifts/shift.logic.js';

export const DEMO_PINS: Record<string, string> = {
  'demo@palmwine.ng': '2468',
  'tunde@palmwine.ng': '1357',
};


/** M2 desk reservations: the M3 online-booking columns keep their defaults. */
type SeedReservation = Omit<
  Reservation,
  | 'paymentMode'
  | 'guaranteeType'
  | 'holdExpiresAt'
  | 'commissionBps'
  | 'quotedTotalKobo'
  | 'quoteRef'
  | 'quote'
  | 'contactPhone'
  | 'contactEmail'
  | 'specialRequests'
  | 'guestAccountId'
  | 'cancelledBy'
  | 'cancellationFeeKobo'
  // M4 columns: the growth seed sets the rate plan and per-night snapshot afterwards.
  | 'ratePlanId'
  | 'promoCodeId'
  | 'corporateAccountId'
  | 'nightlyRates'
  | 'cancelPolicy'
  // M5 columns: the Pro seed sets OTA bookings, arrival times and points.
  | 'otaChannel'
  | 'otaRef'
  | 'otaCommissionKobo'
  | 'overbooked'
  | 'expectedArrivalTime'
  | 'loyaltyPoints'
>;
const MIN = 60_000;
const HOUR = 60 * MIN;

// Deterministic PRNG (mulberry32) so repeated seeds look the same.
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GUEST_NAMES = [
  'Chukwuemeka Nwosu', 'Aisha Bello', 'Olumide Adebayo', 'Ifeoma Okeke', 'Babajide Ogunleye', 'Zainab Yusuf',
  'Emeka Obi', 'Folasade Ajayi', 'Ibrahim Danjuma', 'Chiamaka Eze', 'Segun Oyelaran', 'Hauwa Abdullahi',
  'Kelechi Uzor', 'Temitope Balogun', 'Musa Garba', 'Adaora Nnaji', 'Oluwaseun Akinola', 'Fatima Sani',
  'Uchenna Okafor', 'Bukola Adewale', 'Nnamdi Chukwu', 'Hadiza Mohammed', 'Tobi Fashola', 'Ngozi Onyeka',
  'Yakubu Aliyu', 'Funke Oladipo', 'Obinna Madu', 'Amina Suleiman', 'Kunle Ade', 'Ebere Anozie',
  'Rotimi Coker', 'Maryam Lawal', 'Chidi Ekwueme', 'Yetunde Salami', 'Abubakar Tanko', 'Nkechi Agu',
  'Damilola Ige', 'Bilkisu Umar', 'Ikenna Nwachukwu', 'Titilayo Bankole', 'Efosa Osagie', 'Ese Omoregie',
  'Tamuno Briggs', 'Ekaette Udo', 'Otobong Essien', 'Ngozika Ibe', 'Femi Adeyinka', 'Halima Waziri',
];
const CITIES = ['Abuja', 'Port Harcourt', 'Ibadan', 'Enugu', 'Kano', 'Benin City', 'Calabar', 'Owerri', 'Abeokuta', 'Kaduna', 'Uyo', 'Accra', 'London'];
const COMPANIES = ['Zenith Oil Services Ltd', 'Kanem Logistics', 'Ashbury Legal LP', 'Delta Agro Foods', 'Crestview Telecoms', null, null, null, null, null];
const EXTRAS: [string, number][] = [
  ['Restaurant: jollof rice and grilled croaker', 1_250_000],
  ['Laundry: 5 items', 600_000],
  ['Airport pickup (MMIA)', 2_500_000],
  ['Minibar', 450_000],
  ['Restaurant: pepper soup and chapman', 850_000],
  ['Late checkout (2 hours)', 1_000_000],
];
const SOURCES: ReservationSource[] = ['WALK_IN', 'PHONE', 'WHATSAPP', 'BOOKING_SITE', 'MARKETPLACE', 'CORPORATE', 'OTA'];
const PURPOSES: VisitPurpose[] = ['BUSINESS', 'BUSINESS', 'LEISURE', 'EVENT', 'TRANSIT', 'LEISURE'];

type Kind = 'history' | 'outToday' | 'inHouse' | 'departToday' | 'arriveToday' | 'future' | 'dayUseHistory' | 'dayUseToday' | 'noShow' | 'cancelled';

interface Plan {
  kind: Kind;
  room: string | null;
  type: string;
  arrival: string; // Lagos date
  departure: string; // Lagos date (NIGHTLY) - ignored for day use
  guest: number;
  arrivalAt?: Date;
  departureAt?: Date;
  source?: ReservationSource;
  rateKobo?: number;
  status?: ReservationStatus;
  notes?: string;
  paid?: 'full' | 'owing' | 'deposit' | 'none';
  lateRegistration?: boolean;
  corporateLedger?: boolean;
  voidDuplicate?: boolean;
  approvedDiscount?: boolean;
  smallDiscount?: boolean;
  extra?: boolean;
}

interface Ctx {
  prisma: PrismaClient;
  tenantId: string;
  propertyId: string;
  now: Date;
  today: string;
  rand: () => number;
  users: Map<string, { id: string; fullName: string }>;
  rooms: Map<string, Room>;
  types: Map<string, RoomType>;
  hotel: HotelHeader;
}

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

/** Wipes the demo tenant's operational (M2) rows so the seed can rebuild them. */
async function resetTenant(prisma: PrismaClient, tenantId: string) {
  await prisma.$transaction(async (tx) => {
    // Seed-only: replica mode skips the append-only triggers for this transaction.
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    for (const table of [
      // M3 rows hang off reservations; the guest-side seed rebuilds them after this.
      // M4 rows that reference reservations, rooms or folios; the growth seed rebuilds them.
      'city_ledger_allocations', 'city_ledger_payments', 'city_ledger_charges', 'city_ledger_invoices',
      'promo_redemptions', 'guard_alerts', 'room_blocks', 'maintenance_ticket_events', 'maintenance_tickets',
      'lost_found_items',
      'notification_logs', 'reviews', 'commission_entries', 'booking_refunds', 'booking_payments',
      'idempotency_keys', 'guard_flags', 'owner_digests', 'daily_stats', 'night_audit_runs',
      'housekeeping_tasks', 'receipts', 'guest_invoices', 'folio_entries', 'folios', 'cashier_shifts',
      'reservations', 'guests', 'document_counters', 'tax_settings', 'digest_settings',
    ]) {
      await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, tenantId);
    }
  });
}

export async function seedOperations(prisma: PrismaClient, tenantSlug: string, appName: string): Promise<Record<string, number>> {
  const key = process.env.GUEST_DATA_KEY;
  if (!key) throw new Error('GUEST_DATA_KEY must be set to seed guest ID numbers');
  const cipher = new FieldCipher(key);

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } });
  const property = await prisma.property.findFirstOrThrow({ where: { tenantId: tenant.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  await resetTenant(prisma, tenant.id);

  const now = new Date();
  const ctx: Ctx = {
    prisma,
    tenantId: tenant.id,
    propertyId: property.id,
    now,
    today: lagosDate(now),
    rand: prng(20260923),
    users: new Map(),
    rooms: new Map(),
    types: new Map(),
    hotel: {
      name: property.name,
      address: property.address,
      area: property.area,
      city: property.city,
      state: property.state,
      phone: property.phone,
      email: property.email,
      logoUrl: property.logoUrl,
      accentColor: property.accentColor,
      appName,
    },
  };
  const T = ctx.today;
  const at = (date: string, time: string) => lagosDateTime(date, time);
  /** A time today, never in the future. */
  const todayAt = (time: string, minutesBeforeNow: number) =>
    new Date(Math.min(at(T, time).getTime(), now.getTime() - minutesBeforeNow * MIN));

  for (const u of await prisma.user.findMany({ where: { tenantId: tenant.id } })) ctx.users.set(u.email, { id: u.id, fullName: u.fullName });
  for (const r of await prisma.room.findMany({ where: { tenantId: tenant.id, propertyId: property.id } })) ctx.rooms.set(r.number, r);
  for (const t of await prisma.roomType.findMany({ where: { tenantId: tenant.id, propertyId: property.id } })) ctx.types.set(t.name, t);
  const U = (email: string) => ctx.users.get(email)!;
  const owner = U('demo@palmwine.ng');
  const tunde = U('tunde@palmwine.ng');
  const ngozi = U('ngozi@palmwine.ng');
  const chidinma = U('chidinma@palmwine.ng');

  // ---------------------------------------------------------------------------
  // Settings and approval PINs
  // ---------------------------------------------------------------------------
  const tax = await prisma.taxSetting.create({
    data: {
      tenantId: tenant.id,
      propertyId: property.id,
      vatEnabled: true,
      vatRateBps: 750,
      vatInclusive: false,
      consumptionEnabled: true,
      consumptionRateBps: 500,
      consumptionInclusive: false,
      consumptionLabel: 'Lagos consumption tax',
    },
  });
  const comps = componentsFrom(tax);
  await prisma.digestSetting.create({
    data: { tenantId: tenant.id, propertyId: property.id, enabled: true, recipients: ['+2348035550100'] },
  });
  for (const [email, pin] of Object.entries(DEMO_PINS)) {
    await prisma.user.update({
      where: { email },
      data: { approvalPinHash: await argon2.hash(pin, { type: argon2.argon2id }), pinFailedCount: 0, pinLockedUntil: null },
    });
  }

  // ---------------------------------------------------------------------------
  // Guests
  // ---------------------------------------------------------------------------
  const guests: Guest[] = [];
  const rand = ctx.rand;
  for (const [i, fullName] of GUEST_NAMES.entries()) {
    const foreign = i === 20 || i === 41;
    const phone = foreign ? `+44770090${String(1000 + i).slice(-4)}` : `+23480${String(3 + (i % 7))}${String(5_550_000 + i * 137).padStart(7, '0')}`;
    const idType = foreign ? 'PASSPORT' : pick(rand, ['NIN', 'NIN', 'NIN', 'DRIVERS_LICENSE', 'VOTERS_CARD', 'PASSPORT'] as const);
    const idNumber = idType === 'NIN' ? String(10_000_000_000 + i * 7_654_321).slice(0, 11) : `A${String(51_000_000 + i * 9_173)}`;
    const hasId = i % 9 !== 4; // a few guests have no ID on file yet
    const g = await prisma.guest.create({
      data: {
        tenantId: tenant.id,
        fullName,
        phone,
        email: i % 3 === 0 ? `${fullName.toLowerCase().replace(/[^a-z]+/g, '.')}@mail.ng` : null,
        gender: i % 2 === 0 ? 'MALE' : 'FEMALE',
        nationality: foreign ? 'British' : 'Nigerian',
        address: foreign ? '14 Kensington Road, London' : `${10 + i} ${pick(rand, ['Awolowo Road', 'Adeola Odeku Street', 'Aminu Kano Crescent', 'Ogui Road', 'Aba Road', 'Ring Road'])}, ${pick(rand, CITIES.slice(0, 8))}`,
        idType: hasId ? idType : null,
        idNumberEnc: hasId ? 'pending' : null,
        idNumberLast4: hasId ? last4Of(idNumber) : null,
        company: COMPANIES[i % COMPANIES.length],
        vip: i === 6 || i === 17 || i === 30,
        notes: i === 6 ? 'Prefers a high floor; allergic to groundnuts.' : '',
        consentAt: new Date(now.getTime() - (40 - (i % 30)) * 24 * HOUR),
        marketingOptIn: i % 4 === 0,
        createdAt: new Date(now.getTime() - (45 - (i % 40)) * 24 * HOUR),
      },
    });
    // Encrypt with the tenant id as associated data (same as the API).
    const updated = hasId
      ? await prisma.guest.update({ where: { id: g.id }, data: { idNumberEnc: cipher.encrypt(idNumber, tenant.id) } })
      : g;
    guests.push(updated);
  }

  // ---------------------------------------------------------------------------
  // Stay plan
  // ---------------------------------------------------------------------------
  const plans: Plan[] = [];
  const typeOf = (room: string) => [...ctx.types.values()].find((t) => t.id === ctx.rooms.get(room)!.roomTypeId)!.name;
  let gi = 0;
  const nextGuest = () => {
    gi = (gi + 1 + Math.floor(rand() * 3)) % guests.length;
    // Keep guests without an ID on file for the late-registration case only.
    if (gi % 9 === 4) gi = (gi + 1) % guests.length;
    return gi;
  };

  // Today: explicit, consistent with room statuses.
  const inHouse: [string, number, number, Partial<Plan>?][] = [
    ['101', -2, 2, { paid: 'deposit' }],
    ['105', -1, 1, { paid: 'full' }],
    ['205', -3, 2, { source: 'CORPORATE', rateKobo: 7_500_000, paid: 'none', notes: 'Kanem Logistics corporate rate' }],
    ['301', -1, 3, { paid: 'deposit', source: 'BOOKING_SITE' }],
    ['304', -2, 1, { paid: 'full', source: 'MARKETPLACE' }],
    ['306', -2, 3, { paid: 'deposit', source: 'WHATSAPP', notes: 'Anniversary: flowers and cake on the second night' }],
  ];
  for (const [room, a, d, extra] of inHouse) {
    plans.push({ kind: 'inHouse', room, type: typeOf(room), arrival: addDays(T, a), departure: addDays(T, d), guest: nextGuest(), ...extra });
  }
  // A guest checked in earlier today whose register is still incomplete (LATE_REGISTRATION).
  plans.push({ kind: 'inHouse', room: '201', type: typeOf('201'), arrival: T, departure: addDays(T, 2), guest: 4, lateRegistration: true, paid: 'deposit', source: 'WALK_IN' });
  for (const [room, a, paid] of [['102', -2, 'full'], ['108', -3, 'owing'], ['204', -1, 'owing'], ['207', -2, 'full']] as const) {
    plans.push({ kind: 'departToday', room, type: typeOf(room), arrival: addDays(T, a), departure: T, guest: nextGuest(), paid, extra: room === '108' });
  }
  for (const [room, a] of [['104', -3], ['202', -1], ['208', -2], ['305', -4]] as const) {
    plans.push({ kind: 'outToday', room, type: typeOf(room), arrival: addDays(T, a), departure: T, guest: nextGuest(), paid: 'full', extra: room === '305' });
  }
  plans.push({
    kind: 'dayUseToday',
    room: '107',
    type: 'Standard Queen',
    arrival: T,
    departure: T,
    arrivalAt: new Date(now.getTime() - 70 * MIN),
    departureAt: new Date(now.getTime() + 110 * MIN),
    guest: nextGuest(),
    source: 'WALK_IN',
    paid: 'full',
  });
  plans.push({ kind: 'arriveToday', room: '203', type: 'Standard Queen', arrival: T, departure: addDays(T, 2), guest: nextGuest(), source: 'PHONE', notes: 'Late arrival, guest landing 23:40' });
  plans.push({ kind: 'arriveToday', room: '303', type: 'Deluxe King', arrival: T, departure: addDays(T, 3), guest: nextGuest(), source: 'BOOKING_SITE', paid: 'deposit' });
  plans.push({ kind: 'arriveToday', room: '206', type: 'Deluxe King', arrival: T, departure: addDays(T, 1), guest: 6, source: 'WHATSAPP', notes: 'VIP: returning guest' });
  plans.push({ kind: 'arriveToday', room: null, type: 'Standard Queen', arrival: T, departure: addDays(T, 1), guest: nextGuest(), source: 'PHONE', status: 'PENDING' });
  plans.push({ kind: 'arriveToday', room: null, type: 'Palm Suite', arrival: T, departure: addDays(T, 2), guest: 17, source: 'CORPORATE', notes: 'Delta Agro Foods board visit' });

  // Future bookings over the next two weeks.
  const future: [string | null, string, number, number, ReservationSource, ReservationStatus][] = [
    [null, 'Standard Queen', 1, 3, 'MARKETPLACE', 'CONFIRMED'],
    ['302', 'Deluxe King', 1, 2, 'BOOKING_SITE', 'CONFIRMED'],
    [null, 'Deluxe King', 2, 5, 'CORPORATE', 'CONFIRMED'],
    ['307', 'Palm Suite', 3, 5, 'WHATSAPP', 'CONFIRMED'],
    [null, 'Standard Queen', 4, 5, 'PHONE', 'PENDING'],
    ['103', 'Standard Queen', 5, 8, 'OTA', 'CONFIRMED'],
    ['308', 'Palm Suite', 6, 8, 'BOOKING_SITE', 'CONFIRMED'],
    [null, 'Standard Queen', 7, 9, 'WALK_IN', 'CONFIRMED'],
    [null, 'Deluxe King', 9, 12, 'MARKETPLACE', 'CONFIRMED'],
    ['105', 'Standard Queen', 10, 11, 'PHONE', 'CONFIRMED'],
    [null, 'Palm Suite', 12, 14, 'CORPORATE', 'PENDING'],
  ];
  for (const [room, type, a, d, source, status] of future) {
    plans.push({ kind: 'future', room, type, arrival: addDays(T, a), departure: addDays(T, d), guest: nextGuest(), source, status });
  }

  // History: fill each room back to 30 days ago.
  const firstExplicit = new Map<string, string>();
  for (const p of plans) {
    if (!p.room || p.kind === 'future') continue;
    const cur = firstExplicit.get(p.room);
    if (!cur || p.arrival < cur) firstExplicit.set(p.room, p.arrival);
  }
  for (const room of [...ctx.rooms.keys()].sort()) {
    const explicit = firstExplicit.get(room);
    const end = room === '106' ? addDays(T, -3) : explicit && explicit < T ? explicit : addDays(T, -1);
    let d = addDays(T, -30 - Math.floor(rand() * 3));
    while (true) {
      const r = rand();
      if (r < 0.42) {
        // A gap day: sometimes sold as day use.
        if (typeOf(room) === 'Standard Queen' && rand() < 0.35 && d >= addDays(T, -30) && d < end) {
          const h = 12 + Math.floor(rand() * 4);
          plans.push({
            kind: 'dayUseHistory',
            room,
            type: 'Standard Queen',
            arrival: d,
            departure: d,
            arrivalAt: at(d, `${String(h).padStart(2, '0')}:30`),
            departureAt: at(d, `${String(h + 3).padStart(2, '0')}:30`),
            guest: nextGuest(),
            source: 'WALK_IN',
            paid: 'full',
          });
        }
        d = addDays(d, 1);
        continue;
      }
      const n = pick(rand, [1, 1, 2, 2, 2, 3, 3, 4, 5]);
      if (addDays(d, n) > end) {
        if (addDays(d, 1) <= end) {
          plans.push({ kind: 'history', room, type: typeOf(room), arrival: d, departure: addDays(d, 1), guest: nextGuest(), paid: 'full' });
        }
        break;
      }
      plans.push({
        kind: 'history',
        room,
        type: typeOf(room),
        arrival: d,
        departure: addDays(d, n),
        guest: nextGuest(),
        paid: 'full',
        source: pick(rand, SOURCES),
        extra: rand() < 0.3,
        smallDiscount: rand() < 0.08,
      });
      d = addDays(d, n);
    }
  }
  // Story beats in the history.
  const hist = plans.filter((p) => p.kind === 'history' && p.departure <= addDays(T, -1)).sort((a, b) => a.departure.localeCompare(b.departure));
  const byDeparture = (daysAgo: number) => hist.find((p) => p.departure === addDays(T, -daysAgo) && !p.voidDuplicate && !p.corporateLedger && !p.approvedDiscount);
  const b1 = byDeparture(6);
  if (b1) b1.voidDuplicate = true;
  const b2 = byDeparture(1);
  if (b2) b2.voidDuplicate = true;
  const b3 = byDeparture(3);
  if (b3) Object.assign(b3, { corporateLedger: true, guest: 0, source: 'CORPORATE' as const });
  const b4 = byDeparture(9);
  if (b4) b4.approvedDiscount = true;
  plans.push({ kind: 'noShow', room: null, type: 'Deluxe King', arrival: addDays(T, -5), departure: addDays(T, -3), guest: nextGuest(), source: 'OTA' });
  plans.push({ kind: 'cancelled', room: null, type: 'Standard Queen', arrival: addDays(T, -2), departure: addDays(T, 0), guest: nextGuest(), source: 'PHONE' });

  // ---------------------------------------------------------------------------
  // Cashier shifts (morning Ngozi, evening Chidinma) for each past day, and today.
  // ---------------------------------------------------------------------------
  interface ShiftRow {
    id: string;
    user: { id: string; fullName: string };
    openedAt: Date;
    closedAt: Date | null;
    openingFloatKobo: number;
    varianceCashKobo: number;
    status: 'OPEN' | 'CLOSED' | 'APPROVED';
    date: string;
  }
  const shifts: ShiftRow[] = [];
  for (const d of dateRange(addDays(T, -34), addDays(T, -1))) {
    const recent = d === addDays(T, -1);
    shifts.push({ id: randomUUID(), user: ngozi, openedAt: at(d, '07:00'), closedAt: at(d, '15:05'), openingFloatKobo: 2_000_000, varianceCashKobo: 0, status: recent ? 'CLOSED' : 'APPROVED', date: d });
    const evVariance = d === addDays(T, -12) ? -200_000 : recent ? -750_000 : 0;
    shifts.push({ id: randomUUID(), user: chidinma, openedAt: at(d, '15:00'), closedAt: at(d, '23:05'), openingFloatKobo: 2_000_000, varianceCashKobo: evVariance, status: recent ? 'CLOSED' : 'APPROVED', date: d });
  }
  const todayShift: ShiftRow = {
    id: randomUUID(),
    user: ngozi,
    openedAt: new Date(Math.min(at(T, '07:00').getTime(), now.getTime() - 3 * HOUR)),
    closedAt: null,
    openingFloatKobo: 2_000_000,
    varianceCashKobo: 0,
    status: 'OPEN',
    date: T,
  };
  shifts.push(todayShift);
  const shiftAt = (t: Date): ShiftRow => {
    const s = shifts.find((x) => x.openedAt <= t && (x.closedAt ? t < x.closedAt : true));
    return s ?? todayShift;
  };
  await prisma.cashierShift.createMany({
    data: shifts.map((s) => ({
      id: s.id,
      tenantId: tenant.id,
      propertyId: property.id,
      userId: s.user.id,
      userName: s.user.fullName,
      // Past shifts are finalised (count, expected, approval) further down.
      status: s.status === 'OPEN' ? ('OPEN' as const) : ('CLOSED' as const),
      openedAt: s.openedAt,
      openingFloatKobo: s.openingFloatKobo,
      createdAt: s.openedAt,
    })),
  });

  // ---------------------------------------------------------------------------
  // Reservations, folios and ledger entries
  // ---------------------------------------------------------------------------
  const codes = new Set<string>();
  const code = () => {
    for (;;) {
      let s = 'PWH-';
      for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
      if (!codes.has(s)) {
        codes.add(s);
        return s;
      }
    }
  };
  const entries: FolioEntry[] = [];
  const folioRows: Prisma.FolioCreateManyInput[] = [];
  const resRows: SeedReservation[] = [];
  const payments: { entry: FolioEntry; folioId: string; resId: string; at: Date; by: { id: string; fullName: string } }[] = [];
  const checkouts: { folioId: string; resId: string; at: Date; by: { id: string; fullName: string } }[] = [];
  const flagRows: Prisma.GuardFlagCreateManyInput[] = [];
  const taskRows: Prisma.HousekeepingTaskCreateManyInput[] = [];
  let seq = 0;

  const entry = (folioId: string, e: Partial<FolioEntry> & Pick<FolioEntry, 'type' | 'description' | 'businessDate' | 'createdAt'> & { amount: number }): FolioEntry => {
    const row: FolioEntry = {
      id: randomUUID(),
      tenantId: tenant.id,
      propertyId: property.id,
      folioId,
      type: e.type,
      amountKobo: BigInt(e.amount),
      description: e.description,
      businessDate: e.businessDate,
      parentEntryId: e.parentEntryId ?? null,
      refEntryId: e.refEntryId ?? null,
      taxCode: e.taxCode ?? null,
      rateBps: e.rateBps ?? null,
      inclusive: e.inclusive ?? null,
      paymentMethod: e.paymentMethod ?? null,
      paymentRef: e.paymentRef ?? null,
      shiftId: e.shiftId ?? null,
      reason: e.reason ?? null,
      approvedById: e.approvedById ?? null,
      createdById: e.createdById ?? null,
      clientCreatedAt: null,
      // Keep a strict order for entries created in the same millisecond.
      createdAt: new Date(e.createdAt.getTime() + (seq++ % 1000)),
    };
    entries.push(row);
    return row;
  };
  const charge = (folioId: string, type: 'ROOM' | 'DAY_USE' | 'EXTRA' | 'DISCOUNT', description: string, amount: number, date: string, when: Date, by: string | null, extra: Partial<FolioEntry> = {}) => {
    const b = computeCharge(amount, type === 'DISCOUNT' ? comps.map((c) => ({ ...c, inclusive: false })) : comps);
    const main = entry(folioId, { type, description, amount: b.netKobo, businessDate: dbDate(date), createdAt: when, createdById: by, ...extra });
    for (const l of b.lines) {
      entry(folioId, {
        type: l.code === 'SERVICE_CHARGE' ? 'SERVICE_CHARGE' : 'TAX',
        description: l.label,
        amount: l.amountKobo,
        businessDate: dbDate(date),
        createdAt: when,
        createdById: by,
        parentEntryId: main.id,
        taxCode: l.code,
        rateBps: l.rateBps,
        inclusive: l.inclusive,
      });
    }
    return { main, gross: b.grossKobo };
  };
  const balanceOf = (folioId: string, until?: Date) =>
    entries.filter((e) => e.folioId === folioId && (!until || e.createdAt <= until)).reduce((a, e) => a + Number(e.amountKobo), 0);
  const methodFor = (): PaymentMethod => pick(rand, ['TRANSFER', 'TRANSFER', 'POS', 'POS', 'CASH', 'CASH', 'TRANSFER']);
  const pay = (folioId: string, resId: string, amount: number, when: Date, method: PaymentMethod, note: string | null = null) => {
    if (amount <= 0) return null;
    const shift = method === 'CASH' || method === 'TRANSFER' || method === 'POS' ? shiftAt(when) : null;
    const by = shift?.user ?? tunde;
    const ref = method === 'TRANSFER' ? `TRF${Math.floor(1e9 + rand() * 9e9)}` : method === 'POS' ? `POS-${Math.floor(100000 + rand() * 900000)}` : null;
    const e = entry(folioId, {
      type: 'PAYMENT',
      description: { CASH: 'Cash payment', TRANSFER: 'Bank transfer', POS: 'POS card payment', CARD_ONLINE: 'Online card payment', COMPLIMENTARY: 'Complimentary', CITY_LEDGER: 'Charged to city ledger' }[method] + (note ? `: ${note}` : ''),
      amount: -amount,
      businessDate: dbDate(lagosDate(when)),
      createdAt: when,
      createdById: by.id,
      paymentMethod: method,
      paymentRef: ref,
      shiftId: shift?.id ?? null,
      reason: note,
    });
    if (method !== 'CITY_LEDGER') payments.push({ entry: e, folioId, resId, at: when, by });
    return e;
  };

  for (const p of plans) {
    const rt = ctx.types.get(p.type)!;
    const room = p.room ? ctx.rooms.get(p.room)! : null;
    const guest = guests[p.guest % guests.length];
    const dayUse = p.kind === 'dayUseHistory' || p.kind === 'dayUseToday';
    const stayType: StayType = dayUse ? 'DAY_USE' : 'NIGHTLY';
    const rate = p.rateKobo ?? (dayUse ? rt.hourlyPriceKobo! : rt.basePriceKobo);
    const arrivalAt = p.arrivalAt ?? at(p.arrival, property.checkInTime);
    const departureAt = p.departureAt ?? at(p.departure, property.checkOutTime);
    const nights = dayUse ? 0 : Math.round((Date.parse(p.departure) - Date.parse(p.arrival)) / 86_400_000);
    const hours = dayUse ? Math.ceil((departureAt.getTime() - arrivalAt.getTime()) / HOUR) : 0;
    // Booked one to five days ahead of arrival, and never after the seed runs.
    const createdAt = new Date(
      Math.min(arrivalAt.getTime() - (1 + Math.floor(rand() * 5)) * 24 * HOUR, now.getTime() - (2 + Math.floor(rand() * 40)) * HOUR),
    );
    const resId = randomUUID();
    const folioId = randomUUID();

    let status: ReservationStatus;
    let checkedInAt: Date | null = null;
    let checkedOutAt: Date | null = null;
    let checkInBy: { id: string; fullName: string } | null = null;
    let checkOutBy: { id: string; fullName: string } | null = null;
    switch (p.kind) {
      case 'history':
      case 'dayUseHistory':
      case 'outToday':
        status = 'CHECKED_OUT';
        break;
      case 'inHouse':
      case 'departToday':
      case 'dayUseToday':
        status = 'CHECKED_IN';
        break;
      case 'noShow':
        status = 'NO_SHOW';
        break;
      case 'cancelled':
        status = 'CANCELLED';
        break;
      default:
        status = p.status ?? 'CONFIRMED';
    }
    if (status === 'CHECKED_IN' || status === 'CHECKED_OUT') {
      checkedInAt = dayUse
        ? arrivalAt
        : p.lateRegistration
          ? todayAt('09:30', 110)
          : new Date(arrivalAt.getTime() + Math.floor(rand() * 7 * 60) * MIN);
      checkInBy = shiftAt(checkedInAt).user;
    }
    if (status === 'CHECKED_OUT') {
      checkedOutAt =
        p.kind === 'outToday'
          ? todayAt(`0${8 + Math.floor(rand() * 3)}:${String(Math.floor(rand() * 50) + 5).padStart(2, '0')}`, 20 + Math.floor(rand() * 60))
          : dayUse
            ? departureAt
            : at(p.departure, `${String(8 + Math.floor(rand() * 4)).padStart(2, '0')}:${String(Math.floor(rand() * 55)).padStart(2, '0')}`);
      checkOutBy = shiftAt(checkedOutAt).user;
    }
    const regComplete = (status === 'CHECKED_IN' || status === 'CHECKED_OUT') && !p.lateRegistration;
    const reservation: SeedReservation = {
      id: resId,
      tenantId: tenant.id,
      propertyId: property.id,
      code: code(),
      guestId: guest.id,
      roomTypeId: rt.id,
      roomId: room?.id ?? null,
      stayType,
      arrivalAt: status === 'CHECKED_IN' && checkedInAt && checkedInAt < arrivalAt ? checkedInAt : arrivalAt,
      departureAt: status === 'CHECKED_OUT' && checkedOutAt && checkedOutAt < departureAt ? checkedOutAt : departureAt,
      adults: rt.capacity >= 3 && rand() < 0.4 ? 3 : rand() < 0.45 ? 2 : 1,
      children: rand() < 0.1 ? 1 : 0,
      source: p.source ?? pick(rand, SOURCES),
      status,
      rateKobo: BigInt(rate),
      notes: p.notes ?? '',
      createdById: (p.kind === 'future' || p.kind === 'arriveToday' ? ngozi : (checkInBy ?? ngozi)).id,
      checkedInAt,
      checkedInById: checkInBy?.id ?? null,
      checkedOutAt,
      checkedOutById: checkOutBy?.id ?? null,
      cancelledAt: status === 'CANCELLED' ? new Date(arrivalAt.getTime() - 30 * HOUR) : null,
      cancelReason: status === 'CANCELLED' ? 'Guest postponed the trip' : status === 'NO_SHOW' ? `Not checked in by the night audit of ${humanDate(p.arrival)}` : null,
      noShowAt: status === 'NO_SHOW' ? at(addDays(p.arrival, 1), '02:00') : null,
      clientCreatedAt: null,
      regArrivingFrom: regComplete ? pick(rand, CITIES) : null,
      regGoingTo: regComplete ? pick(rand, CITIES) : null,
      regPurpose: regComplete ? pick(rand, PURPOSES) : null,
      regVehiclePlate: regComplete && rand() < 0.25 ? `LND-${Math.floor(100 + rand() * 899)}${pick(rand, ['AA', 'KJ', 'XY', 'EP'])}` : null,
      registrationCompletedAt: regComplete ? checkedInAt : null,
      registrationCompletedById: regComplete ? (checkInBy?.id ?? null) : null,
      createdAt,
      updatedAt: checkedOutAt ?? checkedInAt ?? createdAt,
    };
    resRows.push(reservation);
    folioRows.push({
      id: folioId,
      tenantId: tenant.id,
      propertyId: property.id,
      kind: 'RESERVATION',
      status: status === 'CHECKED_OUT' ? 'CLOSED' : 'OPEN',
      reservationId: resId,
      guestId: guest.id,
      name: guest.fullName,
      createdById: reservation.createdById,
      closedAt: checkedOutAt,
      createdAt,
    });

    if (status !== 'CHECKED_IN' && status !== 'CHECKED_OUT') {
      if (p.paid === 'deposit') pay(folioId, resId, Math.round(rate * 1.125), todayAt('09:15', 40), 'TRANSFER', 'Advance deposit');
      continue;
    }

    // Charges.
    const by = checkInBy!.id;
    if (dayUse) {
      charge(folioId, 'DAY_USE', `Day use, room ${room!.number}, ${hours} h`, rate * hours, p.arrival, checkedInAt!, by);
    } else {
      const lastNight = status === 'CHECKED_OUT' ? addDays(p.departure, -1) : [addDays(T, -1), addDays(p.departure, -1)].sort()[0];
      for (const night of dateRange(p.arrival, lastNight < p.arrival ? p.arrival : lastNight)) {
        const first = night === p.arrival;
        const when = first ? checkedInAt! : at(addDays(night, 1), '02:00');
        const { main } = charge(folioId, 'ROOM', roomNightLabel(room!.number, night), rate, night, when, first ? by : null);
        if (first && p.smallDiscount) {
          charge(folioId, 'DISCOUNT', `Discount on ${roomNightLabel(room!.number, night)}`, -Math.round(rate * 0.05), night, new Date(when.getTime() + 2 * MIN), by, {
            parentEntryId: main.id,
            reason: 'Returning guest courtesy',
          });
        }
        if (first && p.approvedDiscount) {
          charge(folioId, 'DISCOUNT', `Discount on ${roomNightLabel(room!.number, night)}`, -Math.round(rate * 0.15), night, new Date(when.getTime() + 3 * MIN), by, {
            parentEntryId: main.id,
            reason: 'Service recovery: noisy generator overnight',
            approvedById: tunde.id,
          });
        }
      }
      if (p.extra) {
        const [desc, amt] = pick(rand, EXTRAS);
        const night = p.arrival;
        charge(folioId, 'EXTRA', desc, amt, night, at(night, '20:40'), shiftAt(at(night, '20:40')).user.id);
      }
    }

    // Payments.
    if (p.corporateLedger) {
      // Paid part, rest to the company account at checkout by manager override.
      const half = Math.round(balanceOf(folioId) / 2);
      pay(folioId, resId, half, new Date(checkedInAt!.getTime() + 10 * MIN), 'TRANSFER');
      const rest = balanceOf(folioId);
      pay(folioId, resId, rest, new Date(checkedOutAt!.getTime() - 2 * MIN), 'CITY_LEDGER', 'Zenith Oil Services Ltd to settle by invoice');
      flagRows.push({
        tenantId: tenant.id,
        propertyId: property.id,
        rule: 'CHECKOUT_WITH_BALANCE',
        severity: 'HIGH',
        status: 'ACKNOWLEDGED',
        title: `${reservation.code} checked out owing ₦${Math.round(rest / 100).toLocaleString('en-NG')}`,
        detail: `${tunde.fullName} checked ${guest.fullName} out with an unpaid balance moved to the city ledger. Reason: Zenith Oil Services Ltd to settle by invoice`,
        dedupeKey: `CHECKOUT_WITH_BALANCE:${resId}`,
        amountKobo: rest,
        reservationId: resId,
        roomId: room!.id,
        userId: tunde.id,
        userName: tunde.fullName,
        evidence: { balanceKobo: rest, reason: 'Zenith Oil Services Ltd to settle by invoice' },
        createdAt: checkedOutAt!,
      });
      checkOutBy = tunde;
    } else if (status === 'CHECKED_OUT') {
      const upfront = rand() < 0.5;
      const method = methodFor();
      if (upfront && !dayUse) {
        const nightsGross = Math.round(rate * 1.125) * nights;
        pay(folioId, resId, Math.min(nightsGross, balanceOf(folioId, checkedInAt!) + nightsGross), new Date(checkedInAt!.getTime() + 8 * MIN), method);
      }
      if (p.voidDuplicate) {
        const dup = pay(folioId, resId, Math.round(rate * 1.125), new Date(checkedOutAt!.getTime() - 25 * MIN), 'POS');
        if (dup) {
          const when = new Date(checkedOutAt!.getTime() - 12 * MIN);
          entry(folioId, {
            type: 'VOID',
            description: `Void: ${dup.description}`,
            amount: -Number(dup.amountKobo),
            businessDate: dbDate(lagosDate(when)),
            createdAt: when,
            createdById: tunde.id,
            refEntryId: dup.id,
            paymentMethod: 'POS',
            shiftId: dup.shiftId,
            reason: 'Duplicate POS entry: terminal printed twice',
          });
          const recent = lagosDate(when) === addDays(T, -1);
          flagRows.push({
            tenantId: tenant.id,
            propertyId: property.id,
            rule: 'VOIDED_PAYMENT',
            severity: 'MEDIUM',
            status: recent ? 'OPEN' : 'RESOLVED',
            title: `Payment of ₦${Math.round(-Number(dup.amountKobo) / 100).toLocaleString('en-NG')} voided on ${reservation.code}`,
            detail: `${tunde.fullName} voided a pos payment. Reason: Duplicate POS entry: terminal printed twice`,
            dedupeKey: `VOIDED_PAYMENT:${dup.id}`,
            amountKobo: -Number(dup.amountKobo),
            reservationId: resId,
            roomId: room!.id,
            shiftId: dup.shiftId,
            userId: tunde.id,
            userName: tunde.fullName,
            evidence: { entryId: dup.id, method: 'POS', reference: dup.paymentRef, reason: 'Duplicate POS entry: terminal printed twice' },
            ...(recent
              ? {}
              : { resolvedById: owner.id, resolvedByName: owner.fullName, resolvedAt: new Date(when.getTime() + 20 * HOUR), resolution: 'Checked against the POS terminal report; the second slip was a reprint.' }),
            createdAt: when,
          });
        }
      }
      pay(folioId, resId, balanceOf(folioId), new Date(checkedOutAt!.getTime() - 4 * MIN), upfront ? methodFor() : method);
    } else {
      // In house.
      const bal = balanceOf(folioId);
      const posted = entries.filter((e) => e.folioId === folioId && e.type === 'ROOM').length;
      if (p.paid === 'full') pay(folioId, resId, bal + Math.round(rate * 1.125) * Math.max(0, nights - posted), new Date(checkedInAt!.getTime() + 6 * MIN), methodFor());
      else if (p.paid === 'deposit') pay(folioId, resId, Math.round(rate * 1.125), new Date(checkedInAt!.getTime() + 6 * MIN), methodFor());
      else if (p.paid === 'owing') pay(folioId, resId, Math.max(0, bal - Math.round(rate * 1.125)), new Date(checkedInAt!.getTime() + 6 * MIN), methodFor());
    }
    if (status === 'CHECKED_OUT') {
      checkouts.push({ folioId, resId, at: checkedOutAt!, by: checkOutBy! });
      if (p.kind === 'outToday') {
        taskRows.push({
          tenantId: tenant.id,
          propertyId: property.id,
          roomId: room!.id,
          reservationId: resId,
          status: p.room === '305' ? 'IN_PROGRESS' : 'OPEN',
          reason: 'CHECKOUT',
          notes: p.room === '305' ? 'Deep clean, guest stayed four nights' : '',
          createdAt: checkedOutAt!,
        });
      }
    }
    if (p.lateRegistration) {
      flagRows.push({
        tenantId: tenant.id,
        propertyId: property.id,
        rule: 'LATE_REGISTRATION',
        severity: 'LOW',
        status: 'OPEN',
        title: `${reservation.code}: guest register not completed`,
        detail: `${guest.fullName} checked in to room ${room!.number} over an hour ago without a completed register entry.`,
        dedupeKey: `LATE_REGISTRATION:${resId}`,
        reservationId: resId,
        roomId: room!.id,
        userId: checkInBy!.id,
        userName: checkInBy!.fullName,
        evidence: { checkedInAt: checkedInAt!.toISOString() },
        suggestion: 'Complete the register card (ID, arriving from, going to, purpose).',
        createdAt: new Date(checkedInAt!.getTime() + 65 * MIN),
      });
    }
  }

  // Dirty-room override in the history (dismissed).
  const overrideStay = resRows.find((r) => r.status === 'CHECKED_OUT' && r.checkedInAt && lagosDate(r.checkedInAt) === addDays(T, -9));
  if (overrideStay) {
    flagRows.push({
      tenantId: tenant.id,
      propertyId: property.id,
      rule: 'DIRTY_OVERRIDE_CHECKIN',
      severity: 'LOW',
      status: 'DISMISSED',
      title: `${overrideStay.code} checked in to a dirty room`,
      detail: `${tunde.fullName} overrode the clean-room rule. Reason: Guest arrived early; room inspected and only the bin needed emptying.`,
      dedupeKey: `DIRTY_OVERRIDE_CHECKIN:${overrideStay.id}`,
      reservationId: overrideStay.id,
      roomId: overrideStay.roomId,
      userId: tunde.id,
      userName: tunde.fullName,
      evidence: { roomStatus: 'VACANT_DIRTY' },
      resolvedById: owner.id,
      resolvedByName: owner.fullName,
      resolvedAt: new Date(overrideStay.checkedInAt!.getTime() + 18 * HOUR),
      resolution: 'Reasonable call; housekeeping confirmed the room was ready.',
      createdAt: overrideStay.checkedInAt!,
    });
  }

  await prisma.reservation.createMany({ data: resRows });
  await prisma.folio.createMany({ data: folioRows });
  entries.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (let i = 0; i < entries.length; i += 500) {
    await prisma.folioEntry.createMany({ data: entries.slice(i, i + 500) });
  }

  // ---------------------------------------------------------------------------
  // Receipts and invoices, numbered in time order (gapless per year).
  // ---------------------------------------------------------------------------
  const resById = new Map(resRows.map((r) => [r.id, r]));
  const guestById = new Map(guests.map((g) => [g.id, g]));
  const roomById = new Map([...ctx.rooms.values()].map((r) => [r.id, r]));
  const typeById = new Map([...ctx.types.values()].map((t) => [t.id, t]));
  const folioLike = (folioId: string, resId: string, until: Date) => {
    const r = resById.get(resId)!;
    return {
      id: folioId,
      name: guestById.get(r.guestId)!.fullName,
      entries: entries.filter((e) => e.folioId === folioId && e.createdAt <= until),
      guest: guestById.get(r.guestId)!,
      reservation: { ...r, room: r.roomId ? roomById.get(r.roomId)! : null, roomType: typeById.get(r.roomTypeId)! },
    };
  };
  const counters = new Map<string, number>();
  const next = (kind: 'INVOICE' | 'RECEIPT', when: Date) => {
    const year = lagosYear(when);
    const k = `${kind}:${year}`;
    const v = (counters.get(k) ?? 0) + 1;
    counters.set(k, v);
    const pre = `${kind === 'INVOICE' ? 'INV' : 'RCT'}${property.invoicePrefix ? `-${property.invoicePrefix}` : ''}`;
    return { year, seq: v, number: `${pre}-${year}-${String(v).padStart(6, '0')}` };
  };
  payments.sort((a, b) => a.at.getTime() - b.at.getTime());
  const receiptNumbers = new Map<string, string>();
  const receiptRows: Prisma.ReceiptCreateManyInput[] = [];
  for (const p of payments) {
    const n = next('RECEIPT', p.at);
    const f = folioLike(p.folioId, p.resId, p.at);
    const doc = buildReceiptDocument({ folio: f, entry: p.entry, hotel: ctx.hotel, number: n.number, issuedAt: p.at, balanceAfterKobo: balanceOf(p.folioId, p.at), issuer: p.by });
    const id = randomUUID();
    receiptNumbers.set(p.entry.id, n.number);
    receiptRows.push({
      id,
      tenantId: tenant.id,
      propertyId: property.id,
      folioId: p.folioId,
      entryId: p.entry.id,
      number: n.number,
      year: n.year,
      seq: n.seq,
      issuedAt: p.at,
      method: p.entry.paymentMethod!,
      amountKobo: -Number(p.entry.amountKobo),
      guestName: doc.guestName,
      reservationCode: doc.reservationCode,
      document: { ...doc, id } as unknown as Prisma.InputJsonValue,
      issuedById: p.by.id,
    });
  }
  await prisma.receipt.createMany({ data: receiptRows });
  checkouts.sort((a, b) => a.at.getTime() - b.at.getTime());
  const invoiceRows: Prisma.GuestInvoiceCreateManyInput[] = [];
  for (const c of checkouts) {
    const n = next('INVOICE', c.at);
    const doc = buildInvoiceDocument({ folio: folioLike(c.folioId, c.resId, c.at), receiptNumbers, hotel: ctx.hotel, number: n.number, kind: 'FINAL', issuedAt: c.at, issuer: c.by });
    const id = randomUUID();
    invoiceRows.push({
      id,
      tenantId: tenant.id,
      propertyId: property.id,
      folioId: c.folioId,
      kind: 'FINAL',
      number: n.number,
      year: n.year,
      seq: n.seq,
      issuedAt: c.at,
      businessDate: dbDate(lagosDate(c.at)),
      totalKobo: doc.totals.totalKobo,
      balanceKobo: doc.totals.balanceKobo,
      guestName: doc.guest?.fullName ?? null,
      reservationCode: doc.reservation?.code ?? null,
      document: { ...doc, id } as unknown as Prisma.InputJsonValue,
      issuedById: c.by.id,
    });
  }
  await prisma.guestInvoice.createMany({ data: invoiceRows });
  for (const [k, v] of counters) {
    const [kind, year] = k.split(':');
    await prisma.documentCounter.create({ data: { tenantId: tenant.id, kind: kind as 'INVOICE' | 'RECEIPT', year: Number(year), scope: property.id, lastValue: v } });
  }

  // ---------------------------------------------------------------------------
  // Close the past shifts (blind count = expected + scripted variance).
  // ---------------------------------------------------------------------------
  for (const s of shifts.filter((x) => x.status !== 'OPEN')) {
    const moves = entries
      .filter((e) => e.shiftId === s.id && (e.type === 'PAYMENT' || e.type === 'REFUND' || e.type === 'VOID'))
      .map((e) => ({ type: e.type, method: e.paymentMethod, amountKobo: Number(e.amountKobo) }));
    const exp = expectedTotals(s.openingFloatKobo, moves);
    const counted = { countedCashKobo: exp.expectedCashKobo + s.varianceCashKobo, declaredPosKobo: exp.expectedPosKobo, declaredTransferKobo: exp.expectedTransferKobo };
    const v = variance(exp, counted);
    await prisma.cashierShift.update({
      where: { id: s.id },
      data: {
        status: s.status,
        closedAt: s.closedAt,
        closedById: s.user.id,
        ...counted,
        denominations: denominations(counted.countedCashKobo),
        expectedCashKobo: exp.expectedCashKobo,
        expectedPosKobo: exp.expectedPosKobo,
        expectedTransferKobo: exp.expectedTransferKobo,
        paymentsCount: exp.paymentsCount,
        closeNotes: s.varianceCashKobo ? 'Counted twice; drawer is short.' : null,
        ...(s.status === 'APPROVED' && {
          approvedById: tunde.id,
          approvedByName: tunde.fullName,
          approvedAt: at(addDays(s.date, 1), '09:10'),
          approvalNotes: s.varianceCashKobo ? 'Short explained: change given twice to a guest. Deducted per policy.' : null,
        }),
      },
    });
    if (s.varianceCashKobo) {
      const recent = s.status === 'CLOSED';
      const short = Math.abs(s.varianceCashKobo);
      flagRows.push({
        tenantId: tenant.id,
        propertyId: property.id,
        rule: 'SHIFT_VARIANCE',
        severity: (short > 500_000 ? 'HIGH' : 'MEDIUM') as GuardSeverity,
        status: (recent ? 'OPEN' : 'RESOLVED') as GuardStatus,
        title: `${s.user.fullName}'s shift is short by ₦${(short / 100).toLocaleString('en-NG')}`,
        detail: `Counted cash ₦${(counted.countedCashKobo / 100).toLocaleString('en-NG')} against ₦${(exp.expectedCashKobo / 100).toLocaleString('en-NG')} expected; POS variance ₦0; transfer variance ₦0.`,
        dedupeKey: `SHIFT_VARIANCE:${s.id}`,
        amountKobo: short,
        shiftId: s.id,
        userId: s.user.id,
        userName: s.user.fullName,
        evidence: { ...exp, ...counted, ...v, openingFloatKobo: s.openingFloatKobo },
        ...(recent
          ? {}
          : { resolvedById: tunde.id, resolvedByName: tunde.fullName, resolvedAt: at(addDays(s.date, 1), '09:15'), resolution: 'Change given twice to a guest; amount recovered from the cashier.' }),
        createdAt: s.closedAt!,
      });
    }
  }
  await prisma.guardFlag.createMany({ data: flagRows });
  await prisma.housekeepingTask.createMany({ data: taskRows });

  // ---------------------------------------------------------------------------
  // Room statuses consistent with the stays.
  // ---------------------------------------------------------------------------
  const occupied = new Set(plans.filter((p) => ['inHouse', 'departToday', 'dayUseToday'].includes(p.kind)).map((p) => p.room!));
  const dirty = new Set(plans.filter((p) => p.kind === 'outToday').map((p) => p.room!));
  const reserved = new Set(['203', '303']);
  for (const [number, room] of ctx.rooms) {
    const status = number === '106' ? 'OUT_OF_ORDER' : occupied.has(number) ? 'OCCUPIED' : dirty.has(number) ? 'VACANT_DIRTY' : reserved.has(number) ? 'RESERVED' : 'VACANT_CLEAN';
    const notes = number === '106' ? 'AC compressor replacement booked for Thursday' : number === '203' ? 'Late arrival, guest landing 23:40' : number === '308' ? 'Anniversary setup requested for Saturday' : null;
    await prisma.room.update({ where: { id: room.id }, data: { status, notes } });
  }

  // ---------------------------------------------------------------------------
  // Night audit runs, daily statistics and owner digests for the past 30 days.
  // ---------------------------------------------------------------------------
  const flashes = await computeDailyFlashes(prisma as unknown as Parameters<typeof computeDailyFlashes>[0], tenant.id, addDays(T, -30), addDays(T, -1), [property.id]);
  const allFlags = flagRows.map((f) => ({ created: new Date(f.createdAt as Date), resolved: f.resolvedAt ? new Date(f.resolvedAt as Date) : null, rule: f.rule as GuardRule, severity: f.severity as GuardSeverity, title: f.title }));
  const digestRows: Prisma.OwnerDigestCreateManyInput[] = [];
  for (const f of flashes) {
    const dayEnd = at(addDays(f.date, 1), '00:00');
    const oooThen = f.date >= addDays(T, -3) ? 1 : 0;
    const openThen = allFlags.filter((x) => x.created < dayEnd && (!x.resolved || x.resolved > dayEnd));
    const snap: DailyFlash = { ...f, live: false, roomsOutOfOrder: oooThen, roomsAvailable: f.roomsTotal - oooThen, openFlags: openThen.length };
    finalise(snap);
    const systemRoomEntries = entries.filter((e) => e.type === 'ROOM' && e.createdById === null && lagosDate(e.businessDate) === f.date);
    const systemRooms = systemRoomEntries.length;
    const systemRoomsKobo = systemRoomEntries.reduce((a, e) => a + Number(e.amountKobo), 0);
    await prisma.dailyStat.create({
      data: {
        tenantId: tenant.id,
        propertyId: property.id,
        date: dbDate(f.date),
        roomsAvailable: snap.roomsAvailable,
        roomsSold: snap.roomsSold,
        occupancyRate: snap.occupancyRate,
        adrKobo: snap.adrKobo,
        revparKobo: snap.revparKobo,
        roomRevenueKobo: snap.roomRevenueKobo,
        totalRevenueKobo: snap.totalRevenueKobo,
        paymentsTotalKobo: snap.paymentsTotalKobo,
        dayUseCount: snap.dayUseCount,
        data: snap as unknown as Prisma.InputJsonValue,
        createdAt: at(addDays(f.date, 1), '02:01'),
      },
    });
    await prisma.nightAuditRun.create({
      data: {
        tenantId: tenant.id,
        propertyId: property.id,
        businessDate: dbDate(f.date),
        status: 'COMPLETED',
        trigger: 'SCHEDULED',
        startedAt: at(addDays(f.date, 1), '02:00'),
        finishedAt: at(addDays(f.date, 1), '02:01'),
        summary: { roomChargesPosted: systemRooms, roomChargesKobo: systemRoomsKobo, noShows: f.noShows, flagsCreated: 0 },
      },
    });
    if (f.date >= addDays(T, -7)) {
      const data: DigestData = {
        businessDate: f.date,
        hotelName: property.name,
        roomsSold: snap.roomsSold,
        roomsAvailable: snap.roomsAvailable,
        occupancyRate: snap.occupancyRate,
        dayUseCount: snap.dayUseCount,
        arrivals: snap.arrivals,
        departures: snap.departures,
        roomRevenueKobo: snap.roomRevenueKobo,
        totalRevenueKobo: snap.totalRevenueKobo,
        revenueByMethod: snap.paymentsByMethod,
        paymentsTotalKobo: snap.paymentsTotalKobo,
        openFlags: snap.openFlags,
        topFlags: openThen.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'HIGH' ? -1 : 1)).slice(0, 3).map((x) => ({ rule: x.rule, severity: x.severity, title: x.title })),
      };
      digestRows.push({
        tenantId: tenant.id,
        propertyId: property.id,
        businessDate: dbDate(f.date),
        trigger: 'SCHEDULED',
        channel: 'LOG',
        status: 'LOGGED',
        recipients: ['+2348035550100'],
        body: renderDigest(data, appName),
        data: data as unknown as Prisma.InputJsonValue,
        createdAt: at(f.date, '23:00'),
      });
    }
  }
  await prisma.ownerDigest.createMany({ data: digestRows });

  return {
    guests: guests.length,
    reservations: resRows.length,
    entries: entries.length,
    receipts: receiptRows.length,
    invoices: invoiceRows.length,
    shifts: shifts.length,
    flags: flagRows.length,
    openFlags: flagRows.filter((f) => f.status === 'OPEN').length,
    inHouse: occupied.size,
    housekeepingTasks: taskRows.length,
  };
}

/** Greedy naira note breakdown of a cash count (for the blind-close record). */
function denominations(kobo: number): Record<string, number> {
  let naira = Math.floor(kobo / 100);
  const out: Record<string, number> = {};
  for (const note of [1000, 500, 200, 100, 50, 20, 10, 5]) {
    out[String(note)] = Math.floor(naira / note);
    naira -= out[String(note)] * note;
  }
  return out;
}
