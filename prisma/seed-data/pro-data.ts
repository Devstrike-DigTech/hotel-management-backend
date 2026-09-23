/**
 * M5 demo data, part 2 (runs after the operations, guest-side and growth
 * seeds): Ikoyi stays, POS, channels, pricing, inbox, loyalty and domains.
 */
import { createHash } from 'node:crypto';
import type { Folio, Guest, Prisma, PrismaClient, Property, Reservation, Room, RoomType } from '../../src/generated/prisma/client.js';
import type { TaxComponent } from '../../src/modules/folios/tax.logic.js';
import { orderTotals, type TotalsLine } from '../../src/modules/pos/pos.logic.js';
import { relevantCompetitors, suggest, type EngineInput } from '../../src/modules/pricing/engine.js';
import { barForNight } from '../../src/modules/rates/rates.logic.js';
import { toRuleLike } from '../../src/modules/rates/rates.service.js';
import { IMPACT_BPS, nationalEventsBetween } from '../../src/modules/pricing/events.js';
import { earnPoints, memberNumber, tierFor } from '../../src/modules/loyalty/loyalty.logic.js';
import { mockRatePlanId, mockRoomTypeId } from '../../src/modules/channels/channel-provider.js';
import { DEMO_GUEST } from './guest-side.js';
import {
  addDays,
  createStay,
  DAY,
  dateRange,
  dbDate,
  HOUR,
  IKOYI_SLUG,
  lagosDate,
  lagosDateTime,
  lagosYear,
  MIN,
  NAIRA,
  postCharge,
  prng,
  randomUUID,
  taxComponents,
  type SeedCtx,
} from './pro.js';

type Person = { id: string; fullName: string };

export async function seedPro(prisma: PrismaClient, tenantSlug: string): Promise<Record<string, number>> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } });
  const tenantId = tenant.id;
  const lekki = await prisma.property.findFirstOrThrow({ where: { tenantId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const ikoyi = await prisma.property.findUniqueOrThrow({ where: { slug: IKOYI_SLUG } });
  const now = new Date();
  const today = lagosDate(now);
  const users = new Map<string, Person>((await prisma.user.findMany({ where: { tenantId } })).map((u) => [u.email, { id: u.id, fullName: u.fullName }]));
  const U = (email: string) => users.get(email)!;
  const ctx: SeedCtx = {
    prisma,
    tenantId,
    now,
    today,
    rand: prng(20260924),
    users,
    codes: new Set((await prisma.reservation.findMany({ where: { tenantId }, select: { code: true } })).map((r) => r.code)),
  };
  const counts: Record<string, number> = {};

  // Ikoyi settings the operations reset cleared (tax, digest) and its rates.
  const lekkiTax = await prisma.taxSetting.findUniqueOrThrow({ where: { propertyId: lekki.id } });
  const { id: _i, propertyId: _p, createdAt: _c, updatedAt: _u, ...taxCopy } = lekkiTax;
  await prisma.taxSetting.upsert({ where: { propertyId: ikoyi.id }, create: { ...taxCopy, propertyId: ikoyi.id }, update: { ...taxCopy } });
  await prisma.digestSetting.upsert({ where: { propertyId: ikoyi.id }, create: { tenantId, propertyId: ikoyi.id, enabled: true, recipients: ['+2348031234567'] }, update: {} });
  const lekkiComps = await taxComponents(prisma, lekki.id);
  const ikoyiComps = await taxComponents(prisma, ikoyi.id);

  const typesOf = async (p: Property) => new Map((await prisma.roomType.findMany({ where: { propertyId: p.id } })).map((t) => [t.name, t]));
  const roomsOf = async (p: Property) => new Map((await prisma.room.findMany({ where: { propertyId: p.id } })).map((r) => [r.number, r]));
  const lekkiTypes = await typesOf(lekki);
  const ikoyiTypes = await typesOf(ikoyi);
  const lekkiRooms = await roomsOf(lekki);
  const ikoyiRooms = await roomsOf(ikoyi);

  // ---------------------------------------------------------------------------
  // Ikoyi stays: past, in house and arriving (some guests also stay at Lekki)
  // ---------------------------------------------------------------------------
  const guests = await prisma.guest.findMany({ where: { tenantId, anonymisedAt: null }, orderBy: { createdAt: 'asc' } });
  const byPhone = new Map(guests.map((g) => [g.phone ?? '', g]));
  const lekkiNights = await prisma.$queryRaw<{ guest_id: string; nights: number }[]>`
    SELECT guest_id::text, COALESCE(SUM((departure_at AT TIME ZONE 'Africa/Lagos')::date - (arrival_at AT TIME ZONE 'Africa/Lagos')::date), 0)::int AS nights
      FROM reservations WHERE tenant_id = ${tenantId}::uuid AND status = 'CHECKED_OUT' AND stay_type = 'NIGHTLY' GROUP BY guest_id ORDER BY 2 DESC`;
  const topGuests = lekkiNights.map((r) => guests.find((g) => g.id === r.guest_id)).filter((g): g is Guest => !!g);
  const newGuest = async (fullName: string, phone: string, email: string | null, extra: Partial<Guest> = {}) =>
    prisma.guest.upsert({
      where: { tenantId_phone: { tenantId, phone } },
      create: { tenantId, fullName, phone, email, consentAt: new Date(now.getTime() - 60 * DAY), ...extra },
      update: { fullName },
    });
  const ikoyiGuests = [
    await newGuest('Olumide Bakare', '+2348025557101', 'olumide.bakare@mail.ng', { company: 'Stanbic IBTC' }),
    await newGuest('Hadiza Abubakar', '+2348065557102', 'hadiza.abubakar@mail.ng'),
    await newGuest('Tobi Oyedepo', '+2348095557103', null),
    await newGuest('Amarachi Nwosu', '+2348135557104', 'amarachi.n@mail.ng', { vip: true }),
    await newGuest('Kunle Adesanya', '+2348145557105', 'kunle.adesanya@mail.ng', { company: 'Dangote Group' }),
    await newGuest('Efe Ighodaro', '+2348155557106', null),
    await newGuest('Yetunde Lawal', '+2348165557107', 'yetunde.lawal@mail.ng'),
    await newGuest('Ibrahim Danjuma', '+2348175557108', 'i.danjuma@mail.ng', { company: 'NNPC Ltd' }),
  ];
  const demoGuest = byPhone.get(DEMO_GUEST.phone) ?? (await newGuest(DEMO_GUEST.fullName, DEMO_GUEST.phone, DEMO_GUEST.email));
  const kelechi = U('kelechi@palmwine.ng');
  const IT = (n: string) => ikoyiTypes.get(n)!;
  const IR = (n: string) => ikoyiRooms.get(n)!;
  const ikoyiStay = (g: Guest, type: string, room: string | null, arrival: string, departure: string, status: Reservation['status'], createdDaysBefore = 9, extra: Partial<Parameters<typeof createStay>[1]> = {}) =>
    createStay(ctx, {
      property: ikoyi,
      roomType: IT(type),
      room: room ? IR(room) : null,
      guestId: g.id,
      guestName: g.fullName,
      arrival,
      departure,
      status,
      createdAt: new Date(lagosDateTime(arrival, '10:00').getTime() - createdDaysBefore * DAY),
      checkedInBy: kelechi.id,
      comps: ikoyiComps,
      source: 'PHONE',
      ...extra,
    });
  const T = today;
  // Past stays (checked out). Top Lekki guests also stay in Ikoyi (Gold tier material).
  const past: [Guest, string, string, number, number][] = [
    [topGuests[0] ?? ikoyiGuests[0], 'Executive King', '201', -26, -22],
    [topGuests[1] ?? ikoyiGuests[1], 'Executive King', '202', -20, -17],
    [topGuests[2] ?? ikoyiGuests[2], 'Classic Queen', '101', -18, -15],
    [demoGuest, 'Classic Queen', '102', -24, -21],
    [demoGuest, 'Executive King', '204', -45, -42],
    [ikoyiGuests[0], 'Executive King', '203', -14, -11],
    [ikoyiGuests[1], 'Classic Queen', '103', -12, -10],
    [ikoyiGuests[2], 'Classic Queen', '104', -9, -7],
    [ikoyiGuests[3], 'Ikoyi Loft Suite', '301', -11, -8],
    [ikoyiGuests[4], 'Executive King', '204', -7, -4],
    [ikoyiGuests[5], 'Classic Queen', '105', -6, -3],
    [ikoyiGuests[6], 'Classic Queen', '106', -5, -2],
    [ikoyiGuests[7], 'Ikoyi Loft Suite', '302', -4, -1],
    [topGuests[3] ?? ikoyiGuests[3], 'Classic Queen', '101', -3, -1],
  ];
  const ikoyiPast: { reservation: Reservation; folio: Folio }[] = [];
  for (const [g, type, room, a, d] of past) {
    ikoyiPast.push(await ikoyiStay(g, type, room, addDays(T, a), addDays(T, d), 'CHECKED_OUT', 6, { payMethod: d % 2 ? 'TRANSFER' : 'POS' }));
  }
  // The demo guest is a Silver member (10+ nights in 12 months): top up with an earlier Ikoyi stay.
  const demoNights = Number(
    (
      await prisma.$queryRaw<{ n: number }[]>`
        SELECT COALESCE(SUM((departure_at AT TIME ZONE 'Africa/Lagos')::date - (arrival_at AT TIME ZONE 'Africa/Lagos')::date), 0)::int AS n
          FROM reservations WHERE guest_id = ${demoGuest.id}::uuid AND status = 'CHECKED_OUT' AND stay_type = 'NIGHTLY' AND departure_at >= now() - interval '365 days'`
    )[0]?.n ?? 0,
  );
  if (demoNights < 11) ikoyiPast.push(await ikoyiStay(demoGuest, 'Classic Queen', '105', addDays(T, -75), addDays(T, -75 + (11 - demoNights)), 'CHECKED_OUT', 10, { payMethod: 'POS' }));

  // In house now.
  const inHouseIkoyi = [
    await ikoyiStay(ikoyiGuests[4], 'Executive King', '201', addDays(T, -2), addDays(T, 2), 'CHECKED_IN'),
    await ikoyiStay(ikoyiGuests[7], 'Executive King', '203', addDays(T, -1), addDays(T, 1), 'CHECKED_IN'),
    await ikoyiStay(ikoyiGuests[1], 'Classic Queen', '102', addDays(T, -3), addDays(T, 1), 'CHECKED_IN'),
    await ikoyiStay(topGuests[4] ?? ikoyiGuests[5], 'Ikoyi Loft Suite', '301', addDays(T, -1), addDays(T, 3), 'CHECKED_IN'),
    await ikoyiStay(ikoyiGuests[6], 'Classic Queen', '104', T, addDays(T, 2), 'CHECKED_IN'),
  ];
  for (const s of inHouseIkoyi) await prisma.room.update({ where: { id: s.reservation.roomId! }, data: { status: 'OCCUPIED' } });
  await prisma.room.update({ where: { id: IR('106').id }, data: { status: 'VACANT_DIRTY' } });
  // Arriving.
  await ikoyiStay(ikoyiGuests[0], 'Executive King', null, T, addDays(T, 2), 'CONFIRMED', 5);
  await ikoyiStay(ikoyiGuests[2], 'Classic Queen', null, addDays(T, 1), addDays(T, 3), 'CONFIRMED', 12);
  await ikoyiStay(demoGuest, 'Executive King', null, addDays(T, 9), addDays(T, 12), 'CONFIRMED', 3);
  await ikoyiStay(ikoyiGuests[5], 'Ikoyi Loft Suite', null, addDays(T, 4), addDays(T, 6), 'CONFIRMED', 20);
  await ikoyiStay(ikoyiGuests[3], 'Classic Queen', null, addDays(T, 6), addDays(T, 8), 'CONFIRMED', 2);
  counts.ikoyiStays = past.length + inHouseIkoyi.length + 5;

  // ---------------------------------------------------------------------------
  // Point of sale
  // ---------------------------------------------------------------------------
  counts.posOrders = await seedPos(ctx, { lekki, ikoyi, lekkiComps, ikoyiComps, lekkiTypes, ikoyiTypes });

  // ---------------------------------------------------------------------------
  // Channel manager (Lekki)
  // ---------------------------------------------------------------------------
  counts.otaBookings = await seedChannels(ctx, { lekki, lekkiTypes, lekkiRooms, comps: lekkiComps });

  // ---------------------------------------------------------------------------
  // Dynamic pricing
  // ---------------------------------------------------------------------------
  counts.priceSuggestions = await seedPricing(ctx, { lekki, ikoyi, lekkiTypes, ikoyiTypes });

  // ---------------------------------------------------------------------------
  // Guest inbox
  // ---------------------------------------------------------------------------
  counts.conversations = await seedInbox(ctx, { lekki, ikoyi, lekkiRooms, demoGuest });

  // ---------------------------------------------------------------------------
  // Loyalty
  // ---------------------------------------------------------------------------
  counts.loyaltyMembers = await seedLoyalty(ctx, { lekki, ikoyi, demoGuest });

  // ---------------------------------------------------------------------------
  // Custom domains
  // ---------------------------------------------------------------------------
  const token = (s: string) => createHash('sha256').update(`seed-domain:${s}`).digest('hex').slice(0, 32);
  const verifiedAt = new Date(now.getTime() - 20 * DAY);
  await prisma.customDomain.create({
    data: { tenantId, propertyId: lekki.id, domain: 'book.thepalmwinehouse.com', status: 'VERIFIED', token: token('lekki'), txtOk: true, cnameOk: true, checkCount: 9, lastCheckedAt: new Date(now.getTime() - 6 * HOUR), verifiedAt, createdAt: new Date(verifiedAt.getTime() - 2 * HOUR) },
  });
  await prisma.property.update({ where: { id: lekki.id }, data: { customDomain: 'book.thepalmwinehouse.com', customDomainVerifiedAt: verifiedAt } });
  await prisma.customDomain.create({
    data: { tenantId, propertyId: ikoyi.id, domain: 'stay.palmwineikoyi.com', status: 'PENDING', token: token('ikoyi'), txtOk: true, cnameOk: false, failures: ['CNAME_MISSING'], checkCount: 4, lastCheckedAt: new Date(now.getTime() - 25 * MIN), createdAt: new Date(now.getTime() - 5 * HOUR) },
  });
  counts.domains = 2;
  return counts;
}

// =============================================================================
// POS
// =============================================================================

interface MenuItem {
  name: string;
  priceNaira: number;
  outlets?: string[];
  description?: string;
  modifiers?: { id: string; name: string; required: boolean; multiple: boolean; options: [string, number][] }[];
  stock?: [string, number][];
  vat?: boolean;
  consumption?: boolean;
}

const LEKKI_MENU: { category: string; station: 'KITCHEN' | 'BAR' | 'NONE'; items: MenuItem[] }[] = [
  {
    category: 'Mains',
    station: 'KITCHEN',
    items: [
      {
        name: 'Party jollof rice',
        priceNaira: 9_500,
        description: 'Smoky firewood jollof with fried plantain.',
        modifiers: [
          { id: 'protein', name: 'Protein', required: true, multiple: false, options: [['Chicken', 0], ['Beef', 0], ['Turkey', 1_500], ['Croaker fish', 2_500]] },
          { id: 'extras', name: 'Extras', required: false, multiple: true, options: [['Extra dodo', 1_500], ['Moi moi', 1_500], ['Coleslaw', 800]] },
        ],
        stock: [['Long grain rice', 0.25], ['Chicken (whole)', 0.25]],
      },
      {
        name: 'Ofada rice and ayamase',
        priceNaira: 11_000,
        description: 'Local ofada rice with green pepper stew, assorted meat and boiled egg.',
        stock: [['Ofada rice', 0.25]],
      },
      { name: 'Seafood fried rice', priceNaira: 12_500, description: 'With prawns, calamari and diced liver.', stock: [['Long grain rice', 0.25]] },
      { name: 'Grilled croaker and plantain', priceNaira: 18_500, description: 'Whole croaker, pepper sauce, dodo.', stock: [['Croaker fish', 1]] },
    ],
  },
  {
    category: 'Grills and small chops',
    station: 'KITCHEN',
    items: [
      {
        name: 'Suya platter',
        priceNaira: 7_500,
        description: 'Beef suya with yaji, sliced onions and tomatoes.',
        outlets: ['YARD', 'PBAR', 'RSVC'],
        modifiers: [{ id: 'heat', name: 'Heat', required: true, multiple: false, options: [['Mild', 0], ['Hot', 0], ['Very hot', 0]] }],
        stock: [['Beef (suya cut)', 0.3]],
      },
      { name: 'Peppered snail', priceNaira: 12_000, outlets: ['YARD', 'PBAR', 'RSVC'], description: 'Giant land snails in a rich pepper sauce.' },
      { name: 'Asun', priceNaira: 8_500, outlets: ['YARD', 'PBAR', 'RSVC'], description: 'Smoked spicy goat meat.', stock: [['Goat meat', 0.3]] },
      { name: 'Small chops platter', priceNaira: 6_500, outlets: ['YARD', 'PBAR', 'RSVC'], description: 'Puff-puff, samosa, spring rolls and gizzard.' },
      { name: 'Peppered gizzard', priceNaira: 5_500, outlets: ['YARD', 'PBAR', 'RSVC'] },
    ],
  },
  {
    category: 'Soups and swallow',
    station: 'KITCHEN',
    items: [
      { name: 'Catfish pepper soup', priceNaira: 9_000, description: 'Point-and-kill catfish, uziza and scent leaves.', stock: [['Catfish', 1]] },
      { name: 'Goat meat pepper soup', priceNaira: 7_500, stock: [['Goat meat', 0.3]] },
      {
        name: 'Egusi soup with swallow',
        priceNaira: 10_000,
        modifiers: [{ id: 'swallow', name: 'Swallow', required: true, multiple: false, options: [['Pounded yam', 0], ['Eba', 0], ['Semovita', 0], ['Amala', 0]] }],
      },
      { name: 'Efo riro with amala', priceNaira: 9_500 },
    ],
  },
  {
    category: 'Breakfast',
    station: 'KITCHEN',
    items: [
      { name: 'Yam and egg sauce', priceNaira: 6_000, outlets: ['YARD', 'RSVC'] },
      { name: 'Akara and pap', priceNaira: 4_500, outlets: ['YARD', 'RSVC'] },
      { name: 'Full English breakfast', priceNaira: 8_500, outlets: ['YARD', 'RSVC'] },
    ],
  },
  {
    category: 'Cocktails and mocktails',
    station: 'BAR',
    items: [
      { name: 'Chapman', priceNaira: 4_000, outlets: ['YARD', 'PBAR', 'RSVC'], description: 'Fanta, Sprite, Angostura, cucumber and orange.' },
      { name: 'Palm wine calabash', priceNaira: 3_500, outlets: ['YARD', 'PBAR'], description: 'Fresh from our tapper in Epe.', stock: [['Palm wine', 1]] },
      { name: 'Zobo mojito', priceNaira: 5_500, outlets: ['PBAR'], description: 'Hibiscus, rum, lime and mint.' },
      { name: 'Classic mojito', priceNaira: 6_500, outlets: ['PBAR'] },
      { name: 'Chilled zobo', priceNaira: 2_500, outlets: ['YARD', 'PBAR', 'RSVC'] },
    ],
  },
  {
    category: 'Beer and stout',
    station: 'BAR',
    items: [
      { name: 'Star lager', priceNaira: 2_000, outlets: ['YARD', 'PBAR', 'RSVC'], stock: [['Star lager (60cl)', 1]] },
      { name: 'Gulder', priceNaira: 2_200, outlets: ['YARD', 'PBAR', 'RSVC'], stock: [['Gulder (60cl)', 1]] },
      { name: 'Heineken', priceNaira: 2_800, outlets: ['YARD', 'PBAR', 'RSVC'], stock: [['Heineken (33cl)', 1]] },
      { name: 'Guinness Foreign Extra', priceNaira: 2_500, outlets: ['YARD', 'PBAR', 'RSVC'], stock: [['Guinness FES (60cl)', 1]] },
    ],
  },
  {
    category: 'Wines and spirits',
    station: 'BAR',
    items: [
      {
        name: 'Hennessy VS (shot)',
        priceNaira: 6_000,
        outlets: ['PBAR', 'YARD'],
        modifiers: [{ id: 'mixer', name: 'Mixer', required: false, multiple: false, options: [['Coca-Cola', 1_000], ['Ginger ale', 1_000], ['Neat', 0]] }],
        stock: [['Hennessy VS (70cl)', 0.05]],
      },
      { name: 'Hennessy VS (bottle)', priceNaira: 95_000, outlets: ['PBAR'], stock: [['Hennessy VS (70cl)', 1]] },
      { name: 'House red wine (glass)', priceNaira: 5_000, outlets: ['YARD', 'PBAR', 'RSVC'] },
      { name: 'Moet Imperial (bottle)', priceNaira: 180_000, outlets: ['PBAR'] },
    ],
  },
  {
    category: 'Soft drinks and water',
    station: 'BAR',
    items: [
      { name: 'Coca-Cola', priceNaira: 1_200, outlets: ['YARD', 'PBAR', 'RSVC'], stock: [['Coca-Cola (35cl)', 1]] },
      { name: 'Malta Guinness', priceNaira: 1_500, outlets: ['YARD', 'PBAR', 'RSVC'] },
      { name: 'Eva water (75cl)', priceNaira: 800, outlets: ['YARD', 'PBAR', 'RSVC'], stock: [['Eva water (75cl)', 1]] },
      { name: 'Chivita 100% juice', priceNaira: 2_500, outlets: ['YARD', 'PBAR', 'RSVC'] },
    ],
  },
  {
    category: 'Minibar',
    station: 'NONE',
    items: [
      { name: 'Minibar Heineken', priceNaira: 3_000, outlets: ['MINI'], stock: [['Heineken (33cl)', 1]] },
      { name: 'Minibar Coca-Cola', priceNaira: 1_500, outlets: ['MINI'], stock: [['Coca-Cola (35cl)', 1]] },
      { name: 'Minibar Eva water', priceNaira: 1_000, outlets: ['MINI'], stock: [['Eva water (75cl)', 1]] },
      { name: 'Pringles', priceNaira: 3_500, outlets: ['MINI'] },
      { name: 'Roasted cashew nuts', priceNaira: 2_500, outlets: ['MINI'] },
    ],
  },
];

const IKOYI_MENU: typeof LEKKI_MENU = [
  {
    category: 'Terrace kitchen',
    station: 'KITCHEN',
    items: [
      { name: 'Party jollof rice with chicken', priceNaira: 10_500 },
      { name: 'Asun', priceNaira: 9_000 },
      { name: 'Catfish pepper soup', priceNaira: 9_500 },
      { name: 'Suya platter', priceNaira: 8_000 },
      { name: 'Akara and pap', priceNaira: 5_000 },
    ],
  },
  {
    category: 'Terrace bar',
    station: 'BAR',
    items: [
      { name: 'Chapman', priceNaira: 4_500 },
      { name: 'Palm wine calabash', priceNaira: 4_000 },
      { name: 'Star lager', priceNaira: 2_200 },
      { name: 'Hennessy VS (shot)', priceNaira: 6_500 },
      { name: 'Eva water (75cl)', priceNaira: 900 },
    ],
  },
];

const STOCK: [string, string, string, number, number, number][] = [
  // name, unit, category, onHand, reorder, unit cost (naira)
  ['Long grain rice', 'kg', 'Dry store', 38, 15, 1_450],
  ['Ofada rice', 'kg', 'Dry store', 11, 8, 2_200],
  ['Chicken (whole)', 'bird', 'Cold room', 14, 8, 7_500],
  ['Croaker fish', 'fish', 'Cold room', 6, 5, 6_800],
  ['Catfish', 'fish', 'Cold room', 9, 6, 4_200],
  ['Goat meat', 'kg', 'Cold room', 7.5, 5, 7_000],
  ['Beef (suya cut)', 'kg', 'Cold room', 4.2, 5, 6_500],
  ['Palm wine', 'calabash', 'Bar', 18, 10, 900],
  ['Star lager (60cl)', 'bottle', 'Bar', 72, 36, 850],
  ['Gulder (60cl)', 'bottle', 'Bar', 48, 24, 900],
  ['Heineken (33cl)', 'bottle', 'Bar', 64, 36, 1_150],
  ['Guinness FES (60cl)', 'bottle', 'Bar', 40, 24, 1_050],
  ['Hennessy VS (70cl)', 'bottle', 'Bar', 5, 3, 48_000],
  ['Coca-Cola (35cl)', 'bottle', 'Bar', 96, 48, 350],
  ['Eva water (75cl)', 'bottle', 'Bar', 120, 60, 280],
];

async function seedPos(
  ctx: SeedCtx,
  x: { lekki: Property; ikoyi: Property; lekkiComps: TaxComponent[]; ikoyiComps: TaxComponent[]; lekkiTypes: Map<string, RoomType>; ikoyiTypes: Map<string, RoomType> },
): Promise<number> {
  const { prisma, tenantId, now, today, rand } = ctx;
  const { lekki, ikoyi, lekkiComps, ikoyiComps } = x;
  const U = (e: string) => ctx.users.get(e)!;
  const yemi = U('yemi@palmwine.ng');
  const ngozi = U('ngozi@palmwine.ng');
  const tunde = U('tunde@palmwine.ng');

  // Outlets.
  const outlet = async (p: Property, code: string, name: string, type: 'RESTAURANT' | 'BAR' | 'ROOM_SERVICE' | 'MINIBAR', station: 'KITCHEN' | 'BAR' | 'NONE', sortOrder: number, serviceChargeApplies = false) =>
    prisma.posOutlet.create({ data: { tenantId, propertyId: p.id, code, name, type, defaultStation: station, sortOrder, serviceChargeApplies } });
  const outlets = new Map<string, Awaited<ReturnType<typeof outlet>>>();
  outlets.set('YARD', await outlet(lekki, 'YARD', 'The Yard', 'RESTAURANT', 'KITCHEN', 0, true));
  outlets.set('PBAR', await outlet(lekki, 'PBAR', 'Palm Bar', 'BAR', 'BAR', 1));
  outlets.set('RSVC', await outlet(lekki, 'RSVC', 'Room service', 'ROOM_SERVICE', 'KITCHEN', 2));
  outlets.set('MINI', await outlet(lekki, 'MINI', 'Minibar', 'MINIBAR', 'NONE', 3));
  const terrace = await outlet(ikoyi, 'TERR', 'The Terrace', 'RESTAURANT', 'KITCHEN', 0, true);

  // Stock.
  const stock = new Map<string, { id: string; unitCostKobo: number }>();
  for (const [name, unit, category, onHand, reorder, cost] of STOCK) {
    const s = await prisma.stockItem.create({
      data: { tenantId, propertyId: lekki.id, name, unit, category, onHand, reorderLevel: reorder, parLevel: reorder * 3, unitCostKobo: cost * NAIRA },
    });
    stock.set(name, { id: s.id, unitCostKobo: s.unitCostKobo });
  }

  // Menus.
  type ItemRow = { id: string; name: string; categoryId: string; categoryName: string; priceKobo: number; station: 'KITCHEN' | 'BAR' | 'NONE'; outletCodes: string[]; vat: boolean; consumption: boolean; modifiers: MenuItem['modifiers']; stock: [string, number][] };
  const items: ItemRow[] = [];
  for (const [i, cat] of LEKKI_MENU.entries()) {
    const c = await prisma.posCategory.create({ data: { tenantId, propertyId: lekki.id, name: cat.category, station: cat.station, sortOrder: i } });
    for (const [j, it] of cat.items.entries()) {
      const codes = it.outlets ?? ['YARD', 'RSVC'];
      const mods = (it.modifiers ?? []).map((g) => ({
        id: g.id,
        name: g.name,
        required: g.required,
        multiple: g.multiple,
        options: g.options.map(([n, p]) => ({ id: `${g.id}-${n.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name: n, priceKobo: p * NAIRA })),
      }));
      const row = await prisma.posItem.create({
        data: {
          tenantId,
          propertyId: lekki.id,
          categoryId: c.id,
          name: it.name,
          description: it.description ?? '',
          priceKobo: it.priceNaira * NAIRA,
          outletIds: codes.map((k) => outlets.get(k)!.id),
          modifiers: mods as unknown as Prisma.InputJsonValue,
          stockLinks: (it.stock ?? []).map(([n, q]) => ({ stockItemId: stock.get(n)!.id, quantity: q })) as unknown as Prisma.InputJsonValue,
          sortOrder: j,
          available: it.name !== 'Moet Imperial (bottle)',
        },
      });
      items.push({ id: row.id, name: it.name, categoryId: c.id, categoryName: cat.category, priceKobo: row.priceKobo, station: cat.station, outletCodes: codes, vat: true, consumption: true, modifiers: it.modifiers, stock: it.stock ?? [] });
    }
  }
  const ikoyiItems: ItemRow[] = [];
  for (const [i, cat] of IKOYI_MENU.entries()) {
    const c = await prisma.posCategory.create({ data: { tenantId, propertyId: ikoyi.id, name: cat.category, station: cat.station, sortOrder: i } });
    for (const [j, it] of cat.items.entries()) {
      const row = await prisma.posItem.create({ data: { tenantId, propertyId: ikoyi.id, categoryId: c.id, name: it.name, priceKobo: it.priceNaira * NAIRA, outletIds: [terrace.id], sortOrder: j } });
      ikoyiItems.push({ id: row.id, name: it.name, categoryId: c.id, categoryName: cat.category, priceKobo: row.priceKobo, station: cat.station, outletCodes: ['TERR'], vat: true, consumption: true, modifiers: undefined, stock: [] });
    }
  }
  const catId = (name: string) => items.find((i) => i.categoryName === name)!.categoryId;
  await prisma.posPriceRule.create({
    data: {
      tenantId,
      propertyId: lekki.id,
      name: 'Palm Bar happy hour',
      outletIds: [outlets.get('PBAR')!.id],
      categoryIds: [catId('Cocktails and mocktails'), catId('Beer and stout')],
      startTime: '17:00',
      endTime: '19:00',
      adjustmentType: 'PERCENT',
      value: 2_000,
    },
  });
  // Minibar par levels per room type.
  const mini = items.filter((i) => i.outletCodes.includes('MINI'));
  for (const rt of x.lekkiTypes.values()) {
    for (const it of mini) {
      await prisma.minibarPar.create({ data: { tenantId, propertyId: lekki.id, roomTypeId: rt.id, itemId: it.id, parQty: it.name.includes('water') ? 2 : rt.name === 'Palm Suite' ? 2 : 1 } });
    }
  }

  // Orders.
  const inHouse = await prisma.reservation.findMany({ where: { tenantId, propertyId: lekki.id, status: 'CHECKED_IN' }, include: { folio: true, room: true, guest: true } });
  const counters = new Map<string, number>();
  const nextSeq = (p: Property) => {
    const n = (counters.get(p.id) ?? 0) + 1;
    counters.set(p.id, n);
    return n;
  };
  const kds = new Map<string, number>();
  const nextTicket = (p: Property, day: string) => {
    const key = `${p.id}|${day}`;
    const n = (kds.get(key) ?? 0) + 1;
    kds.set(key, n);
    return n;
  };
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  let orderCount = 0;

  const makeOrder = async (o: {
    p: Property;
    outletCode: string;
    outletId: string;
    at: Date;
    lines: { item: ItemRow; qty: number; unit?: number; mods?: { groupId: string; group: string; optionId: string; option: string; priceKobo: number }[]; voided?: { reason: string; by: Person; approvedBy?: Person | null } }[];
    status: 'OPEN' | 'SETTLED' | 'CANCELLED';
    settlement?: 'PAYMENT' | 'ROOM_CHARGE' | 'COMPLIMENTARY';
    method?: 'CASH' | 'POS' | 'TRANSFER';
    stay?: (typeof inHouse)[number];
    table?: string | null;
    by: Person;
    ticketStatus?: 'NEW' | 'PREPARING' | 'READY' | 'SERVED';
    sent?: boolean;
    tip?: number;
    covers?: number;
    comps: Parameters<typeof orderTotals>[1];
    serviceCharge: boolean;
  }) => {
    const year = lagosYear(o.at);
    const seq = nextSeq(o.p);
    const id = randomUUID();
    const day = lagosDate(o.at);
    const lineRows = o.lines.map((l) => {
      const unit = (l.unit ?? l.item.priceKobo) + (l.mods ?? []).reduce((a, m) => a + m.priceKobo, 0);
      return { l, unit };
    });
    const live: TotalsLine[] = lineRows.filter((r) => !r.l.voided).map((r) => ({ name: r.l.item.name, quantity: r.l.qty, lineTotalKobo: r.unit * r.l.qty, vat: r.l.item.vat, consumption: r.l.item.consumption }));
    const { totals } = orderTotals(live, o.comps, o.serviceCharge, null);
    const settled = o.status === 'SETTLED';
    const settledAt = settled ? new Date(o.at.getTime() + (20 + Math.floor(rand() * 70)) * MIN) : null;
    const total = o.settlement === 'COMPLIMENTARY' ? 0 : totals.totalKobo;
    await prisma.posOrder.create({
      data: {
        id,
        tenantId,
        propertyId: o.p.id,
        outletId: o.outletId,
        number: `${o.outletCode}-${String(seq).padStart(6, '0')}`,
        year,
        seq,
        status: o.status,
        tableLabel: o.table ?? null,
        roomId: o.stay?.roomId ?? null,
        reservationId: o.stay?.id ?? null,
        guestName: o.stay?.guest.fullName ?? null,
        covers: o.covers ?? 1,
        settlement: settled ? (o.settlement ?? 'PAYMENT') : null,
        payments: (settled && (o.settlement ?? 'PAYMENT') === 'PAYMENT' ? [{ method: o.method ?? 'POS', amountKobo: totals.totalKobo + (o.tip ?? 0), reference: o.method === 'TRANSFER' ? `TRF${Math.floor(rand() * 1e8)}` : null, receiptId: null, receiptNumber: null }] : []) as unknown as Prisma.InputJsonValue,
        tipKobo: BigInt(o.tip ?? 0),
        folioId: settled && o.settlement === 'ROOM_CHARGE' ? (o.stay?.folio?.id ?? null) : null,
        totals: settled ? (totals as unknown as Prisma.InputJsonValue) : undefined,
        netKobo: BigInt(settled ? totals.netKobo : 0),
        totalKobo: BigInt(settled ? total : 0),
        taxKobo: BigInt(settled ? totals.taxTotalKobo : 0),
        openedById: o.by.id,
        openedByName: o.by.fullName,
        openedAt: o.at,
        settledAt,
        settledById: settled ? o.by.id : null,
        settledByName: settled ? o.by.fullName : null,
        cancelledAt: o.status === 'CANCELLED' ? new Date(o.at.getTime() + 10 * MIN) : null,
        cancelReason: o.status === 'CANCELLED' ? 'Guest left before ordering' : null,
        signature: settled && o.settlement === 'ROOM_CHARGE' ? 'Signed on the tablet' : null,
        createdAt: o.at,
      },
    });
    // Kitchen / bar tickets for sent lines.
    const sent = o.sent !== false;
    const ticketIds = new Map<string, string>();
    if (sent) {
      for (const station of new Set(lineRows.map((r) => r.l.item.station))) {
        if (station === 'NONE') continue;
        const tn = nextTicket(o.p, day);
        const status = o.ticketStatus ?? 'SERVED';
        const t = await prisma.posTicket.create({
          data: {
            tenantId,
            propertyId: o.p.id,
            orderId: id,
            outletId: o.outletId,
            number: `${station === 'BAR' ? 'B' : 'K'}-${String(tn).padStart(3, '0')}`,
            station,
            status,
            serverId: o.by.id,
            serverName: o.by.fullName,
            startedAt: status !== 'NEW' ? new Date(o.at.getTime() + 3 * MIN) : null,
            readyAt: status === 'READY' || status === 'SERVED' ? new Date(o.at.getTime() + 14 * MIN) : null,
            servedAt: status === 'SERVED' ? new Date(o.at.getTime() + 17 * MIN) : null,
            createdAt: new Date(o.at.getTime() + MIN),
          },
        });
        ticketIds.set(station, t.id);
      }
    }
    for (const r of lineRows) {
      await prisma.posOrderLine.create({
        data: {
          tenantId,
          propertyId: o.p.id,
          orderId: id,
          itemId: r.l.item.id,
          name: r.l.item.name,
          categoryName: r.l.item.categoryName,
          quantity: r.l.qty,
          unitPriceKobo: r.unit,
          basePriceKobo: r.l.item.priceKobo,
          modifiers: (r.l.mods ?? []) as unknown as Prisma.InputJsonValue,
          station: r.l.item.station,
          status: r.l.voided ? 'VOIDED' : sent ? 'SENT' : 'PENDING',
          sentAt: sent ? new Date(o.at.getTime() + MIN) : null,
          ticketId: sent ? (ticketIds.get(r.l.item.station) ?? null) : null,
          voidedAt: r.l.voided ? new Date(o.at.getTime() + 25 * MIN) : null,
          voidReason: r.l.voided?.reason ?? null,
          voidedById: r.l.voided?.by.id ?? null,
          voidedByName: r.l.voided?.by.fullName ?? null,
          approvedById: r.l.voided?.approvedBy?.id ?? null,
          addedById: o.by.id,
          addedByName: o.by.fullName,
          createdAt: o.at,
        },
      });
    }
    // Stock deduction for settled sales.
    if (settled) {
      for (const r of lineRows) {
        if (r.l.voided) continue;
        for (const [name, q] of r.l.item.stock) {
          const s = stock.get(name);
          if (!s) continue;
          await prisma.stockMovement.create({
            data: { tenantId, propertyId: o.p.id, stockItemId: s.id, type: o.outletCode === 'MINI' ? 'MINIBAR' : 'SALE', quantity: -q * r.l.qty, orderId: id, reference: `${o.outletCode}-${String(seq).padStart(6, '0')}`, createdById: o.by.id, createdByName: o.by.fullName, createdAt: settledAt! },
          });
        }
      }
    }
    // Room charges go to the guest's folio.
    if (settled && o.settlement === 'ROOM_CHARGE' && o.stay?.folio) {
      const byGroup = orderTotals(live, o.comps, o.serviceCharge, null).groups;
      for (const g of byGroup) {
        await postCharge(ctx, o.stay.folio, {
          type: 'EXTRA',
          description: `${o.outletCode === 'RSVC' ? 'Room service' : o.outletCode === 'MINI' ? 'Minibar' : o.outletCode === 'PBAR' ? 'Palm Bar' : 'The Yard'} ${o.outletCode}-${String(seq).padStart(6, '0')}: ${g.lines.map((l) => `${l.quantity} x ${l.name}`).join(', ')}`,
          amountKobo: g.enteredKobo,
          date: lagosDate(settledAt!),
          at: settledAt!,
          comps: g.comps,
          byId: o.by.id,
        });
      }
    }
    orderCount++;
    return { id, number: `${o.outletCode}-${String(seq).padStart(6, '0')}` };
  };

  const modsFor = (it: ItemRow) =>
    (it.modifiers ?? [])
      .filter((g) => g.required || rand() < 0.3)
      .map((g) => {
        const [name, price] = pick(g.options);
        return { groupId: g.id, group: g.name, optionId: `${g.id}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, option: name, priceKobo: price * NAIRA };
      });
  const itemsAt = (code: string) => items.filter((i) => i.outletCodes.includes(code) && i.name !== 'Moet Imperial (bottle)');
  const stayOn = (day: string) => inHouse.filter((r) => r.folio && lagosDate(r.arrivalAt) <= day && lagosDate(r.departureAt) > day);
  const staffPool = [yemi, yemi, ngozi, tunde];

  // 30 days of settled sales at Lekki.
  for (const day of dateRange(addDays(today, -30), addDays(today, -1))) {
    const n = 12 + Math.floor(rand() * 10);
    for (let k = 0; k < n; k++) {
      const code = pick(['YARD', 'YARD', 'YARD', 'PBAR', 'PBAR', 'RSVC', 'MINI']);
      const hour = code === 'PBAR' ? 17 + Math.floor(rand() * 6) : code === 'YARD' ? pick([8, 9, 13, 14, 19, 20, 21]) : 10 + Math.floor(rand() * 12);
      const at = lagosDateTime(day, `${String(hour).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}`);
      const pool = itemsAt(code);
      const lines = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => {
        const it = pick(pool);
        const happy = code === 'PBAR' && hour >= 17 && hour < 19 && (it.categoryName === 'Cocktails and mocktails' || it.categoryName === 'Beer and stout');
        return { item: it, qty: 1 + Math.floor(rand() * (it.station === 'BAR' ? 3 : 2)), unit: happy ? Math.round((it.priceKobo * 8_000) / 10_000) : undefined, mods: modsFor(it) };
      });
      const stays = stayOn(day);
      const roomCharge = (code === 'RSVC' || code === 'MINI' || rand() < 0.15) && stays.length > 0;
      const voidOne = rand() < 0.04 && lines.length > 1;
      if (voidOne) lines[0] = { ...lines[0], voided: { reason: pick(['Guest changed order', 'Wrong item keyed', 'Kitchen ran out']), by: yemi, approvedBy: rand() < 0.5 ? tunde : null } } as (typeof lines)[number];
      await makeOrder({
        p: lekki,
        outletCode: code,
        outletId: outlets.get(code)!.id,
        at,
        lines,
        status: 'SETTLED',
        settlement: roomCharge ? 'ROOM_CHARGE' : 'PAYMENT',
        method: pick(['CASH', 'POS', 'POS', 'TRANSFER']),
        stay: roomCharge ? pick(stays) : undefined,
        table: code === 'YARD' ? `T${1 + Math.floor(rand() * 12)}` : code === 'PBAR' ? `Bar ${1 + Math.floor(rand() * 8)}` : null,
        by: code === 'MINI' ? U('musa@palmwine.ng') : pick(staffPool),
        tip: code === 'YARD' && rand() < 0.3 ? 100_000 : 0,
        covers: code === 'YARD' ? 1 + Math.floor(rand() * 4) : 1,
        comps: lekkiComps,
        serviceCharge: code === 'YARD',
      });
    }
  }
  // Today: open orders with tickets in every state, one unsent, one settled.
  const at = (hhmm: string, minutesAgo: number) => new Date(Math.min(lagosDateTime(today, hhmm).getTime(), now.getTime() - minutesAgo * MIN));
  const find = (n: string) => items.find((i) => i.name === n)!;
  const jollof = find('Party jollof rice');
  await makeOrder({ p: lekki, outletCode: 'YARD', outletId: outlets.get('YARD')!.id, at: at('12:40', 6), status: 'OPEN', lines: [{ item: jollof, qty: 2, mods: [{ groupId: 'protein', group: 'Protein', optionId: 'protein-chicken', option: 'Chicken', priceKobo: 0 }] }, { item: find('Chapman'), qty: 2 }], table: 'T4', by: yemi, ticketStatus: 'NEW', covers: 2, comps: lekkiComps, serviceCharge: true });
  await makeOrder({ p: lekki, outletCode: 'YARD', outletId: outlets.get('YARD')!.id, at: at('12:25', 18), status: 'OPEN', lines: [{ item: find('Ofada rice and ayamase'), qty: 1 }, { item: find('Catfish pepper soup'), qty: 1 }], table: 'T9', by: yemi, ticketStatus: 'PREPARING', covers: 2, comps: lekkiComps, serviceCharge: true });
  await makeOrder({ p: lekki, outletCode: 'PBAR', outletId: outlets.get('PBAR')!.id, at: at('12:10', 25), status: 'OPEN', lines: [{ item: find('Suya platter'), qty: 1, mods: [{ groupId: 'heat', group: 'Heat', optionId: 'heat-hot', option: 'Hot', priceKobo: 0 }] }, { item: find('Star lager'), qty: 3 }], table: 'Bar 2', by: yemi, ticketStatus: 'READY', comps: lekkiComps, serviceCharge: false });
  if (inHouse[0]) {
    await makeOrder({ p: lekki, outletCode: 'RSVC', outletId: outlets.get('RSVC')!.id, at: at('11:50', 40), status: 'OPEN', lines: [{ item: find('Yam and egg sauce'), qty: 1 }, { item: find('Chivita 100% juice'), qty: 1 }], stay: inHouse[0], by: ngozi, ticketStatus: 'SERVED', comps: lekkiComps, serviceCharge: false });
  }
  await makeOrder({ p: lekki, outletCode: 'YARD', outletId: outlets.get('YARD')!.id, at: at('12:50', 2), status: 'OPEN', sent: false, lines: [{ item: find('Egusi soup with swallow'), qty: 1, mods: [{ groupId: 'swallow', group: 'Swallow', optionId: 'swallow-pounded-yam', option: 'Pounded yam', priceKobo: 0 }] }], table: 'T1', by: yemi, comps: lekkiComps, serviceCharge: true });
  const voided = await makeOrder({
    p: lekki,
    outletCode: 'PBAR',
    outletId: outlets.get('PBAR')!.id,
    at: at('11:30', 60),
    status: 'SETTLED',
    settlement: 'PAYMENT',
    method: 'CASH',
    lines: [{ item: find('Hennessy VS (shot)'), qty: 4, voided: { reason: 'Customer said he did not order it', by: yemi, approvedBy: null } }, { item: find('Heineken'), qty: 2 }],
    table: 'Bar 5',
    by: yemi,
    comps: lekkiComps,
    serviceCharge: false,
  });
  // Ikoyi: a smaller book of sales at The Terrace.
  const ikoyiStays = await prisma.reservation.findMany({ where: { tenantId, propertyId: ikoyi.id, status: 'CHECKED_IN' }, include: { folio: true, room: true, guest: true } });
  for (const day of dateRange(addDays(today, -14), addDays(today, -1))) {
    for (let k = 0; k < 5 + Math.floor(rand() * 4); k++) {
      const hour = pick([8, 9, 13, 19, 20, 21]);
      const stays = ikoyiStays.filter((r) => r.folio && lagosDate(r.arrivalAt) <= day && lagosDate(r.departureAt) > day);
      const roomCharge = stays.length > 0 && rand() < 0.3;
      await makeOrder({
        p: ikoyi,
        outletCode: 'TERR',
        outletId: terrace.id,
        at: lagosDateTime(day, `${String(hour).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}`),
        status: 'SETTLED',
        settlement: roomCharge ? 'ROOM_CHARGE' : 'PAYMENT',
        method: pick(['POS', 'TRANSFER', 'CASH']),
        stay: roomCharge ? pick(stays) : undefined,
        lines: Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ({ item: pick(ikoyiItems), qty: 1 + Math.floor(rand() * 2) })),
        table: `Terrace ${1 + Math.floor(rand() * 6)}`,
        by: U('kelechi@palmwine.ng'),
        comps: ikoyiComps,
        serviceCharge: true,
      });
    }
  }
  // Counters continue from the seeded numbers.
  for (const [pid, seq] of counters) {
    await prisma.$executeRaw`INSERT INTO document_counters (tenant_id, kind, year, scope, last_value) VALUES (${tenantId}::uuid, 'POS_ORDER', ${lagosYear(now)}, ${pid}, ${seq})
      ON CONFLICT (tenant_id, kind, year, scope) DO UPDATE SET last_value = EXCLUDED.last_value`;
  }
  const todayKey = Number(today.replace(/-/g, ''));
  for (const [key, seq] of kds) {
    const [pid, day] = key.split('|');
    if (day !== today) continue;
    await prisma.$executeRaw`INSERT INTO document_counters (tenant_id, kind, year, scope, last_value) VALUES (${tenantId}::uuid, 'KDS_TICKET', ${todayKey}, ${pid}, ${seq})
      ON CONFLICT (tenant_id, kind, year, scope) DO UPDATE SET last_value = EXCLUDED.last_value`;
  }

  // Purchases, waste and a stock count with a variance.
  for (const [name, , , onHand, , cost] of STOCK) {
    const s = stock.get(name)!;
    const sold = Number((await prisma.stockMovement.aggregate({ where: { stockItemId: s.id }, _sum: { quantity: true } }))._sum.quantity ?? 0);
    const purchased = Math.ceil(onHand - sold);
    await prisma.stockMovement.create({ data: { tenantId, propertyId: lekki.id, stockItemId: s.id, type: 'PURCHASE', quantity: purchased, unitCostKobo: cost * NAIRA, reference: `GRN-${1000 + Math.floor(rand() * 9000)}`, note: 'Supplier delivery (Mile 12 / Ebeano)', createdById: U('funmi@palmwine.ng').id, createdByName: U('funmi@palmwine.ng').fullName, createdAt: new Date(now.getTime() - 31 * DAY) } });
  }
  const bottles = stock.get('Hennessy VS (70cl)')!;
  const heineken = stock.get('Heineken (33cl)')!;
  const countLines = [
    { stockItemId: bottles.id, name: 'Hennessy VS (70cl)', unit: 'bottle', expected: 5, counted: 3, variance: -2, varianceValueKobo: -2 * bottles.unitCostKobo },
    { stockItemId: heineken.id, name: 'Heineken (33cl)', unit: 'bottle', expected: 64, counted: 60, variance: -4, varianceValueKobo: -4 * heineken.unitCostKobo },
  ];
  const varianceValue = countLines.reduce((a, l) => a + l.varianceValueKobo, 0);
  const funmi = U('funmi@palmwine.ng');
  const countAt = new Date(now.getTime() - 20 * HOUR);
  const sc = await prisma.stockCount.create({ data: { tenantId, propertyId: lekki.id, note: 'Palm Bar weekly count', lines: countLines as unknown as Prisma.InputJsonValue, varianceValueKobo: BigInt(varianceValue), flagged: true, countedById: funmi.id, countedByName: funmi.fullName, countedAt: countAt } });
  for (const l of countLines) {
    await prisma.stockMovement.create({ data: { tenantId, propertyId: lekki.id, stockItemId: l.stockItemId, type: 'COUNT', quantity: l.variance, countId: sc.id, note: 'Stock count adjustment', createdById: funmi.id, createdByName: funmi.fullName, createdAt: countAt } });
    await prisma.stockItem.update({ where: { id: l.stockItemId }, data: { onHand: l.counted } });
  }
  await prisma.stockItem.update({ where: { id: stock.get('Beef (suya cut)')!.id }, data: { onHand: 4.2 } });
  await prisma.stockMovement.create({ data: { tenantId, propertyId: lekki.id, stockItemId: stock.get('Catfish')!.id, type: 'WASTE', quantity: -1, note: 'Died in the tank overnight', createdById: U('bisi@palmwine.ng').id, createdByName: U('bisi@palmwine.ng').fullName, createdAt: new Date(now.getTime() - 3 * DAY) } });

  // Revenue Guard flags from POS.
  await prisma.guardFlag.createMany({
    data: [
      {
        tenantId,
        propertyId: lekki.id,
        rule: 'STOCK_VARIANCE',
        severity: 'HIGH',
        title: `Stock count short by ₦${Math.abs(varianceValue / 100).toLocaleString('en-NG')} at Palm Bar`,
        detail: `${funmi.fullName} counted 2 bottles of Hennessy VS and 4 Heineken fewer than the system expected.`,
        dedupeKey: `STOCK_VARIANCE:${sc.id}`,
        amountKobo: BigInt(Math.abs(varianceValue)),
        userId: funmi.id,
        userName: funmi.fullName,
        evidence: { countId: sc.id, lines: countLines } as unknown as Prisma.InputJsonValue,
        createdAt: countAt,
      },
      {
        tenantId,
        propertyId: lekki.id,
        rule: 'POS_VOID_AFTER_SEND',
        severity: 'HIGH',
        title: `4 x Hennessy VS (shot) voided after it went to the bar (${voided.number})`,
        detail: `${yemi.fullName} voided ₦24,000 of drinks already poured, without a manager's PIN. Reason: Customer said he did not order it`,
        dedupeKey: `POS_VOID_AFTER_SEND:${voided.id}`,
        amountKobo: BigInt(2_400_000),
        userId: yemi.id,
        userName: yemi.fullName,
        evidence: { orderId: voided.id, number: voided.number } as Prisma.InputJsonValue,
        createdAt: at('11:55', 35),
      },
    ],
  });
  return orderCount;
}

// =============================================================================
// Channels
// =============================================================================

async function seedChannels(ctx: SeedCtx, x: { lekki: Property; lekkiTypes: Map<string, RoomType>; lekkiRooms: Map<string, Room>; comps: TaxComponent[] }): Promise<number> {
  const { prisma, tenantId, now, today, rand } = ctx;
  const { lekki, comps } = x;
  const bar = await prisma.ratePlan.findFirstOrThrow({ where: { propertyId: lekki.id, isBar: true } });
  const std = x.lekkiTypes.get('Standard Queen')!;
  const dlx = x.lekkiTypes.get('Deluxe King')!;
  const suite = x.lekkiTypes.get('Palm Suite')!;

  const airbnb = await prisma.channelConnection.create({
    data: {
      tenantId,
      propertyId: lekki.id,
      provider: 'ICAL',
      name: 'Airbnb (iCal)',
      channel: 'AIRBNB',
      settings: { stopSellBuffer: 0, commissionBps: { AIRBNB: 300 }, pushRates: false, pushRestrictions: false, horizonDays: 365 },
      lastSyncAt: new Date(now.getTime() - 12 * MIN),
      createdAt: new Date(now.getTime() - 45 * DAY),
    },
  });
  await prisma.icalFeed.create({
    data: { tenantId, propertyId: lekki.id, connectionId: airbnb.id, roomTypeId: suite.id, url: 'https://www.airbnb.com/calendar/ical/912345678901234567.ics?s=7f3c9a1e2b4d', lastFetchedAt: new Date(now.getTime() - 12 * MIN), lastStatus: 'OK', eventsCount: 3 },
  });
  const channex = await prisma.channelConnection.create({
    data: {
      tenantId,
      propertyId: lekki.id,
      provider: 'CHANNEX',
      name: 'Channex',
      mock: true,
      externalPropertyId: `mock-property-${lekki.id.slice(0, 8)}`,
      settings: { stopSellBuffer: 1, commissionBps: { BOOKING_COM: 1500, EXPEDIA: 1800 }, pushRates: true, pushRestrictions: true, horizonDays: 365 },
      lastSyncAt: new Date(now.getTime() - 4 * MIN),
      createdAt: new Date(now.getTime() - 40 * DAY),
    },
  });
  for (const t of [std, dlx, suite]) {
    await prisma.channelMapping.create({
      data: { tenantId, propertyId: lekki.id, connectionId: channex.id, roomTypeId: t.id, ratePlanId: bar.id, externalRoomTypeId: mockRoomTypeId(t.id), externalRoomTypeName: `${t.name} (Channex)`, externalRatePlanId: mockRatePlanId(t.id, bar.code), externalRatePlanName: `${t.name} ${bar.name}` },
    });
  }

  // Earlier OTA stays (desk-keyed from the extranet) get their channel and commission.
  const legacy = await prisma.reservation.findMany({ where: { tenantId, propertyId: lekki.id, source: 'OTA', otaChannel: null }, select: { id: true, nightlyRates: true, rateKobo: true } });
  for (const r of legacy) {
    const channel = rand() < 0.65 ? 'BOOKING_COM' : 'EXPEDIA';
    const gross = (r.nightlyRates as { rateKobo: number }[]).reduce((a, n) => a + n.rateKobo, 0) || Number(r.rateKobo);
    const ref = channel === 'BOOKING_COM' ? String(3_100_000_000 + Math.floor(rand() * 900_000_000)) : String(72_000_000 + Math.floor(rand() * 9_000_000));
    await prisma.reservation.update({ where: { id: r.id }, data: { otaChannel: channel, otaRef: ref, otaCommissionKobo: BigInt(Math.round((gross * (channel === 'BOOKING_COM' ? 1500 : 1800)) / 10_000)) } });
  }

  // OTA guests and bookings.
  const otaGuests: [string, string, string | null][] = [
    ['Sarah Mensah', '+233245550191', 'sarah.mensah@mail.com'],
    ['David Okonkwo', '+447700900455', 'd.okonkwo@mail.co.uk'],
    ['Aisha Bello', '+2348035558201', null],
    ['Michael Adebayo', '+14155550198', 'madebayo@mail.com'],
    ['Chioma Umeh', '+2348055558203', 'chioma.umeh@mail.ng'],
    ['Pierre Dubois', '+33612345678', 'p.dubois@mail.fr'],
    ['Folake Coker', '+2348085558205', null],
    ['Emmanuel Asante', '+233205550122', 'e.asante@mail.com'],
    ['Grace Nwankwo', '+2348165558207', 'grace.nwankwo@mail.ng'],
    ['Joseph Eze', '+2348175558208', null],
    ['Linda Okafor', '+2348185558209', 'linda.o@mail.ng'],
    ['Samuel Idowu', '+2348195558210', null],
  ];
  const guestRows: Guest[] = [];
  for (const [fullName, phone, email] of otaGuests) {
    guestRows.push(await prisma.guest.upsert({ where: { tenantId_phone: { tenantId, phone } }, create: { tenantId, fullName, phone, email, nationality: phone.startsWith('+234') ? 'Nigerian' : 'Other', consentAt: now }, update: {} }));
  }
  const channels: ('BOOKING_COM' | 'EXPEDIA')[] = ['BOOKING_COM', 'EXPEDIA'];
  let n = 0;
  const book = async (g: Guest, t: RoomType, a: number, d: number, channel: 'BOOKING_COM' | 'EXPEDIA', status: Reservation['status'], overbooked = false, room: Room | null = null) => {
    const nights = d - a;
    const rate = Math.round((t.basePriceKobo * (1 + (rand() - 0.3) * 0.2)) / 50_000) * 50_000;
    const gross = rate * nights;
    const bps = channel === 'BOOKING_COM' ? 1500 : 1800;
    const commission = Math.round((gross * bps) / 10_000);
    const ref = channel === 'BOOKING_COM' ? String(3_100_000_000 + Math.floor(rand() * 900_000_000)) : String(72_000_000 + Math.floor(rand() * 9_000_000));
    const { reservation } = await createStay(ctx, {
      property: lekki,
      roomType: t,
      room,
      guestId: g.id,
      guestName: g.fullName,
      arrival: addDays(today, a),
      departure: addDays(today, d),
      status,
      rateKobo: rate,
      createdAt: new Date(lagosDateTime(addDays(today, a), '09:00').getTime() - (5 + Math.floor(rand() * 25)) * DAY),
      ota: { channel, ref, commissionKobo: commission, overbooked },
      source: 'OTA',
      comps,
      notes: `${channel === 'BOOKING_COM' ? 'Booking.com' : 'Expedia'} reservation ${ref}`,
      checkedInBy: ctx.users.get('ngozi@palmwine.ng')!.id,
    });
    const externalId = `bk-${randomUUID().slice(0, 18)}`;
    await prisma.channelBooking.create({
      data: {
        tenantId,
        propertyId: lekki.id,
        connectionId: channex.id,
        provider: 'CHANNEX',
        channel,
        externalId,
        revisionId: `rev-${randomUUID()}`,
        status: status === 'CANCELLED' ? 'CANCELLED' : 'NEW',
        reservationId: reservation.id,
        grossKobo: BigInt(gross),
        commissionKobo: BigInt(commission),
        commissionBps: bps,
        overbooked,
        raw: { ota_name: channel === 'BOOKING_COM' ? 'Booking.com' : 'Expedia', ota_reservation_code: ref, arrival_date: addDays(today, a), departure_date: addDays(today, d) },
        receivedAt: reservation.createdAt,
      },
    });
    n++;
    return reservation;
  };
  // Past (checked out) and upcoming.
  for (let i = 0; i < 6; i++) {
    const a = -28 + i * 4;
    await book(guestRows[i]!, pick3(rand, [std, dlx, std]), a, a + 2 + (i % 2), channels[i % 2]!, 'CHECKED_OUT');
  }
  for (let i = 6; i < 11; i++) {
    const a = 2 + (i - 6) * 5;
    await book(guestRows[i]!, pick3(rand, [std, dlx, std]), a, a + 2 + (i % 3), channels[i % 2]!, i === 9 ? 'CANCELLED' : 'CONFIRMED');
  }
  // Overbooked: a Palm Suite night that is already full.
  const night = addDays(today, 5);
  const suites = [...x.lekkiRooms.values()].filter((r) => r.roomTypeId === suite.id).length;
  const w = { start: lagosDateTime(night, lekki.checkInTime), end: lagosDateTime(addDays(night, 1), lekki.checkOutTime) };
  let taken = await prisma.reservation.count({ where: { propertyId: lekki.id, roomTypeId: suite.id, status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] }, arrivalAt: { lt: w.end }, departureAt: { gt: w.start } } });
  let filler = 0;
  while (taken < suites) {
    await book(guestRows[(filler++ % 3) + 9] ?? guestRows[0]!, suite, 5, 6, 'BOOKING_COM', 'CONFIRMED');
    taken++;
  }
  const over = await book(guestRows[11]!, suite, 5, 7, 'EXPEDIA', 'CONFIRMED', true);
  await prisma.guardFlag.create({
    data: {
      tenantId,
      propertyId: lekki.id,
      rule: 'OVERBOOKED',
      severity: 'HIGH',
      title: `Overbooked: Palm Suite on ${night} (Expedia ${over.otaRef})`,
      detail: `An Expedia booking arrived for a night with no free Palm Suite (${suites + 1} sold of ${suites}). Move the guest or upgrade them.`,
      dedupeKey: `OVERBOOKED:${over.id}`,
      reservationId: over.id,
      evidence: { nights: [{ date: night, sold: suites + 1, capacity: suites }], channel: 'EXPEDIA', otaRef: over.otaRef } as Prisma.InputJsonValue,
      suggestion: 'Offer a Deluxe King with a complimentary dinner, or relocate to Palmwine House Ikoyi (Ikoyi Loft Suite free that night).',
      createdAt: over.createdAt,
    },
  });

  // Sync logs.
  const logs: Prisma.ChannelSyncLogCreateManyInput[] = [];
  for (let h = 1; h <= 30; h++) {
    const t = new Date(now.getTime() - h * 55 * MIN);
    logs.push({ tenantId, propertyId: lekki.id, connectionId: channex.id, direction: 'PUSH', kind: 'ARI', status: h % 5 === 0 ? 'SKIPPED' : 'OK', summary: h % 5 === 0 ? 'Nothing changed' : `Pushed ${1 + (h % 4)} availability and ${2 + (h % 3)} rate ranges`, items: h % 5 === 0 ? 0 : 3 + (h % 5), startedAt: t, finishedAt: new Date(t.getTime() + 900) });
    if (h % 4 === 0) logs.push({ tenantId, propertyId: lekki.id, connectionId: airbnb.id, direction: 'PULL', kind: 'ICAL_IMPORT', status: 'OK', summary: 'Imported 3 Airbnb blocks (no changes)', items: 3, startedAt: t, finishedAt: new Date(t.getTime() + 1200) });
  }
  logs.push({ tenantId, propertyId: lekki.id, connectionId: channex.id, direction: 'PUSH', kind: 'ARI', status: 'ERROR', summary: 'Availability and rates could not be pushed', error: 'HTTP 503: Channex is temporarily unavailable', items: 0, startedAt: new Date(now.getTime() - 20 * HOUR) });
  logs.push({ tenantId, propertyId: lekki.id, connectionId: channex.id, direction: 'WEBHOOK', kind: 'BOOKING', status: 'OK', summary: `New Expedia booking ${over.otaRef} (overbooked)`, items: 1, startedAt: over.createdAt });
  logs.push({ tenantId, propertyId: lekki.id, connectionId: channex.id, direction: 'PULL', kind: 'MAPPING', status: 'OK', summary: 'Mapped 3 room types to Channex', items: 3, startedAt: new Date(now.getTime() - 40 * DAY) });
  logs.push({ tenantId, propertyId: lekki.id, connectionId: channex.id, direction: 'PULL', kind: 'CONNECT', status: 'OK', summary: 'Connected to Mock Channex property (mock)', items: 0, startedAt: new Date(now.getTime() - 40 * DAY) });
  await prisma.channelSyncLog.createMany({ data: logs });
  return n;
}

function pick3<T>(rand: () => number, xs: T[]): T {
  return xs[Math.floor(rand() * xs.length)]!;
}

// =============================================================================
// Dynamic pricing
// =============================================================================

async function seedPricing(ctx: SeedCtx, x: { lekki: Property; ikoyi: Property; lekkiTypes: Map<string, RoomType>; ikoyiTypes: Map<string, RoomType> }): Promise<number> {
  const { prisma, tenantId, today, rand } = ctx;
  const tunde = ctx.users.get('tunde@palmwine.ng')!;
  const owner = ctx.users.get('demo@palmwine.ng')!;
  let suggestions = 0;

  await prisma.pricingSetting.create({ data: { tenantId, propertyId: x.lekki.id, mode: 'SUGGEST', horizonDays: 90, minChangeBps: 300, lastRunAt: lagosDateTime(today, '03:00') } });
  await prisma.pricingSetting.create({ data: { tenantId, propertyId: x.ikoyi.id, mode: 'AUTOPILOT', horizonDays: 60, minChangeBps: 300, paceSpikeRooms: 3, lastRunAt: lagosDateTime(today, '03:00') } });
  for (const [p, types] of [[x.lekki, x.lekkiTypes], [x.ikoyi, x.ikoyiTypes]] as const) {
    for (const t of types.values()) {
      await prisma.pricingGuardrail.create({ data: { tenantId, propertyId: p.id, roomTypeId: t.id, floorKobo: Math.round((t.basePriceKobo * 0.75) / 50_000) * 50_000, ceilingKobo: Math.round((t.basePriceKobo * 1.8) / 50_000) * 50_000, maxDailyChangeBps: 1500 } });
    }
  }
  const custom = [
    { name: 'Burna Boy live at Eko Convention Centre', from: addDays(today, 17), to: addDays(today, 18), impact: 'VERY_HIGH' as const, note: 'Sold-out homecoming show; the Island fills up.' },
    { name: 'AFCON qualifier: Super Eagles at Teslim Balogun', from: addDays(today, 10), to: addDays(today, 10), impact: 'HIGH' as const, note: '' },
    { name: 'Lagos Business School alumni conference', from: addDays(today, 24), to: addDays(today, 26), impact: 'MEDIUM' as const, note: 'Corporate block at Lekki expected.' },
  ];
  for (const e of custom) {
    await prisma.pricingEvent.create({ data: { tenantId, propertyId: x.lekki.id, kind: 'CUSTOM', name: e.name, dateFrom: dbDate(e.from), dateTo: dbDate(e.to), impact: e.impact, upliftBps: IMPACT_BPS[e.impact], city: 'Lagos', note: e.note } });
  }
  await prisma.pricingFrozenDate.create({ data: { tenantId, propertyId: x.lekki.id, date: dbDate(addDays(today, 31)), note: 'Wedding block for the Adeyemi family at a fixed price', createdById: owner.id, createdByName: owner.fullName } });
  const compNames = ['Lagos Continental Lekki', 'The George Ikoyi', 'Radisson Blu Ikoyi'];
  for (const d of dateRange(today, addDays(today, 13))) {
    for (const [i, name] of compNames.entries()) {
      await prisma.competitorRate.create({ data: { tenantId, propertyId: x.lekki.id, competitorName: name, date: dbDate(d), rateKobo: Math.round((6_000_000 + i * 1_500_000 + rand() * 1_500_000) / 50_000) * 50_000, roomTypeId: null } });
    }
  }

  // Suggestions from the engine (inputs from the seeded books).
  const make = async (p: Property, types: Map<string, RoomType>, days: number, apply: boolean) => {
    const events = [...nationalEventsBetween(today, addDays(today, days)), ...custom.map((e) => ({ name: e.name, dateFrom: e.from, dateTo: e.to, upliftBps: IMPACT_BPS[e.impact], city: 'Lagos', disabled: false }))];
    const rooms = await prisma.room.groupBy({ by: ['roomTypeId'], where: { propertyId: p.id }, _count: { _all: true } });
    const cap = new Map(rooms.map((r) => [r.roomTypeId, r._count._all]));
    const stays = await prisma.reservation.findMany({ where: { propertyId: p.id, status: { notIn: ['CANCELLED', 'NO_SHOW'] }, departureAt: { gt: lagosDateTime(addDays(today, -35), '12:00') } }, select: { roomTypeId: true, arrivalAt: true, departureAt: true, status: true, createdAt: true } });
    // Today's BAR (seasons and manual overrides), as the engine sees it.
    const rules = (await prisma.rateRule.findMany({ where: { propertyId: p.id, active: true } })).map(toRuleLike);
    const overrides = new Map((await prisma.rateOverride.findMany({ where: { propertyId: p.id } })).map((o) => [`${o.roomTypeId}|${o.date.toISOString().slice(0, 10)}`, o.rateKobo]));
    const manual = new Set((await prisma.rateOverride.findMany({ where: { propertyId: p.id, source: 'MANUAL' } })).map((o) => `${o.roomTypeId}|${o.date.toISOString().slice(0, 10)}`));
    const comps = await prisma.competitorRate.findMany({ where: { propertyId: p.id } });
    for (const t of types.values()) {
      for (const d of dateRange(addDays(today, 1), addDays(today, days))) {
        if (p.id === x.lekki.id && d === addDays(today, 31)) continue;
        const covering = (day: string) => {
          const s = lagosDateTime(day, p.checkInTime);
          const e = lagosDateTime(addDays(day, 1), p.checkOutTime);
          return stays.filter((r) => r.roomTypeId === t.id && r.arrivalAt < e && r.departureAt > s);
        };
        const daysOut = Math.round((lagosDateTime(d, '12:00').getTime() - lagosDateTime(today, '12:00').getTime()) / DAY);
        // Same weekday in the past four weeks, read at the same lead time (the same rule as the service).
        const reference = [1, 2, 3, 4]
          .map((w) => addDays(d, -7 * w))
          .filter((r) => r < today && r >= addDays(today, -35))
          .map((r) => {
            const c = covering(r);
            const cutoff = new Date(lagosDateTime(r, '12:00').getTime() - daysOut * DAY);
            return { otbAtLead: c.filter((s) => s.createdAt <= cutoff).length, final: c.length };
          });
        const currentKobo = barForNight(t, d, rules, overrides).baseRateKobo;
        const input: EngineInput = {
          date: d,
          currentKobo,
          baseKobo: t.basePriceKobo,
          capacity: cap.get(t.id) ?? 0,
          sold: covering(d).filter((s) => s.status !== 'CHECKED_OUT').length,
          daysOut,
          reference,
          events: events.filter((e) => !e.disabled && e.dateFrom <= d && e.dateTo >= d && (!e.city || e.city === 'Lagos')).map((e) => ({ name: e.name, upliftBps: e.upliftBps })),
          competitorKobo: relevantCompetitors(currentKobo, comps.filter((c) => c.date.toISOString().slice(0, 10) === d), t.id),
          guardrail: { enabled: true, floorKobo: Math.round((t.basePriceKobo * 0.75) / 50_000) * 50_000, ceilingKobo: Math.round((t.basePriceKobo * 1.8) / 50_000) * 50_000, maxDailyChangeBps: 1500 },
          minChangeBps: 300,
          frozen: false,
          manualOverride: manual.has(`${t.id}|${d}`),
        };
        if (!input.capacity) continue;
        const out = suggest(input);
        if (out.blockedBy) continue;
        const s = await prisma.priceSuggestion.create({
          data: {
            tenantId,
            propertyId: p.id,
            roomTypeId: t.id,
            date: dbDate(d),
            currentKobo: input.currentKobo,
            suggestedKobo: out.suggestedKobo,
            changeBps: out.changeBps,
            factors: out.factors as unknown as Prisma.InputJsonValue,
            reason: out.reason,
            occupancy: out.occupancy as unknown as Prisma.InputJsonValue,
            confidence: out.confidence,
            status: apply ? 'APPLIED' : 'PENDING',
            generatedAt: lagosDateTime(today, '03:00'),
            decidedAt: apply ? lagosDateTime(today, '03:00') : null,
          },
        });
        suggestions++;
        if (apply) {
          await prisma.rateOverride.upsert({
            where: { roomTypeId_date: { roomTypeId: t.id, date: dbDate(d) } },
            create: { tenantId, propertyId: p.id, roomTypeId: t.id, date: dbDate(d), rateKobo: out.suggestedKobo, source: 'PRICING', note: 'Dynamic pricing', updatedByName: 'Autopilot' },
            update: { rateKobo: out.suggestedKobo, source: 'PRICING', note: 'Dynamic pricing', updatedByName: 'Autopilot' },
          });
          await prisma.priceChange.create({ data: { tenantId, propertyId: p.id, roomTypeId: t.id, date: dbDate(d), fromKobo: input.currentKobo, toKobo: out.suggestedKobo, previousKobo: null, source: 'AUTOPILOT', reason: out.reason, suggestionId: s.id, createdAt: lagosDateTime(today, '03:00') } });
        }
      }
    }
  };
  await make(x.lekki, x.lekkiTypes, 30, false);
  await make(x.ikoyi, x.ikoyiTypes, 14, true);

  // History for "what the engine earned": changes on past nights that then sold.
  const pastStays = await prisma.reservation.findMany({
    where: { tenantId, status: { in: ['CHECKED_OUT', 'CHECKED_IN'] }, arrivalAt: { gte: lagosDateTime(addDays(today, -28), '00:00') }, stayType: 'NIGHTLY' },
    select: { propertyId: true, roomTypeId: true, nightlyRates: true, createdAt: true },
  });
  const seen = new Set<string>();
  let history = 0;
  for (const s of pastStays) {
    for (const n of (s.nightlyRates as { date: string; baseRateKobo: number }[]).slice(0, 2)) {
      const key = `${s.roomTypeId}|${n.date}`;
      if (seen.has(key) || n.date >= today || rand() < 0.45) continue;
      seen.add(key);
      const up = 0.05 + rand() * 0.1;
      const from = Math.round(n.baseRateKobo / (1 + up) / 50_000) * 50_000;
      if (from >= n.baseRateKobo) continue;
      const autopilot = s.propertyId === x.ikoyi.id;
      const at = new Date(Math.min(s.createdAt.getTime() - 6 * HOUR, lagosDateTime(n.date, '03:00').getTime()));
      const pct = Math.round(((n.baseRateKobo - from) * 100) / from);
      await prisma.priceChange.create({
        data: {
          tenantId,
          propertyId: s.propertyId,
          roomTypeId: s.roomTypeId,
          date: dbDate(n.date),
          fromKobo: from,
          toKobo: n.baseRateKobo,
          previousKobo: null,
          source: autopilot ? 'AUTOPILOT' : 'ACCEPTED',
          reason: `${60 + Math.floor(rand() * 30)}% booked ${Math.max(1, Math.round((lagosDateTime(n.date, '12:00').getTime() - at.getTime()) / DAY))} days out, ahead of usual pace -> +${pct}%`,
          byId: autopilot ? null : tunde.id,
          byName: autopilot ? null : tunde.fullName,
          createdAt: at,
        },
      });
      history++;
    }
  }
  return suggestions + history;
}

// =============================================================================
// Guest inbox
// =============================================================================

async function seedInbox(ctx: SeedCtx, x: { lekki: Property; ikoyi: Property; lekkiRooms: Map<string, Room>; demoGuest: Guest }): Promise<number> {
  const { prisma, tenantId, now } = ctx;
  const ngozi = ctx.users.get('ngozi@palmwine.ng')!;
  const chidinma = ctx.users.get('chidinma@palmwine.ng')!;
  const kelechi = ctx.users.get('kelechi@palmwine.ng')!;
  const lekki = x.lekki;
  await prisma.inboxSetting.create({
    data: { tenantId, propertyId: lekki.id, wifiName: 'PalmwineGuest', wifiPassword: 'courtyard2026', directions: 'From Admiralty Way, turn into Fola Osibo Road; we are the green gate after Mega Chicken.', whatsappPhone: '+2348025550141', slaMinutes: 15 },
  });
  await prisma.inboxSetting.create({ data: { tenantId, propertyId: x.ikoyi.id, wifiName: 'PalmwineIkoyi', wifiPassword: 'terrace2026', directions: 'Glover Road, off Bourdillon; the white gate opposite the church.', whatsappPhone: '+2348025550142', slaMinutes: 20 } });
  const replies = [
    ['Wi-Fi', '/wifi', 'Hello {{guest_first_name}}, the Wi-Fi is {{wifi_name}} and the password is {{wifi_password}}. Enjoy your stay.'],
    ['Directions', '/directions', '{{hotel_name}} is easy to find: {{directions}} Call {{hotel_phone}} if you get lost.'],
    ['Check-out time', '/checkout', 'Check-out is by {{check_out_time}}. Late check-out until 2pm is often possible; let us know and we will confirm.'],
    ['Airport pickup', '/pickup', 'Our driver can meet you at the airport for ₦35,000 (Murtala Muhammed International). Send your flight number and landing time.'],
    ['Breakfast hours', '/breakfast', 'Breakfast is served at The Yard from 7am to 11am. Room service breakfast is available until noon.'],
  ];
  for (const [i, [title, shortcut, body]] of replies.entries()) {
    await prisma.quickReply.create({ data: { tenantId, propertyId: lekki.id, title: title!, shortcut: shortcut!, body: body!, sortOrder: i } });
  }

  const stays = await prisma.reservation.findMany({ where: { tenantId, propertyId: lekki.id, status: { in: ['CHECKED_IN', 'CONFIRMED'] } }, include: { guest: true, room: true }, orderBy: { arrivalAt: 'asc' } });
  const inHouse = stays.filter((s) => s.status === 'CHECKED_IN' && s.guest.phone && s.room);
  const tomorrow = addDays(lagosDate(now), 1);
  const arriving = stays.filter((s) => s.status === 'CONFIRMED' && lagosDate(s.arrivalAt) === tomorrow && s.guest.phone);
  const ago = (m: number) => new Date(now.getTime() - m * MIN);
  type Msg = [dir: 'INBOUND' | 'OUTBOUND' | 'SYSTEM' | 'NOTE', body: string, minutesAgo: number, by?: Person | null, template?: [string, string[]]];
  let n = 0;
  const conv = async (o: { guest: Guest | null; phone: string; name: string; reservation?: { id: string } | null; status: 'OPEN' | 'PENDING' | 'CLOSED'; assignee?: Person | null; msgs: Msg[]; unread?: number; sla?: boolean; propertyId?: string; flowState?: string | null; notes?: string }) => {
    const pid = o.propertyId ?? lekki.id;
    const last = o.msgs[o.msgs.length - 1]!;
    const lastIn = [...o.msgs].reverse().find((m) => m[0] === 'INBOUND');
    const lastOut = [...o.msgs].reverse().find((m) => m[0] === 'OUTBOUND' || m[0] === 'SYSTEM');
    const c = await prisma.conversation.create({
      data: {
        tenantId,
        propertyId: pid,
        guestId: o.guest?.id ?? null,
        guestPhone: o.phone,
        guestName: o.name,
        reservationId: o.reservation?.id ?? null,
        status: o.status,
        assigneeId: o.assignee?.id ?? null,
        assigneeName: o.assignee?.fullName ?? null,
        lastMessageAt: ago(last[2]),
        lastInboundAt: lastIn ? ago(lastIn[2]) : null,
        lastOutboundAt: lastOut ? ago(lastOut[2]) : null,
        lastPreview: last[1].slice(0, 120),
        lastDirection: last[0],
        unreadCount: o.unread ?? 0,
        slaDueAt: o.sla && lastIn ? new Date(ago(lastIn[2]).getTime() + 15 * MIN) : null,
        flowState: o.flowState ?? null,
        notes: o.notes ?? '',
        createdAt: ago(o.msgs[0]![2]),
      },
    });
    const ids: string[] = [];
    for (const m of o.msgs) {
      const row = await prisma.conversationMessage.create({
        data: {
          tenantId,
          propertyId: pid,
          conversationId: c.id,
          direction: m[0],
          body: m[1],
          templateName: m[4]?.[0] ?? null,
          templateParams: m[4]?.[1] ?? [],
          status: m[0] === 'INBOUND' ? 'RECEIVED' : m[0] === 'NOTE' ? 'SENT' : m[2] > 30 ? 'READ' : 'DELIVERED',
          providerMessageId: m[0] === 'NOTE' ? null : `wamid.seed.${randomUUID()}`,
          sentById: m[3]?.id ?? null,
          sentByName: m[3]?.fullName ?? null,
          createdAt: ago(m[2]),
        },
      });
      ids.push(row.id);
    }
    n++;
    return { c, ids };
  };

  // 1. In-house guest asking for towels: pending housekeeping suggestion.
  const g1 = inHouse[0];
  if (g1) {
    const { c, ids } = await conv({
      guest: g1.guest,
      phone: g1.guest.phone!,
      name: g1.guest.fullName,
      reservation: g1,
      status: 'OPEN',
      unread: 1,
      sla: true,
      msgs: [
        ['SYSTEM', `Welcome to The Palmwine House, ${g1.guest.fullName.split(' ')[0]}. You are in room ${g1.room!.number}. Reply to this message with any request and our team will help.`, 26 * 60, null, ['in_stay_welcome', ['The Palmwine House', g1.guest.fullName.split(' ')[0]!, g1.room!.number]]],
        ['INBOUND', 'Good evening. Please can I get two extra towels and a bathrobe in the room?', 7],
      ],
    });
    await prisma.taskSuggestion.create({ data: { tenantId, propertyId: lekki.id, conversationId: c.id, messageId: ids[1]!, kind: 'HOUSEKEEPING', keyword: 'towel', summary: 'Towels requested', roomId: g1.roomId } });
  }
  // 2. AC complaint turned into a maintenance ticket.
  const g2 = inHouse[1];
  if (g2) {
    const room = g2.room!;
    const { c, ids } = await conv({
      guest: g2.guest,
      phone: g2.guest.phone!,
      name: g2.guest.fullName,
      reservation: g2,
      status: 'PENDING',
      assignee: ngozi,
      msgs: [
        ['INBOUND', 'Hi, the AC in my room is not cooling at all. It is very hot in here.', 95],
        ['OUTBOUND', 'Thank you, we are on it.', 90, ngozi],
        ['OUTBOUND', `So sorry about that. Emeka from maintenance is on his way to room ${room.number} now.`, 88, ngozi],
        ['INBOUND', 'Thank you, it is working now.', 40],
        ['OUTBOUND', 'Wonderful. Enjoy the rest of your evening.', 38, ngozi],
      ],
    });
    const seq = await prisma.$queryRaw<{ last_value: number }[]>`
      INSERT INTO document_counters (tenant_id, kind, year, scope, last_value) VALUES (${tenantId}::uuid, 'MAINTENANCE_TICKET', 0, '', 1)
      ON CONFLICT (tenant_id, kind, year, scope) DO UPDATE SET last_value = document_counters.last_value + 1 RETURNING last_value`;
    const emeka = ctx.users.get('emeka@palmwine.ng')!;
    const ticket = await prisma.maintenanceTicket.create({
      data: {
        tenantId,
        propertyId: lekki.id,
        number: `MT-${String(Number(seq[0]!.last_value)).padStart(6, '0')}`,
        roomId: room.id,
        category: 'AC_HVAC',
        priority: 'HIGH',
        status: 'RESOLVED',
        title: `Air conditioning problem, room ${room.number}`,
        description: 'Guest wrote on WhatsApp: "the AC in my room is not cooling at all". Gas top-up and filter cleaned.',
        reportedById: ngozi.id,
        reportedByName: ngozi.fullName,
        assigneeId: emeka.id,
        assigneeName: emeka.fullName,
        slaDueAt: ago(-60),
        resolvedAt: ago(45),
        createdAt: ago(90),
      },
    });
    await prisma.taskSuggestion.create({ data: { tenantId, propertyId: lekki.id, conversationId: c.id, messageId: ids[0]!, kind: 'MAINTENANCE', keyword: 'AC', summary: 'Air conditioning problem', category: 'AC_HVAC', roomId: room.id, status: 'CREATED', ticketId: ticket.id, decidedById: ngozi.id } });
  }
  // 3. Pre-arrival confirmation with an ETA.
  const g3 = arriving[0];
  if (g3) {
    const first = g3.guest.fullName.split(' ')[0]!;
    await prisma.reservation.update({ where: { id: g3.id }, data: { expectedArrivalTime: '15:00' } });
    await conv({
      guest: g3.guest,
      phone: g3.guest.phone!,
      name: g3.guest.fullName,
      reservation: g3,
      status: 'PENDING',
      msgs: [
        ['SYSTEM', `Hello ${first}, we look forward to welcoming you at The Palmwine House on ${tomorrow}. Reply 1 to confirm your arrival time.`, 180, null, ['pre_arrival_confirm', [first, 'The Palmwine House', tomorrow]]],
        ['INBOUND', '1', 150],
        ['SYSTEM', 'Thank you for confirming. What time do you expect to arrive?', 150],
        ['INBOUND', 'Around 3pm, flight lands at 1:30', 146],
        ['SYSTEM', 'Thank you. We have noted your arrival at about 3pm. See you soon.', 146],
      ],
    });
  }
  // 4. Outside the 24-hour window.
  await conv({
    guest: x.demoGuest,
    phone: x.demoGuest.phone!,
    name: x.demoGuest.fullName,
    status: 'PENDING',
    assignee: chidinma,
    msgs: [
      ['INBOUND', 'Hello, do you have a meeting room for 12 people next month?', 3 * 24 * 60 + 200],
      ['OUTBOUND', 'Hello Adaeze, yes: our courtyard room seats 14. Half day with tea break is ₦180,000. Shall I hold a date?', 3 * 24 * 60 + 180, chidinma],
    ],
  });
  // 5. Unassigned and overdue.
  const walkIn = await prisma.guest.upsert({ where: { tenantId_phone: { tenantId, phone: '+2348125559301' } }, create: { tenantId, fullName: 'Chukwuemeka Ibe', phone: '+2348125559301', consentAt: now }, update: {} });
  await conv({ guest: walkIn, phone: walkIn.phone!, name: walkIn.fullName, status: 'OPEN', unread: 2, sla: true, msgs: [['INBOUND', 'Good afternoon. What is your rate for a Deluxe King this Friday and Saturday?', 41], ['INBOUND', 'Also is breakfast included?', 38]] });
  // 6. Closed: late check-out.
  const g6 = inHouse[2];
  if (g6) {
    await conv({
      guest: g6.guest,
      phone: g6.guest.phone!,
      name: g6.guest.fullName,
      reservation: g6,
      status: 'CLOSED',
      assignee: ngozi,
      msgs: [
        ['INBOUND', 'Can I check out at 2pm tomorrow instead of 12?', 20 * 60],
        ['OUTBOUND', 'Yes, 2pm is fine at no charge. Enjoy the rest of your stay.', 19 * 60, ngozi],
        ['INBOUND', 'Thank you!', 19 * 60 - 5],
      ],
    });
  }
  // 7. Airport pickup question, answered.
  const g7 = arriving[1] ?? stays.find((s) => s.status === 'CONFIRMED' && s.guest.phone && s.id !== g3?.id);
  if (g7) {
    await conv({
      guest: g7.guest,
      phone: g7.guest.phone!,
      name: g7.guest.fullName,
      reservation: g7,
      status: 'PENDING',
      assignee: chidinma,
      msgs: [
        ['INBOUND', 'Hello, can you arrange a pickup from the airport? Arik flight W3 108 from Abuja.', 300],
        ['OUTBOUND', 'Our driver can meet you at the airport for ₦35,000 (Murtala Muhammed International). Send your flight number and landing time.', 290, chidinma],
        ['INBOUND', 'W3 108 landing 5:40pm. Please book it.', 280],
        ['OUTBOUND', 'Booked. Musa will be waiting at arrivals with a Palmwine House sign. His number is 0807 555 0104.', 270, chidinma],
        ['NOTE', 'Pickup added to the folio as an extra on arrival.', 268, chidinma],
      ],
    });
  }
  // 8. Restaurant question answered with a quick reply, still open.
  const g8 = inHouse[3];
  if (g8) {
    await conv({
      guest: g8.guest,
      phone: g8.guest.phone!,
      name: g8.guest.fullName,
      reservation: g8,
      status: 'OPEN',
      assignee: ngozi,
      msgs: [
        ['INBOUND', 'What time does breakfast start?', 11 * 60],
        ['OUTBOUND', 'Breakfast is served at The Yard from 7am to 11am. Room service breakfast is available until noon.', 11 * 60 - 3, ngozi],
        ['INBOUND', 'And the wifi password please?', 12],
      ],
      unread: 1,
      sla: true,
    });
  }
  // Ikoyi: one conversation.
  const ik = await prisma.reservation.findFirst({ where: { tenantId, propertyId: x.ikoyi.id, status: 'CHECKED_IN' }, include: { guest: true, room: true } });
  if (ik?.guest.phone) {
    await conv({
      guest: ik.guest,
      phone: ik.guest.phone,
      name: ik.guest.fullName,
      reservation: ik,
      status: 'PENDING',
      assignee: kelechi,
      propertyId: x.ikoyi.id,
      msgs: [
        ['INBOUND', 'Please can I have dinner on the terrace at 8pm for two?', 180],
        ['OUTBOUND', 'Of course. A table for two on the terrace at 8pm is booked in your name.', 170, kelechi],
      ],
    });
  }
  return n;
}

// =============================================================================
// Loyalty
// =============================================================================

async function seedLoyalty(ctx: SeedCtx, x: { lekki: Property; ikoyi: Property; demoGuest: Guest }): Promise<number> {
  const { prisma, tenantId, now, rand } = ctx;
  const owner = ctx.users.get('demo@palmwine.ng')!;
  const tunde = ctx.users.get('tunde@palmwine.ng')!;
  const ngozi = ctx.users.get('ngozi@palmwine.ng')!;
  const programme = await prisma.loyaltyProgramme.create({
    data: { tenantId, enabled: true, name: 'Palmwine Circle', earnPointsPer1000: 10, pointValueKobo: 100, minRedeemPoints: 1000, maxRedeemBps: 5000, expiryMonths: 24, adjustmentFlagPoints: 5000, enrolOnline: true, memberNoPrefix: 'PWC', createdAt: new Date(now.getTime() - 120 * DAY) },
  });
  const tiers = [
    await prisma.loyaltyTier.create({ data: { tenantId, name: 'Member', minNights: 0, bonusBps: 0, perks: ['Welcome palm wine on arrival', 'Members-only rates on the booking site'], color: 'palm', sortOrder: 0 } }),
    await prisma.loyaltyTier.create({ data: { tenantId, name: 'Silver', minNights: 10, bonusBps: 1000, perks: ['10% bonus points', 'Late check-out until 2pm', 'Free airport pickup once a year'], color: 'brass', sortOrder: 1 } }),
    await prisma.loyaltyTier.create({ data: { tenantId, name: 'Gold', minNights: 25, bonusBps: 2500, perks: ['25% bonus points', 'Room upgrade when available', 'Late check-out until 4pm', 'Breakfast for two every stay'], color: 'laterite', sortOrder: 2 } }),
  ];

  // ~30 members: guests with the most nights, the demo guest, some newer faces.
  const nights = await prisma.$queryRaw<{ guest_id: string; nights: number }[]>`
    SELECT guest_id::text, COALESCE(SUM(GREATEST(1, (departure_at AT TIME ZONE 'Africa/Lagos')::date - (arrival_at AT TIME ZONE 'Africa/Lagos')::date)), 0)::int AS nights
      FROM reservations WHERE tenant_id = ${tenantId}::uuid AND status = 'CHECKED_OUT' AND stay_type = 'NIGHTLY' AND departure_at >= now() - interval '365 days'
     GROUP BY guest_id`;
  const nightsBy = new Map(nights.map((r) => [r.guest_id, Number(r.nights)]));
  const all = await prisma.guest.findMany({ where: { tenantId, anonymisedAt: null, phone: { not: null } } });
  const ranked = all.sort((a, b) => (nightsBy.get(b.id) ?? 0) - (nightsBy.get(a.id) ?? 0));
  const chosen = new Map<string, Guest>();
  chosen.set(x.demoGuest.id, x.demoGuest);
  for (const g of ranked) {
    if (chosen.size >= 30) break;
    chosen.set(g.id, g);
  }
  let seq = 0;
  let members = 0;
  const flagged: { memberId: string; memberNo: string; guest: string; txnId: string }[] = [];
  for (const g of chosen.values()) {
    seq++;
    const n12 = nightsBy.get(g.id) ?? 0;
    const tier = tierFor(tiers, n12);
    const enrolledAt = new Date(now.getTime() - (30 + Math.floor(rand() * 300)) * DAY);
    const m = await prisma.loyaltyMember.create({
      data: { tenantId, guestId: g.id, memberNo: memberNumber(programme.memberNoPrefix, seq), tierId: tier?.id ?? null, nights12m: n12, enrolledVia: seq % 3 === 0 ? 'ONLINE' : seq % 3 === 1 ? 'CHECK_IN' : 'DESK', enrolledAt },
    });
    members++;
    let balance = 0;
    let lifetime = 0;
    const txns: Prisma.LoyaltyTransactionCreateManyInput[] = [];
    const push = (t: Omit<Prisma.LoyaltyTransactionCreateManyInput, 'tenantId' | 'memberId' | 'balanceAfter'>) => {
      balance += t.points;
      if (t.type === 'EARN') lifetime += t.points;
      txns.push({ ...t, tenantId, memberId: m.id, balanceAfter: balance });
    };
    // Earn on every checked-out stay since enrolment (eligible = live charges net of discounts).
    const stays = await prisma.reservation.findMany({ where: { tenantId, guestId: g.id, status: 'CHECKED_OUT', checkedOutAt: { gte: enrolledAt } }, include: { folio: { include: { entries: true } } }, orderBy: { checkedOutAt: 'asc' } });
    for (const s of stays) {
      const entries = s.folio?.entries ?? [];
      const voided = new Set(entries.filter((e) => e.type === 'VOID').map((e) => e.refEntryId));
      const eligible = entries.filter((e) => !voided.has(e.id) && ['ROOM', 'DAY_USE', 'EXTRA', 'DISCOUNT'].includes(e.type)).reduce((a, e) => a + Number(e.amountKobo), 0);
      const points = earnPoints(eligible, programme.earnPointsPer1000, tier?.bonusBps ?? 0);
      if (points <= 0) continue;
      push({ type: 'EARN', points, description: `Stay ${s.code}`, propertyId: s.propertyId, reservationId: s.id, folioId: s.folio?.id ?? null, remaining: points, expiresAt: new Date(s.checkedOutAt!.getTime() + 730 * DAY), dedupeKey: `EARN:${s.id}`, createdAt: s.checkedOutAt! });
    }
    // Some welcome bonuses, a big flagged adjustment, an old expired lot.
    if (seq % 4 === 0) push({ type: 'ADJUST', points: 500, description: 'Points added', reason: 'Welcome bonus for joining at the desk', propertyId: x.lekki.id, remaining: 500, expiresAt: new Date(enrolledAt.getTime() + 730 * DAY), createdById: ngozi.id, createdByName: ngozi.fullName, createdAt: new Date(enrolledAt.getTime() + HOUR) });
    if (seq === 5) {
      const id = randomUUID();
      push({ id, type: 'ADJUST', points: 6000, description: 'Points added', reason: 'Goodwill: wedding party of 8 rooms moved because of a burst pipe', propertyId: x.lekki.id, remaining: 6000, expiresAt: new Date(now.getTime() + 700 * DAY), createdById: tunde.id, createdByName: tunde.fullName, createdAt: new Date(now.getTime() - 2 * DAY) });
      flagged.push({ memberId: m.id, memberNo: m.memberNo, guest: g.fullName, txnId: id });
    }
    if (seq === 7) {
      const lotAt = new Date(enrolledAt.getTime() - 400 * DAY);
      push({ type: 'ADJUST', points: 800, description: 'Points added', reason: 'Migrated from the old paper stamp card', propertyId: x.lekki.id, remaining: 0, expiresAt: new Date(now.getTime() - 5 * DAY), createdById: owner.id, createdByName: owner.fullName, createdAt: lotAt });
      push({ type: 'EXPIRE', points: -800, description: `Points earned ${lagosDate(lotAt)} expired`, dedupeKey: `EXPIRE:seed-${m.id}`, createdAt: new Date(now.getTime() - 5 * DAY + 4 * HOUR) });
    }
    // Redemptions (FIFO from the earn lots) for a few members with points.
    if (seq % 6 === 2 && balance >= 2000) {
      const pts = 1000 * Math.min(3, Math.floor(balance / 2000));
      let left = pts;
      for (const t of txns) {
        if (left <= 0) break;
        const rem = (t.remaining as number) ?? 0;
        if (rem <= 0) continue;
        const take = Math.min(rem, left);
        t.remaining = rem - take;
        left -= take;
      }
      push({ type: 'REDEEM', points: -pts, description: 'Redeemed on a stay', propertyId: x.lekki.id, createdById: ngozi.id, createdByName: ngozi.fullName, createdAt: new Date(now.getTime() - (3 + seq) * DAY) });
    }
    if (txns.length) await prisma.loyaltyTransaction.createMany({ data: txns });
    await prisma.loyaltyMember.update({ where: { id: m.id }, data: { points: Math.max(0, balance), lifetimePoints: lifetime } });
  }
  for (const f of flagged) {
    await prisma.guardFlag.create({
      data: {
        tenantId,
        propertyId: x.lekki.id,
        rule: 'LOYALTY_ADJUSTMENT',
        severity: 'MEDIUM',
        title: `+6,000 points for ${f.guest}`,
        detail: `${tunde.fullName} adjusted ${f.memberNo} by 6,000 points (worth ₦6,000). Reason: Goodwill: wedding party of 8 rooms moved because of a burst pipe`,
        dedupeKey: `LOYALTY_ADJUSTMENT:${f.txnId}`,
        amountKobo: BigInt(600_000),
        userId: tunde.id,
        userName: tunde.fullName,
        evidence: { memberId: f.memberId, memberNo: f.memberNo, points: 6000, transactionId: f.txnId } as Prisma.InputJsonValue,
        createdAt: new Date(now.getTime() - 2 * DAY),
      },
    });
  }
  // Member numbers continue after the seeded ones.
  await prisma.$executeRaw`INSERT INTO document_counters (tenant_id, kind, year, scope, last_value) VALUES (${tenantId}::uuid, 'LOYALTY_MEMBER', 0, '', ${seq})
    ON CONFLICT (tenant_id, kind, year, scope) DO UPDATE SET last_value = EXCLUDED.last_value`;
  return members;
}

