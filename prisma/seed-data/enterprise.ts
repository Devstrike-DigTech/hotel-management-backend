/**
 * M6 demo data: Harmattan Hotels & Suites (Enterprise, three properties,
 * white-label, SSO, API keys, webhooks, its own dedicated database) and the
 * platform console data (announcements, support desk, failed jobs, failed
 * notifications, a past support session, coupons).
 *
 * Idempotent: once Harmattan lives in its dedicated database, its
 * operational rows are left alone and only control-plane rows are updated.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { platformKeyMaterial, SecretCipher, sha256Hex } from '../../src/common/crypto/secret-box.js';
import { formatApiKey } from '../../src/modules/enterprise/api-keys/api-keys.logic.js';
import { signatureHeader } from '../../src/modules/enterprise/webhooks/webhooks.logic.js';
import { mockEmailRecords } from '../../src/modules/enterprise/white-label/white-label.logic.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NAIRA = 100;

export const HARMATTAN = {
  name: 'Harmattan Hotels & Suites',
  slug: 'harmattan',
  city: 'Abuja',
  state: 'FCT',
  owner: { email: 'owner@harmattanhotels.com', fullName: 'Amina Danjuma', phone: '+2348031110001' },
  staff: [
    { email: 'gm@harmattanhotels.com', fullName: 'Chuka Nwosu', phone: '+2348031110002', role: 'MANAGER' as const },
    { email: 'frontdesk.abuja@harmattanhotels.com', fullName: 'Blessing Okon', phone: '+2348031110003', role: 'FRONT_DESK' as const },
  ],
  customPriceKobo: 1_250_000 * NAIRA,
  bookingDomain: 'book.harmattanhotels.com',
  groupDomain: 'www.harmattanhotels.com',
  staffPortal: 'staff.harmattanhotels.com',
  emailDomain: 'mail.harmattanhotels.com',
  smsSender: 'HARMATTAN',
};

const PROPERTIES = [
  {
    slug: 'harmattan-abuja', name: 'Harmattan Abuja', city: 'Abuja', state: 'FCT', area: 'Maitama', prefix: 'HHA',
    address: '12 Aguiyi Ironsi Street, Maitama', phone: '+2349061110010', email: 'abuja@harmattanhotels.com',
    rooms: [{ type: 'Deluxe King', from: 101, count: 8, price: 95_000 }, { type: 'Executive Twin', from: 201, count: 6, price: 120_000 }, { type: 'Harmattan Suite', from: 301, count: 3, price: 210_000 }],
  },
  {
    slug: 'harmattan-lagos', name: 'Harmattan Lagos', city: 'Lagos', state: 'Lagos', area: 'Victoria Island', prefix: 'HHL',
    address: '4 Adeola Odeku Street, Victoria Island', phone: '+2349061110020', email: 'lagos@harmattanhotels.com',
    rooms: [{ type: 'Deluxe King', from: 101, count: 10, price: 110_000 }, { type: 'Executive Twin', from: 201, count: 6, price: 140_000 }, { type: 'Harmattan Suite', from: 301, count: 2, price: 250_000 }],
  },
  {
    slug: 'harmattan-port-harcourt', name: 'Harmattan Port Harcourt', city: 'Port Harcourt', state: 'Rivers', area: 'GRA', prefix: 'HHP',
    address: '21 Tombia Street, GRA Phase 2', phone: '+2349061110030', email: 'portharcourt@harmattanhotels.com',
    rooms: [{ type: 'Deluxe King', from: 101, count: 6, price: 85_000 }, { type: 'Executive Twin', from: 201, count: 4, price: 105_000 }],
  },
];

const GUESTS = [
  ['Tunde Bakare', '+2348021230001'], ['Ngozi Eze', '+2348021230002'], ['Ibrahim Sule', '+2348021230003'], ['Folake Adeyemi', '+2348021230004'],
  ['Emeka Obi', '+2348021230005'], ['Hauwa Musa', '+2348021230006'], ['Kunle Ajayi', '+2348021230007'], ['Adaeze Nnaji', '+2348021230008'],
] as const;

/** Dev API key secrets (40 characters, base62): stable so docs and scripts can use them. */
export const DEV_API_KEYS = {
  live: { name: 'Channel sync', environment: 'LIVE' as const, prefix: 'hhchannel1', secret: 'devHarmattanLiveKeyDoNotUseInProduction1'.padEnd(40, '0').slice(0, 40), scopes: ['reservations:read', 'reservations:write', 'availability:read', 'rates:read', 'rates:write', 'webhooks:manage'] },
  test: { name: 'Staging integration', environment: 'TEST' as const, prefix: 'hhstaging1', secret: 'devHarmattanTestKeyDoNotUseInProduction1'.padEnd(40, '0').slice(0, 40), scopes: ['reservations:read', 'reservations:write', 'availability:read', 'rates:read', 'rooms:read', 'rooms:write', 'guests:read', 'folios:read', 'housekeeping:read', 'housekeeping:write', 'reports:read', 'webhooks:manage'] },
};

export const DEV_WEBHOOK_SECRET = 'whsec_devHarmattanWebhookSecret000000000';

function cipher() {
  return new SecretCipher(platformKeyMaterial({ PLATFORM_DATA_KEY: process.env.PLATFORM_DATA_KEY?.trim() || undefined, GUEST_DATA_KEY: process.env.GUEST_DATA_KEY ?? '' }));
}

const uuidFrom = (s: string) => {
  const h = createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** Operational rows of Harmattan (shared database; copied to the dedicated one when provisioned). */
export async function seedHarmattan(prisma: PrismaClient, passwordHash: string): Promise<{ tenantId: string; dedicated: boolean }> {
  const now = Date.now();
  const createdAt = new Date(now - 240 * DAY);
  const tenant = await prisma.tenant.upsert({
    where: { slug: HARMATTAN.slug },
    create: { name: HARMATTAN.name, slug: HARMATTAN.slug, city: HARMATTAN.city, state: HARMATTAN.state, createdAt },
    update: { name: HARMATTAN.name, city: HARMATTAN.city, state: HARMATTAN.state, lifecycle: 'ACTIVE' },
  });
  const tenantId = tenant.id;

  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'enterprise' } });
  const periodStart = new Date(now - 10 * DAY);
  const subData = {
    planId: plan.id, status: 'ACTIVE' as const, interval: 'MONTHLY' as const, trialEndsAt: null,
    currentPeriodStart: periodStart, currentPeriodEnd: new Date(periodStart.getTime() + 30 * DAY),
    pastDueAt: null, readOnlyAt: null, suspendedAt: null, cancelledAt: null,
    customPriceKobo: HARMATTAN.customPriceKobo,
    contractStartAt: new Date('2026-01-01T00:00:00+01:00'), contractEndAt: new Date('2027-12-31T23:59:59+01:00'),
    contractNotes: 'Two-year Enterprise agreement: three properties, dedicated database, white-label, SSO. Invoiced monthly in advance.',
  };
  const sub = await prisma.subscription.upsert({ where: { tenantId }, create: { tenantId, createdAt, ...subData }, update: subData });
  for (let k = 0; k < 3; k++) {
    const paidAt = new Date(periodStart.getTime() - k * 30 * DAY);
    const reference = `SEED-harmattan-${k + 1}`;
    await prisma.invoice.upsert({
      where: { reference },
      create: { tenantId, subscriptionId: sub.id, reference, amountKobo: HARMATTAN.customPriceKobo, status: 'PAID', planCode: 'enterprise', interval: 'MONTHLY', paidAt, createdAt: paidAt },
      update: {},
    });
  }

  const reg = await prisma.tenantDatabase.findUnique({ where: { tenantId } });
  if (reg?.mode === 'DEDICATED') return { tenantId, dedicated: true };

  const propertyIds: string[] = [];
  const firstRooms: { propertyId: string; roomTypeId: string; roomId: string; rate: number; prefix: string }[] = [];
  for (const [i, p] of PROPERTIES.entries()) {
    const data = {
      name: p.name, city: p.city, state: p.state, area: p.area, address: p.address, phone: p.phone, email: p.email,
      tagline: 'Warm Nigerian hospitality, all year round',
      description: `${p.name} is part of Harmattan Hotels & Suites: calm rooms, fast Wi-Fi, a business centre and an all-day restaurant in ${p.area}.`,
      invoicePrefix: p.prefix, accentColor: '#B4532A', listedOnMarketplace: true, amenities: ['Wi-Fi', 'Restaurant', 'Pool', 'Gym', 'Airport shuttle'],
      ...(i === 0 && { customDomain: HARMATTAN.bookingDomain, customDomainVerifiedAt: new Date(now - 60 * DAY) }),
    };
    const prop = await prisma.property.upsert({ where: { slug: p.slug }, create: { tenantId, slug: p.slug, createdAt, ...data }, update: data });
    propertyIds.push(prop.id);
    await prisma.ratePlan.upsert({
      where: { propertyId_code: { propertyId: prop.id, code: 'BAR' } },
      create: { tenantId, propertyId: prop.id, code: 'BAR', name: 'Best Available Rate', description: "Flexible rate at the day's best price.", kind: 'BAR', isBar: true, pricing: 'DERIVED' },
      update: {},
    });
    for (const [j, rt] of p.rooms.entries()) {
      const type = await prisma.roomType.upsert({
        where: { propertyId_name: { propertyId: prop.id, name: rt.type } },
        create: { tenantId, propertyId: prop.id, name: rt.type, basePriceKobo: rt.price * NAIRA, capacity: rt.type.includes('Suite') ? 3 : 2, bedType: rt.type.includes('Twin') ? 'Twin' : 'King', sizeSqm: rt.type.includes('Suite') ? 48 : 28, amenities: ['Air conditioning', 'Smart TV', 'Work desk'], sortOrder: j },
        update: { basePriceKobo: rt.price * NAIRA },
      });
      for (let n = 0; n < rt.count; n++) {
        const number = String(rt.from + n);
        const room = await prisma.room.upsert({
          where: { propertyId_number: { propertyId: prop.id, number } },
          create: { tenantId, propertyId: prop.id, roomTypeId: type.id, number, floor: Math.floor(rt.from / 100), status: 'VACANT_CLEAN' },
          update: {},
        });
        if (j === 0 && n < 4) firstRooms.push({ propertyId: prop.id, roomTypeId: type.id, roomId: room.id, rate: rt.price * NAIRA, prefix: p.prefix });
      }
    }
  }
  const abuja = propertyIds[0]!;
  await prisma.customDomain.upsert({
    where: { domain: HARMATTAN.bookingDomain },
    create: { tenantId, propertyId: abuja, domain: HARMATTAN.bookingDomain, status: 'VERIFIED', token: 'harmattan-dev-token', txtOk: true, cnameOk: true, verifiedAt: new Date(now - 60 * DAY), lastCheckedAt: new Date(now - DAY) },
    update: { status: 'VERIFIED' },
  });
  // The group root on its own domain (all three hotels).
  await prisma.customDomain.upsert({
    where: { domain: HARMATTAN.groupDomain },
    create: { tenantId, propertyId: abuja, domain: HARMATTAN.groupDomain, scope: 'GROUP', status: 'VERIFIED', token: 'harmattan-group-dev-token', txtOk: true, cnameOk: true, verifiedAt: new Date(now - 60 * DAY), lastCheckedAt: new Date(now - DAY) },
    update: { status: 'VERIFIED', scope: 'GROUP' },
  });

  const people = [{ ...HARMATTAN.owner, role: 'OWNER' as const }, ...HARMATTAN.staff];
  const userIds = new Map<string, string>();
  for (const s of people) {
    const u = await prisma.user.upsert({
      where: { email: s.email },
      create: { tenantId, email: s.email, fullName: s.fullName, phone: s.phone, role: s.role, passwordHash, createdAt },
      update: { tenantId, fullName: s.fullName, phone: s.phone, role: s.role, passwordHash, isActive: true },
    });
    userIds.set(s.email, u.id);
  }

  // A few stays per property so the dashboards, partner API and webhooks have data.
  if ((await prisma.reservation.count({ where: { tenantId } })) === 0) {
    const guestIds: string[] = [];
    for (const [name, phone] of GUESTS) {
      const g = await prisma.guest.create({ data: { tenantId, fullName: name, phone, email: `${name.toLowerCase().replace(/ /g, '.')}@example.ng` } });
      guestIds.push(g.id);
    }
    let seq = 1001;
    const lagosNoon = (days: number) => new Date(Math.floor((now + days * DAY) / DAY) * DAY + 13 * HOUR);
    for (const [i, r] of firstRooms.entries()) {
      const variants = [
        { status: 'CHECKED_IN' as const, arrive: -1, nights: 3, roomStatus: 'OCCUPIED' as const },
        { status: 'CONFIRMED' as const, arrive: 2, nights: 2 },
        { status: 'CONFIRMED' as const, arrive: 7, nights: 4 },
        { status: 'CHECKED_OUT' as const, arrive: -6, nights: 2 },
      ];
      const v = variants[i % variants.length]!;
      const arrivalAt = lagosNoon(v.arrive);
      const departureAt = new Date(arrivalAt.getTime() + v.nights * DAY - 2 * HOUR);
      const id = randomUUID();
      await prisma.reservation.create({
        data: {
          id, tenantId, propertyId: r.propertyId, code: `${r.prefix}-${seq++}`, guestId: guestIds[i % guestIds.length]!, roomTypeId: r.roomTypeId,
          roomId: v.status === 'CONFIRMED' && v.arrive > 3 ? null : r.roomId, stayType: 'NIGHTLY', arrivalAt, departureAt, adults: 2, children: 0,
          source: i % 3 === 0 ? 'API' : i % 3 === 1 ? 'BOOKING_SITE' : 'WALK_IN', status: v.status, rateKobo: r.rate,
          nightlyRates: Array.from({ length: v.nights }, (_, n) => ({ date: new Date(arrivalAt.getTime() + n * DAY).toISOString().slice(0, 10), rateKobo: r.rate, baseRateKobo: r.rate, source: 'BASE', ruleId: null, ruleName: null, discountKobo: 0 })) as unknown as Prisma.InputJsonValue,
          externalRef: i % 3 === 0 ? `CS-${40_000 + i}` : null,
          createdById: userIds.get(HARMATTAN.staff[1]!.email) ?? null,
          ...(v.status === 'CHECKED_IN' || v.status === 'CHECKED_OUT' ? { checkedInAt: arrivalAt } : {}),
          ...(v.status === 'CHECKED_OUT' ? { checkedOutAt: departureAt } : {}),
        },
      });
      await prisma.folio.create({ data: { tenantId, propertyId: r.propertyId, kind: 'RESERVATION', reservationId: id, guestId: guestIds[i % guestIds.length]!, name: GUESTS[i % GUESTS.length]![0] } });
      if (v.roomStatus) await prisma.room.update({ where: { id: r.roomId }, data: { status: v.roomStatus } });
    }
  }

  // Webhook endpoints (tenant data: they move with the tenant's database).
  if ((await prisma.webhookEndpoint.count({ where: { tenantId } })) === 0) await seedWebhooks(prisma, tenantId, userIds.get(HARMATTAN.owner.email)!);

  return { tenantId, dedicated: false };
}

async function seedWebhooks(prisma: PrismaClient, tenantId: string, ownerId: string) {
  const c = cipher();
  const now = Date.now();
  const main = await prisma.webhookEndpoint.create({
    data: {
      tenantId, url: 'https://hooks.harmattanhotels.com/pms', description: 'Group PMS bridge', events: ['reservation.created', 'reservation.updated', 'reservation.cancelled', 'payment.received'],
      secretEnc: c.seal(DEV_WEBHOOK_SECRET, 'webhook-secret'), secretLast4: DEV_WEBHOOK_SECRET.slice(-4), createdById: ownerId, createdByName: HARMATTAN.owner.fullName,
      lastSuccessAt: new Date(now - 3 * HOUR), lastFailureAt: new Date(now - 40 * 60_000), consecutiveFailures: 2, failingSince: new Date(now - 50 * 60_000),
    },
  });
  const old = await prisma.webhookEndpoint.create({
    data: {
      tenantId, url: 'https://legacy-bi.harmattanhotels.com/ingest', description: 'Old BI collector (retired)', events: ['*'], status: 'DISABLED',
      disabledReason: 'SUSTAINED_FAILURE', disabledAt: new Date(now - 5 * DAY), failingSince: new Date(now - 6 * DAY), consecutiveFailures: 14,
      lastFailureAt: new Date(now - 5 * DAY), secretEnc: c.seal(`${DEV_WEBHOOK_SECRET}old`, 'webhook-secret'), secretLast4: 'dold', createdById: ownerId, createdByName: HARMATTAN.owner.fullName,
    },
  });
  const deliveries: Prisma.WebhookDeliveryCreateManyInput[] = [];
  const make = (endpointId: string, url: string, i: number, status: string, code: number | null, error: string | null, ago: number) => {
    const at = new Date(now - ago);
    const eventId = `evt_seed${String(i).padStart(4, '0')}${createHash('sha1').update(url + i).digest('hex').slice(0, 12)}`;
    const type = ['reservation.created', 'reservation.updated', 'payment.received', 'reservation.cancelled'][i % 4]!;
    const payload = { id: eventId, type, createdAt: at.toISOString(), apiVersion: '2026-09-24', livemode: true, tenantId, propertyId: null, data: { object: { code: `HHA-${1001 + (i % 4)}`, note: 'seeded example' } } };
    const body = JSON.stringify(payload);
    const ts = Math.floor(at.getTime() / 1000);
    deliveries.push({
      tenantId, endpointId, eventId, eventType: type, payload: payload as Prisma.InputJsonValue, status, attempts: status === 'SUCCEEDED' ? 1 : status === 'FAILED' ? 8 : 3,
      lastAttemptAt: at, responseStatus: code, durationMs: code ? 180 + (i % 5) * 40 : 10_000, error,
      nextAttemptAt: status === 'RETRYING' ? new Date(now + 2 * HOUR) : null,
      requestHeaders: { 'content-type': 'application/json', 'x-event-id': eventId, 'x-event-type': type, 'x-signature': signatureHeader(['whsec_seed'], ts, body).replace(/v1=([0-9a-f]{8})[0-9a-f]+/, 'v1=$1...') },
      responseHeaders: code ? { 'content-type': 'application/json' } : {},
      responseBody: code === 200 ? '{"ok":true}' : code ? '{"error":"upstream timeout"}' : null,
      attemptLog: [{ at: at.toISOString(), responseStatus: code, durationMs: code ? 200 : 10_000, error }] as Prisma.InputJsonValue,
      createdAt: at,
    });
  };
  for (let i = 0; i < 12; i++) make(main.id, main.url, i, 'SUCCEEDED', 200, null, (i + 4) * 3 * HOUR);
  make(main.id, main.url, 12, 'RETRYING', 503, 'HTTP 503', 40 * 60_000);
  make(main.id, main.url, 13, 'FAILED', 500, 'HTTP 500', 20 * HOUR);
  for (let i = 0; i < 4; i++) make(old.id, old.url, 20 + i, 'FAILED', null, 'DNS_FAILED: Could not resolve legacy-bi.harmattanhotels.com', (5 + i) * DAY);
  await prisma.webhookDelivery.createMany({ data: deliveries });
}

/** Control-plane rows of Harmattan (always on the shared database). */
export async function seedHarmattanControl(prisma: PrismaClient, tenantId: string, ownerId: string | null): Promise<string[]> {
  const c = cipher();
  const now = Date.now();
  const wl = {
    enabled: true, brandName: 'Harmattan Hotels & Suites', logoUrl: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=256&h=256&fit=crop',
    faviconUrl: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=64&h=64&fit=crop', primaryColor: '#7A2E12', accentColor: '#D98E3A',
    headingFont: 'Cormorant Garamond', bodyFont: 'Work Sans',
    footerLinks: [{ label: 'About the group', url: 'https://harmattanhotels.com/about' }, { label: 'Careers', url: 'https://harmattanhotels.com/careers' }, { label: 'Contact', url: 'mailto:hello@harmattanhotels.com' }] as Prisma.InputJsonValue,
    hidePoweredBy: true, emailFromName: 'Harmattan Reservations',
  };
  await prisma.whiteLabelSetting.upsert({ where: { tenantId }, create: { tenantId, ...wl }, update: wl });
  const records = mockEmailRecords(HARMATTAN.emailDomain).map((r) => ({ ...r, status: 'verified' }));
  await prisma.emailDomain.upsert({
    where: { tenantId },
    create: { tenantId, domain: HARMATTAN.emailDomain, fromLocalPart: 'reservations', provider: 'mock', status: 'VERIFIED', records: records as Prisma.InputJsonValue, verifiedAt: new Date(now - 50 * DAY), lastCheckedAt: new Date(now - DAY) },
    update: { status: 'VERIFIED', records: records as Prisma.InputJsonValue },
  });
  await prisma.smsSenderRequest.deleteMany({ where: { tenantId } });
  await prisma.smsSenderRequest.create({
    data: { tenantId, senderId: HARMATTAN.smsSender, useCase: 'Booking confirmations, pre-arrival details and receipts for guests of Harmattan Hotels & Suites.', status: 'APPROVED', provider: 'mock', requestedAt: new Date(now - 55 * DAY), decidedAt: new Date(now - 52 * DAY), decidedByName: 'Kemi Adebayo' },
  });
  await prisma.staffPortalDomain.upsert({
    where: { tenantId },
    create: { tenantId, domain: HARMATTAN.staffPortal, status: 'VERIFIED', token: 'harmattan-portal-dev-token', txtOk: true, cnameOk: true, verifiedAt: new Date(now - 45 * DAY), lastCheckedAt: new Date(now - DAY) },
    update: { status: 'VERIFIED' },
  });
  const apiBase = (process.env.API_PUBLIC_URL ?? 'http://localhost:4000').replace(/\/$/, '');
  const sso = {
    enabled: true, provider: 'OIDC', issuer: `${apiBase}/api/v1/dev/oidc`, clientId: 'dev-client', clientSecretEnc: c.seal('dev-secret', 'sso-client-secret'), clientSecretLast4: 'cret',
    allowedDomains: ['harmattanhotels.com'], provisioning: 'JIT', defaultRole: 'FRONT_DESK', enforced: false, breakGlassUserId: ownerId,
    lastTestAt: new Date(now - 2 * HOUR), lastTestOk: true, lastTestMessage: `Signed in as ${HARMATTAN.staff[0]!.email}`, lastTestEmail: HARMATTAN.staff[0]!.email,
  };
  await prisma.ssoConfig.upsert({ where: { tenantId }, create: { tenantId, ...sso }, update: sso });

  // API keys: stable development secrets, written to storage/dev-api-keys.txt.
  const lines: string[] = [];
  for (const k of Object.values(DEV_API_KEYS)) {
    const data = { tenantId, name: k.name, environment: k.environment, secretHash: sha256Hex(k.secret), last4: k.secret.slice(-4), scopes: k.scopes, revokedAt: null, previousSecretHash: null, previousExpiresAt: null, createdById: ownerId, createdByName: HARMATTAN.owner.fullName };
    const row = await prisma.apiKey.upsert({ where: { prefix: k.prefix }, create: { prefix: k.prefix, ...data, createdAt: new Date(now - 30 * DAY), lastUsedAt: new Date(now - HOUR), lastUsedIp: '102.89.40.12' }, update: data });
    lines.push(`${k.name.padEnd(20)} ${formatApiKey(k.environment, k.prefix, k.secret)}`);
    const usage = Array.from({ length: 30 }, (_, d) => ({ d, n: k.environment === 'LIVE' ? 900 + ((d * 137) % 400) : 40 + ((d * 17) % 60) }));
    for (const u of usage) {
      const date = new Date(`${new Date(now - u.d * DAY).toISOString().slice(0, 10)}T00:00:00.000Z`);
      const vals = { requests: u.n, errors: Math.floor(u.n / 60), writes: Math.floor(u.n / 5), rateLimited: u.d % 9 === 0 ? 3 : 0 };
      await prisma.apiUsageDaily.upsert({ where: { apiKeyId_date: { apiKeyId: row.id, date } }, create: { tenantId, apiKeyId: row.id, date, ...vals }, update: vals });
    }
  }
  const file = join(process.cwd(), 'storage', 'dev-api-keys.txt');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# Development API keys of Harmattan Hotels & Suites (seed). Never use in production.\n${lines.join('\n')}\n# Webhook signing secret of https://hooks.harmattanhotels.com/pms: ${DEV_WEBHOOK_SECRET}\n`);
  return lines;
}

/** Platform console data: announcements, support desk, failed notifications, a past impersonation, coupons. */
export async function seedConsole(prisma: PrismaClient): Promise<Record<string, number>> {
  const now = Date.now();
  const admin = await prisma.platformUser.findUniqueOrThrow({ where: { email: 'admin@devstrike.ng' } });
  const ops = await prisma.platformUser.findUniqueOrThrow({ where: { email: 'ops@devstrike.ng' } });
  const support = await prisma.platformUser.findUniqueOrThrow({ where: { email: 'support@devstrike.ng' } });
  const tenants = await prisma.tenant.findMany({ include: { subscription: { include: { plan: true } } } });
  const bySlug = new Map(tenants.map((t) => [t.slug, t]));

  // Announcements (fixed ids so re-seeding updates them).
  const ann = [
    { id: uuidFrom('ann-maintenance'), title: 'Scheduled maintenance on Sunday night', body: 'We are upgrading our database servers on Sunday from 01:00 to 02:00 (Lagos time).\nThe app stays available; saving may pause for up to a minute.', severity: 'MAINTENANCE', audience: { kind: 'ALL' }, startsAt: new Date(now - DAY), endsAt: new Date(now + 4 * DAY), publishedAt: new Date(now - DAY), email: true, emailedAt: new Date(now - DAY), linkLabel: 'Status page', linkUrl: 'https://status.hotelos.ng' },
    { id: uuidFrom('ann-loyalty'), title: 'New: loyalty programme reports', body: 'Pro and Enterprise hotels can now see member activity by tier in Reports.', severity: 'SUCCESS', audience: { kind: 'PLANS', planCodes: ['pro', 'enterprise'] }, startsAt: new Date(now + 3 * DAY), endsAt: new Date(now + 17 * DAY), publishedAt: new Date(now - 2 * HOUR), email: false, emailedAt: null, linkLabel: null, linkUrl: null },
    { id: uuidFrom('ann-vat'), title: 'VAT invoice layout updated', body: 'Guest invoices now show VAT and consumption tax on separate lines.', severity: 'INFO', audience: { kind: 'ALL' }, startsAt: new Date(now - 30 * DAY), endsAt: new Date(now - 16 * DAY), publishedAt: new Date(now - 30 * DAY), email: false, emailedAt: null, linkLabel: null, linkUrl: null },
  ];
  for (const a of ann) {
    const data = { title: a.title, body: a.body, severity: a.severity, audience: a.audience as Prisma.InputJsonValue, startsAt: a.startsAt, endsAt: a.endsAt, publishedAt: a.publishedAt, email: a.email, emailedAt: a.emailedAt, linkLabel: a.linkLabel, linkUrl: a.linkUrl, targetedTenants: a.audience.kind === 'ALL' ? tenants.length : 3, emailsSent: a.emailedAt ? tenants.length : 0, createdById: ops.id, createdByName: ops.fullName };
    await prisma.announcement.upsert({ where: { id: a.id }, create: { id: a.id, ...data }, update: data });
  }

  // Support desk: every state, one overdue Enterprise request, one with an internal note.
  let supportCount = 0;
  {
    const owner = async (slug: string) => {
      const t = bySlug.get(slug);
      if (!t) return null;
      const u = await prisma.user.findFirst({ where: { tenantId: t.id, role: 'OWNER' } });
      const p = await prisma.property.findFirst({ where: { tenantId: t.id }, orderBy: { createdAt: 'asc' } });
      return t && u ? { t, u, p } : null;
    };
    const SLA: Record<string, number> = { starter: 48, growth: 24, pro: 8, enterprise: 2 };
    const specs = [
      { slug: 'harmattan', subject: 'Channel sync stopped for Lagos property', category: 'TECHNICAL', priority: 'URGENT', status: 'NEW', ago: 5 * HOUR, responded: false, note: false },
      { slug: 'palmwine-house', subject: 'Receipt shows the wrong VAT line', category: 'BILLING', priority: 'NORMAL', status: 'OPEN', ago: 3 * HOUR, responded: true, note: true },
      { slug: 'eko-tides', subject: 'How do I add a second property?', category: 'ACCOUNT', priority: 'LOW', status: 'WAITING_ON_HOTEL', ago: 30 * HOUR, responded: true, note: false },
      { slug: 'maitama-court', subject: 'Refund stuck in processing', category: 'PAYMENTS', priority: 'HIGH', status: 'RESOLVED', ago: 4 * DAY, responded: true, note: false },
      { slug: 'garden-city-lodge', subject: 'Please delete an old guest record', category: 'DATA_PRIVACY', priority: 'NORMAL', status: 'CLOSED', ago: 9 * DAY, responded: true, note: false },
      { slug: 'ikoyi-lantern', subject: 'Feature request: split folio by company', category: 'FEATURE_REQUEST', priority: 'LOW', status: 'OPEN', ago: 20 * HOUR, responded: false, note: false },
    ];
    for (const s of specs) {
      const o = await owner(s.slug);
      if (!o) continue;
      if (await prisma.supportRequest.findFirst({ where: { tenantId: o.t.id, subject: s.subject } })) continue;
      const planCode = o.t.subscription?.plan.code ?? 'starter';
      const createdAt = new Date(now - s.ago);
      const slaHours = SLA[planCode] ?? 24;
      const respondedAt = s.responded ? new Date(createdAt.getTime() + Math.min(slaHours * HOUR * 0.5, s.ago / 2)) : null;
      const r = await prisma.supportRequest.create({
        data: {
          tenantId: o.t.id, propertyId: o.p?.id ?? null, propertyName: o.p?.name ?? null, openedById: o.u.id, openedByName: o.u.fullName, openedByEmail: o.u.email, openedByRole: 'OWNER',
          subject: s.subject, category: s.category, priority: s.priority, status: s.status, planCode, slaHours, firstResponseDue: new Date(createdAt.getTime() + slaHours * HOUR),
          firstRespondedAt: respondedAt, assigneeId: s.status === 'NEW' ? null : support.id, assigneeName: s.status === 'NEW' ? null : support.fullName,
          context: { pageUrl: '/settings', appVersion: '2026.9.0', userAgent: 'Mozilla/5.0', propertyName: o.p?.name ?? null, userRole: 'OWNER' },
          lastMessageAt: respondedAt ?? createdAt, lastHotelMsgAt: createdAt, lastPlatformMsgAt: respondedAt, resolvedAt: ['RESOLVED', 'CLOSED'].includes(s.status) ? new Date(createdAt.getTime() + DAY) : null, createdAt,
        },
      });
      await prisma.supportMessage.create({ data: { requestId: r.id, tenantId: o.t.id, authorKind: 'HOTEL', authorId: o.u.id, authorName: o.u.fullName, body: `${s.subject}. Could you take a look? Thank you.`, createdAt } });
      if (s.note) await prisma.supportMessage.create({ data: { requestId: r.id, tenantId: o.t.id, authorKind: 'PLATFORM', authorId: support.id, authorName: support.fullName, body: 'Internal: the tax setting was edited last week; check the audit log before replying.', internal: true, createdAt: new Date(createdAt.getTime() + 20 * 60_000) } });
      if (respondedAt) await prisma.supportMessage.create({ data: { requestId: r.id, tenantId: o.t.id, authorKind: 'PLATFORM', authorId: support.id, authorName: support.fullName, body: 'Thanks for reaching out. We are looking into it and will update you here.', createdAt: respondedAt } });
      supportCount++;
    }
  }

  // Failed notifications (platform-wide health page).
  const palm = bySlug.get('palmwine-house');
  const failed = [
    { key: 'SEED-FAILED-SMS-1', channel: 'SMS' as const, recipient: '+2348030000001', provider: 'termii', error: 'Termii: DND number, message not delivered' },
    { key: 'SEED-FAILED-EMAIL-1', channel: 'EMAIL' as const, recipient: 'bounced.guest@example.ng', provider: 'resend', error: 'Resend 422: recipient address rejected' },
    { key: 'SEED-FAILED-WA-1', channel: 'WHATSAPP' as const, recipient: '+2348030000002', provider: 'whatsapp', error: 'WhatsApp 131026: message undeliverable' },
  ];
  for (const [i, f] of failed.entries()) {
    await prisma.notificationLog.upsert({
      where: { dedupeKey: f.key },
      create: { tenantId: palm?.id ?? null, template: 'BOOKING_CONFIRMED', channel: f.channel, audience: 'GUEST', recipient: f.recipient, subject: 'Your booking is confirmed', bodyText: 'Seeded failed message', status: 'FAILED', provider: f.provider, attempts: 5, error: f.error, dedupeKey: f.key, createdAt: new Date(now - (i + 2) * HOUR) },
      update: { status: 'FAILED', createdAt: new Date(now - (i + 2) * HOUR) },
    });
  }

  // A past, read-only support session at Palmwine House.
  if (palm) {
    const staff = await prisma.user.findFirst({ where: { tenantId: palm.id, role: 'FRONT_DESK' } }) ?? await prisma.user.findFirst({ where: { tenantId: palm.id } });
    const id = uuidFrom('imp-palmwine');
    if (staff && !(await prisma.impersonationSession.findUnique({ where: { id } }))) {
      const startedAt = new Date(now - 3 * DAY);
      await prisma.impersonationSession.create({
        data: {
          id, tenantId: palm.id, userId: staff.id, userName: staff.fullName, userEmail: staff.email, userRole: staff.role, platformUserId: support.id, platformUserName: support.fullName, platformUserEmail: support.email,
          reason: 'Hotel reported that the check-in screen shows an empty room list; reproducing as the front desk user.', mode: 'READ_ONLY', startedAt, expiresAt: new Date(startedAt.getTime() + 30 * 60_000),
          endedAt: new Date(startedAt.getTime() + 18 * 60_000), endedBy: 'PLATFORM', requests: 42, writes: 0,
        },
      });
      await prisma.auditLog.createMany({
        data: [
          { tenantId: palm.id, actorPlatformUserId: support.id, actorName: `${support.fullName} (Devstrike support)`, action: 'impersonation.started', entityType: 'impersonation_session', entityId: id, metadata: { mode: 'READ_ONLY', staff: staff.fullName }, createdAt: startedAt },
          { tenantId: palm.id, actorPlatformUserId: support.id, actorName: `${support.fullName} (Devstrike support)`, action: 'impersonation.ended', entityType: 'impersonation_session', entityId: id, metadata: { endedBy: 'PLATFORM' }, createdAt: new Date(startedAt.getTime() + 18 * 60_000) },
        ],
      });
    }
  }

  // Coupons.
  const coupons = [
    { code: 'HARMATTAN50', name: 'Launch: 50% off for 3 months', percentOff: 50, amountOffKobo: null, durationMonths: 3, planCodes: ['growth', 'pro'], intervals: [] as string[] },
    { code: 'YEARLY20K', name: 'NGN 20,000 off a yearly plan', percentOff: null, amountOffKobo: 20_000 * NAIRA, durationMonths: 1, planCodes: [], intervals: ['YEARLY'] },
  ];
  for (const c of coupons) {
    const data = { name: c.name, percentOff: c.percentOff, amountOffKobo: c.amountOffKobo, durationMonths: c.durationMonths, planCodes: c.planCodes, intervals: c.intervals, active: true, createdById: admin.id, createdByName: admin.fullName };
    await prisma.coupon.upsert({ where: { code: c.code }, create: { code: c.code, ...data }, update: data });
  }
  return { announcements: ann.length, supportRequests: supportCount, failedNotifications: failed.length, coupons: coupons.length };
}
