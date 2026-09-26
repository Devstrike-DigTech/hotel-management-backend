import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { BookingTokens } from '../src/modules/booking/booking-tokens.service.js';
import { maskDiscreetRows } from '../src/modules/enterprise/exports/exports.service.js';
import { API, appRoleClient, createApp, ownerClient, platformAuth, setSignedTenant, uniq } from './helpers.js';
import { addStaff, guestInput, ID, lagosDay, login, REGISTRATION, type Auth } from './m2-helpers.js';
import { chargeSuccess, freshPhone, onlineHotel, postWebhook, randomIp, startPaystackStub, stopStub, type OnlineHotel, type PaystackStub } from './m3-helpers.js';

interface Hotel {
  h: OnlineHotel;
  owner: Auth;
  desk: Auth;
  deskId: string;
  rooms: string[];
}

interface Stay {
  id: string;
  code: string;
  guestId: string;
  folioId: string;
  phone: string;
  email: string;
  t: string;
}

type Item = { id: string; number: string; masked: boolean; title: string; status: string; discreet: boolean };

describe('M8: concierge (lawful guest requests)', () => {
  let app: INestApplication;
  let db: pg.Client;
  let platform: Auth;
  let stub: PaystackStub;
  let tokens: BookingTokens;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    stub = await startPaystackStub();
    app = await createApp();
    db = ownerClient();
    await db.connect();
    platform = await platformAuth(app);
    tokens = app.get(BookingTokens);
  });

  afterAll(async () => {
    await db.end();
    await app.close();
    await stopStub(stub);
  });

  async function onPlan(h: OnlineHotel, planCode: 'starter' | 'growth' | 'pro' | 'enterprise') {
    await request(server()).patch(`${API}/platform/tenants/${h.owner.tenantId}/subscription`).set(platform).send({ planCode, status: 'ACTIVE' }).expect(200);
  }

  async function acceptAup(auth: Auth) {
    const aup = await request(server()).get(`${API}/concierge/aup`).set(auth).expect(200);
    return request(server()).post(`${API}/concierge/aup/accept`).set(auth).send({ version: aup.body.version }).expect(200);
  }

  /** A Growth-trial hotel with a payout account, a front-desk user, the policy accepted and the concierge on. */
  async function hotel(opts: { plan?: 'growth' | 'pro' | 'enterprise'; enable?: boolean } = {}): Promise<Hotel> {
    const h = await onlineHotel(app, 4);
    if (opts.plan && opts.plan !== 'growth') await onPlan(h, opts.plan);
    const desk = await addStaff(app, h.owner.auth, 'FRONT_DESK');
    if (opts.enable !== false) {
      await acceptAup(h.owner.auth);
      await request(server()).put(`${API}/concierge/settings`).set(h.owner.auth).send({ enabled: true }).expect(200);
    }
    return { h, owner: h.owner.auth, desk: desk.auth, deskId: desk.id, rooms: h.rooms.map((r) => r.id) };
  }

  /** A checked-in stay (two nights) with a trip-page token. */
  async function stay(c: Hotel, opts: { phone?: string; checkIn?: boolean } = {}): Promise<Stay> {
    const phone = opts.phone ?? freshPhone();
    const email = `guest-${uniq()}@e2e.test`;
    const res = await request(server())
      .post(`${API}/reservations`)
      .set(c.owner)
      .send({ guest: guestInput({ fullName: 'Chidinma Okafor', phone, email }), roomTypeId: c.h.typeId, roomId: c.rooms.shift(), arrivalDate: lagosDay(0), departureDate: lagosDay(2) })
      .expect(201);
    if (opts.checkIn !== false) await request(server()).post(`${API}/reservations/${res.body.id}/check-in`).set(c.owner).send({ guest: ID, registration: REGISTRATION }).expect(200);
    const row = (await db.query('SELECT tenant_id, code, departure_at, guest_id FROM reservations WHERE id = $1', [res.body.id])).rows[0];
    const folio = (await db.query(`SELECT id FROM folios WHERE reservation_id = $1 AND kind = 'RESERVATION'`, [res.body.id])).rows[0];
    return { id: res.body.id, code: row.code, guestId: row.guest_id, folioId: folio.id, phone: `+${phone.replace(/\D/g, '')}`, email, t: tokens.signTrip(row.tenant_id, res.body.id, row.code, row.departure_at) };
  }

  function service(auth: Auth, body: Record<string, unknown>) {
    return request(server())
      .post(`${API}/concierge/services`)
      .set(auth)
      .send({ category: 'TRANSPORT', pricing: 'FIXED', priceKobo: 1_000_000, taxable: false, ...body, name: body.name ?? `Airport run ${uniq()}` });
  }

  function guestCreate(s: Stay, body: Record<string, unknown>) {
    return request(server())
      .post(`${API}/public/trips/${s.code}/concierge/requests`)
      .query({ t: s.t })
      .set('X-Forwarded-For', randomIp())
      .send({ contactPreference: 'SMS', ...body });
  }

  const detail = (auth: Auth, id: string) => request(server()).get(`${API}/concierge/requests/${id}`).set(auth);
  const status = (auth: Auth, id: string, body: Record<string, unknown>) => request(server()).post(`${API}/concierge/requests/${id}/status`).set(auth).send(body);

  async function folioLines(auth: Auth, folioId: string): Promise<{ description: string; type: string; amountKobo: number }[]> {
    return (await request(server()).get(`${API}/folios/${folioId}`).set(auth).expect(200)).body.entries;
  }

  async function outboxFor(to: string, template: string) {
    for (let i = 0; i < 30; i++) {
      const res = await request(server()).get(`${API}/public/dev/outbox`).query({ to, limit: 50 }).expect(200);
      const found = (res.body.items as { template: string; channel: string; text: string | null; subject: string | null }[]).filter((m) => m.template === template);
      if (found.length) return found;
      await new Promise((r) => setTimeout(r, 200));
    }
    return [];
  }

  async function auditActions(tenantId: string, entityId: string): Promise<{ action: string; metadata: Record<string, unknown> }[]> {
    return (await db.query('SELECT action, metadata FROM audit_logs WHERE tenant_id = $1 AND entity_id = $2 ORDER BY created_at', [tenantId, entityId])).rows;
  }

  // -------------------------------------------------------------------------
  // Policy, plans, platform review
  // -------------------------------------------------------------------------

  describe('acceptable-use policy and plan gates', () => {
    it('requires the policy before services or switching on; the public catalogue stays off', async () => {
      const c = await hotel({ enable: false });
      const gates = await request(server()).get(`${API}/concierge/gates`).set(c.owner).expect(200);
      expect(gates.body).toMatchObject({ feature: true, enabled: false, aup: { accepted: false }, suspended: null, canSeeDiscreet: true });
      const aup = await request(server()).get(`${API}/concierge/aup`).set(c.owner).expect(200);
      expect(aup.body.text).toContain('escort');
      expect(aup.body.prohibited.length).toBeGreaterThan(3);

      expect((await service(c.owner, {}).expect(409)).body.code).toBe('AUP_REQUIRED');
      expect((await request(server()).put(`${API}/concierge/settings`).set(c.owner).send({ enabled: true }).expect(409)).body.code).toBe('AUP_REQUIRED');
      expect((await request(server()).post(`${API}/concierge/aup/accept`).set(c.owner).send({ version: '2000-01-01' }).expect(409)).body.code).toBe('AUP_VERSION_MISMATCH');
      // Only concierge.settings may accept.
      await request(server()).post(`${API}/concierge/aup/accept`).set(c.desk).send({ version: aup.body.version }).expect(403);

      const accepted = await acceptAup(c.owner);
      expect(accepted.body).toMatchObject({ accepted: true, acceptedVersion: aup.body.version });
      await service(c.owner, { name: 'Airport drop-off' }).expect(201);
      expect((await request(server()).get(`${API}/public/hotels/${c.h.slug}/concierge`).expect(200)).body).toMatchObject({ enabled: false, services: [] });
      await request(server()).put(`${API}/concierge/settings`).set(c.owner).send({ enabled: true }).expect(200);
      const pub = await request(server()).get(`${API}/public/hotels/${c.h.slug}/concierge`).expect(200);
      expect(pub.body.enabled).toBe(true);
      expect(pub.body.services.map((s: { name: string }) => s.name)).toEqual(['Airport drop-off']);
      // Settings wording is screened too.
      const bad = await request(server()).put(`${API}/concierge/settings`).set(c.owner).send({ intro: 'Ask us for an escort tonight' }).expect(400);
      expect(bad.body.code).toBe('VALIDATION_ERROR');
    });

    it('Starter is locked (gates still answer); commission tracking needs Pro', async () => {
      const c = await hotel();
      const vendor = await request(server()).post(`${API}/concierge/vendors`).set(c.owner).send({ name: 'Lekki Rides', category: 'TRANSPORT', phone: '08031234567', commissionType: 'PERCENT', commissionValue: 1000 }).expect(403);
      expect(vendor.body).toMatchObject({ code: 'FEATURE_LOCKED', details: { feature: 'concierge_vendors', requiredPlan: 'pro' } });
      const plain = await request(server()).post(`${API}/concierge/vendors`).set(c.owner).send({ name: 'Lekki Rides', category: 'TRANSPORT', phone: '08031234567' }).expect(201);
      expect(plain.body.name).toBe('Lekki Rides');

      await onPlan(c.h, 'starter');
      const locked = await request(server()).get(`${API}/concierge/services`).set(c.owner).expect(403);
      expect(locked.body).toMatchObject({ code: 'FEATURE_LOCKED', details: { feature: 'concierge', requiredPlan: 'growth' } });
      const gates = await request(server()).get(`${API}/concierge/gates`).set(c.owner).expect(200);
      expect(gates.body).toMatchObject({ feature: false, vendorsFeature: false, requiredPlan: 'growth', vendorsRequiredPlan: 'pro', enabled: false });
      expect((await request(server()).get(`${API}/public/hotels/${c.h.slug}/concierge`).expect(200)).body.enabled).toBe(false);
    });
  });

  describe('content screen and platform review', () => {
    it('holds flagged services for review; the platform approves, rejects and hides them', async () => {
      const c = await hotel();
      const flagged = await service(c.owner, { name: 'Police escort for the airport run', category: 'SECURITY' }).expect(201);
      expect(flagged.body).toMatchObject({ reviewStatus: 'PENDING_REVIEW', guestVisible: false, review: { flaggedTerms: ['escort'] } });
      const other = await service(c.owner, { name: 'Casino gambling night out', category: 'TOURS_AND_EXPERIENCES' }).expect(201);
      expect(other.body.reviewStatus).toBe('PENDING_REVIEW');
      const live = await service(c.owner, { name: 'Lagos city tour', category: 'TOURS_AND_EXPERIENCES' }).expect(201);
      expect(live.body.reviewStatus).toBe('LIVE');
      const names = async () => (await request(server()).get(`${API}/public/hotels/${c.h.slug}/concierge`).expect(200)).body.services.map((s: { name: string }) => s.name).sort();
      expect(await names()).toEqual(['Lagos city tour']);
      await request(server()).get(`${API}/public/hotels/${c.h.slug}/concierge/services/${flagged.body.id}`).expect(404);
      // A dry-run screen for the admin form.
      const dry = await request(server()).post(`${API}/concierge/screen`).set(c.owner).send({ texts: ['Airport pickup', 'weed delivery'] }).expect(200);
      expect(dry.body.flagged).toBe(true);
      expect(dry.body.matches).toEqual([expect.objectContaining({ term: 'weed', category: 'DRUGS', textIndex: 1 })]);

      const queue = await request(server()).get(`${API}/platform/concierge/reviews`).query({ tenantId: c.h.owner.tenantId }).set(platform).expect(200);
      expect(queue.body.items.map((i: { name: string }) => i.name).sort()).toEqual(['Casino gambling night out', 'Police escort for the airport run']);
      expect(queue.body.items[0].tenant.id).toBe(c.h.owner.tenantId);
      // Hotel staff cannot reach the platform queue.
      await request(server()).get(`${API}/platform/concierge/reviews`).set(c.owner).expect(401);

      const base = `${API}/platform/concierge/tenants/${c.h.owner.tenantId}/services`;
      const ok = await request(server()).post(`${base}/${flagged.body.id}/approve`).set(platform).send({ note: 'Licensed security firm' }).expect(200);
      expect(ok.body).toMatchObject({ reviewStatus: 'LIVE', reason: 'Licensed security firm' });
      await request(server()).post(`${base}/${other.body.id}/reject`).set(platform).send({ reason: 'Gambling is not allowed' }).expect(200);
      await request(server()).post(`${base}/${live.body.id}/hide`).set(platform).send({ reason: 'Hidden while we check' }).expect(200);
      expect(await names()).toEqual(['Police escort for the airport run']);

      // A rejected service edited by the hotel goes back to the queue.
      const edited = await request(server()).patch(`${API}/concierge/services/${other.body.id}`).set(c.owner).send({ name: 'Evening at the National Theatre' }).expect(200);
      expect(edited.body.reviewStatus).toBe('PENDING_REVIEW');
      const audit = await auditActions(c.h.owner.tenantId, flagged.body.id);
      expect(audit.map((a) => a.action)).toEqual(['concierge_service.created', 'concierge_service.approved']);
    });

    it('suspends and reinstates a hotel concierge', async () => {
      const c = await hotel();
      const svc = await service(c.owner, { name: 'Barber in the room', category: 'WELLNESS', location: 'IN_ROOM' }).expect(201);
      const s = await stay(c);
      const created = await guestCreate(s, { serviceId: svc.body.id, paymentMethod: 'FOLIO' }).expect(201);
      expect(created.body.request.status).toBe('CONFIRMED');

      const suspended = await request(server()).post(`${API}/platform/concierge/tenants/${c.h.owner.tenantId}/suspend`).set(platform).send({ reason: 'Listings under investigation' }).expect(200);
      expect(suspended.body.suspended).toMatchObject({ reason: 'Listings under investigation' });
      expect((await outboxFor(c.h.owner.email, 'CONCIERGE_SUSPENDED')).length).toBe(1);
      expect((await service(c.owner, {}).expect(403)).body.code).toBe('CONCIERGE_SUSPENDED');
      expect((await request(server()).get(`${API}/concierge/gates`).set(c.owner).expect(200)).body).toMatchObject({ enabled: false, suspended: { reason: 'Listings under investigation' } });
      expect((await request(server()).get(`${API}/public/hotels/${c.h.slug}/concierge`).expect(200)).body.enabled).toBe(false);
      expect((await guestCreate(s, { serviceId: svc.body.id, paymentMethod: 'FOLIO' }).expect(409)).body.code).toBe('CONCIERGE_DISABLED');
      // Work already under way can be finished.
      await status(c.owner, created.body.request.id, { status: 'COMPLETED' }).expect(200);
      const list = await request(server()).get(`${API}/platform/concierge/tenants`).query({ suspended: 'true' }).set(platform).expect(200);
      expect(list.body.items.some((t: { tenant: { id: string } }) => t.tenant.id === c.h.owner.tenantId)).toBe(true);

      await request(server()).post(`${API}/platform/concierge/tenants/${c.h.owner.tenantId}/reinstate`).set(platform).send({ note: 'Cleared' }).expect(200);
      await service(c.owner, { name: 'Laundry express' }).expect(201);
      expect((await request(server()).get(`${API}/public/hotels/${c.h.slug}/concierge`).expect(200)).body.enabled).toBe(true);
    });

    it('holds flagged guest requests: never auto-confirmed, quoted or sent to a vendor until reviewed', async () => {
      const c = await hotel();
      const vendor = await request(server()).post(`${API}/concierge/vendors`).set(c.owner).send({ name: 'Island Errands', category: 'OTHER', whatsapp: '08035550101' }).expect(201);
      const svc = await service(c.owner, { name: 'Errand run', category: 'OTHER', pricing: 'FIXED', priceKobo: 300_000 }).expect(201);
      const s = await stay(c);

      const free = await guestCreate(s, { requestText: 'Please get me some weed for tonight' }).expect(201);
      expect(free.body.request).toMatchObject({ status: 'NEW', statusLabel: expect.any(String) });
      const id = free.body.request.id;
      const d = (await detail(c.owner, id).expect(200)).body;
      expect(d).toMatchObject({ flagged: true, flag: { terms: ['weed'], categories: ['DRUGS'], status: 'PENDING' }, vendor: null });
      expect((await request(server()).post(`${API}/concierge/requests/${id}/assign`).set(c.owner).send({ vendorId: vendor.body.id }).expect(409)).body.code).toBe('INVALID_STATE');
      expect((await request(server()).post(`${API}/concierge/requests/${id}/send-to-vendor`).set(c.owner).send({}).expect(409)).body.code).toBe('INVALID_STATE');
      expect((await request(server()).post(`${API}/concierge/requests/${id}/quote`).set(c.owner).send({ amountKobo: 100_000 }).expect(409)).body.code).toBe('INVALID_STATE');
      const flaggedList = await request(server()).get(`${API}/concierge/requests`).query({ flagged: 'true' }).set(c.owner).expect(200);
      expect(flaggedList.body.items.map((i: Item) => i.id)).toEqual([id]);
      // Front desk cannot review held requests.
      await request(server()).post(`${API}/concierge/requests/${id}/flag-review`).set(c.desk).send({ decision: 'DECLINE', note: 'No' }).expect(403);
      const declined = await request(server()).post(`${API}/concierge/requests/${id}/flag-review`).set(c.owner).send({ decision: 'DECLINE', note: 'Illegal drugs' }).expect(200);
      expect(declined.body).toMatchObject({ status: 'DECLINED', flag: { status: 'DECLINED' } });
      const guestView = await request(server()).get(`${API}/public/trips/${s.code}/concierge/requests/${id}`).query({ t: s.t }).expect(200);
      expect(guestView.body.statusLabel).toBe("We couldn't arrange this request");

      // A flagged note on a priced service is not auto-confirmed; clearing it confirms to the folio.
      const held = await guestCreate(s, { serviceId: svc.body.id, paymentMethod: 'FOLIO', notes: 'and a little weed too' }).expect(201);
      expect(held.body.request.status).toBe('NEW');
      expect(held.body.request.price).toBeNull();
      const cleared = await request(server()).post(`${API}/concierge/requests/${held.body.request.id}/flag-review`).set(c.owner).send({ decision: 'CLEAR', note: 'Spoke to the guest: groceries only' }).expect(200);
      expect(cleared.body).toMatchObject({ status: 'CONFIRMED', flag: { status: 'CLEARED' }, payment: { method: 'FOLIO' } });
      await request(server()).post(`${API}/concierge/requests/${held.body.request.id}/assign`).set(c.owner).send({ vendorId: vendor.body.id }).expect(200);
      const sent = await request(server()).post(`${API}/concierge/requests/${held.body.request.id}/send-to-vendor`).set(c.owner).send({}).expect(200);
      expect(sent.body.sent).toMatchObject({ channel: 'WHATSAPP', to: '+2348035550101' });
    });
  });

  // -------------------------------------------------------------------------
  // Requests: pricing, quotes, payments, folio
  // -------------------------------------------------------------------------

  describe('requests, quotes and payments', () => {
    it('prices a fixed service and auto-confirms to the folio; completion posts one named folio line', async () => {
      const c = await hotel();
      const svc = await service(c.owner, { name: 'Airport transfer', variants: [{ name: 'Saloon', priceKobo: 1_500_000 }, { name: 'SUV', priceKobo: 2_500_000 }], pricing: 'FIXED', priceKobo: null }).expect(201);
      const suv = svc.body.variants.find((v: { name: string }) => v.name === 'SUV');
      const price = await request(server()).post(`${API}/public/hotels/${c.h.slug}/concierge/price`).send({ serviceId: svc.body.id, variantId: suv.id }).expect(200);
      expect(price.body).toMatchObject({ requiresQuote: false, price: { totalKobo: 2_500_000 } });

      const s = await stay(c);
      const trip = await request(server()).get(`${API}/public/trips/${s.code}/concierge`).query({ t: s.t }).expect(200);
      expect(trip.body.catalogue.services.map((x: { id: string }) => x.id)).toContain(svc.body.id);
      expect(trip.body.stay.folioOpen).toBe(true);
      await request(server()).get(`${API}/public/trips/${s.code}/concierge`).query({ t: 'nope' }).expect(404);

      const created = await guestCreate(s, { serviceId: svc.body.id, variantId: suv.id, paymentMethod: 'FOLIO', partySize: 2 }).expect(201);
      expect(created.body.request).toMatchObject({ number: 'CR-000001', status: 'CONFIRMED', price: { totalKobo: 2_500_000 }, payment: { method: 'FOLIO' }, canCancel: true });
      expect((await outboxFor(s.phone, 'CONCIERGE_CONFIRMED')).length).toBe(1);
      const id = created.body.request.id;

      // Guest numbers are per property and run on.
      const second = await guestCreate(s, { serviceId: svc.body.id, variantId: suv.id, paymentMethod: 'FOLIO' }).expect(201);
      expect(second.body.request.number).toBe('CR-000002');
      const cancelled = await request(server()).post(`${API}/public/trips/${s.code}/concierge/requests/${second.body.request.id}/cancel`).query({ t: s.t }).set('X-Forwarded-For', randomIp()).send({ reason: 'Plans changed' }).expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');

      await status(c.owner, id, { status: 'SCHEDULED', scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }).expect(200);
      await status(c.owner, id, { status: 'IN_PROGRESS' }).expect(200);
      const done = await status(c.owner, id, { status: 'COMPLETED' }).expect(200);
      expect(done.body.payment).toMatchObject({ status: 'POSTED', folioDescription: 'Airport transfer, SUV (CR-000001)' });
      const lines = (await folioLines(c.owner, s.folioId)).filter((e) => e.description.includes('CR-000001'));
      expect(lines).toHaveLength(1);
      expect(lines[0]!.amountKobo).toBe(2_500_000);
      // Completing twice is refused; the line is not posted again.
      await status(c.owner, id, { status: 'COMPLETED' }).expect(409);

      const rated = await request(server()).post(`${API}/public/trips/${s.code}/concierge/requests/${id}/rating`).query({ t: s.t }).set('X-Forwarded-For', randomIp()).send({ rating: 5, comment: 'Smooth ride' }).expect(200);
      expect(rated.body.rating).toEqual({ rating: 5, comment: 'Smooth ride' });
      const reports = await request(server()).get(`${API}/concierge/reports`).set(c.owner).expect(200);
      expect(reports.body.totals).toMatchObject({ requests: 2, completed: 1, cancelled: 1 });
      expect(reports.body.ratings).toMatchObject({ average: 5, count: 1 });
      expect(reports.body.vendorCommission).toBeNull();
    });

    it('quotes a free-form request; the guest accepts from the link and pays online (signed webhook)', async () => {
      const c = await hotel();
      const s = await stay(c);
      const created = await guestCreate(s, { requestText: 'A birthday cake for my wife, chocolate, tomorrow evening', contactEmail: s.email }).expect(201);
      expect(created.body.request).toMatchObject({ status: 'NEW', title: 'Something else', price: null });
      const id = created.body.request.id;
      expect((await outboxFor(s.phone, 'CONCIERGE_RECEIVED')).length).toBe(1);

      const quoted = await request(server()).post(`${API}/concierge/requests/${id}/quote`).set(c.desk).send({ amountKobo: 3_500_000, taxable: false, note: 'Includes delivery' }).expect(200);
      expect(quoted.body).toMatchObject({ status: 'QUOTED', quote: { version: 1, totalKobo: 3_500_000 } });
      expect((await outboxFor(s.phone, 'CONCIERGE_QUOTE')).length).toBe(1);
      const token = new URL(quoted.body.quote.acceptUrl).pathname.split('/').pop()!;
      expect(quoted.body.quote.acceptUrl.startsWith('http://localhost:3000/concierge/q/')).toBe(true);

      const page = await request(server()).get(`${API}/public/concierge/quotes/${token}`).expect(200);
      expect(page.body).toMatchObject({ state: 'OPEN', paymentOptions: { online: true, folio: true }, request: { quote: { totalKobo: 3_500_000 } } });

      // A new quote replaces the old link.
      const requoted = await request(server()).post(`${API}/concierge/requests/${id}/quote`).set(c.desk).send({ amountKobo: 3_000_000, taxable: false }).expect(200);
      expect((await request(server()).get(`${API}/public/concierge/quotes/${token}`).expect(200)).body.state).toBe('REPLACED');
      expect((await request(server()).post(`${API}/public/concierge/quotes/${token}/accept`).send({ paymentMethod: 'ONLINE' }).expect(410)).body.code).toBe('QUOTE_EXPIRED');
      const latest = new URL(requoted.body.quote.acceptUrl).pathname.split('/').pop()!;

      const accepted = await request(server()).post(`${API}/public/concierge/quotes/${latest}/accept`).send({ paymentMethod: 'ONLINE', email: s.email }).expect(200);
      expect(accepted.body.request.status).toBe('AWAITING_GUEST');
      const ref = accepted.body.payment.reference as string;
      expect(ref).toMatch(/^CRQ_/);
      expect(accepted.body.payment.authorizationUrl).toBe(`https://checkout.paystack.test/${ref}`);
      expect(stub.inits.get(ref)).toMatchObject({ amount: 3_000_000, metadata: { kind: 'concierge' } });
      await request(server()).post(`${API}/public/concierge/quotes/${latest}/accept`).send({ paymentMethod: 'ONLINE' }).expect(409);

      await postWebhook(app, chargeSuccess(ref, 3_000_000, { metadata: { kind: 'concierge' } })).expect(200);
      const paid = (await detail(c.owner, id).expect(200)).body;
      expect(paid).toMatchObject({ status: 'CONFIRMED', payment: { method: 'ONLINE', status: 'PAID', folioDescription: `Something else (${paid.number})` } });
      const lines = await folioLines(c.owner, s.folioId);
      expect(lines.filter((e) => e.description === paid.payment.folioDescription)).toHaveLength(1);
      // Replays are ignored.
      await postWebhook(app, chargeSuccess(ref, 3_000_000, { metadata: { kind: 'concierge' } })).expect(200);
      expect((await folioLines(c.owner, s.folioId)).filter((e) => e.description === paid.payment.folioDescription)).toHaveLength(1);
      const verify = await request(server()).get(`${API}/public/concierge/payments/${ref}/verify`).expect(200);
      expect(verify.body).toMatchObject({ kind: 'CONCIERGE', state: 'SUCCESS', requestNumber: paid.number });

      // The guest cancels a paid request: refunded in full.
      const cancelled = await request(server()).post(`${API}/public/trips/${s.code}/concierge/requests/${id}/cancel`).query({ t: s.t }).set('X-Forwarded-For', randomIp()).send({}).expect(200);
      expect(cancelled.body).toMatchObject({ status: 'CANCELLED', payment: { status: 'REFUNDED' } });
      expect(stub.refunds.some((r) => r.transaction === ref && r.amount === 3_000_000)).toBe(true);
    });

    it('a guest declines a quote from the link', async () => {
      const c = await hotel();
      const s = await stay(c);
      const created = await guestCreate(s, { requestText: 'Two tickets to the Afrobeats show at Eko Hotel' }).expect(201);
      const quoted = await request(server()).post(`${API}/concierge/requests/${created.body.request.id}/quote`).set(c.owner).send({ amountKobo: 4_000_000 }).expect(200);
      const token = new URL(quoted.body.quote.acceptUrl).pathname.split('/').pop()!;
      const declined = await request(server()).post(`${API}/public/concierge/quotes/${token}/decline`).send({ reason: 'Too dear' }).expect(200);
      expect(declined.body.request.status).toBe('CANCELLED');
      expect((await request(server()).get(`${API}/public/concierge/quotes/${token}`).expect(200)).body.state).toBe('DECLINED');
    });
  });

  // -------------------------------------------------------------------------
  // Discretion
  // -------------------------------------------------------------------------

  describe('private requests', () => {
    it('masks them for staff without concierge.discreet, audits holder views and posts neutral folio wording', async () => {
      const c = await hotel();
      const svc = await service(c.owner, { name: 'In-room massage', category: 'WELLNESS', location: 'IN_ROOM', discreetEligible: true, pricing: 'FIXED', priceKobo: 2_000_000 }).expect(201);
      const plain = await service(c.owner, { name: 'Shoe shine', category: 'LAUNDRY_EXPRESS', discreetEligible: false }).expect(201);
      const s = await stay(c);
      // Only discreet-eligible services can be private.
      await guestCreate(s, { serviceId: plain.body.id, discreet: true, paymentMethod: 'FOLIO' }).expect(400);
      const created = await guestCreate(s, { serviceId: svc.body.id, discreet: true, paymentMethod: 'FOLIO', notes: 'Deep tissue, 7pm' }).expect(201);
      // The guest sees their own request in full.
      expect(created.body.request).toMatchObject({ discreet: true, title: 'In-room massage', status: 'CONFIRMED', notes: 'Deep tissue, 7pm' });
      const id = created.body.request.id;
      const number = created.body.request.number;
      // Guest messages stay neutral.
      const confirmed = await outboxFor(s.phone, 'CONCIERGE_CONFIRMED');
      expect(confirmed[0]!.text).not.toContain('massage');

      // Front desk: masked everywhere.
      const board = await request(server()).get(`${API}/concierge/board`).set(c.desk).expect(200);
      const cards = board.body.columns.flatMap((col: { items: Item[] }) => col.items);
      expect(cards.find((x: Item) => x.id === id)).toMatchObject({ masked: true, title: 'Private request', category: null, guestName: null, totalKobo: null });
      const masked = (await detail(c.desk, id).expect(200)).body;
      expect(masked).toMatchObject({ masked: true, service: null, notes: null, answers: [], guest: null, reservation: null, contact: { phone: null, email: null }, price: null });
      expect(JSON.stringify(masked)).not.toContain('massage');
      const byName = await request(server()).get(`${API}/concierge/requests`).query({ q: 'massage' }).set(c.desk).expect(200);
      expect(byName.body.total).toBe(0);
      const resv = await request(server()).get(`${API}/reservations/${s.id}`).set(c.desk).expect(200);
      expect(resv.body.concierge[0]).toMatchObject({ id, masked: true, title: 'Private request' });
      expect(JSON.stringify(resv.body.concierge)).not.toContain('massage');
      // Non-holders cannot act on it or make requests private.
      await request(server()).post(`${API}/concierge/requests/${id}/notes`).set(c.desk).send({ note: 'hello' }).expect(403);
      await request(server()).post(`${API}/concierge/requests`).set(c.desk).send({ reservationId: s.id, serviceId: svc.body.id, discreet: true, paymentMethod: 'FOLIO' }).expect(403);
      expect(await auditActions(c.h.owner.tenantId, id)).not.toContainEqual(expect.objectContaining({ action: 'concierge_request.discreet_viewed' }));

      // Holders see it; each view is audited. The Concierge role holds the permission.
      const conciergeEmail = `concierge-${uniq()}@e2e.test`;
      await request(server()).post(`${API}/staff`).set(c.owner).send({ fullName: 'Amaka Nwosu', email: conciergeEmail, phone: '+2348000000002', role: 'CONCIERGE', password: 'Passw0rd!x' }).expect(201);
      const concierge = await login(app, conciergeEmail);
      const full = (await detail(concierge, id).expect(200)).body;
      expect(full).toMatchObject({ masked: false, title: 'In-room massage', notes: 'Deep tissue, 7pm', guest: { fullName: 'Chidinma Okafor' } });
      await detail(c.owner, id).expect(200);
      const audit = await auditActions(c.h.owner.tenantId, id);
      expect(audit.filter((a) => a.action === 'concierge_request.discreet_viewed')).toHaveLength(2);
      // The creation entry is neutral too.
      expect(audit.find((a) => a.action === 'concierge_request.created')!.metadata).toMatchObject({ title: 'Private request', discreet: true });

      // Completion posts the hotel's neutral folio wording.
      const done = await status(concierge, id, { status: 'COMPLETED' }).expect(200);
      expect(done.body.payment.folioDescription).toBe(`In-room service (${number})`);
      const lines = await folioLines(c.desk, s.folioId);
      const line = lines.find((e) => e.description.includes(number))!;
      expect(line.description).toBe(`In-room service (${number})`);
      expect(JSON.stringify(lines)).not.toContain('massage');

      // HIDDEN: non-holders do not see private requests at all.
      await request(server()).put(`${API}/concierge/settings`).set(c.owner).send({ discreetVisibility: 'HIDDEN' }).expect(200);
      await detail(c.desk, id).expect(404);
      const list = await request(server()).get(`${API}/concierge/requests`).set(c.desk).expect(200);
      expect(list.body.items.map((x: Item) => x.id)).not.toContain(id);
      expect((await request(server()).get(`${API}/reservations/${s.id}`).set(c.desk).expect(200)).body.concierge).toEqual([]);
      await detail(concierge, id).expect(200);
    });

    it('keeps private requests out of the Today card, exports and the partner API', async () => {
      const c = await hotel({ plan: 'enterprise' });
      const svc = await service(c.owner, { name: 'Private dinner setup', category: 'ROMANCE_AND_CELEBRATION', discreetEligible: true, pricing: 'FIXED', priceKobo: 5_000_000 }).expect(201);
      const s = await stay(c);
      const soon = new Date(Date.now() + 2 * 3_600_000).toISOString();
      const secret = await guestCreate(s, { serviceId: svc.body.id, discreet: true, paymentMethod: 'FOLIO', preferredStart: soon }).expect(201);
      const open = await guestCreate(s, { serviceId: svc.body.id, paymentMethod: 'FOLIO', preferredStart: soon }).expect(201);

      // Today card on the front desk: counted, never named.
      const today = await request(server()).get(`${API}/front-desk/today`).set(c.desk).expect(200);
      expect(today.body.concierge).toMatchObject({ discreet: 1 });
      const next = today.body.concierge.next as Item[];
      expect(next.map((x) => x.id)).toContain(open.body.request.id);
      expect(next.map((x) => x.id)).not.toContain(secret.body.request.id);
      const ownerToday = await request(server()).get(`${API}/concierge/today`).set(c.owner).expect(200);
      const shared = (ownerToday.body.next as Item[]).find((x) => x.id === secret.body.request.id);
      expect(shared).toMatchObject({ masked: true, title: 'Private request' });

      // Concierge export: an accountant (reports, not discreet) does not get private rows.
      const acct = await addStaff(app, c.owner, 'ACCOUNTANT');
      const range = { from: lagosDay(-1), to: lagosDay(1), format: 'json' };
      const acctExport = await request(server()).get(`${API}/concierge/requests/export`).query(range).set(acct.auth).expect(200);
      expect(JSON.parse(acctExport.text).items.map((x: { number: string }) => x.number)).toEqual([open.body.request.number]);
      const ownerExport = await request(server()).get(`${API}/concierge/requests/export`).query({ ...range, format: 'csv' }).set(c.owner).expect(200);
      expect(ownerExport.text).toContain(secret.body.request.number);
      expect(ownerExport.headers['content-type']).toContain('text/csv');

      // Full-data export masking (staff without concierge.discreet).
      const masked = maskDiscreetRows([
        { id: 'a', discreet: true, service_name: 'Private dinner setup', notes: 'Roses', contact_phone: '+2348030000000', category: 'ROMANCE_AND_CELEBRATION', answers: { a: 1 } },
        { id: 'b', discreet: false, service_name: 'Airport run', notes: 'Early', category: 'TRANSPORT' },
      ]);
      expect(masked[0]).toMatchObject({ service_name: 'Private request', notes: null, contact_phone: null, category: 'OTHER', answers: {} });
      expect(masked[1]).toMatchObject({ service_name: 'Airport run', notes: 'Early' });

      // Partner API: private requests never leave the hotel.
      const key = await request(server()).post(`${API}/api-keys`).set(c.owner).send({ name: 'E2E concierge', environment: 'LIVE', scopes: ['reservations:read', 'rates:read'] }).expect(201);
      const partner = await request(server()).get('/api/partner/v1/concierge-requests').set('X-Api-Key', key.body.secret).expect(200);
      const ids = partner.body.data.map((x: { id: string }) => x.id);
      expect(ids).toContain(open.body.request.id);
      expect(ids).not.toContain(secret.body.request.id);
      const services = await request(server()).get('/api/partner/v1/concierge-services').set('X-Api-Key', key.body.secret).expect(200);
      expect(services.body.data.map((x: { id: string }) => x.id)).toEqual([svc.body.id]);
    });
  });

  // -------------------------------------------------------------------------
  // WhatsApp, vendors, SLA, retention, NDPA
  // -------------------------------------------------------------------------

  describe('WhatsApp replies and vendors (Pro)', () => {
    it('answers a WhatsApp quote with YES (folio) and NO (cancelled)', async () => {
      const c = await hotel({ plan: 'pro' });
      const s = await stay(c);
      const a = await guestCreate(s, { requestText: 'Book a table for four at a seafood restaurant in VI', contactPreference: 'WHATSAPP' }).expect(201);
      const q = await request(server()).post(`${API}/concierge/requests/${a.body.request.id}/quote`).set(c.owner).send({ amountKobo: 1_200_000, taxable: false }).expect(200);
      expect(q.body.status).toBe('QUOTED');
      const quoteMsg = await outboxFor(s.phone, 'CONCIERGE_QUOTE');
      expect(quoteMsg[0]!.channel).toBe('WHATSAPP');

      const yes = await request(server()).post(`${API}/inbox/dev/inbound`).set(c.owner).send({ phone: s.phone, body: 'Yes please' }).expect(200);
      expect(yes.body).toMatchObject({ handledBy: 'concierge', routed: true });
      const confirmed = (await detail(c.owner, a.body.request.id).expect(200)).body;
      expect(confirmed).toMatchObject({ status: 'CONFIRMED', payment: { method: 'FOLIO' }, quote: { answer: 'ACCEPTED', answeredVia: 'WHATSAPP' } });
      const replies = await outboxFor(s.phone, 'WHATSAPP_REPLY');
      expect(replies.some((m) => (m.text ?? '').includes(confirmed.number))).toBe(true);

      const b = await guestCreate(s, { requestText: 'A tailor to take in two shirts', contactPreference: 'WHATSAPP' }).expect(201);
      await request(server()).post(`${API}/concierge/requests/${b.body.request.id}/quote`).set(c.owner).send({ amountKobo: 800_000 }).expect(200);
      const no = await request(server()).post(`${API}/inbox/dev/inbound`).set(c.owner).send({ phone: s.phone, body: 'No' }).expect(200);
      expect(no.body.handledBy).toBe('concierge');
      expect((await detail(c.owner, b.body.request.id).expect(200)).body).toMatchObject({ status: 'CANCELLED', quote: { answer: 'DECLINED', answeredVia: 'WHATSAPP' } });
      // Anything else goes to the inbox as usual.
      const other = await request(server()).post(`${API}/inbox/dev/inbound`).set(c.owner).send({ phone: s.phone, body: 'Yes' }).expect(200);
      expect(other.body.handledBy).toBeUndefined();
    });

    it('tracks vendor jobs and commission on completion', async () => {
      const c = await hotel({ plan: 'pro' });
      const vendor = await request(server()).post(`${API}/concierge/vendors`).set(c.owner).send({ name: 'Mainland Chauffeurs', category: 'TRANSPORT', whatsapp: '08037770000', commissionType: 'PERCENT', commissionValue: 1000 }).expect(201);
      const svc = await service(c.owner, { name: 'Chauffeur for the day', vendorId: vendor.body.id, pricing: 'FIXED', priceKobo: 4_000_000 }).expect(201);
      expect(svc.body).toMatchObject({ fulfilledBy: 'VENDOR', vendor: { id: vendor.body.id } });
      const s = await stay(c);
      const created = await request(server()).post(`${API}/concierge/requests`).set(c.desk).send({ reservationId: s.id, serviceId: svc.body.id, paymentMethod: 'FOLIO' }).expect(201);
      expect(created.body).toMatchObject({ status: 'CONFIRMED', vendor: { id: vendor.body.id }, commission: { type: 'PERCENT', value: 1000 } });
      const id = created.body.id;
      const sent = await request(server()).post(`${API}/concierge/requests/${id}/send-to-vendor`).set(c.desk).send({ note: 'Pick up at the lobby' }).expect(200);
      expect(sent.body.sent).toMatchObject({ channel: 'WHATSAPP', to: '+2348037770000' });
      const job = await outboxFor('+2348037770000', 'CONCIERGE_VENDOR_JOB');
      expect(job[0]!.text).toContain('Chidinma');
      expect(job[0]!.text).not.toContain('Okafor');

      const done = await status(c.desk, id, { status: 'COMPLETED', vendorRating: 4 }).expect(200);
      expect(done.body.commission).toMatchObject({ commissionKobo: 400_000, vendorPayableKobo: 3_600_000, settledAt: null });
      const settled = await request(server()).post(`${API}/concierge/vendors/${vendor.body.id}/settle`).set(c.owner).send({ reference: 'TRF-001' }).expect(200);
      expect(JSON.stringify(settled.body)).toContain('3600000');
      const reports = await request(server()).get(`${API}/concierge/reports`).set(c.owner).expect(200);
      expect(reports.body.vendorCommission[0]).toMatchObject({ vendorId: vendor.body.id, commissionKobo: 400_000, payableKobo: 3_600_000, settledKobo: 3_600_000 });
      // A vendor in use cannot be deleted.
      expect((await request(server()).delete(`${API}/concierge/vendors/${vendor.body.id}`).set(c.owner).expect(409)).body.code).toBe('SERVICE_IN_USE');
    });
  });

  describe('SLA, retention and NDPA', () => {
    it('escalates unanswered requests once, by email to reviewers', async () => {
      const c = await hotel();
      const s = await stay(c);
      const created = await guestCreate(s, { requestText: 'Could someone recommend a good Yoruba restaurant nearby?' }).expect(201);
      const id = created.body.request.id;
      const board = await request(server()).get(`${API}/concierge/board`).set(c.owner).expect(200);
      expect(board.body.counts).toMatchObject({ new: 1, overdue: 0 });
      expect((await request(server()).post(`${API}/concierge/jobs/sla/run`).set(c.owner).expect(200)).body.escalated).toBe(0);

      await db.query(`UPDATE concierge_requests SET sla_due_at = now() - interval '30 minutes' WHERE id = $1`, [id]);
      const overdue = await request(server()).get(`${API}/concierge/requests`).query({ overdue: 'true' }).set(c.owner).expect(200);
      expect(overdue.body.items.map((x: Item) => x.id)).toEqual([id]);
      await request(server()).post(`${API}/concierge/jobs/sla/run`).set(c.desk).expect(403);
      expect((await request(server()).post(`${API}/concierge/jobs/sla/run`).set(c.owner).expect(200)).body.escalated).toBe(1);
      const mail = await outboxFor(c.h.owner.email, 'CONCIERGE_ESCALATION');
      expect(mail.length).toBe(1);
      expect(mail[0]!.subject).toContain(created.body.request.number);
      expect((await request(server()).post(`${API}/concierge/jobs/sla/run`).set(c.owner).expect(200)).body.escalated).toBe(0);
      const d = (await detail(c.owner, id).expect(200)).body;
      expect(d.sla).toMatchObject({ overdue: true });
      expect(d.timeline.some((e: { type: string }) => e.type === 'escalated')).toBe(true);
    });

    it('redacts finished requests after the retention period, keeping amounts', async () => {
      const c = await hotel();
      const svc = await service(c.owner, { name: 'Laundry pickup', category: 'LAUNDRY_EXPRESS', priceKobo: 700_000 }).expect(201);
      const s = await stay(c);
      const created = await guestCreate(s, { serviceId: svc.body.id, paymentMethod: 'FOLIO', notes: 'Two white agbadas, starch lightly' }).expect(201);
      const id = created.body.request.id;
      await status(c.owner, id, { status: 'COMPLETED', note: 'Returned pressed' }).expect(200);
      expect((await request(server()).post(`${API}/concierge/jobs/redaction/run`).set(c.owner).expect(200)).body.redacted).toBe(0);
      await db.query(`UPDATE concierge_requests SET completed_at = now() - interval '100 days' WHERE id = $1`, [id]);
      expect((await request(server()).post(`${API}/concierge/jobs/redaction/run`).set(c.owner).expect(200)).body.redacted).toBe(1);
      const d = (await detail(c.owner, id).expect(200)).body;
      expect(d.notes).toBe('[redacted]');
      expect(d.redactedAt).not.toBeNull();
      expect(d.price.totalKobo).toBe(700_000);
      expect(JSON.stringify(d.timeline)).not.toContain('agbadas');
      expect((await request(server()).post(`${API}/concierge/jobs/redaction/run`).set(c.owner).expect(200)).body.redacted).toBe(0);
    });

    it('exports the guest concierge data (NDPA) and wipes it on anonymisation', async () => {
      const c = await hotel();
      const svc = await service(c.owner, { name: 'Gele tying', category: 'GROOMING', discreetEligible: true, priceKobo: 500_000 }).expect(201);
      const s = await stay(c);
      const created = await guestCreate(s, { serviceId: svc.body.id, discreet: true, paymentMethod: 'FOLIO', notes: 'For the wedding on Saturday' }).expect(201);
      const id = created.body.request.id;
      await status(c.owner, id, { status: 'COMPLETED' }).expect(200);

      const exp = await request(server()).get(`${API}/guests/${s.guestId}/export`).set(c.owner).expect(200);
      expect(exp.body.conciergeRequests).toHaveLength(1);
      expect(exp.body.conciergeRequests[0]).toMatchObject({ number: created.body.request.number, service: 'Gele tying', discreet: true, notes: 'For the wedding on Saturday' });

      const folio = (await request(server()).get(`${API}/folios/${s.folioId}`).set(c.owner).expect(200)).body;
      await request(server()).post(`${API}/folios/${s.folioId}/payments`).set(c.owner).send({ method: 'COMPLIMENTARY', amountKobo: folio.totals.balanceKobo }).expect(201);
      await request(server()).post(`${API}/reservations/${s.id}/check-out`).set(c.owner).send({}).expect(200);
      await request(server()).post(`${API}/guests/${s.guestId}/anonymise`).set(c.owner).send({ reason: 'Subject request by email, ref NDPA-0101' }).expect(200);
      const row = (await db.query('SELECT notes, contact_phone, contact_email, redacted_at, price_amount_kobo, folio_entry_id FROM concierge_requests WHERE id = $1', [id])).rows[0];
      expect(row).toMatchObject({ notes: '[redacted]', contact_phone: null, contact_email: null, price_amount_kobo: 500_000 });
      expect(row.redacted_at).not.toBeNull();
      expect(row.folio_entry_id).not.toBeNull();
    });
  });

  describe('tenant isolation', () => {
    it('RLS keeps concierge rows inside their tenant', async () => {
      const a = await hotel();
      const b = await hotel();
      await service(a.owner, { name: 'Tenant A service' }).expect(201);
      const svcB = await service(b.owner, { name: 'Tenant B service' }).expect(201);
      const s = await stay(b);
      const reqB = await guestCreate(s, { serviceId: svcB.body.id, paymentMethod: 'FOLIO' }).expect(201);
      await detail(a.owner, reqB.body.request.id).expect(404);
      await request(server()).get(`${API}/concierge/services/${svcB.body.id}`).set(a.owner).expect(404);

      const client = appRoleClient();
      await client.connect();
      try {
        await client.query('BEGIN');
        await setSignedTenant(client, a.h.owner.tenantId);
        for (const table of ['concierge_services', 'concierge_requests', 'concierge_payments', 'concierge_settings', 'concierge_accounts', 'concierge_vendors']) {
          const rows = (await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [b.h.owner.tenantId])).rows[0];
          expect({ table, n: rows.n }).toEqual({ table, n: 0 });
        }
        const own = (await client.query('SELECT count(*)::int AS n FROM concierge_services')).rows[0];
        expect(own.n).toBe(1);
        await client.query('ROLLBACK');
        // No context at all: nothing.
        const none = (await client.query('SELECT count(*)::int AS n FROM concierge_requests')).rows[0];
        expect(none.n).toBe(0);
      } finally {
        await client.end();
      }
    });
  });
});
