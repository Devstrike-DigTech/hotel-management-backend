/**
 * M6 Enterprise tier: API keys and the partner API, outbound webhooks,
 * white-label, SSO (development OIDC provider), full data export and
 * dedicated databases (seeded Harmattan + a live provision / rollback).
 */
import type { INestApplication } from '@nestjs/common';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { SecretBox } from '../src/common/crypto/secret-box.js';
import { connect, copyTable, createDatabase, databaseExists, syncMirror, tenantTables, withDatabase } from '../src/modules/dedicated-db/engine.js';
import { migrateDatabase } from '../src/modules/dedicated-db/migrate.js';
import { MAX_RESUMES, ProvisioningService } from '../src/modules/dedicated-db/provisioning.service.js';
import { verifySignature } from '../src/modules/enterprise/webhooks/webhooks.logic.js';
import { DbService } from '../src/prisma/db.service.js';
import { URL_PURPOSE } from '../src/prisma/tenant-db-router.js';
import { API, createApp, platformLogin, signup, uniq } from './helpers.js';

let app: INestApplication;
const http = () => request(app.getHttpServer());
const P = '/api/partner/v1';
let owner: { Authorization: string };

async function hotelLogin(email: string, password = 'Demo1234!') {
  const res = await http().post(`${API}/auth/login`).send({ email, password }).expect(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

const idem = () => ({ 'Idempotency-Key': `e2e-${uniq()}${uniq()}` });

beforeAll(async () => {
  app = await createApp();
  owner = await hotelLogin('owner@harmattanhotels.com');
});

afterAll(async () => {
  await app.close();
});

describe('dedicated database (seeded Harmattan)', () => {
  it('serves Harmattan from its own database and keeps platform reads complete', async () => {
    const me = await http().get(`${API}/me`).set(owner).expect(200);
    expect(me.body.dedicatedDb).toEqual({ mode: 'DEDICATED' });
    expect(me.body.properties).toHaveLength(3);
    expect(me.body.whiteLabel.active).toBe(true);
    const status = await http().get(`${API}/dedicated-database`).set(owner).expect(200);
    expect(status.body).toMatchObject({ mode: 'DEDICATED', status: 'ACTIVE' });
    const search = await http().get(`${API}/public/hotels?city=abuja&pageSize=24`).expect(200);
    expect(search.body.items.map((h: { slug: string }) => h.slug)).toContain('harmattan-abuja');
    const admin = await platformLogin(app);
    const t = await http().get(`${API}/platform/tenants?q=harmattan`).set({ Authorization: admin.Authorization }).expect(200);
    expect(t.body.items[0]).toMatchObject({ slug: 'harmattan', dbMode: 'DEDICATED', properties: 3 });
  });

  it('provisions a new tenant: copy, verify, cutover, then rolls back', async () => {
    const hotel = await signup(app, 'Dedicated Candidate');
    await http().post(`${API}/room-types`).set(hotel.auth).send({ name: 'Standard', basePriceKobo: 2_500_000, capacity: 2, bedType: 'Queen', sizeSqm: 20 }).expect(201);
    const admin = await platformLogin(app);
    const A = { Authorization: admin.Authorization };
    const locked = await http().post(`${API}/platform/tenants/${hotel.tenantId}/database/provision`).set(A).send({ source: 'AUTO' }).expect(403);
    expect(locked.body.code).toBe('FEATURE_LOCKED');
    await http().patch(`${API}/platform/tenants/${hotel.tenantId}/subscription`).set(A).send({ planCode: 'enterprise', status: 'ACTIVE' }).expect(200);
    const p = await http().post(`${API}/platform/tenants/${hotel.tenantId}/database/provision`).set(A).send({ source: 'AUTO' }).expect(202);
    let run = p.body;
    for (let i = 0; i < 240 && !['ACTIVE', 'FAILED', 'ROLLED_BACK'].includes(run.status); i++) {
      await new Promise((r) => setTimeout(r, 500));
      run = (await http().get(`${API}/platform/provisionings/${p.body.id}`).set(A).expect(200)).body;
    }
    expect(run.status).toBe('ACTIVE');
    expect(run.tables.length).toBeGreaterThan(10);
    expect(run.tables.every((t: { ok: boolean | null }) => t.ok !== false)).toBe(true);
    expect(run.readOnlyWindow.durationMs).toBeGreaterThanOrEqual(0);
    // The hotel keeps working on its new database.
    const created = await http().post(`${API}/room-types`).set(hotel.auth).send({ name: 'Deluxe', basePriceKobo: 4_000_000, capacity: 2, bedType: 'Queen', sizeSqm: 20 }).expect(201);
    const view = await http().get(`${API}/platform/tenants/${hotel.tenantId}/database`).set(A).expect(200);
    expect(view.body).toMatchObject({ mode: 'DEDICATED', status: 'ACTIVE' });
    // Roll back: rows written since the cutover come back to the shared database.
    const rb = await http().post(`${API}/platform/tenants/${hotel.tenantId}/database/rollback`).set(A).expect(202);
    let r = rb.body;
    for (let i = 0; i < 240 && !['ROLLED_BACK', 'FAILED'].includes(r.status); i++) {
      await new Promise((res) => setTimeout(res, 500));
      r = (await http().get(`${API}/platform/provisionings/${rb.body.id}`).set(A).expect(200)).body;
    }
    expect(r.status).toBe('ROLLED_BACK');
    const types = await http().get(`${API}/room-types`).set(hotel.auth).expect(200);
    expect(types.body.map((t: { id: string }) => t.id)).toContain(created.body.id);
    const after = await http().get(`${API}/me`).set(hotel.auth).expect(200);
    expect(after.body.dedicatedDb.mode).toBe('SHARED');
  }, 180_000);
});

describe('dedicated database: interrupted runs', () => {
  /** Leaves a provisioning exactly as a crash in the middle of step COPY would (read-only window open). */
  async function interrupted(resumes: number) {
    const hotel = await signup(app, 'Interrupted Candidate');
    await http().post(`${API}/room-types`).set(hotel.auth).send({ name: 'Standard', basePriceKobo: 2_500_000, capacity: 2, bedType: 'Queen', sizeSqm: 20 }).expect(201);
    const admin = await platformLogin(app);
    await http().patch(`${API}/platform/tenants/${hotel.tenantId}/subscription`).set({ Authorization: admin.Authorization }).send({ planCode: 'enterprise', status: 'ACTIVE' }).expect(200);
    const db = app.get(DbService);
    const box = app.get(SecretBox);
    const dbName = `hotel_e2e_t_interrupted_${uniq()}`;
    const ownerUrl = withDatabase(process.env.DATABASE_MIGRATION_URL!, dbName);
    await createDatabase(ownerUrl, dbName);
    if (resumes === 0) {
      // Part of the copy happened before the "crash": the resumed run must clear it.
      await migrateDatabase(ownerUrl);
      const src = await connect(process.env.DATABASE_MIGRATION_URL!);
      const dst = await connect(ownerUrl);
      try {
        const tables = await tenantTables(src);
        await syncMirror(src, dst, hotel.tenantId);
        for (const t of tables.filter((x) => ['properties', 'room_types', 'users'].includes(x.name))) await copyTable(src, dst, t, hotel.tenantId, { batch: 500 });
      } finally {
        await Promise.all([src.end(), dst.end()]);
      }
    }
    const logs = [
      { at: new Date().toISOString(), level: 'info', message: `Creating database ${dbName}` },
      ...Array.from({ length: resumes }, () => ({ at: new Date().toISOString(), level: 'warn', message: 'Resuming after an interruption at step COPY' })),
    ];
    const prov = await db.system(async (tx) => {
      await tx.tenantDatabase.create({ data: { tenantId: hotel.tenantId, mode: 'SHARED', status: 'CUTOVER', urlEnc: box.seal(ownerUrl, URL_PURPOSE.admin), dbName, host: 'localhost:5432', createdByUs: true } });
      return tx.dbProvisioning.create({ data: { tenantId: hotel.tenantId, status: 'COPYING', step: 'COPY', progressPct: 40, logs, readOnlyStartedAt: new Date() } });
    });
    return { hotel, admin, dbName, ownerUrl, provId: prov.id };
  }

  it('resumes from its checkpoint after a restart (reconciler) and completes the cutover', async () => {
    const { hotel, admin, dbName, provId } = await interrupted(0);
    const svc = app.get(ProvisioningService);
    const r = await svc.reconcile();
    expect(r.resumed).toBeGreaterThanOrEqual(1);
    await svc.wait(provId);
    const run = (await http().get(`${API}/platform/provisionings/${provId}`).set({ Authorization: admin.Authorization }).expect(200)).body;
    expect(run.status).toBe('ACTIVE');
    expect(run.logs.some((l: { message: string }) => l.message.startsWith('Resuming after an interruption'))).toBe(true);
    expect(run.logs.some((l: { message: string }) => l.message.startsWith(`Reusing ${dbName}`))).toBe(true);
    expect(run.logs.some((l: { message: string }) => /^Removed \d+ rows copied before the interruption/.test(l.message))).toBe(true);
    const types = await http().get(`${API}/room-types`).set(hotel.auth).expect(200);
    expect(types.body.map((t: { name: string }) => t.name)).toContain('Standard');
    await http().post(`${API}/room-types`).set(hotel.auth).send({ name: 'After resume', basePriceKobo: 3_000_000, capacity: 2, bedType: 'Queen', sizeSqm: 20 }).expect(201);
    // A second reconcile finds nothing to do.
    await svc.reconcile();
    const again = (await http().get(`${API}/platform/provisionings/${provId}`).set({ Authorization: admin.Authorization }).expect(200)).body;
    expect(again.status).toBe('ACTIVE');
    const rb = await http().post(`${API}/platform/tenants/${hotel.tenantId}/database/rollback`).set({ Authorization: admin.Authorization }).expect(202);
    await svc.wait(rb.body.id);
  }, 180_000);

  it('gives up after repeated interruptions: FAILED with a reason, target dropped, hotel writable', async () => {
    const { hotel, admin, dbName, ownerUrl, provId } = await interrupted(MAX_RESUMES);
    const svc = app.get(ProvisioningService);
    await svc.reconcile();
    await svc.wait(provId);
    const run = (await http().get(`${API}/platform/provisionings/${provId}`).set({ Authorization: admin.Authorization }).expect(200)).body;
    expect(run.status).toBe('FAILED');
    expect(run.error).toMatch(/Interrupted \d+ times/);
    expect(await databaseExists(ownerUrl, dbName)).toBe(false);
    const view = (await http().get(`${API}/platform/tenants/${hotel.tenantId}/database`).set({ Authorization: admin.Authorization }).expect(200)).body;
    expect(view).toMatchObject({ mode: 'SHARED', status: 'FAILED' });
    await app.get(DbService).router.refresh(true);
    await http().post(`${API}/room-types`).set(hotel.auth).send({ name: 'Still writable', basePriceKobo: 3_000_000, capacity: 2, bedType: 'Queen', sizeSqm: 20 }).expect(201);
  }, 120_000);
});

describe('API keys and the partner API', () => {
  let live: string;
  let propertyId: string;
  let roomTypeId: string;

  it('creates a key once-visible, with scopes, and authenticates it', async () => {
    const scopes = await http().get(`${API}/api-keys/scopes`).set(owner).expect(200);
    expect(scopes.body.map((s: { scope: string }) => s.scope)).toContain('reservations:write');
    const res = await http().post(`${API}/api-keys`).set(owner).send({ name: 'E2E live', environment: 'LIVE', scopes: ['reservations:read', 'reservations:write', 'availability:read', 'webhooks:manage'] }).expect(201);
    live = res.body.secret;
    expect(live).toMatch(/^hk_live_[a-z0-9]{10}_[A-Za-z0-9]{40}$/);
    expect(res.body.apiKey.display).toContain('...');
    const list = await http().get(`${API}/api-keys`).set(owner).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(live.slice(-20));
    const me = await http().get(`${P}/me`).set('Authorization', `Bearer ${live}`).expect(200);
    expect(me.body.data.tenant.name).toBe('Harmattan Hotels & Suites');
    expect(me.headers['ratelimit-limit']).toBe('600');
    expect(me.headers['x-request-id']).toBeTruthy();
    const props = await http().get(`${P}/properties`).set('X-Api-Key', live).expect(200);
    propertyId = props.body.data.find((p: { slug: string }) => p.slug === 'harmattan-abuja').id;
    const types = await http().get(`${P}/room-types?propertyId=${propertyId}`).set('X-Api-Key', live).expect(200);
    roomTypeId = types.body.data[0].id;
  });

  it('enforces scopes, the Idempotency-Key and the error envelope', async () => {
    const denied = await http().get(`${P}/guests`).set('Authorization', `Bearer ${live}`).expect(403);
    expect(denied.body).toMatchObject({ code: 'INSUFFICIENT_SCOPE', details: { required: 'guests:read' } });
    expect(denied.body.requestId).toBeTruthy();
    const body = { propertyId, roomTypeId, arrivalDate: '2027-02-10', departureDate: '2027-02-12', adults: 2, guest: { fullName: 'Partner Guest', phone: '+2348091112222' }, externalRef: 'OTA-778' };
    const noKey = await http().post(`${P}/reservations`).set('Authorization', `Bearer ${live}`).send(body).expect(400);
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = idem();
    const created = await http().post(`${P}/reservations`).set('Authorization', `Bearer ${live}`).set(key).send(body).expect(201);
    expect(created.body.data).toMatchObject({ source: 'API', status: 'CONFIRMED', externalRef: 'OTA-778', nights: 2 });
    const replay = await http().post(`${P}/reservations`).set('Authorization', `Bearer ${live}`).set(key).send(body).expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.id).toBe(created.body.data.id);
    await http().post(`${P}/reservations`).set('Authorization', `Bearer ${live}`).set(key).send({ ...body, adults: 1 }).expect(422);
    const one = await http().get(`${P}/reservations/${created.body.data.code}`).set('Authorization', `Bearer ${live}`);
    expect(one.status).toBe(200);
    expect(one.body.data.id).toBe(created.body.data.id);
    const audit = await http().get(`${API}/audit-logs?action=reservation.created&pageSize=5`).set(owner).expect(200);
    expect(audit.body.items[0].actor.fullName).toBe('API key E2E live');
    const page = await http().get(`${P}/reservations?limit=2`).set('Authorization', `Bearer ${live}`).expect(200);
    expect(page.body.pagination.limit).toBe(2);
    const next = await http().get(`${P}/reservations?limit=2&cursor=${page.body.pagination.nextCursor}`).set('Authorization', `Bearer ${live}`).expect(200);
    expect(next.body.data[0].id).not.toBe(page.body.data[0].id);
  });

  it('test keys validate writes fully but roll them back', async () => {
    const res = await http().post(`${API}/api-keys`).set(owner).send({ name: 'E2E test', environment: 'TEST', scopes: ['reservations:read', 'reservations:write'] }).expect(201);
    const test = res.body.secret as string;
    const body = { propertyId, roomTypeId, arrivalDate: '2027-03-01', departureDate: '2027-03-03', adults: 1, guest: { fullName: 'Dry Run Guest', phone: '+2348091113333' } };
    const dry = await http().post(`${P}/reservations`).set('Authorization', `Bearer ${test}`).set(idem()).send(body).expect(201);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.data.code).toBeTruthy();
    await http().get(`${P}/reservations/${dry.body.data.id}`).set('Authorization', `Bearer ${test}`).expect(404);
    const bad = await http().post(`${P}/reservations`).set('Authorization', `Bearer ${test}`).set(idem()).send({ ...body, roomTypeId: '00000000-0000-4000-8000-000000000000' }).expect(404);
    expect(bad.body.code).toBe('NOT_FOUND');
  });

  it('rotates with a 24-hour overlap and revokes at once', async () => {
    const created = await http().post(`${API}/api-keys`).set(owner).send({ name: 'E2E rotate', environment: 'LIVE', scopes: ['availability:read'], ipAllowlist: ['0.0.0.0/0', '::/0'] }).expect(201);
    const old = created.body.secret as string;
    const rotated = await http().post(`${API}/api-keys/${created.body.apiKey.id}/rotate`).set(owner).expect(200);
    expect(rotated.body.apiKey.previousSecretExpiresAt).not.toBeNull();
    await http().get(`${P}/me`).set('Authorization', `Bearer ${old}`).expect(200);
    await http().get(`${P}/me`).set('Authorization', `Bearer ${rotated.body.secret}`).expect(200);
    await http().post(`${API}/api-keys/${created.body.apiKey.id}/revoke`).set(owner).expect(200);
    const gone = await http().get(`${P}/me`).set('Authorization', `Bearer ${rotated.body.secret}`).expect(401);
    expect(gone.body.code).toBe('INVALID_API_KEY');
    await http().get(`${P}/me`).set('Authorization', `Bearer ${old}`).expect(401);
    const restricted = await http().post(`${API}/api-keys`).set(owner).send({ name: 'E2E ip', environment: 'LIVE', scopes: ['availability:read'], ipAllowlist: ['203.0.113.7/32'] }).expect(201);
    const ipRes = await http().get(`${P}/me`).set('Authorization', `Bearer ${restricted.body.secret}`).expect(403);
    expect(ipRes.body.code).toBe('IP_NOT_ALLOWED');
  });

  it('refuses keys of hotels without api_access and publishes the OpenAPI document', async () => {
    const hotel = await signup(app, 'No API');
    const locked = await http().post(`${API}/api-keys`).set(hotel.auth).send({ name: 'Nope', environment: 'LIVE', scopes: ['rooms:read'] }).expect(403);
    expect(locked.body.code).toBe('FEATURE_LOCKED');
    const doc = await http().get(`${P}/openapi.json`).expect(200);
    expect(doc.body.openapi).toBe('3.1.0');
    expect(doc.body.info.version).toBe('2026-09-24');
    expect(Object.keys(doc.body.paths)).toContain('/reservations');
    expect(Object.keys(doc.body.webhooks)).toContain('reservation.created');
    // Tags, stable operationIds and scopes per operation.
    expect(doc.body.tags.map((t: { name: string }) => t.name)).toContain('Reservations');
    expect(doc.body.info.description).toContain('Developers');
    const create = doc.body.paths['/reservations'].post;
    expect(create).toMatchObject({ operationId: 'createReservation', tags: ['Reservations'], 'x-scopes': ['reservations:write'], security: [{ bearerAuth: ['reservations:write'] }] });
    expect(doc.body.paths['/me'].get['x-scopes']).toEqual([]);
    const ids = Object.values(doc.body.paths as Record<string, Record<string, { operationId: string }>>).flatMap((m) => Object.values(m).map((o) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    // One schema per webhook event.
    const hook = doc.body.webhooks['payment.received'].post.requestBody.content['application/json'].schema.$ref;
    expect(hook).toBe('#/components/schemas/PaymentReceivedEvent');
    const s = doc.body.components.schemas.PaymentReceivedEvent.allOf[1];
    expect(s.properties.type.const).toBe('payment.received');
    expect(s.properties.data.properties.object.$ref).toBe('#/components/schemas/PaymentReceived');
    expect(doc.body.components.schemas.RoomStatusChangedEvent).toBeTruthy();
  });

  it('meters usage per key', async () => {
    await new Promise((r) => setTimeout(r, 200));
    const usage = await http().get(`${API}/api-keys/usage`).set(owner).expect(200);
    const k = usage.body.keys.find((x: { name: string }) => x.name === 'E2E live');
    expect(k.requests).toBeGreaterThan(3);
    expect(k.errors).toBeGreaterThan(0);
  });
});

describe('outbound webhooks', () => {
  let server: Server;
  let url: string;
  const received: { headers: IncomingMessage['headers']; body: string }[] = [];
  let failNext = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        if (failNext > 0) {
          failNext--;
          res.writeHead(500).end('nope');
        } else res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    url = `http://localhost:${(server.address() as AddressInfo).port}/hook`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it('refuses private and metadata addresses (SSRF guard)', async () => {
    for (const bad of ['http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/hook', 'ftp://example.com/x']) {
      const res = await http().post(`${API}/webhook-endpoints`).set(owner).send({ url: bad, events: ['*'] }).expect(422);
      expect(res.body.code).toBe('UNSAFE_URL');
    }
  });

  it('delivers signed events from hotel changes, logs them and replays', async () => {
    const created = await http().post(`${API}/webhook-endpoints`).set(owner).send({ url, events: ['reservation.created'], description: 'e2e' }).expect(201);
    const secret = created.body.secret as string;
    expect(secret).toMatch(/^whsec_/);
    const ping = await http().post(`${API}/webhook-endpoints/${created.body.endpoint.id}/test`).set(owner).expect(201);
    expect(ping.body).toMatchObject({ status: 'SUCCEEDED', responseStatus: 200, eventType: 'webhook.ping' });

    const props = await http().get(`${API}/me`).set(owner).expect(200);
    const abuja = props.body.properties.find((p: { slug: string }) => p.slug === 'harmattan-abuja');
    const types = await http().get(`${API}/room-types`).set(owner).set('X-Property-Id', abuja.id).expect(200);
    await http()
      .post(`${API}/reservations`)
      .set(owner)
      .set('X-Property-Id', abuja.id)
      .send({ roomTypeId: types.body[0].id, arrivalDate: '2027-04-01', departureDate: '2027-04-02', guest: { fullName: 'Hook Guest', phone: '+2348091114444' } })
      .expect(201);
    let hit: (typeof received)[number] | undefined;
    for (let i = 0; i < 40 && !hit; i++) {
      await new Promise((r) => setTimeout(r, 150));
      hit = received.find((r) => r.headers['x-event-type'] === 'reservation.created');
    }
    expect(hit).toBeTruthy();
    expect(verifySignature(String(hit!.headers['x-signature']), secret, hit!.body)).toBe(true);
    const payload = JSON.parse(hit!.body);
    expect(payload).toMatchObject({ type: 'reservation.created', apiVersion: '2026-09-24', data: { object: { guest: { fullName: 'Hook Guest' } } } });

    const log = await http().get(`${API}/webhook-endpoints/${created.body.endpoint.id}/deliveries`).set(owner).expect(200);
    const d = log.body.items.find((x: { eventType: string }) => x.eventType === 'reservation.created');
    expect(d.status).toBe('SUCCEEDED');
    const detail = await http().get(`${API}/webhook-deliveries/${d.id}`).set(owner).expect(200);
    expect(detail.body.request.url).toBe(url);
    expect(detail.body.attemptLog).toHaveLength(1);
    const replay = await http().post(`${API}/webhook-deliveries/${d.id}/replay`).set(owner).expect(201);
    expect(replay.body.replayOf).toBe(d.id);
  });

  it('retries a failed delivery with backoff', async () => {
    const created = await http().post(`${API}/webhook-endpoints`).set(owner).send({ url, events: ['*'] }).expect(201);
    failNext = 1;
    const ping = await http().post(`${API}/webhook-endpoints/${created.body.endpoint.id}/test`).set(owner).expect(201);
    expect(ping.body).toMatchObject({ status: 'FAILED', responseStatus: 500 });
    const ep = await http().get(`${API}/webhook-endpoints/${created.body.endpoint.id}`).set(owner).expect(200);
    expect(ep.body.status).toBe('ACTIVE');
  });
});

describe('white-label', () => {
  it('shows the brand kit only on the verified custom domain', async () => {
    const own = await http().get(`${API}/public/hotels/harmattan-abuja?host=book.harmattanhotels.com`).expect(200);
    expect(own.body.whiteLabel).toMatchObject({ brandName: 'Harmattan Hotels & Suites', hidePoweredBy: true });
    expect(own.body.whiteLabel.headingFont.family).toBe('Cormorant Garamond');
    const market = await http().get(`${API}/public/hotels/harmattan-abuja`).expect(200);
    expect(market.body.whiteLabel).toBeNull();
    const host = await http().get(`${API}/public/resolve-host?host=book.harmattanhotels.com`).expect(200);
    expect(host.body).toMatchObject({ slug: 'harmattan-abuja', whiteLabel: true });
    // The group root on its own verified domain.
    const group = await http().get(`${API}/public/resolve-host?host=www.harmattanhotels.com`).expect(200);
    expect(group.body).toMatchObject({ kind: 'GROUP', groupSlug: 'harmattan', canonicalHost: 'www.harmattanhotels.com', whiteLabel: true, brand: { brandName: 'Harmattan Hotels & Suites' } });
    const page = await http().get(`${API}/public/groups/harmattan?host=www.harmattanhotels.com`).expect(200);
    expect(page.body.whiteLabel.hidePoweredBy).toBe(true);
    expect((await http().get(`${API}/public/groups/harmattan`).expect(200)).body.whiteLabel).toBeNull();
    const sub = await http().get(`${API}/public/resolve-host?host=harmattan-abuja.hotelos.test`).expect(200);
    expect(sub.body).toMatchObject({ kind: 'PROPERTY', whiteLabel: false, brand: null });
    const portal = await http().get(`${API}/public/staff-portal?host=staff.harmattanhotels.com`).expect(200);
    expect(portal.body).toMatchObject({ tenantSlug: 'harmattan', hidePlatformBranding: true, sso: { enabled: true } });
    await http().get(`${API}/public/staff-portal?host=unknown.example.com`).expect(404);
  });

  it('attaches a verified custom domain to the group root', async () => {
    const gm = await hotelLogin('owner@harmattanhotels.com');
    const d = await http().post(`${API}/domains`).set(gm).send({ domain: `group${uniq()}.example.com`, scope: 'GROUP' }).expect(201);
    expect(d.body).toMatchObject({ scope: 'GROUP', status: 'PENDING' });
    await http().post(`${API}/domains/${d.body.id}/dev/publish`).set(gm).expect(200);
    const v = await http().post(`${API}/domains/${d.body.id}/verify`).set(gm).expect(200);
    expect(v.body.status).toBe('VERIFIED');
    const r = await http().get(`${API}/public/resolve-host?host=${d.body.domain}`).expect(200);
    expect(r.body).toMatchObject({ kind: 'GROUP', groupSlug: 'harmattan', whiteLabel: true });
    const info = await http().get(`${API}/domains`).set(gm).expect(200);
    expect(info.body.groupDomain.id).toBe(d.body.id);
    // The property's own booking domain is untouched.
    expect((await http().get(`${API}/public/resolve-host?host=book.harmattanhotels.com`).expect(200)).body.kind).toBe('PROPERTY');
  });

  it('validates settings and verifies a mock email domain', async () => {
    const bad = await http().put(`${API}/white-label`).set(owner).send({ primaryColor: 'red', headingFont: 'Comic Sans' }).expect(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
    const wl = await http().get(`${API}/white-label`).set(owner).expect(200);
    expect(wl.body).toMatchObject({ active: true, emailDomain: { status: 'VERIFIED' }, smsSender: { status: 'APPROVED' }, staffPortal: { status: 'VERIFIED' } });
    const hotel = await signup(app, 'No White Label');
    await http().get(`${API}/white-label`).set(hotel.auth).expect(403);
    const gm = await hotelLogin('gm@harmattanhotels.com');
    const d = await http().post(`${API}/white-label/email-domain`).set(gm).send({ domain: `mail${uniq()}.example.com` }).expect(201);
    expect(d.body).toMatchObject({ status: 'PENDING', provider: 'mock' });
    const v = await http().post(`${API}/white-label/email-domain/dev/verify`).set(gm).expect(200);
    expect(v.body.status).toBe('VERIFIED');
    expect(v.body.records.every((r: { status: string }) => r.status === 'verified')).toBe(true);
  });
});

describe('single sign-on (development OIDC provider)', () => {
  async function ssoLogin(email: string) {
    const start = await http().get(`${API}/auth/sso/start?tenant=harmattan`).expect(302);
    const authorize = new URL(start.headers.location!);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const idp = await http().get(`${authorize.pathname}${authorize.search}&login_hint=${encodeURIComponent(email)}`).expect(302);
    const cb = new URL(idp.headers.location!);
    const back = await http().get(`${cb.pathname}${cb.search}`).expect(302);
    return back.headers.location as string;
  }

  it('signs in an existing staff member and provisions a new one just in time', async () => {
    const done = await ssoLogin('gm@harmattanhotels.com');
    expect(done).toMatch(/\/sso\/complete#code=/);
    const code = done.split('#code=')[1]!.split('&')[0]!;
    const res = await http().post(`${API}/auth/sso/exchange`).send({ code }).expect(200);
    expect(res.body.user.email).toBe('gm@harmattanhotels.com');
    await http().post(`${API}/auth/sso/exchange`).send({ code }).expect(401);

    const jit = await ssoLogin(`new.${uniq()}@harmattanhotels.com`);
    const jitRes = await http().post(`${API}/auth/sso/exchange`).send({ code: jit.split('#code=')[1]!.split('&')[0] }).expect(200);
    expect(jitRes.body.user.role).toBe('FRONT_DESK');

    const outsider = await ssoLogin('someone@gmail.com');
    expect(outsider).toContain('sso_error=SSO_DOMAIN_NOT_ALLOWED');
    const state = await http().get(`${API}/auth/sso/callback?code=x&state=forged`).expect(302);
    expect(state.headers.location).toContain('sso_error=SSO_STATE_INVALID');
  });

  it('enforces SSO-only except for the break-glass owner', async () => {
    const cfg = (await http().get(`${API}/sso`).set(owner).expect(200)).body;
    const put = (enforced: boolean) =>
      http().put(`${API}/sso`).set(owner).send({ provider: cfg.provider, issuer: cfg.issuer, clientId: cfg.clientId, allowedDomains: cfg.allowedDomains, provisioning: cfg.provisioning, defaultRole: cfg.defaultRole, enforced, breakGlassUserId: cfg.breakGlassUserId, enabled: true });
    await put(true).expect(200);
    const refused = await http().post(`${API}/auth/login`).send({ email: 'gm@harmattanhotels.com', password: 'Demo1234!' }).expect(403);
    expect(refused.body.code).toBe('SSO_REQUIRED');
    expect(refused.body.details.startUrl).toContain('/auth/sso/start?tenant=harmattan');
    await http().post(`${API}/auth/login`).send({ email: 'owner@harmattanhotels.com', password: 'Demo1234!' }).expect(200);
    const discover = await http().post(`${API}/auth/sso/discover`).send({ email: 'anyone@harmattanhotels.com' }).expect(200);
    expect(discover.body).toMatchObject({ sso: true, enforced: true });
    await put(false).expect(200);
    await http().post(`${API}/auth/login`).send({ email: 'gm@harmattanhotels.com', password: 'Demo1234!' }).expect(200);
  });
});

describe('full data export', () => {
  it('builds a zip with every entity and a signed 24-hour link', async () => {
    const req = await http().post(`${API}/exports`).set(owner).send({}).expect(202);
    let e = req.body;
    for (let i = 0; i < 120 && !['READY', 'FAILED'].includes(e.status); i++) {
      await new Promise((r) => setTimeout(r, 250));
      e = (await http().get(`${API}/exports/${req.body.id}`).set(owner).expect(200)).body;
    }
    expect(e.status).toBe('READY');
    expect(e.entities.find((x: { name: string }) => x.name === 'reservations').rows).toBeGreaterThan(0);
    const path = new URL(e.downloadUrl).pathname;
    const zip = await http().get(path).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(zip.headers['content-type']).toContain('application/zip');
    expect((zip.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    expect((zip.body as Buffer).includes(Buffer.from('manifest.json'))).toBe(true);
    const gm = await hotelLogin('gm@harmattanhotels.com');
    await http().post(`${API}/exports`).set(gm).send({}).expect(403);
  });
});
