/**
 * Idempotent seed: `pnpm db:seed` can be run any number of times.
 *
 * Runs as the schema owner (DATABASE_MIGRATION_URL), which is a superuser in
 * local development and therefore not subject to RLS. Natural keys (codes,
 * slugs, emails, room numbers) are used for upserts so nothing is duplicated.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import { PrismaClient, type Prisma } from '../src/generated/prisma/client.js';
import { FEATURES, PLANS } from './seed-data/catalogue.js';
import { ALL_HOTELS, DEMO_HOTEL, type HotelSeed } from './seed-data/hotels.js';

const DAY = 24 * 60 * 60 * 1000;
const NAIRA = 100;

const PLATFORM_ADMIN = {
  email: 'admin@devstrike.ng',
  password: 'Admin1234!',
  fullName: 'Devstrike Admin',
};
const HOTEL_PASSWORD = 'Demo1234!';

const argonOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} satisfies argon2.HashOptions;

const url =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://hotel:hotel@localhost:5432/hotel';
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});

async function seedCatalogue() {
  for (const f of FEATURES) {
    await prisma.feature.upsert({
      where: { code: f.code },
      create: f,
      update: { name: f.name, description: f.description, category: f.category },
    });
  }
  for (const p of PLANS) {
    const data = {
      name: p.name,
      tagline: p.tagline,
      priceMonthlyKobo: p.priceMonthlyKobo,
      priceYearlyKobo: p.priceYearlyKobo,
      limits: p.limits,
      commissionBps: p.commissionBps,
      highlighted: p.highlighted,
      sortOrder: p.sortOrder,
      isActive: true,
    };
    const plan = await prisma.plan.upsert({
      where: { code: p.code },
      create: { code: p.code, ...data },
      update: data,
    });
    await prisma.planFeature.deleteMany({ where: { planId: plan.id } });
    await prisma.planFeature.createMany({
      data: p.features.map((featureCode) => ({ planId: plan.id, featureCode })),
    });
  }
  console.log(`  features: ${FEATURES.length}, plans: ${PLANS.length}`);
}

async function seedPlatformAdmin() {
  const passwordHash = await argon2.hash(PLATFORM_ADMIN.password, argonOptions);
  await prisma.platformUser.upsert({
    where: { email: PLATFORM_ADMIN.email },
    create: {
      email: PLATFORM_ADMIN.email,
      fullName: PLATFORM_ADMIN.fullName,
      passwordHash,
      role: 'SUPER_ADMIN',
    },
    update: { fullName: PLATFORM_ADMIN.fullName, passwordHash, isActive: true },
  });
  console.log(`  platform admin: ${PLATFORM_ADMIN.email}`);
}

async function seedHotel(h: HotelSeed, passwordHash: string) {
  const now = Date.now();
  const createdAt = new Date(now - h.createdDaysAgo * DAY);

  const tenant = await prisma.tenant.upsert({
    where: { slug: h.slug },
    create: { name: h.name, slug: h.slug, city: h.city, state: h.state, createdAt },
    update: { name: h.name, city: h.city, state: h.state },
  });

  const propertyData = {
    name: h.name,
    tagline: h.tagline,
    description: h.description,
    address: h.address,
    city: h.city,
    state: h.state,
    area: h.area,
    phone: h.phone,
    email: h.email,
    checkInTime: h.checkInTime,
    checkOutTime: h.checkOutTime,
    coverImageUrl: h.coverImageUrl,
    images: h.images as Prisma.InputJsonValue,
    amenities: h.amenities,
    policies: h.policies,
    accentColor: h.accentColor,
    listedOnMarketplace: true,
    featured: h.featured,
    rating: h.rating,
    reviewCount: h.reviewCount,
  };
  const property = await prisma.property.upsert({
    where: { slug: h.slug },
    create: { tenantId: tenant.id, slug: h.slug, createdAt, ...propertyData },
    update: propertyData,
  });

  const typeIds = new Map<string, string>();
  for (const [i, rt] of h.roomTypes.entries()) {
    const data = {
      description: rt.description,
      basePriceKobo: rt.basePriceNaira * NAIRA,
      hourlyPriceKobo:
        rt.hourlyPriceNaira !== undefined ? rt.hourlyPriceNaira * NAIRA : null,
      capacity: rt.capacity,
      bedType: rt.bedType,
      sizeSqm: rt.sizeSqm,
      amenities: rt.amenities,
      images: rt.images as Prisma.InputJsonValue,
      sortOrder: i,
    };
    const row = await prisma.roomType.upsert({
      where: { propertyId_name: { propertyId: property.id, name: rt.name } },
      create: { tenantId: tenant.id, propertyId: property.id, name: rt.name, ...data },
      update: data,
    });
    typeIds.set(rt.name, row.id);
  }

  for (const r of h.rooms) {
    const roomTypeId = typeIds.get(r.type);
    if (!roomTypeId) throw new Error(`Unknown room type ${r.type} in ${h.slug}`);
    const data = { roomTypeId, floor: r.floor, status: r.status, notes: r.notes ?? null };
    await prisma.room.upsert({
      where: { propertyId_number: { propertyId: property.id, number: r.number } },
      create: { tenantId: tenant.id, propertyId: property.id, number: r.number, ...data },
      update: data,
    });
  }

  const people = [h.owner, ...h.staff];
  const userIds = new Map<string, string>();
  for (const s of people) {
    const user = await prisma.user.upsert({
      where: { email: s.email },
      create: {
        tenantId: tenant.id,
        email: s.email,
        fullName: s.fullName,
        phone: s.phone,
        role: s.role,
        passwordHash,
        createdAt,
      },
      update: {
        tenantId: tenant.id,
        fullName: s.fullName,
        phone: s.phone,
        role: s.role,
        passwordHash,
        isActive: true,
      },
    });
    userIds.set(s.email, user.id);
  }

  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: h.plan } });
  const periodEnd =
    h.periodEndsInDays !== undefined ? new Date(now + h.periodEndsInDays * DAY) : null;
  const periodLength = h.interval === 'YEARLY' ? 365 : 30;
  const subData = {
    planId: plan.id,
    status: h.status,
    interval: h.interval,
    trialEndsAt:
      h.trialEndsInDays !== undefined ? new Date(now + h.trialEndsInDays * DAY) : null,
    currentPeriodEnd: periodEnd,
    currentPeriodStart: periodEnd ? new Date(periodEnd.getTime() - periodLength * DAY) : null,
    pastDueAt: h.status === 'PAST_DUE' && periodEnd ? new Date(periodEnd.getTime() + 3 * DAY) : null,
    readOnlyAt: null,
    suspendedAt: null,
    cancelledAt: null,
  };
  const subscription = await prisma.subscription.upsert({
    where: { tenantId: tenant.id },
    create: { tenantId: tenant.id, createdAt, ...subData },
    update: subData,
  });

  // Paid invoice history for paying tenants (one per past period, max 3).
  if (periodEnd && plan.priceMonthlyKobo !== null) {
    const amount =
      h.interval === 'YEARLY' ? plan.priceYearlyKobo ?? 0 : plan.priceMonthlyKobo;
    for (let k = 0; k < 3; k++) {
      const paidAt = new Date(periodEnd.getTime() - (k + 1) * periodLength * DAY);
      if (paidAt.getTime() < createdAt.getTime()) break;
      const reference = `SEED-${h.slug}-${k + 1}`;
      await prisma.invoice.upsert({
        where: { reference },
        create: {
          tenantId: tenant.id,
          subscriptionId: subscription.id,
          reference,
          amountKobo: amount,
          status: 'PAID',
          planCode: plan.code,
          interval: h.interval,
          paidAt,
          createdAt: paidAt,
        },
        update: {},
      });
    }
  }

  // Audit history: written once (audit_logs is append-only by design).
  const existingAudit = await prisma.auditLog.count({ where: { tenantId: tenant.id } });
  if (existingAudit === 0) {
    await seedAuditHistory(h, tenant.id, userIds, typeIds, createdAt);
  }

  return { tenantId: tenant.id, rooms: h.rooms.length, users: people.length };
}

async function seedAuditHistory(
  h: HotelSeed,
  tenantId: string,
  userIds: Map<string, string>,
  typeIds: Map<string, string>,
  createdAt: Date,
) {
  const owner = { id: userIds.get(h.owner.email)!, name: h.owner.fullName };
  const entries: Prisma.AuditLogCreateManyInput[] = [
    {
      tenantId,
      actorUserId: owner.id,
      actorName: owner.name,
      action: 'tenant.signup',
      entityType: 'tenant',
      entityId: tenantId,
      metadata: { hotelName: h.name },
      createdAt,
    },
  ];

  if (h.slug === DEMO_HOTEL.slug) {
    const staff = (email: string) => {
      const s = h.staff.find((x) => x.email === email)!;
      return { id: userIds.get(email)!, name: s.fullName };
    };
    const tunde = staff('tunde@palmwine.ng');
    const ngozi = staff('ngozi@palmwine.ng');
    const musa = staff('musa@palmwine.ng');
    const hoursAgo = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000);
    const push = (
      actor: { id: string; name: string },
      action: string,
      entityType: string,
      entityId: string | null,
      metadata: Record<string, unknown>,
      at: Date,
    ) =>
      entries.push({
        tenantId,
        actorUserId: actor.id,
        actorName: actor.name,
        action,
        entityType,
        entityId,
        metadata: metadata as Prisma.InputJsonValue,
        createdAt: at,
      });

    push(owner, 'room_type.created', 'room_type', typeIds.get('Standard Queen')!, { name: 'Standard Queen' }, new Date(createdAt.getTime() + 60_000));
    push(owner, 'room_type.created', 'room_type', typeIds.get('Deluxe King')!, { name: 'Deluxe King' }, new Date(createdAt.getTime() + 120_000));
    push(owner, 'room_type.created', 'room_type', typeIds.get('Palm Suite')!, { name: 'Palm Suite' }, new Date(createdAt.getTime() + 180_000));
    push(owner, 'room.bulk_created', 'room', null, { count: 24, from: '101', to: '308' }, new Date(createdAt.getTime() + 600_000));
    for (const s of h.staff) {
      push(owner, 'staff.created', 'user', userIds.get(s.email)!, { fullName: s.fullName, role: s.role }, new Date(createdAt.getTime() + 3_600_000));
    }
    push(owner, 'subscription.activated', 'subscription', null, { planCode: 'growth', interval: 'MONTHLY' }, new Date(Date.now() - 10 * DAY));
    push(tunde, 'room_type.updated', 'room_type', typeIds.get('Deluxe King')!, { changes: ['basePriceKobo'] }, hoursAgo(50));
    push(musa, 'room.status_changed', 'room', null, { number: '106', from: 'VACANT_DIRTY', to: 'OUT_OF_ORDER', note: 'AC compressor replacement booked for Thursday' }, hoursAgo(30));
    push(ngozi, 'room.status_changed', 'room', null, { number: '205', from: 'VACANT_CLEAN', to: 'OCCUPIED' }, hoursAgo(6));
    push(musa, 'room.status_changed', 'room', null, { number: '302', from: 'VACANT_DIRTY', to: 'VACANT_CLEAN' }, hoursAgo(4));
    push(ngozi, 'room.status_changed', 'room', null, { number: '203', from: 'VACANT_CLEAN', to: 'RESERVED', note: 'Late arrival, guest landing 23:40' }, hoursAgo(2));
    push(ngozi, 'room.status_changed', 'room', null, { number: '104', from: 'OCCUPIED', to: 'VACANT_DIRTY' }, hoursAgo(1));
  }

  await prisma.auditLog.createMany({ data: entries });
}

async function main() {
  console.log('Seeding catalogue...');
  await seedCatalogue();
  await seedPlatformAdmin();

  console.log('Seeding hotels...');
  const passwordHash = await argon2.hash(HOTEL_PASSWORD, argonOptions);
  for (const h of ALL_HOTELS) {
    const r = await seedHotel(h, passwordHash);
    console.log(`  ${h.slug.padEnd(22)} ${h.plan.padEnd(10)} ${h.status.padEnd(9)} rooms=${r.rooms} users=${r.users}`);
  }
  console.log('Done. Hotel logins use password "%s"; demo owner: %s', HOTEL_PASSWORD, DEMO_HOTEL.owner.email);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
