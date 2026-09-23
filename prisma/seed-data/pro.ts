/**
 * M5 (Pro) demo data for The Palmwine House group: a second property
 * (Palmwine House Ikoyi), point of sale, channel manager, dynamic pricing,
 * the guest WhatsApp inbox, the Palmwine Circle loyalty programme and custom
 * domains. Idempotent: `prepareProTenant` runs before the operations seed
 * (it clears the M5 rows, which hang off reservations and folios), and
 * `seedPro` runs last. All people and phone numbers are fictional.
 */
import { randomUUID } from 'node:crypto';
import type { Folio, Prisma, PrismaClient, Property, Reservation, Room, RoomType } from '../../src/generated/prisma/client.js';
import type { PaymentMethod, ReservationStatus } from '../../src/generated/prisma/enums.js';
import { addDays, dateRange, dbDate, diffDays, humanDate, lagosDate, lagosDateTime, lagosYear, roomNightLabel } from '../../src/common/time/lagos.js';
import { CODE_ALPHABET, codePrefix } from '../../src/common/utils/codes.js';
import { componentsFrom, computeCharge, type TaxComponent } from '../../src/modules/folios/tax.logic.js';
import { PHOTOS, STANDARD_POLICIES } from './hotels.js';

export const IKOYI_SLUG = 'palmwine-house-ikoyi';
const DAY = 24 * 3_600_000;
const HOUR = 3_600_000;
const MIN = 60_000;
const NAIRA = 100;

export const PRO_STAFF = [
  { email: 'kelechi@palmwine.ng', fullName: 'Kelechi Nnamdi', phone: '+2348185550111', role: 'FRONT_DESK' as const, ikoyiOnly: true },
  { email: 'yemi@palmwine.ng', fullName: 'Yemi Alade-Bello', phone: '+2348195550112', role: 'WAITER' as const, ikoyiOnly: false },
  { email: 'bisi@palmwine.ng', fullName: 'Bisi Oyelaran', phone: '+2348105550113', role: 'KITCHEN' as const, ikoyiOnly: false },
];

const IKOYI_TYPES = [
  {
    name: 'Classic Queen',
    description: 'A quiet queen room facing the garden wall of bougainvillea, with a walk-in shower and blackout blinds.',
    basePriceNaira: 75_000,
    hourlyPriceNaira: 20_000,
    capacity: 2,
    bedType: 'Queen',
    sizeSqm: 24,
    amenities: ['Air conditioning', 'Smart TV', 'Walk-in shower', 'Work desk', 'Free Wi-Fi', 'Minibar'],
    images: [{ url: PHOTOS.roomClassic, alt: 'Classic Queen room' }],
    rooms: ['101', '102', '103', '104', '105', '106'],
  },
  {
    name: 'Executive King',
    description: 'A king room on the upper floor with a writing desk, a reading nook and views over Bourdillon Road.',
    basePriceNaira: 110_000,
    hourlyPriceNaira: 30_000,
    capacity: 2,
    bedType: 'King',
    sizeSqm: 30,
    amenities: ['Air conditioning', 'Smart TV', 'Rain shower', 'Nespresso machine', 'Free Wi-Fi', 'Minibar'],
    images: [{ url: PHOTOS.roomModern, alt: 'Executive King room' }],
    rooms: ['201', '202', '203', '204'],
  },
  {
    name: 'Ikoyi Loft Suite',
    description: 'A two-level suite with a lounge downstairs, a king bed upstairs and a private terrace.',
    basePriceNaira: 210_000,
    hourlyPriceNaira: null,
    capacity: 3,
    bedType: 'King',
    sizeSqm: 48,
    amenities: ['Air conditioning', 'Smart TV', 'Soaking tub', 'Private terrace', 'Nespresso machine', 'Free Wi-Fi', 'Minibar'],
    images: [{ url: PHOTOS.roomSuite, alt: 'Ikoyi Loft Suite' }],
    rooms: ['301', '302'],
  },
];

/** Deterministic pseudo-random numbers (same demo data on every run). */
export function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const M5_TABLES = [
  'task_suggestions', 'conversation_messages', 'conversations', 'quick_replies', 'inbox_settings',
  'loyalty_challenges', 'loyalty_transactions', 'loyalty_members', 'loyalty_tiers', 'loyalty_programmes',
  'price_changes', 'price_suggestions', 'competitor_rates', 'pricing_events', 'pricing_frozen_dates', 'pricing_guardrails', 'pricing_settings',
  'channel_bookings', 'channel_sync_logs', 'channel_mappings', 'ical_feeds', 'channel_connections',
  'pos_order_lines', 'pos_tickets', 'pos_orders', 'pos_price_rules', 'minibar_pars', 'pos_items', 'pos_categories', 'pos_outlets',
  'stock_movements', 'stock_counts', 'stock_items',
  'custom_domains', 'user_property_access',
];

/**
 * Before the operations seed: clears the M5 rows, puts the group on its two
 * properties (prefixes, Ikoyi rooms) and sets up staff property access.
 */
export async function prepareProTenant(prisma: PrismaClient, tenantSlug: string, passwordHash: string): Promise<{ ikoyiId: string }> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } });
  const lekki = await prisma.property.findFirstOrThrow({ where: { tenantId: tenant.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    for (const table of M5_TABLES) await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, tenant.id);
    await tx.$executeRawUnsafe(`UPDATE users SET all_properties = true, default_property_id = NULL WHERE tenant_id = $1::uuid`, tenant.id);
    await tx.$executeRawUnsafe(`UPDATE properties SET custom_domain = NULL, custom_domain_verified_at = NULL WHERE tenant_id = $1::uuid`, tenant.id);
  });
  await prisma.property.update({ where: { id: lekki.id }, data: { invoicePrefix: 'PWH' } });

  const ikoyiData = {
    name: 'Palmwine House Ikoyi',
    tagline: 'The Palmwine House in a quiet Ikoyi close, twelve rooms and a garden terrace.',
    description:
      'Our second house sits on a leafy close off Bourdillon Road: twelve rooms, a garden terrace that serves breakfast ' +
      'until noon, and the same palm wine from Epe at sundown. Falomo Bridge and the island offices are ten minutes away, ' +
      'the power never goes off and the terrace Wi-Fi is fast enough for board calls.',
    address: '7 Glover Road, Ikoyi, Lagos',
    city: 'Lagos',
    state: 'Lagos',
    area: 'Ikoyi',
    phone: '+234 802 555 0142',
    email: 'ikoyi@palmwine.ng',
    checkInTime: '14:00',
    checkOutTime: '12:00',
    coverImageUrl: PHOTOS.villaPool,
    images: [
      { url: PHOTOS.villaPool, alt: 'Garden terrace and plunge pool' },
      { url: PHOTOS.lobbyLounge, alt: 'Lounge with local art' },
      { url: PHOTOS.roomModern, alt: 'Executive King room' },
    ] as Prisma.InputJsonValue,
    amenities: ['Free Wi-Fi', '24-hour power', 'Plunge pool', 'Garden terrace', 'Restaurant', 'Secure parking', 'Airport pickup'],
    policies: STANDARD_POLICIES,
    accentColor: '#2F6B4F',
    listedOnMarketplace: true,
    featured: false,
    invoicePrefix: 'PWI',
  };
  const createdAt = new Date(Math.max(lekki.createdAt.getTime() + DAY, Date.now() - 150 * DAY));
  const ikoyi = await prisma.property.upsert({
    where: { slug: IKOYI_SLUG },
    create: { tenantId: tenant.id, slug: IKOYI_SLUG, createdAt, ...ikoyiData },
    update: ikoyiData,
  });
  for (const [i, t] of IKOYI_TYPES.entries()) {
    const data = {
      description: t.description,
      basePriceKobo: t.basePriceNaira * NAIRA,
      hourlyPriceKobo: t.hourlyPriceNaira === null ? null : t.hourlyPriceNaira * NAIRA,
      capacity: t.capacity,
      bedType: t.bedType,
      sizeSqm: t.sizeSqm,
      amenities: t.amenities,
      images: t.images as Prisma.InputJsonValue,
      sortOrder: i,
    };
    const rt = await prisma.roomType.upsert({
      where: { propertyId_name: { propertyId: ikoyi.id, name: t.name } },
      create: { tenantId: tenant.id, propertyId: ikoyi.id, name: t.name, ...data },
      update: data,
    });
    for (const number of t.rooms) {
      const floor = Number(number[0]);
      await prisma.room.upsert({
        where: { propertyId_number: { propertyId: ikoyi.id, number } },
        create: { tenantId: tenant.id, propertyId: ikoyi.id, number, roomTypeId: rt.id, floor, status: 'VACANT_CLEAN' },
        update: { roomTypeId: rt.id, floor, status: 'VACANT_CLEAN', notes: null },
      });
    }
  }

  // Staff: three new accounts, and who may see which property.
  for (const s of PRO_STAFF) {
    await prisma.user.upsert({
      where: { email: s.email },
      create: { tenantId: tenant.id, email: s.email, fullName: s.fullName, phone: s.phone, role: s.role, passwordHash, createdAt: new Date(Date.now() - 40 * DAY) },
      update: { tenantId: tenant.id, fullName: s.fullName, phone: s.phone, role: s.role, passwordHash, isActive: true, customRoleId: null },
    });
  }
  const only = async (email: string, propertyId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.user.update({ where: { id: u.id }, data: { allProperties: false, defaultPropertyId: propertyId } });
    await prisma.userPropertyAccess.create({ data: { tenantId: tenant.id, userId: u.id, propertyId } });
  };
  await only('kelechi@palmwine.ng', ikoyi.id);
  await only('chidinma@palmwine.ng', lekki.id);
  await only('yemi@palmwine.ng', lekki.id);
  await only('bisi@palmwine.ng', lekki.id);
  return { ikoyiId: ikoyi.id };
}

// -----------------------------------------------------------------------------
// Shared helpers for stays posted straight into the ledger
// -----------------------------------------------------------------------------

export interface SeedCtx {
  prisma: PrismaClient;
  tenantId: string;
  now: Date;
  today: string;
  rand: () => number;
  users: Map<string, { id: string; fullName: string }>;
  codes: Set<string>;
}

export function newCode(ctx: SeedCtx, prefix: string): string {
  for (;;) {
    let s = '';
    for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(ctx.rand() * CODE_ALPHABET.length)];
    const code = `${prefix}-${s}`;
    if (!ctx.codes.has(code)) {
      ctx.codes.add(code);
      return code;
    }
  }
}

export async function taxComponents(prisma: PrismaClient, propertyId: string): Promise<TaxComponent[]> {
  const t = await prisma.taxSetting.findUnique({ where: { propertyId } });
  return t ? componentsFrom(t) : [];
}

export interface StayInput {
  property: Property;
  roomType: RoomType;
  room: Room | null;
  guestId: string;
  guestName: string;
  arrival: string;
  departure: string;
  status: ReservationStatus;
  source?: Reservation['source'];
  rateKobo?: number;
  nightly?: number[];
  createdAt: Date;
  adults?: number;
  notes?: string;
  ota?: { channel: NonNullable<Reservation['otaChannel']>; ref: string; commissionKobo: number; overbooked?: boolean };
  payMethod?: PaymentMethod;
  checkedInBy?: string | null;
  comps: TaxComponent[];
  loyaltyPoints?: number;
  expectedArrivalTime?: string | null;
}

/**
 * A stay with its folio: room nights posted for nights up to yesterday (in
 * house) or all nights (checked out), payments, closed folio when checked out.
 */
export async function createStay(ctx: SeedCtx, s: StayInput): Promise<{ reservation: Reservation; folio: Folio }> {
  const { prisma, tenantId } = ctx;
  const p = s.property;
  const nights = dateRange(s.arrival, addDays(s.departure, -1));
  const rates = nights.map((_, i) => s.nightly?.[i] ?? s.rateKobo ?? s.roomType.basePriceKobo);
  const snap = nights.map((d, i) => ({ date: d, rateKobo: rates[i], baseRateKobo: rates[i], source: 'BASE', ruleId: null, ruleName: null, discountKobo: 0 }));
  const arrivalAt = lagosDateTime(s.arrival, s.status === 'CHECKED_IN' || s.status === 'CHECKED_OUT' ? '15:10' : p.checkInTime);
  const departureAt = lagosDateTime(s.departure, s.status === 'CHECKED_OUT' ? '11:25' : p.checkOutTime);
  const inHouse = s.status === 'CHECKED_IN' || s.status === 'CHECKED_OUT';
  const code = newCode(ctx, codePrefix(p.name));
  const reservation = await prisma.reservation.create({
    data: {
      tenantId,
      propertyId: p.id,
      code,
      guestId: s.guestId,
      roomTypeId: s.roomType.id,
      roomId: s.room?.id ?? null,
      arrivalAt,
      departureAt,
      adults: s.adults ?? 1,
      source: s.source ?? (s.ota ? 'OTA' : 'PHONE'),
      status: s.status,
      rateKobo: rates[0] ?? s.roomType.basePriceKobo,
      notes: s.notes ?? '',
      nightlyRates: snap as unknown as Prisma.InputJsonValue,
      createdAt: s.createdAt,
      checkedInAt: inHouse ? arrivalAt : null,
      checkedInById: inHouse ? (s.checkedInBy ?? null) : null,
      checkedOutAt: s.status === 'CHECKED_OUT' ? departureAt : null,
      checkedOutById: s.status === 'CHECKED_OUT' ? (s.checkedInBy ?? null) : null,
      registrationCompletedAt: inHouse ? arrivalAt : null,
      regPurpose: inHouse ? 'BUSINESS' : null,
      regArrivingFrom: inHouse ? 'Abuja' : null,
      otaChannel: s.ota?.channel ?? null,
      otaRef: s.ota?.ref ?? null,
      otaCommissionKobo: s.ota ? BigInt(s.ota.commissionKobo) : null,
      overbooked: s.ota?.overbooked ?? false,
      loyaltyPoints: s.loyaltyPoints ?? 0,
      expectedArrivalTime: s.expectedArrivalTime ?? null,
      cancelledAt: s.status === 'CANCELLED' ? new Date(s.createdAt.getTime() + 2 * DAY) : null,
      cancelReason: s.status === 'CANCELLED' ? 'Guest changed plans' : null,
      cancelledBy: s.status === 'CANCELLED' ? 'HOTEL' : null,
    },
  });
  const folio = await prisma.folio.create({
    data: {
      tenantId,
      propertyId: p.id,
      kind: 'RESERVATION',
      reservationId: reservation.id,
      guestId: s.guestId,
      name: s.guestName,
      status: s.status === 'CHECKED_OUT' ? 'CLOSED' : 'OPEN',
      closedAt: s.status === 'CHECKED_OUT' ? departureAt : null,
      createdAt: s.createdAt,
    },
  });
  if (!inHouse) return { reservation, folio };
  const posted = s.status === 'CHECKED_OUT' ? nights : nights.filter((d) => d < ctx.today);
  if (s.status === 'CHECKED_IN' && !posted.includes(s.arrival)) posted.unshift(s.arrival);
  let gross = 0;
  for (const d of posted) {
    const i = nights.indexOf(d);
    gross += await postCharge(ctx, folio, { type: 'ROOM', description: roomNightLabel(s.room?.number, d), amountKobo: rates[i], date: d, at: lagosDateTime(d, '23:40'), comps: s.comps, byId: null });
  }
  if (s.status === 'CHECKED_OUT') {
    await prisma.folioEntry.create({
      data: {
        tenantId,
        propertyId: p.id,
        folioId: folio.id,
        type: 'PAYMENT',
        amountKobo: BigInt(-gross),
        description: s.ota ? `${s.ota.channel === 'BOOKING_COM' ? 'Booking.com' : 'Expedia'} payout` : 'Payment',
        businessDate: dbDate(s.departure),
        paymentMethod: s.payMethod ?? 'TRANSFER',
        paymentRef: s.ota ? s.ota.ref : null,
        createdById: s.checkedInBy ?? null,
        createdAt: new Date(departureAt.getTime() - 20 * MIN),
      },
    });
  } else {
    const deposit = Math.round(gross / 100_000) * 100_000;
    if (deposit > 0) {
      await prisma.folioEntry.create({
        data: {
          tenantId,
          propertyId: p.id,
          folioId: folio.id,
          type: 'PAYMENT',
          amountKobo: BigInt(-deposit),
          description: 'Deposit at check-in',
          businessDate: dbDate(s.arrival),
          paymentMethod: s.payMethod ?? 'POS',
          createdById: s.checkedInBy ?? null,
          createdAt: new Date(arrivalAt.getTime() + 5 * MIN),
        },
      });
    }
  }
  return { reservation, folio };
}

/** Posts a charge and its tax lines (like LedgerService.postCharge). Returns the gross. */
export async function postCharge(
  ctx: SeedCtx,
  folio: Pick<Folio, 'id' | 'propertyId'>,
  c: { type: 'ROOM' | 'EXTRA' | 'DAY_USE'; description: string; amountKobo: number; date: string; at: Date; comps: TaxComponent[]; byId: string | null },
): Promise<number> {
  const b = computeCharge(c.amountKobo, c.comps);
  const main = await ctx.prisma.folioEntry.create({
    data: {
      tenantId: ctx.tenantId,
      propertyId: folio.propertyId,
      folioId: folio.id,
      type: c.type,
      amountKobo: BigInt(b.netKobo),
      description: c.description,
      businessDate: dbDate(c.date),
      createdById: c.byId,
      createdAt: c.at,
    },
  });
  for (const l of b.lines) {
    await ctx.prisma.folioEntry.create({
      data: {
        tenantId: ctx.tenantId,
        propertyId: folio.propertyId,
        folioId: folio.id,
        type: l.code === 'SERVICE_CHARGE' ? 'SERVICE_CHARGE' : 'TAX',
        amountKobo: BigInt(l.amountKobo),
        description: l.label,
        businessDate: dbDate(c.date),
        parentEntryId: main.id,
        taxCode: l.code,
        rateBps: l.rateBps,
        inclusive: l.inclusive,
        createdAt: c.at,
      },
    });
  }
  return b.grossKobo;
}

export { addDays, dateRange, dbDate, diffDays, humanDate, lagosDate, lagosDateTime, lagosYear, DAY, HOUR, MIN, NAIRA, randomUUID };
