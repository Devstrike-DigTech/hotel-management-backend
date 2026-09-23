/**
 * M3 demo data: payout subaccounts, booking settings and cancellation
 * policies, ~60 verified-stay reviews, online bookings for The Palmwine House
 * (paid online, booking site, pay at hotel, a guest cancellation with refund,
 * an expired hold, an orphaned payment and one live hold) and a demo guest
 * account with trips across hotels.
 *
 * Idempotent: rows created here are either rebuilt with the demo hotel's
 * operational data (The Palmwine House) or carry the `seed:m3` marker in
 * reservations.notes and are deleted and recreated on each run. All people,
 * phone numbers and bank accounts are fictional.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, Property, RoomType, TaxSetting } from '../../src/generated/prisma/client.js';
import type { PaymentMethod, ReservationSource } from '../../src/generated/prisma/enums.js';
import { FieldCipher } from '../../src/common/crypto/field-cipher.js';
import { addDays, dbDate, lagosDate, lagosDateTime, lagosYear, roomNightLabel } from '../../src/common/time/lagos.js';
import { codePrefix, CODE_ALPHABET } from '../../src/common/utils/codes.js';
import { commissionFor, HOLD_EXPIRED_REASON, priceStay } from '../../src/modules/booking/booking.logic.js';
import { componentsFrom, computeCharge, type TaxComponent } from '../../src/modules/folios/tax.logic.js';
import { buildInvoiceDocument, buildReceiptDocument, type HotelHeader } from '../../src/modules/invoices/document.builder.js';
import { aggregate, displayName } from '../../src/modules/reviews/reviews.logic.js';
import { REVIEWS, type ReviewSeed } from './reviews.js';

const SEED_MARK = 'seed:m3';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const DEMO_GUEST = {
  phone: '+2348030000001',
  fullName: 'Adaeze Okafor',
  email: 'adaeze.okafor@example.ng',
};

/** Hotels without a payout subaccount (to demo onboarding). */
const NO_PAYOUT = new Set(['wuse-garden-suites']);

const BANKS: [string, string][] = [
  ['058', 'Guaranty Trust Bank'],
  ['057', 'Zenith Bank'],
  ['044', 'Access Bank'],
  ['033', 'United Bank For Africa'],
  ['011', 'First Bank of Nigeria'],
  ['221', 'Stanbic IBTC Bank'],
  ['070', 'Fidelity Bank'],
  ['232', 'Sterling Bank'],
  ['035', 'Wema Bank'],
];

const POLICIES: Record<string, { free: number; late: number; noShow: number }> = {
  'palmwine-house': { free: 48, late: 100, noShow: 100 },
  'ikoyi-lantern': { free: 72, late: 100, noShow: 100 },
  'eko-tides': { free: 24, late: 50, noShow: 100 },
  'maitama-court': { free: 72, late: 100, noShow: 100 },
  'wuse-garden-suites': { free: 24, late: 50, noShow: 50 },
  'garden-city-lodge': { free: 48, late: 100, noShow: 100 },
  'marina-creek': { free: 24, late: 50, noShow: 100 },
  'bodija-heights': { free: 24, late: 50, noShow: 50 },
  'coal-city-retreat': { free: 48, late: 100, noShow: 100 },
};

const PRE_ARRIVAL: Record<string, string> = {
  'palmwine-house': 'Our gate is on Fola Osibo Road, opposite the pharmacy. Security will ask for your booking code. Parking is free.',
  'ikoyi-lantern': 'Tell the driver "the lantern house off Bourdillon". Airport pick-up can be arranged through the front desk.',
  'maitama-court': 'Visitors to Maitama Court register at the gate with a photo ID. Late arrivals after 22:00, please call ahead.',
};

type Tx = Prisma.TransactionClient;

interface HotelCtx {
  tenantId: string;
  property: Property;
  types: RoomType[];
  comps: TaxComponent[];
  header: HotelHeader;
  prefix: string;
  codes: Set<string>;
  commissionBps: number;
}

/** Deterministic pseudo-random numbers (same data every run). */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nameHash(s: string): number {
  return parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16);
}

/** Fictional Nigerian mobile number derived from a name (stable across runs). */
function phoneFor(name: string): string {
  const n = String(nameHash(name) % 100_000_000).padStart(8, '0');
  return `+23481${n}`;
}

function newCode(h: HotelCtx, rand: () => number): string {
  for (;;) {
    let s = '';
    for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
    const code = `${h.prefix}-${s}`;
    if (!h.codes.has(code)) {
      h.codes.add(code);
      return code;
    }
  }
}

async function nextNumber(tx: Tx, h: { tenantId: string; property: { id: string; invoicePrefix: string | null } }, kind: 'INVOICE' | 'RECEIPT', year: number) {
  // M5: invoice and receipt series are per property (scope = property id).
  const rows = await tx.$queryRaw<{ last_value: number }[]>`
    INSERT INTO document_counters (tenant_id, kind, year, scope, last_value)
    VALUES (${h.tenantId}::uuid, ${kind}::"DocumentCounterKind", ${year}, ${h.property.id}, 1)
    ON CONFLICT (tenant_id, kind, year, scope) DO UPDATE SET last_value = document_counters.last_value + 1
    RETURNING last_value`;
  const seq = Number(rows[0].last_value);
  const pre = `${kind === 'INVOICE' ? 'INV' : 'RCT'}${h.property.invoicePrefix ? `-${h.property.invoicePrefix}` : ''}`;
  return { seq, number: `${pre}-${year}-${String(seq).padStart(6, '0')}` };
}

async function hotelCtx(prisma: PrismaClient, slug: string, appName: string): Promise<HotelCtx | null> {
  const property = await prisma.property.findUnique({ where: { slug } });
  if (!property) return null;
  const types = await prisma.roomType.findMany({ where: { propertyId: property.id }, orderBy: [{ sortOrder: 'asc' }, { basePriceKobo: 'asc' }] });
  const tax: TaxSetting = await prisma.taxSetting.upsert({ where: { propertyId: property.id }, create: { tenantId: property.tenantId, propertyId: property.id }, update: {} });
  const sub = await prisma.subscription.findUnique({ where: { tenantId: property.tenantId }, include: { plan: true } });
  const existing = await prisma.reservation.findMany({ where: { tenantId: property.tenantId }, select: { code: true } });
  return {
    tenantId: property.tenantId,
    property,
    types,
    comps: componentsFrom(tax),
    header: {
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
    prefix: codePrefix(property.name),
    codes: new Set(existing.map((e) => e.code)),
    commissionBps: sub?.plan.commissionBps ?? 0,
  };
}

// -----------------------------------------------------------------------------
// Settings, payouts
// -----------------------------------------------------------------------------

async function seedSettings(prisma: PrismaClient, cipher: FieldCipher): Promise<{ payouts: number }> {
  const properties = await prisma.property.findMany({ orderBy: { createdAt: 'asc' } });
  let payouts = 0;
  for (const [i, p] of properties.entries()) {
    // Only the seed hotels: hotels created through signup keep their own settings.
    const pol = POLICIES[p.slug];
    if (!pol) continue;
    const ready = !NO_PAYOUT.has(p.slug);
    await prisma.property.update({
      where: { id: p.id },
      data: {
        freeCancellationHours: pol.free,
        lateCancellationFeePct: pol.late,
        noShowFeePct: pol.noShow,
        onlineBookingEnabled: true,
        allowPayAtHotel: true,
        preArrivalMessage: PRE_ARRIVAL[p.slug] ?? '',
        payoutReady: ready,
      },
    });
    if (!ready) {
      await prisma.payoutAccount.deleteMany({ where: { propertyId: p.id } });
      continue;
    }
    const [bankCode, bankName] = BANKS[i % BANKS.length];
    const account = String(1_000_000_000 + (nameHash(p.slug) % 8_999_999_999)).slice(0, 10);
    const sub = `ACCT_mock${createHash('sha256').update(`${bankCode}:${account}`).digest('hex').slice(0, 10)}`;
    const data = {
      bankCode,
      bankName,
      accountNumberEnc: cipher.encrypt(account, p.tenantId),
      accountNumberLast4: account.slice(-4),
      accountName: `${p.name.toUpperCase().replace(/^THE /, '')} LTD`,
      businessName: p.name,
      subaccountCode: sub,
      provider: 'mock',
      settlementVerified: true,
      percentageCharge: 0,
    };
    await prisma.payoutAccount.upsert({ where: { propertyId: p.id }, create: { tenantId: p.tenantId, propertyId: p.id, ...data }, update: data });
    payouts++;
  }
  return { payouts };
}

// -----------------------------------------------------------------------------
// Ledger helpers
// -----------------------------------------------------------------------------

interface StaySpec {
  h: HotelCtx;
  rand: () => number;
  guest: { name: string; phone: string; email?: string | null; accountId?: string | null };
  type: RoomType;
  arrival: string;
  nights: number;
  source: ReservationSource;
  status: 'PENDING' | 'CONFIRMED' | 'CHECKED_OUT' | 'CANCELLED';
  paymentMode: 'ONLINE' | 'PAY_AT_HOTEL' | null;
  createdAt: Date;
  notes?: string;
  specialRequests?: string;
  adults?: number;
}

async function upsertGuest(tx: Tx, tenantId: string, g: StaySpec['guest'], createdAt: Date) {
  const existing = await tx.guest.findFirst({ where: { tenantId, phone: g.phone } });
  if (existing) {
    if (g.accountId && !existing.guestAccountId) return tx.guest.update({ where: { id: existing.id }, data: { guestAccountId: g.accountId } });
    return existing;
  }
  return tx.guest.create({
    data: { tenantId, fullName: g.name, phone: g.phone, email: g.email ?? null, consentAt: createdAt, guestAccountId: g.accountId ?? null, createdAt },
  });
}

async function createStay(tx: Tx, s: StaySpec) {
  const { h } = s;
  const p = h.property;
  const arrivalAt = lagosDateTime(s.arrival, p.checkInTime);
  const departureAt = lagosDateTime(addDays(s.arrival, s.nights), p.checkOutTime);
  const quote = priceStay({ stayType: 'NIGHTLY', rateKobo: s.type.basePriceKobo, roomTypeName: s.type.name, components: h.comps, arrivalDate: s.arrival, nights: s.nights });
  const guest = await upsertGuest(tx, h.tenantId, s.guest, s.createdAt);
  const online = s.paymentMode !== null;
  const bps = online ? (s.source === 'MARKETPLACE' ? h.commissionBps : 0) : null;
  const checkedOutAt = s.status === 'CHECKED_OUT' ? new Date(departureAt.getTime() - (1 + Math.floor(s.rand() * 3)) * HOUR) : null;
  const r = await tx.reservation.create({
    data: {
      tenantId: h.tenantId,
      propertyId: p.id,
      code: newCode(h, s.rand),
      guestId: guest.id,
      roomTypeId: s.type.id,
      stayType: 'NIGHTLY',
      arrivalAt,
      departureAt,
      adults: s.adults ?? (s.type.capacity >= 2 ? 2 : 1),
      children: 0,
      source: s.source,
      status: s.status,
      rateKobo: s.type.basePriceKobo,
      notes: s.notes ?? SEED_MARK,
      checkedInAt: s.status === 'CHECKED_OUT' ? new Date(arrivalAt.getTime() + 2 * HOUR) : null,
      checkedOutAt,
      createdAt: s.createdAt,
      ...(online && {
        paymentMode: s.paymentMode,
        guaranteeType: 'NONE',
        commissionBps: bps,
        quotedTotalKobo: quote.totalKobo,
        quoteRef: randomUUID().slice(0, 12),
        quote: quote as unknown as Prisma.InputJsonValue,
        contactPhone: s.guest.phone,
        contactEmail: s.guest.email ?? null,
        specialRequests: s.specialRequests ?? '',
        guestAccountId: s.guest.accountId ?? null,
      }),
    },
  });
  const folio = await tx.folio.create({
    data: {
      tenantId: h.tenantId,
      propertyId: p.id,
      kind: 'RESERVATION',
      reservationId: r.id,
      guestId: guest.id,
      name: guest.fullName,
      status: s.status === 'CHECKED_OUT' ? 'CLOSED' : 'OPEN',
      closedAt: checkedOutAt,
      createdAt: s.createdAt,
    },
  });
  return { r, folio, guest, quote, bps: bps ?? 0, arrivalAt, departureAt, checkedOutAt };
}

async function postNights(tx: Tx, h: HotelCtx, folioId: string, arrival: string, nights: number, rate: number, roomLabel: string | null) {
  let total = 0;
  for (let i = 0; i < nights; i++) {
    const night = addDays(arrival, i);
    const at = lagosDateTime(i === 0 ? night : addDays(night, 1), i === 0 ? h.property.checkInTime : '02:00');
    const b = computeCharge(rate, h.comps);
    const main = await tx.folioEntry.create({
      data: { tenantId: h.tenantId, propertyId: h.property.id, folioId, type: 'ROOM', amountKobo: b.netKobo, description: roomNightLabel(roomLabel, night), businessDate: dbDate(night), createdAt: at },
    });
    for (const l of b.lines) {
      await tx.folioEntry.create({
        data: {
          tenantId: h.tenantId,
          propertyId: h.property.id,
          folioId,
          type: l.code === 'SERVICE_CHARGE' ? 'SERVICE_CHARGE' : 'TAX',
          amountKobo: l.amountKobo,
          description: l.label,
          businessDate: dbDate(night),
          parentEntryId: main.id,
          taxCode: l.code,
          rateBps: l.rateBps,
          inclusive: l.inclusive,
          createdAt: at,
        },
      });
    }
    total += b.grossKobo;
  }
  return total;
}

async function folioLike(tx: Tx, folioId: string) {
  const f = await tx.folio.findUniqueOrThrow({ where: { id: folioId }, include: { entries: true, guest: true, reservation: { include: { room: true, roomType: true } } } });
  return f;
}

/** Online payment on the folio (+ receipt) and the payment row. */
async function payOnline(
  tx: Tx,
  h: HotelCtx,
  stay: Awaited<ReturnType<typeof createStay>>,
  at: Date,
  opts: { channel?: string; receipt?: boolean; status?: 'SUCCEEDED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'ORPHANED'; orphanReason?: 'LATE_NO_INVENTORY'; method?: PaymentMethod } = {},
) {
  const amount = stay.quote.totalKobo;
  const commission = commissionFor(amount, stay.bps);
  const reference = `BKG_seed${createHash('sha256').update(stay.r.id).digest('hex').slice(0, 14)}`;
  const entry = await tx.folioEntry.create({
    data: {
      tenantId: h.tenantId,
      propertyId: h.property.id,
      folioId: stay.folio.id,
      type: 'PAYMENT',
      amountKobo: -amount,
      description: `Online payment (${opts.channel === 'bank_transfer' ? 'bank transfer' : opts.channel === 'ussd' ? 'USSD' : 'card'})`,
      businessDate: dbDate(lagosDate(at)),
      paymentMethod: 'CARD_ONLINE',
      paymentRef: reference,
      createdAt: at,
    },
  });
  const pay = await tx.bookingPayment.create({
    data: {
      tenantId: h.tenantId,
      propertyId: h.property.id,
      reservationId: stay.r.id,
      reference,
      provider: 'mock',
      status: opts.status ?? 'SUCCEEDED',
      amountKobo: amount,
      commissionKobo: commission,
      commissionBps: stay.bps,
      subaccountCode: 'ACCT_mockseed',
      callbackUrl: 'http://localhost:3000/booking/confirmation',
      email: stay.guest.email ?? 'guest@example.ng',
      paidAmountKobo: amount,
      paidAt: at,
      channel: opts.channel ?? 'card',
      providerTransactionId: `mock_${reference.slice(-8)}`,
      folioEntryId: entry.id,
      orphanReason: opts.orphanReason ?? null,
      createdAt: new Date(at.getTime() - 4 * 60_000),
    },
  });
  if (commission > 0) {
    await tx.commissionEntry.create({
      data: { tenantId: h.tenantId, propertyId: h.property.id, reservationId: stay.r.id, paymentId: pay.id, kind: 'COLLECTED', amountKobo: commission, baseKobo: amount, commissionBps: stay.bps, channel: stay.r.source, note: 'Split at payment (Paystack transaction charge)', createdAt: at },
    });
  }
  if (opts.receipt !== false) {
    const f = await folioLike(tx, stay.folio.id);
    const balance = f.entries.reduce((a, e) => a + Number(e.amountKobo), 0);
    const n = await nextNumber(tx, h, 'RECEIPT', lagosYear(at));
    const doc = buildReceiptDocument({ folio: f, entry, hotel: h.header, number: n.number, issuedAt: at, balanceAfterKobo: balance, issuer: null });
    const id = randomUUID();
    await tx.receipt.create({
      data: {
        id,
        tenantId: h.tenantId,
        propertyId: h.property.id,
        folioId: stay.folio.id,
        entryId: entry.id,
        number: n.number,
        year: lagosYear(at),
        seq: n.seq,
        issuedAt: at,
        method: 'CARD_ONLINE',
        amountKobo: amount,
        guestName: doc.guestName,
        reservationCode: doc.reservationCode,
        document: { ...doc, id } as unknown as Prisma.InputJsonValue,
      },
    });
  }
  return { pay, entry, amount, commission, reference };
}

async function logMessages(tx: Tx, h: HotelCtx, reservationId: string, code: string, at: Date, items: { template: string; channel: 'EMAIL' | 'SMS'; to: string; subject: string | null; text: string; audience?: 'GUEST' | 'HOTEL' }[]) {
  for (const [i, m] of items.entries()) {
    await tx.notificationLog.create({
      data: {
        tenantId: h.tenantId,
        reservationId,
        template: m.template,
        channel: m.channel,
        audience: m.audience ?? 'GUEST',
        recipient: m.to,
        subject: m.subject,
        bodyText: m.text,
        status: 'OUTBOX',
        provider: 'outbox',
        providerMessageId: `seed-${code}-${i}`,
        attempts: 1,
        sentAt: new Date(at.getTime() + (i + 1) * 1000),
        createdAt: new Date(at.getTime() + i * 1000),
      },
    });
  }
}

// -----------------------------------------------------------------------------
// Reviews
// -----------------------------------------------------------------------------

async function seedReviews(tx: Tx, h: HotelCtx, reviews: ReviewSeed[], now: Date, demoAccountId: string) {
  const rand = prng(nameHash(h.property.slug));
  const today = lagosDate(now);
  let count = 0;
  for (const [i, rv] of reviews.entries()) {
    const departure = addDays(today, -rv.ago);
    const arrival = addDays(departure, -rv.nights);
    const type = h.types[i % Math.max(1, h.types.length)];
    const isDemo = rv.guest === DEMO_GUEST.fullName;
    const guest = isDemo
      ? { name: DEMO_GUEST.fullName, phone: DEMO_GUEST.phone, email: DEMO_GUEST.email, accountId: demoAccountId }
      : { name: rv.guest, phone: phoneFor(rv.guest), email: null };
    const createdAt = new Date(lagosDateTime(arrival, '09:00').getTime() - (3 + (i % 10)) * DAY);
    const stay = await createStay(tx, {
      h,
      rand,
      guest,
      type,
      arrival,
      nights: rv.nights,
      source: i % 3 === 0 ? 'BOOKING_SITE' : i % 3 === 1 ? 'MARKETPLACE' : 'WALK_IN',
      status: 'CHECKED_OUT',
      paymentMode: null,
      createdAt,
    });
    const total = await postNights(tx, h, stay.folio.id, arrival, rv.nights, type.basePriceKobo, null);
    await tx.folioEntry.create({
      data: {
        tenantId: h.tenantId,
        propertyId: h.property.id,
        folioId: stay.folio.id,
        type: 'PAYMENT',
        amountKobo: -total,
        description: i % 2 ? 'Payment (pos)' : 'Payment (transfer)',
        businessDate: dbDate(departure),
        paymentMethod: i % 2 ? 'POS' : 'TRANSFER',
        createdAt: stay.checkedOutAt!,
      },
    });
    const reviewedAt = new Date(stay.checkedOutAt!.getTime() + (6 + Math.floor(rand() * 40)) * HOUR);
    await tx.review.create({
      data: {
        tenantId: h.tenantId,
        propertyId: h.property.id,
        reservationId: stay.r.id,
        guestId: stay.guest.id,
        guestAccountId: isDemo ? demoAccountId : null,
        overall: rv.scores[0],
        cleanliness: rv.scores[1],
        service: rv.scores[2],
        location: rv.scores[3],
        value: rv.scores[4],
        title: rv.title ?? null,
        body: rv.body,
        stayMonth: arrival.slice(0, 7),
        travellerType: rv.traveller,
        displayName: displayName(rv.guest),
        status: rv.flag ? 'FLAGGED' : 'PUBLISHED',
        flaggedReason: rv.flag ?? null,
        flaggedAt: rv.flag ? new Date(reviewedAt.getTime() + DAY) : null,
        hotelReply: rv.reply ?? null,
        hotelRepliedAt: rv.reply ? new Date(reviewedAt.getTime() + (10 + Math.floor(rand() * 30)) * HOUR) : null,
        createdAt: reviewedAt,
        updatedAt: reviewedAt,
      },
    });
    count++;
  }
  return count;
}

async function recompute(tx: Tx, propertyId: string) {
  const rows = await tx.review.findMany({ where: { propertyId, status: { in: ['PUBLISHED', 'FLAGGED'] } } });
  const a = aggregate(rows);
  await tx.property.update({
    where: { id: propertyId },
    data: {
      rating: a.rating,
      reviewCount: a.count,
      ratingCleanliness: a.cleanliness,
      ratingService: a.service,
      ratingLocation: a.location,
      ratingValue: a.value,
      ratingDistribution: { stars: a.stars, byTravellerType: a.byTravellerType },
    },
  });
}

/** Deletes rows this seed created on an earlier run (non-demo hotels). */
async function clearSeeded(tx: Tx, tenantId: string) {
  const ids = (await tx.reservation.findMany({ where: { tenantId, notes: { startsWith: SEED_MARK } }, select: { id: true } })).map((r) => r.id);
  if (!ids.length) return;
  await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
  const list = `ARRAY[${ids.map((i) => `'${i}'::uuid`).join(',')}]`;
  await tx.$executeRawUnsafe(`DELETE FROM notification_logs WHERE reservation_id = ANY(${list})`);
  await tx.$executeRawUnsafe(`DELETE FROM reviews WHERE reservation_id = ANY(${list})`);
  await tx.$executeRawUnsafe(`DELETE FROM commission_entries WHERE reservation_id = ANY(${list})`);
  await tx.$executeRawUnsafe(`DELETE FROM booking_refunds WHERE reservation_id = ANY(${list})`);
  await tx.$executeRawUnsafe(`DELETE FROM booking_payments WHERE reservation_id = ANY(${list})`);
  await tx.$executeRawUnsafe(`DELETE FROM receipts WHERE folio_id IN (SELECT id FROM folios WHERE reservation_id = ANY(${list}))`);
  await tx.$executeRawUnsafe(`DELETE FROM guest_invoices WHERE folio_id IN (SELECT id FROM folios WHERE reservation_id = ANY(${list}))`);
  await tx.$executeRawUnsafe(`DELETE FROM folio_entries WHERE folio_id IN (SELECT id FROM folios WHERE reservation_id = ANY(${list}))`);
  await tx.$executeRawUnsafe(`DELETE FROM folios WHERE reservation_id = ANY(${list})`);
  await tx.$executeRawUnsafe(`DELETE FROM reservations WHERE id = ANY(${list})`);
  await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = origin`);
}

// -----------------------------------------------------------------------------
// The Palmwine House: online bookings
// -----------------------------------------------------------------------------

async function seedPalmwineOnline(tx: Tx, h: HotelCtx, now: Date, demoAccountId: string) {
  const rand = prng(20260924);
  const today = lagosDate(now);
  const byName = (n: string) => h.types.find((t) => t.name === n) ?? h.types[0];
  const std = byName('Standard Queen');
  const dlx = byName('Deluxe King');
  const suite = byName('Palm Suite');
  let n = 0;
  const hoursAgo = (x: number) => new Date(now.getTime() - x * HOUR);
  const hotelMail = h.property.email || 'stay@palmwine.ng';

  // 1. Marketplace, paid by card, arriving in 6 days.
  {
    const created = hoursAgo(26);
    const s = await createStay(tx, { h, rand, guest: { name: 'Tolulope Adesanya', phone: '+2348091112233', email: 'tolu.adesanya@example.ng' }, type: dlx, arrival: addDays(today, 6), nights: 2, source: 'MARKETPLACE', status: 'CONFIRMED', paymentMode: 'ONLINE', createdAt: created, notes: '', specialRequests: 'Late arrival around 22:00, please hold the room.' });
    await payOnline(tx, h, s, new Date(created.getTime() + 6 * 60_000), { channel: 'card' });
    await tx.reservation.update({ where: { id: s.r.id }, data: { guaranteeType: 'PREPAID' } });
    await logMessages(tx, h, s.r.id, s.r.code, created, [
      { template: 'BOOKING_CONFIRMED', channel: 'EMAIL', to: 'tolu.adesanya@example.ng', subject: `Booking confirmed: The Palmwine House (${s.r.code})`, text: `Your room at The Palmwine House is confirmed. Booking code ${s.r.code}.` },
      { template: 'BOOKING_CONFIRMED', channel: 'SMS', to: '+2348091112233', subject: null, text: `The Palmwine House: booking ${s.r.code} confirmed. Show ${s.r.code} at check-in.` },
      { template: 'PAYMENT_RECEIPT', channel: 'EMAIL', to: 'tolu.adesanya@example.ng', subject: `Receipt for booking ${s.r.code}`, text: 'Payment received.' },
      { template: 'HOTEL_NEW_BOOKING', channel: 'EMAIL', to: hotelMail, subject: `New marketplace booking ${s.r.code}`, text: 'New online booking.', audience: 'HOTEL' },
    ]);
    n++;
  }
  // 2. Booking site (no commission), paid by bank transfer, arriving in 12 days.
  {
    const created = hoursAgo(50);
    const s = await createStay(tx, { h, rand, guest: { name: 'Ngozi Chukwuemeka', phone: '+2348062223344', email: 'ngozi.c@example.ng' }, type: std, arrival: addDays(today, 12), nights: 3, source: 'BOOKING_SITE', status: 'CONFIRMED', paymentMode: 'ONLINE', createdAt: created, notes: '' });
    await payOnline(tx, h, s, new Date(created.getTime() + 9 * 60_000), { channel: 'bank_transfer' });
    await tx.reservation.update({ where: { id: s.r.id }, data: { guaranteeType: 'PREPAID' } });
    n++;
  }
  // 3. Pay at hotel via the marketplace (commission accrued), demo guest, arriving in 9 days.
  {
    const created = hoursAgo(72);
    const s = await createStay(tx, { h, rand, guest: { name: DEMO_GUEST.fullName, phone: DEMO_GUEST.phone, email: DEMO_GUEST.email, accountId: demoAccountId }, type: suite, arrival: addDays(today, 9), nights: 2, source: 'MARKETPLACE', status: 'CONFIRMED', paymentMode: 'PAY_AT_HOTEL', createdAt: created, notes: '', specialRequests: 'Anniversary: a quiet room if possible.' });
    const c = commissionFor(s.quote.totalKobo, h.commissionBps);
    if (c > 0) {
      await tx.commissionEntry.create({ data: { tenantId: h.tenantId, propertyId: h.property.id, reservationId: s.r.id, kind: 'ACCRUED', amountKobo: c, baseKobo: s.quote.totalKobo, commissionBps: h.commissionBps, channel: 'MARKETPLACE', note: 'Pay-at-hotel marketplace booking (receivable)', createdAt: created } });
    }
    await logMessages(tx, h, s.r.id, s.r.code, created, [
      { template: 'PAY_AT_HOTEL_CONFIRMED', channel: 'EMAIL', to: DEMO_GUEST.email, subject: `Booking confirmed: The Palmwine House (${s.r.code}), pay at the hotel`, text: 'Booking confirmed. You pay at the hotel.' },
      { template: 'PAY_AT_HOTEL_CONFIRMED', channel: 'SMS', to: DEMO_GUEST.phone, subject: null, text: `The Palmwine House: booking ${s.r.code} confirmed. Pay at the hotel.` },
    ]);
    n++;
  }
  // 4. Pay at hotel on the booking site, arriving tomorrow.
  {
    const created = hoursAgo(5);
    await createStay(tx, { h, rand, guest: { name: 'Yakubu Garba', phone: '+2348033334455', email: null }, type: std, arrival: addDays(today, 1), nights: 1, source: 'BOOKING_SITE', status: 'CONFIRMED', paymentMode: 'PAY_AT_HOTEL', createdAt: created, notes: '' });
    n++;
  }
  // 5. Paid, then cancelled by the guest inside the free window: full refund, commission reversed.
  {
    const created = hoursAgo(96);
    const s = await createStay(tx, { h, rand, guest: { name: 'Damilola Fashola', phone: '+2348024445566', email: 'dami.fashola@example.ng' }, type: dlx, arrival: addDays(today, 14), nights: 2, source: 'MARKETPLACE', status: 'CANCELLED', paymentMode: 'ONLINE', createdAt: created, notes: '' });
    const paidAt = new Date(created.getTime() + 5 * 60_000);
    const p = await payOnline(tx, h, s, paidAt, { channel: 'card', status: 'REFUNDED' });
    const cancelledAt = hoursAgo(30);
    await tx.folioEntry.create({
      data: { tenantId: h.tenantId, propertyId: h.property.id, folioId: s.folio.id, type: 'REFUND', amountKobo: p.amount, description: 'Refund (online payment)', businessDate: dbDate(lagosDate(cancelledAt)), paymentMethod: 'CARD_ONLINE', paymentRef: p.reference, reason: 'Guest cancellation', createdAt: cancelledAt },
    });
    await tx.bookingRefund.create({
      data: { tenantId: h.tenantId, paymentId: p.pay.id, reservationId: s.r.id, amountKobo: p.amount, reason: 'GUEST_CANCELLED', status: 'PROCESSED', providerRefundId: 'mock_rf_seed01', attempts: 1, requestedBy: 'Guest (Damilola Fashola)', processedAt: new Date(cancelledAt.getTime() + 30_000), createdAt: cancelledAt },
    });
    if (p.commission > 0) {
      await tx.commissionEntry.create({ data: { tenantId: h.tenantId, propertyId: h.property.id, reservationId: s.r.id, paymentId: p.pay.id, kind: 'REVERSED', accrual: false, amountKobo: p.commission, baseKobo: p.amount, commissionBps: s.bps, channel: 'MARKETPLACE', note: 'Guest cancellation refund', createdAt: cancelledAt } });
    }
    await tx.reservation.update({ where: { id: s.r.id }, data: { cancelledAt, cancelledBy: 'GUEST', cancelReason: 'Trip moved to next month', cancellationFeeKobo: 0 } });
    await logMessages(tx, h, s.r.id, s.r.code, cancelledAt, [
      { template: 'BOOKING_CANCELLED', channel: 'EMAIL', to: 'dami.fashola@example.ng', subject: `Cancelled: The Palmwine House (${s.r.code})`, text: 'Your booking is cancelled and the refund is on its way.' },
      { template: 'HOTEL_BOOKING_CANCELLED', channel: 'EMAIL', to: hotelMail, subject: `Cancelled by guest: ${s.r.code}`, text: 'The guest cancelled.', audience: 'HOTEL' },
    ]);
    n++;
  }
  // 6. Hold that expired unpaid this morning.
  {
    const created = hoursAgo(3);
    const s = await createStay(tx, { h, rand, guest: { name: 'Precious Okafor', phone: '+2348145556677', email: 'precious.o@example.ng' }, type: std, arrival: addDays(today, 4), nights: 1, source: 'MARKETPLACE', status: 'CANCELLED', paymentMode: 'ONLINE', createdAt: created, notes: '' });
    const expiresAt = new Date(created.getTime() + 20 * 60_000);
    await tx.reservation.update({ where: { id: s.r.id }, data: { holdExpiresAt: expiresAt, cancelledAt: expiresAt, cancelReason: HOLD_EXPIRED_REASON, cancelledBy: 'SYSTEM' } });
    await tx.bookingPayment.create({
      data: { tenantId: h.tenantId, propertyId: h.property.id, reservationId: s.r.id, reference: `BKG_seedexp${s.r.code.slice(-4)}`, provider: 'mock', status: 'INITIALIZED', amountKobo: s.quote.totalKobo, commissionKobo: commissionFor(s.quote.totalKobo, s.bps), commissionBps: s.bps, subaccountCode: 'ACCT_mockseed', callbackUrl: 'http://localhost:3000/booking/confirmation', email: 'precious.o@example.ng', authorizationUrl: `http://localhost:3000/pay/mock?reference=BKG_seedexp${s.r.code.slice(-4)}`, createdAt: created },
    });
    await logMessages(tx, h, s.r.id, s.r.code, expiresAt, [
      { template: 'HOLD_EXPIRED', channel: 'EMAIL', to: 'precious.o@example.ng', subject: 'Your hold at The Palmwine House has expired', text: 'We released the room because payment was not completed in time.' },
    ]);
    n++;
  }
  // 7. Orphaned payment: paid after the hold expired and the last suite was gone; refund failed at the bank (retry from the console).
  {
    const created = hoursAgo(20);
    const s = await createStay(tx, { h, rand, guest: { name: 'Kingsley Umeh', phone: '+2348156667788', email: 'kingsley.umeh@example.ng' }, type: suite, arrival: addDays(today, 3), nights: 1, source: 'MARKETPLACE', status: 'CANCELLED', paymentMode: 'ONLINE', createdAt: created, notes: '' });
    const expiresAt = new Date(created.getTime() + 20 * 60_000);
    await tx.reservation.update({ where: { id: s.r.id }, data: { holdExpiresAt: expiresAt, cancelledAt: expiresAt, cancelReason: HOLD_EXPIRED_REASON, cancelledBy: 'SYSTEM' } });
    const paidAt = new Date(created.getTime() + 34 * 60_000);
    const p = await payOnline(tx, h, s, paidAt, { channel: 'bank_transfer', status: 'ORPHANED', orphanReason: 'LATE_NO_INVENTORY', receipt: false });
    await tx.folioEntry.create({
      data: { tenantId: h.tenantId, propertyId: h.property.id, folioId: s.folio.id, type: 'REFUND', amountKobo: p.amount, description: 'Refund (online payment)', businessDate: dbDate(lagosDate(paidAt)), paymentMethod: 'CARD_ONLINE', paymentRef: p.reference, reason: 'The payment arrived after the 20-minute hold ended and the room had been sold.', createdAt: paidAt },
    });
    if (p.commission > 0) {
      await tx.commissionEntry.create({ data: { tenantId: h.tenantId, propertyId: h.property.id, reservationId: s.r.id, paymentId: p.pay.id, kind: 'REVERSED', accrual: false, amountKobo: p.commission, baseKobo: p.amount, commissionBps: s.bps, channel: 'MARKETPLACE', note: 'Orphaned payment refunded in full', createdAt: paidAt } });
    }
    await tx.bookingRefund.create({
      data: { tenantId: h.tenantId, paymentId: p.pay.id, reservationId: s.r.id, amountKobo: p.amount, reason: 'PAYMENT_ORPHANED', status: 'FAILED', attempts: 1, error: 'Refund declined by the customer bank (account restricted). Retry or refund by transfer.', requestedBy: 'System', createdAt: paidAt },
    });
    await tx.guardFlag.create({
      data: {
        tenantId: h.tenantId,
        propertyId: h.property.id,
        rule: 'PAYMENT_ORPHANED',
        severity: 'HIGH',
        title: `Online payment for ${s.r.code} could not be applied`,
        detail: `The payment arrived after the 20-minute hold ended and the room had been sold. The refund to Kingsley Umeh failed and needs a retry.`,
        amountKobo: p.amount,
        reservationId: s.r.id,
        dedupeKey: `PAYMENT_ORPHANED:${p.pay.id}`,
        evidence: { reference: p.reference, reason: 'LATE_NO_INVENTORY', amountKobo: p.amount },
        suggestion: 'No action needed unless the refund fails; the platform team is alerted too.',
        createdAt: paidAt,
      },
    });
    n++;
  }
  // 8. The live hold: about 15 minutes left at seed time.
  {
    const created = new Date(now.getTime() - 5 * 60_000);
    const s = await createStay(tx, { h, rand, guest: { name: 'Seyi Oladipo', phone: '+2348077778899', email: 'seyi.oladipo@example.ng' }, type: dlx, arrival: addDays(today, 7), nights: 2, source: 'MARKETPLACE', status: 'PENDING', paymentMode: 'ONLINE', createdAt: created, notes: '' });
    const ref = `BKG_seedhold${s.r.code.slice(-4)}`;
    await tx.reservation.update({ where: { id: s.r.id }, data: { holdExpiresAt: new Date(created.getTime() + 20 * 60_000) } });
    await tx.bookingPayment.create({
      data: { tenantId: h.tenantId, propertyId: h.property.id, reservationId: s.r.id, reference: ref, provider: 'mock', status: 'INITIALIZED', amountKobo: s.quote.totalKobo, commissionKobo: commissionFor(s.quote.totalKobo, s.bps), commissionBps: s.bps, subaccountCode: 'ACCT_mockseed', callbackUrl: 'http://localhost:3000/booking/confirmation', email: 'seyi.oladipo@example.ng', authorizationUrl: `http://localhost:3000/pay/mock?reference=${ref}`, createdAt: created },
    });
    n++;
  }
  // 9. Demo guest: a completed online stay last week (review still possible), with invoice and receipt.
  {
    const arrival = addDays(today, -7);
    const created = lagosDateTime(addDays(arrival, -10), '11:20');
    const s = await createStay(tx, { h, rand, guest: { name: DEMO_GUEST.fullName, phone: DEMO_GUEST.phone, email: DEMO_GUEST.email, accountId: demoAccountId }, type: dlx, arrival, nights: 2, source: 'MARKETPLACE', status: 'CHECKED_OUT', paymentMode: 'ONLINE', createdAt: created, notes: '' });
    await payOnline(tx, h, s, new Date(created.getTime() + 7 * 60_000), { channel: 'card' });
    await postNights(tx, h, s.folio.id, arrival, 2, dlx.basePriceKobo, null);
    await tx.reservation.update({ where: { id: s.r.id }, data: { guaranteeType: 'PREPAID' } });
    const f = await folioLike(tx, s.folio.id);
    const at = s.checkedOutAt!;
    const receipts = await tx.receipt.findMany({ where: { folioId: s.folio.id } });
    const num = await nextNumber(tx, h, 'INVOICE', lagosYear(at));
    const doc = buildInvoiceDocument({ folio: f, receiptNumbers: new Map(receipts.map((r) => [r.entryId, r.number])), hotel: h.header, number: num.number, kind: 'FINAL', issuedAt: at, issuer: null });
    const id = randomUUID();
    await tx.guestInvoice.create({
      data: { id, tenantId: h.tenantId, propertyId: h.property.id, folioId: s.folio.id, kind: 'FINAL', number: num.number, year: lagosYear(at), seq: num.seq, issuedAt: at, businessDate: dbDate(lagosDate(at)), totalKobo: doc.totals.totalKobo, balanceKobo: doc.totals.balanceKobo, guestName: doc.guest?.fullName ?? f.name, reservationCode: s.r.code, document: { ...doc, id } as unknown as Prisma.InputJsonValue },
    });
    n++;
  }
  return n;
}

/** Demo guest's upcoming marketplace booking at another hotel (paid online). */
async function seedDemoTripElsewhere(tx: Tx, h: HotelCtx, now: Date, demoAccountId: string) {
  const rand = prng(nameHash(`${h.property.slug}:demo`));
  const type = h.types[0];
  const created = new Date(now.getTime() - 40 * HOUR);
  const s = await createStay(tx, {
    h,
    rand,
    guest: { name: DEMO_GUEST.fullName, phone: DEMO_GUEST.phone, email: DEMO_GUEST.email, accountId: demoAccountId },
    type,
    arrival: addDays(lagosDate(now), 18),
    nights: 3,
    source: 'MARKETPLACE',
    status: 'CONFIRMED',
    paymentMode: 'ONLINE',
    createdAt: created,
    notes: SEED_MARK,
  });
  await payOnline(tx, h, s, new Date(created.getTime() + 8 * 60_000), { channel: 'card' });
  await tx.reservation.update({ where: { id: s.r.id }, data: { guaranteeType: 'PREPAID' } });
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

export async function seedGuestSide(prisma: PrismaClient, demoSlug: string, appName: string, now = new Date()): Promise<Record<string, number>> {
  const key = process.env.GUEST_DATA_KEY;
  if (!key) throw new Error('GUEST_DATA_KEY must be set to seed payout accounts');
  const cipher = new FieldCipher(key);
  const { payouts } = await seedSettings(prisma, cipher);

  const account = await prisma.guestAccount.upsert({
    where: { phone: DEMO_GUEST.phone },
    create: { phone: DEMO_GUEST.phone, fullName: DEMO_GUEST.fullName, email: DEMO_GUEST.email },
    update: { fullName: DEMO_GUEST.fullName, email: DEMO_GUEST.email },
  });

  let reviews = 0;
  let online = 0;
  for (const slug of Object.keys(REVIEWS)) {
    const h = await hotelCtx(prisma, slug, appName);
    if (!h || !h.types.length) continue;
    await prisma.$transaction(
      async (tx) => {
        if (slug !== demoSlug) await clearSeeded(tx, h.tenantId);
        reviews += await seedReviews(tx, h, REVIEWS[slug], now, account.id);
        if (slug === demoSlug) online += await seedPalmwineOnline(tx, h, now, account.id);
        if (slug === 'eko-tides') await seedDemoTripElsewhere(tx, h, now, account.id);
        await recompute(tx, h.property.id);
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
  }
  // Every hotel record with the demo phone belongs to the demo account (as after an OTP sign-in).
  await prisma.guest.updateMany({ where: { phone: DEMO_GUEST.phone }, data: { guestAccountId: account.id } });
  const trips = await prisma.reservation.count({ where: { OR: [{ guestAccountId: account.id }, { guest: { guestAccountId: account.id } }] } });
  return { payouts, reviews, onlineBookings: online, demoGuestTrips: trips };
}
