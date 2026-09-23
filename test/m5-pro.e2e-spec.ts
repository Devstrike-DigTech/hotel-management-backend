import type { INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import request from 'supertest';
import { CHANNEL_PROVIDER, type MockChannexProvider } from '../src/modules/channels/channel-provider.js';
import { ChannelsService } from '../src/modules/channels/channels.service.js';
import { API, createApp, ownerClient, platformAuth, uniq } from './helpers.js';
import { checkedInStay, guestInput, ID, lagosDay, login, openShift, REGISTRATION, setupHotel, type Auth, type Hotel } from './m2-helpers.js';
import { freshPhone, randomIp } from './m3-helpers.js';

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('M5 Pro tier', () => {
  let app: INestApplication;
  let db: pg.Client;
  let platform: Auth;
  const server = () => app.getHttpServer();
  const as = (auth: Auth, propertyId?: string) => (propertyId ? { ...auth, 'X-Property-Id': propertyId } : auth);

  beforeAll(async () => {
    app = await createApp();
    db = ownerClient();
    await db.connect();
    platform = await platformAuth(app);
  });

  afterAll(async () => {
    await db.end();
    await app.close();
  });

  /** A Growth-trial hotel moved to Pro (ACTIVE), with the owner's approval PIN set. */
  async function proHotel(rooms = 3): Promise<Hotel & { propertyId: string }> {
    const h = await setupHotel(app, rooms);
    await request(server()).patch(`${API}/platform/tenants/${h.owner.tenantId}/subscription`).set(platform).send({ planCode: 'pro', status: 'ACTIVE' }).expect(200);
    await request(server()).put(`${API}/me/approval-pin`).set(h.owner.auth).send({ pin: '2580', currentPassword: 'Passw0rd!x' }).expect(200);
    const p = await request(server()).get(`${API}/property`).set(h.owner.auth).expect(200);
    return { ...h, propertyId: p.body.id as string };
  }

  // ---------------------------------------------------------------------------
  describe('multi-property', () => {
    it('Growth hotels cannot add a property (FEATURE_LOCKED)', async () => {
      const h = await setupHotel(app, 1);
      const res = await request(server()).post(`${API}/properties`).set(h.owner.auth).send({ name: `Annex ${uniq()}`, city: 'Lagos', state: 'Lagos' }).expect(403);
      expect(res.body).toMatchObject({ code: 'FEATURE_LOCKED', details: { feature: 'multi_property' } });
    });

    it('keeps properties apart: data never crosses and staff without access get 403', async () => {
      const h = await proHotel(2);
      const b = await request(server()).post(`${API}/properties`).set(h.owner.auth).send({ name: `Ikoyi Annex ${uniq()}`, city: 'Lagos', state: 'Lagos', area: 'Ikoyi' }).expect(201);
      const B = b.body.id as string;
      expect(b.body.invoicePrefix).toMatch(/^[A-Z0-9]{2,4}$/);
      const type = await request(server()).post(`${API}/room-types`).set(as(h.owner.auth, B)).send({ name: 'Garden Queen', basePriceKobo: 7_000_000, capacity: 2, bedType: 'Queen', sizeSqm: 22 }).expect(201);
      expect(type.body.propertyId).toBe(B);
      await request(server()).post(`${API}/rooms/bulk`).set(as(h.owner.auth, B)).send({ roomTypeId: type.body.id, floor: 1, from: 101, to: 102 }).expect(201);

      // The default property sees only its own rooms and types; B's ids are 404 there.
      const roomsA = await request(server()).get(`${API}/rooms`).set(h.owner.auth).expect(200);
      expect(roomsA.headers['x-property-id']).toBe(h.propertyId);
      expect((roomsA.body as { roomType: { id: string } }[]).every((r) => r.roomType.id === h.typeId)).toBe(true);
      await request(server()).get(`${API}/room-types/${type.body.id}`).set(h.owner.auth).expect(404);
      const roomsB = await request(server()).get(`${API}/rooms`).set(as(h.owner.auth, B)).expect(200);
      expect(roomsB.body).toHaveLength(2);

      // A front-desk user limited to property A.
      const email = `desk-a-${uniq()}@e2e.test`;
      await request(server()).post(`${API}/staff`).set(h.owner.auth).send({ fullName: 'Desk A', email, phone: freshPhone(), role: 'FRONT_DESK', password: 'Passw0rd!x', allProperties: false, propertyIds: [h.propertyId] }).expect(201);
      const deskA = await login(app, email);
      const denied = await request(server()).get(`${API}/rooms`).set(as(deskA, B)).expect(403);
      expect(denied.body).toMatchObject({ code: 'PROPERTY_ACCESS_DENIED', details: { propertyId: B } });
      await request(server()).get(`${API}/rooms`).set(as(deskA, 'not-a-uuid')).expect(403);
      const mine = await request(server()).get(`${API}/properties`).set(deskA).expect(200);
      expect(mine.body.map((p: { id: string }) => p.id)).toEqual([h.propertyId]);
      // Reservations made in B stay in B.
      const r = await request(server()).post(`${API}/reservations`).set(as(h.owner.auth, B)).send({ guest: guestInput(), roomTypeId: type.body.id, arrivalDate: lagosDay(3), departureDate: lagosDay(4) }).expect(201);
      expect(r.body.propertyId).toBe(B);
      await request(server()).get(`${API}/reservations/${r.body.id}`).set(h.owner.auth).expect(404);
      await request(server()).get(`${API}/reservations/${r.body.id}`).set(deskA).expect(404);
    });

    it('enforces max_properties (Pro: 3)', async () => {
      const h = await proHotel(1);
      for (let i = 0; i < 2; i++) await request(server()).post(`${API}/properties`).set(h.owner.auth).send({ name: `Branch ${i} ${uniq()}`, city: 'Abuja', state: 'FCT' }).expect(201);
      const res = await request(server()).post(`${API}/properties`).set(h.owner.auth).send({ name: `Branch 3 ${uniq()}`, city: 'Abuja', state: 'FCT' }).expect(403);
      expect(res.body).toMatchObject({ code: 'LIMIT_REACHED', details: { limit: 'max_properties', max: 3, current: 3 } });
    });
  });

  // ---------------------------------------------------------------------------
  describe('point of sale', () => {
    let h: Hotel & { propertyId: string };
    let outletId: string;
    let itemId: string;
    let drinkId: string;
    let stockId: string;

    beforeAll(async () => {
      h = await proHotel(3);
      const auth = h.owner.auth;
      outletId = (await request(server()).post(`${API}/pos/outlets`).set(auth).send({ name: 'The Yard', code: 'YARD', type: 'RESTAURANT' }).expect(201)).body.id;
      const food = (await request(server()).post(`${API}/pos/categories`).set(auth).send({ name: 'Mains', station: 'KITCHEN' }).expect(201)).body.id;
      const bar = (await request(server()).post(`${API}/pos/categories`).set(auth).send({ name: 'Drinks', station: 'BAR' }).expect(201)).body.id;
      stockId = (await request(server()).post(`${API}/stock/items`).set(auth).send({ name: 'Star lager (60cl)', unit: 'bottle', openingQuantity: 24, unitCostKobo: 85_000 }).expect(201)).body.id;
      itemId = (await request(server()).post(`${API}/pos/items`).set(auth).send({ categoryId: food, name: 'Party jollof rice', priceKobo: 950_000 }).expect(201)).body.id;
      drinkId = (await request(server()).post(`${API}/pos/items`).set(auth).send({ categoryId: bar, name: 'Star lager', priceKobo: 200_000, stockLinks: [{ stockItemId: stockId, quantity: 1 }] }).expect(201)).body.id;
    });

    it('sends to the kitchen and bar, walks the KDS status flow and deducts stock', async () => {
      const o = await request(server()).post(`${API}/pos/orders`).set(h.desk).send({ outletId, tableLabel: 'T4', lines: [{ itemId, quantity: 2 }, { itemId: drinkId, quantity: 3 }], send: true }).expect(201);
      expect(o.body.lines.every((l: { status: string }) => l.status === 'SENT')).toBe(true);
      const tickets = await request(server()).get(`${API}/kds/tickets`).set(h.owner.auth).expect(200);
      const kitchen = tickets.body.find((t: { orderId?: string; station: string; order?: { id: string } }) => t.station === 'KITCHEN');
      expect(kitchen).toMatchObject({ status: 'NEW' });
      expect(tickets.body.some((t: { station: string }) => t.station === 'BAR')).toBe(true);
      await request(server()).post(`${API}/kds/tickets/${kitchen.id}/status`).set(h.owner.auth).send({ status: 'SERVED' }).expect(409);
      await request(server()).post(`${API}/kds/tickets/${kitchen.id}/status`).set(h.owner.auth).send({ status: 'PREPARING' }).expect(200);
      const ready = await request(server()).post(`${API}/kds/tickets/${kitchen.id}/bump`).set(h.owner.auth).send({}).expect(200);
      expect(ready.body.status).toBe('READY');
      const served = await request(server()).post(`${API}/kds/tickets/${kitchen.id}/bump`).set(h.owner.auth).send({}).expect(200);
      expect(served.body.status).toBe('SERVED');
      const stock = await request(server()).get(`${API}/stock/items`).set(h.owner.auth).expect(200);
      expect(Number(stock.body.find((s: { id: string }) => s.id === stockId).onHand)).toBe(21);
    });

    it('cash needs an open shift; with one the order settles with a receipt', async () => {
      const o = await request(server()).post(`${API}/pos/orders`).set(h.desk).send({ outletId, lines: [{ itemId, quantity: 1 }], send: true }).expect(201);
      const due = o.body.totals.totalKobo as number;
      const no = await request(server()).post(`${API}/pos/orders/${o.body.id}/settle`).set(h.desk).send({ payments: [{ method: 'CASH', amountKobo: due }] }).expect(409);
      expect(no.body.code).toBe('SHIFT_REQUIRED');
      await openShift(app, h.desk);
      const bad = await request(server()).post(`${API}/pos/orders/${o.body.id}/settle`).set(h.desk).send({ payments: [{ method: 'CASH', amountKobo: due - 100 }] }).expect(400);
      expect(bad.body.code).toBe('PAYMENT_MISMATCH');
      const ok = await request(server()).post(`${API}/pos/orders/${o.body.id}/settle`).set(h.desk).send({ payments: [{ method: 'CASH', amountKobo: due }] }).expect(200);
      expect(ok.body.order.status).toBe('SETTLED');
      expect(ok.body.receipts).toHaveLength(1);
      expect(ok.body.receipts[0].pos).toMatchObject({ orderNumber: o.body.number });
    });

    it('charges to the room: the guest folio gets the sale; a wrong surname is refused', async () => {
      const stay = await checkedInStay(app, h.desk, h, h.rooms[1]!.id, 2);
      const o = await request(server()).post(`${API}/pos/orders`).set(h.desk).send({ outletId, lines: [{ itemId, quantity: 1 }] }).expect(201);
      const wrong = await request(server()).post(`${API}/pos/orders/${o.body.id}/settle`).set(h.desk).send({ roomCharge: { reservationId: stay.id, guestName: 'Nobody' } }).expect(409);
      expect(wrong.body.code).toBe('ROOM_CHARGE_MISMATCH');
      const surname = (stay.guest.fullName as string).split(' ').pop();
      const ok = await request(server()).post(`${API}/pos/orders/${o.body.id}/settle`).set(h.desk).send({ roomCharge: { reservationId: stay.id, guestName: surname } }).expect(200);
      expect(ok.body.folioId).toBe(stay.folioId);
      const folio = await request(server()).get(`${API}/folios/${stay.folioId}`).set(h.desk).expect(200);
      expect(folio.body.entries.some((e: { type: string; description: string }) => e.type === 'EXTRA' && e.description.includes(o.body.number))).toBe(true);
    });

    it('voiding a line after it was sent raises POS_VOID_AFTER_SEND', async () => {
      const o = await request(server()).post(`${API}/pos/orders`).set(h.desk).send({ outletId, lines: [{ itemId: drinkId, quantity: 2 }], send: true }).expect(201);
      await request(server()).post(`${API}/pos/orders/${o.body.id}/lines/${o.body.lines[0].id}/void`).set(h.manager).send({ reason: 'Guest changed their mind', returnToStock: true }).expect(200);
      const flags = await request(server()).get(`${API}/guard/flags`).query({ rule: 'POS_VOID_AFTER_SEND' }).set(h.owner.auth).expect(200);
      expect(flags.body.items.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('channel manager', () => {
    let h: Hotel & { propertyId: string };
    let ics = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';
    let feedServer: Server;
    let feedUrl: string;

    beforeAll(async () => {
      h = await proHotel(2);
      feedServer = createServer((req, res) => {
        if (req.url === '/redirect.ics') {
          res.writeHead(302, { Location: `http://127.0.0.1:${(feedServer.address() as AddressInfo).port}/airbnb.ics` });
          res.end();
          return;
        }
        if (req.url === '/page.html') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html></html>');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/calendar' });
        res.end(ics);
      });
      await new Promise<void>((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
      feedUrl = `http://localhost:${(feedServer.address() as AddressInfo).port}/airbnb.ics`;
    });

    afterAll(async () => {
      await new Promise((resolve) => feedServer.close(resolve));
    });

    it('iCal: exports booked nights and imports an OTA calendar, cancelling what disappears', async () => {
      const auth = h.owner.auth;
      const conn = await request(server()).post(`${API}/channels/connections`).set(auth).send({ provider: 'ICAL', channel: 'AIRBNB' }).expect(201);
      const r = await request(server()).post(`${API}/reservations`).set(h.desk).send({ guest: guestInput(), roomTypeId: h.typeId, roomId: h.rooms[0]!.id, arrivalDate: lagosDay(5), departureDate: lagosDay(7) }).expect(201);
      expect(r.status).toBe(201);
      const exports = await request(server()).get(`${API}/channels/connections/${conn.body.id}/ical/exports`).set(auth).expect(200);
      const room = exports.body.find((e: { room: { id: string } | null }) => e.room?.id === h.rooms[0]!.id);
      const path = new URL(room.url as string).pathname.replace(/^\/api\/v1/, '');
      const cal = await request(server()).get(`${API}${path}`).expect(200);
      expect(cal.headers['content-type']).toContain('text/calendar');
      expect(cal.text).toContain('BEGIN:VCALENDAR');
      expect(cal.text).toContain(`DTSTART;VALUE=DATE:${lagosDay(5).replace(/-/g, '')}`);

      const start = lagosDay(20).replace(/-/g, '');
      const end = lagosDay(23).replace(/-/g, '');
      ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:abc123-${uniq()}@airbnb.com`, `DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`, 'SUMMARY:Reserved', 'DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABC123\\nPhone Number (Last 4 Digits): 4455', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
      await request(server()).post(`${API}/channels/connections/${conn.body.id}/ical/feeds`).set(auth).send({ roomTypeId: h.typeId, url: feedUrl }).expect(201);
      await request(server()).post(`${API}/channels/connections/${conn.body.id}/sync`).set(auth).send({}).expect(200);
      const list = await request(server()).get(`${API}/reservations`).query({ from: lagosDay(19), to: lagosDay(24) }).set(auth).expect(200);
      const ota = list.body.items.find((x: { source: string; arrivalDate: string }) => x.source === 'OTA' && x.arrivalDate === lagosDay(20));
      expect(ota).toBeDefined();
      const detail = await request(server()).get(`${API}/reservations/${ota.id}`).set(auth).expect(200);
      expect(detail.body.otaChannel).toBe('AIRBNB');

      ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
      await request(server()).post(`${API}/channels/connections/${conn.body.id}/sync`).set(auth).send({}).expect(200);
      const after = await request(server()).get(`${API}/reservations/${ota.id}`).set(auth).expect(200);
      expect(after.body.status).toBe('CANCELLED');
    });

    it('refuses feed URLs that point inside the network, and fetches nothing unsafe (SSRF guard)', async () => {
      const auth = h.owner.auth;
      const conn = await request(server()).post(`${API}/channels/connections`).set(auth).send({ provider: 'ICAL', channel: 'VRBO' }).expect(201);
      const port = (feedServer.address() as AddressInfo).port;
      for (const url of [
        `http://127.0.0.1:${port}/airbnb.ics`,
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/feed.ics',
        'http://[::ffff:10.0.0.1]/feed.ics',
        'http://10.0.0.8/feed.ics',
        'http://100.64.1.1/feed.ics',
        'http://user:secret@localhost/feed.ics',
      ]) {
        const res = await request(server()).post(`${API}/channels/connections/${conn.body.id}/ical/feeds`).set(auth).send({ roomTypeId: h.typeId, url }).expect(400);
        expect([url, res.body.code]).toEqual([url, 'VALIDATION_ERROR']);
      }
      await request(server()).post(`${API}/channels/connections/${conn.body.id}/ical/feeds`).set(auth).send({ roomTypeId: h.typeId, url: 'file:///etc/passwd' }).expect(400);

      // A vetted host that redirects into private space, or serves HTML, imports nothing.
      await request(server()).post(`${API}/channels/connections/${conn.body.id}/ical/feeds`).set(auth).send({ roomTypeId: h.typeId, url: `http://localhost:${port}/redirect.ics` }).expect(201);
      await request(server()).post(`${API}/channels/connections/${conn.body.id}/ical/feeds`).set(auth).send({ roomTypeId: h.typeId, url: `http://localhost:${port}/page.html` }).expect(201);
      await request(server()).post(`${API}/channels/connections/${conn.body.id}/sync`).set(auth).send({}).expect(200);
      const feeds = await request(server()).get(`${API}/channels/connections/${conn.body.id}/ical/feeds`).set(auth).expect(200);
      const errors = feeds.body.map((f: { lastStatus: string; lastError: string | null }) => [f.lastStatus, f.lastError]);
      expect(errors).toEqual(
        expect.arrayContaining([
          ['ERROR', expect.stringContaining('not reachable from the internet')],
          ['ERROR', expect.stringContaining('Unexpected content type text/html')],
        ]),
      );
    });

    it('Channex: signed webhooks only, mapping, debounced diffed pushes and the overbooking flag', async () => {
      const auth = h.owner.auth;
      const raw = JSON.stringify({ event: 'booking', property_id: 'nope', payload: { booking_id: 'b', revision_id: 'r' } });
      await request(server()).post(`${API}/webhooks/channex`).set('Content-Type', 'application/json').set('X-Channex-Signature', 'deadbeef').send(raw).expect(401);
      const sig = createHmac('sha256', process.env.CHANNEX_WEBHOOK_SECRET!).update(raw).digest('hex');
      const ignored = await request(server()).post(`${API}/webhooks/channex`).set('Content-Type', 'application/json').set('X-Channex-Signature', sig).send(raw).expect(200);
      expect(ignored.body).toMatchObject({ received: true, ignored: true });

      const conn = await request(server()).post(`${API}/channels/connections`).set(auth).send({ provider: 'CHANNEX' }).expect(201);
      expect(conn.body.mock).toBe(true);
      const remote = await request(server()).get(`${API}/channels/connections/${conn.body.id}/remote`).set(auth).expect(200);
      const plans = await request(server()).get(`${API}/rate-plans`).set(auth).expect(200);
      const bar = plans.body.find((p: { isBar: boolean }) => p.isBar);
      await request(server())
        .put(`${API}/channels/connections/${conn.body.id}/mappings`)
        .set(auth)
        .send({ mappings: [{ roomTypeId: h.typeId, ratePlanId: bar.id, externalRoomTypeId: remote.body.roomTypes[0].id, externalRatePlanId: remote.body.ratePlans[0].id }] })
        .expect(200);

      // Debounce: nothing is pushed until the connection has been quiet for 30 s.
      const channels = app.get(ChannelsService);
      const mock = app.get<MockChannexProvider>(CHANNEL_PROVIDER);
      const before = mock.pushCount(conn.body.id);
      await channels.flushDirty(30_000);
      expect(mock.pushCount(conn.body.id)).toBe(before);
      await channels.flushDirty(0);
      const first = mock.pushCount(conn.body.id);
      expect(first).toBeGreaterThan(before);
      // Nothing changed: a sweep pushes nothing new.
      await channels.pushAri(h.owner.tenantId, conn.body.id);
      expect(mock.pushCount(conn.body.id)).toBe(first);

      // Two rooms: the third OTA booking for the same night is overbooked.
      const night = lagosDay(30);
      let last: request.Response | null = null;
      for (let i = 0; i < 3; i++) {
        last = await request(server()).post(`${API}/channels/dev/channex/bookings`).set(auth).send({ connectionId: conn.body.id, roomTypeId: h.typeId, checkIn: night, checkOut: addDays(night, 1), guestName: `Guest ${i} Okoro` }).expect(200);
        expect(last.body.webhook.status).toBe(200);
      }
      const flags = await request(server()).get(`${API}/guard/flags`).query({ rule: 'OVERBOOKED' }).set(auth).expect(200);
      expect(flags.body.items).toHaveLength(1);
      const bookings = await request(server()).get(`${API}/channels/bookings`).set(auth).expect(200);
      expect(bookings.body.items.filter((b: { overbooked: boolean }) => b.overbooked)).toHaveLength(1);
      // A cancellation through the webhook cancels the reservation.
      await request(server()).post(`${API}/channels/dev/channex/bookings`).set(auth).send({ connectionId: conn.body.id, roomTypeId: h.typeId, checkIn: night, checkOut: addDays(night, 1), cancelExternalId: last!.body.externalId }).expect(200);
      const after = await request(server()).get(`${API}/channels/bookings`).query({ status: 'CANCELLED' }).set(auth).expect(200);
      expect(after.body.items.filter((b: { provider: string }) => b.provider === 'CHANNEX')).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('dynamic pricing', () => {
    it('autopilot applies within guardrails, logs every change and never touches manual overrides', async () => {
      const h = await proHotel(2);
      const auth = h.owner.auth;
      // Both rooms sold tomorrow: forecast 100% one day out.
      for (const room of h.rooms) {
        await request(server()).post(`${API}/reservations`).set(h.desk).send({ guest: guestInput(), roomTypeId: h.typeId, roomId: room.id, arrivalDate: lagosDay(1), departureDate: lagosDay(2) }).expect(201);
      }
      await request(server()).put(`${API}/pricing/guardrails/${h.typeId}`).set(auth).send({ floorKobo: 4_000_000, ceilingKobo: 5_500_000, maxDailyChangeBps: 1500 }).expect(200);
      const bad = await request(server()).put(`${API}/pricing/guardrails/${h.typeId}`).set(auth).send({ floorKobo: 6_000_000, ceilingKobo: 5_000_000 }).expect(400);
      expect(bad.body.code).toBe('VALIDATION_ERROR');
      const preview = await request(server()).get(`${API}/pricing/preview`).query({ roomTypeId: h.typeId, date: lagosDay(1) }).set(auth).expect(200);
      expect(preview.body.suggestedKobo).toBe(5_500_000);
      expect(preview.body.reason).toContain('100% booked 1 day out');
      expect(preview.body.factors.map((f: { code: string }) => f.code)).toContain('GUARDRAIL');

      // A manual override on a later night blocks the engine there.
      await request(server()).put(`${API}/rate-overrides`).set(auth).send({ roomTypeIds: [h.typeId], from: lagosDay(3), to: lagosDay(3), rateKobo: 9_000_000 }).expect(200);
      const blocked = await request(server()).get(`${API}/pricing/preview`).query({ roomTypeId: h.typeId, date: lagosDay(3) }).set(auth).expect(200);
      expect(blocked.body.blockedBy).toBe('MANUAL_OVERRIDE');

      await request(server()).put(`${API}/pricing/settings`).set(auth).send({ mode: 'AUTOPILOT', horizonDays: 14 }).expect(200);
      const run = await request(server()).post(`${API}/pricing/run`).set(auth).send({ from: lagosDay(1), to: lagosDay(5) }).expect(200);
      expect(run.body.applied).toBeGreaterThan(0);
      const changes = await request(server()).get(`${API}/pricing/changes`).query({ source: 'AUTOPILOT' }).set(auth).expect(200);
      const tomorrow = changes.body.items.find((c: { date: string }) => c.date === lagosDay(1));
      expect(tomorrow).toMatchObject({ fromKobo: 5_000_000, toKobo: 5_500_000, source: 'AUTOPILOT' });
      expect(changes.body.items.some((c: { date: string }) => c.date === lagosDay(3))).toBe(false);
      const cal = await request(server()).get(`${API}/rates/calendar`).query({ from: lagosDay(1), to: lagosDay(3) }).set(auth).expect(200);
      const days = cal.body.roomTypes[0].days as { date: string; rateKobo: number; overrideSource: string | null }[];
      expect(days[0]).toMatchObject({ rateKobo: 5_500_000, overrideSource: 'PRICING' });
      expect(days[2]).toMatchObject({ rateKobo: 9_000_000, overrideSource: 'MANUAL' });
      const audit = await request(server()).get(`${API}/audit-logs`).query({ action: 'pricing.autopilot' }).set(auth).expect(200);
      expect(audit.body.items.length).toBeGreaterThan(0);

      // Revert restores the previous price.
      const reverted = await request(server()).post(`${API}/pricing/changes/${tomorrow.id}/revert`).set(auth).expect(200);
      expect(reverted.body).toMatchObject({ source: 'REVERT', toKobo: 5_000_000 });
    });
  });

  // ---------------------------------------------------------------------------
  describe('guest WhatsApp inbox', () => {
    it('threads inbound messages, suggests tasks and enforces the 24-hour window', async () => {
      const h = await proHotel(2);
      const stay = await checkedInStay(app, h.desk, h, h.rooms[0]!.id, 2);
      const phone = stay.guest.phone as string;
      const inbound = await request(server()).post(`${API}/inbox/dev/inbound`).set(h.owner.auth).send({ phone, body: 'Hello, please bring two towels, and the AC is not cooling' }).expect(200);
      expect(inbound.body.routed).toBe(true);
      const again = await request(server()).post(`${API}/inbox/dev/inbound`).set(h.owner.auth).send({ phone, body: 'Thanks' }).expect(200);
      expect(again.body.conversationId).toBe(inbound.body.conversationId);
      const conv = await request(server()).get(`${API}/inbox/conversations/${inbound.body.conversationId}`).set(h.desk).expect(200);
      expect(conv.body).toMatchObject({ status: 'OPEN', unreadCount: 2, window: { open: true }, reservation: { id: stay.id } });
      expect(conv.body.suggestions.map((s: { kind: string }) => s.kind).sort()).toEqual(['HOUSEKEEPING', 'MAINTENANCE']);

      const reply = await request(server()).post(`${API}/inbox/conversations/${conv.body.id}/messages`).set(h.desk).send({ body: 'On the way.' }).expect(201);
      expect(reply.body).toMatchObject({ direction: 'OUTBOUND', status: 'OUTBOX' });
      const hk = conv.body.suggestions.find((s: { kind: string }) => s.kind === 'HOUSEKEEPING');
      const accepted = await request(server()).post(`${API}/inbox/suggestions/${hk.id}/accept`).set(h.desk).send({}).expect(200);
      expect(accepted.body.housekeepingTaskId).toEqual(expect.any(String));

      // Outside the window only templates go out.
      await db.query(`UPDATE conversations SET last_inbound_at = now() - interval '25 hours' WHERE id = $1`, [conv.body.id]);
      const closed = await request(server()).post(`${API}/inbox/conversations/${conv.body.id}/messages`).set(h.desk).send({ body: 'Hello again' }).expect(409);
      expect(closed.body.code).toBe('WHATSAPP_WINDOW_CLOSED');
      await request(server()).post(`${API}/inbox/conversations/${conv.body.id}/template`).set(h.desk).send({ name: 'guest_message', params: ['Ada', 'Test Hotel', 'Your taxi is here.'] }).expect(201);

      const unknown = await request(server()).post(`${API}/inbox/dev/inbound`).set(h.owner.auth).send({ phone: freshPhone(), body: 'hi' }).expect(200);
      expect(unknown.body).toEqual({ conversationId: null, routed: false });
    });
  });

  // ---------------------------------------------------------------------------
  describe('loyalty', () => {
    it('earns at check-out, moves up a tier, redeems with the guest code or a PIN, returns voided points and expires lots', async () => {
      const h = await proHotel(2);
      const auth = h.owner.auth;
      await request(server()).put(`${API}/loyalty/programme`).set(auth).send({ enabled: true, name: 'Palmwine Circle', memberNoPrefix: 'PWC' }).expect(200);
      await request(server()).post(`${API}/loyalty/tiers`).set(auth).send({ name: 'Member', minNights: 0 }).expect(201);
      await request(server()).post(`${API}/loyalty/tiers`).set(auth).send({ name: 'Silver', minNights: 2, bonusBps: 1000 }).expect(201);

      // Enrol at check-in, stay two nights (charges posted), pay and check out.
      const r = await request(server()).post(`${API}/reservations`).set(h.desk).send({ guest: guestInput(), roomTypeId: h.typeId, roomId: h.rooms[0]!.id, arrivalDate: lagosDay(0), departureDate: lagosDay(2) }).expect(201);
      const ci = await request(server()).post(`${API}/reservations/${r.body.id}/check-in`).set(h.desk).send({ guest: ID, registration: REGISTRATION, enrolLoyalty: true }).expect(200);
      expect(ci.body.loyalty).toMatchObject({ memberNo: 'PWC-000001', pointsEarned: null });
      await request(server()).post(`${API}/folios/${ci.body.folioId}/charges`).set(h.desk).send({ type: 'EXTRA', description: 'Dinner at The Yard', amountKobo: 2_000_000 }).expect(200);
      const member = await request(server()).get(`${API}/loyalty/members/by-guest/${ci.body.guest.id}`).set(h.desk).expect(200);

      // Desk redemption with the guest's code (dev outbox) then void it.
      const start = await request(server()).post(`${API}/loyalty/members/${member.body.id}/adjust`).set(auth).send({ points: 6000, reason: 'Goodwill for a noisy room' }).expect(200);
      expect(start.body.points).toBe(6000);
      const flags = await request(server()).get(`${API}/guard/flags`).query({ rule: 'LOYALTY_ADJUSTMENT' }).set(auth).expect(200);
      expect(flags.body.items).toHaveLength(1);
      const ch = await request(server()).post(`${API}/loyalty/members/${member.body.id}/redeem/start`).set(h.owner.auth).send({ folioId: ci.body.folioId, points: 1000 }).expect(200);
      const bad = await request(server()).post(`${API}/loyalty/redeem`).set(auth).send({ challengeId: ch.body.challengeId, code: '000000' }).expect(400);
      expect(bad.body).toMatchObject({ code: 'LOYALTY_CODE_INVALID', details: { attemptsLeft: 4 } });
      const out = await request(server()).get(`${API}/public/dev/outbox`).query({ limit: 20 }).expect(200);
      const code = (out.body.items as { meta: { otpCode?: string; challengeId?: string } }[]).find((m) => m.meta.challengeId === ch.body.challengeId)?.meta.otpCode;
      expect(code).toMatch(/^\d{6}$/);
      const redeemed = await request(server()).post(`${API}/loyalty/redeem`).set(auth).send({ challengeId: ch.body.challengeId, code }).expect(200);
      expect(redeemed.body.member.points).toBe(5000);
      const line = redeemed.body.folio.entries.find((e: { type: string; description: string }) => e.type === 'DISCOUNT' && e.description.startsWith('Palmwine Circle'));
      expect(line.amountKobo).toBe(-100_000);
      await request(server()).post(`${API}/loyalty/redeem`).set(auth).send({ challengeId: ch.body.challengeId, code }).expect(410);
      await request(server()).post(`${API}/folios/${ci.body.folioId}/entries/${line.id}/void`).set(h.manager).send({ reason: 'Guest will redeem next time' }).expect(200);
      expect((await request(server()).get(`${API}/loyalty/members/${member.body.id}`).set(auth).expect(200)).body.points).toBe(6000);
      // With a manager PIN instead of the code.
      const pin = await request(server()).post(`${API}/loyalty/redeem`).set(h.desk).send({ memberId: member.body.id, folioId: ci.body.folioId, points: 2000, approval: { approverId: h.owner.userId, pin: '2580' } }).expect(200);
      expect(pin.body.transaction).toMatchObject({ type: 'REDEEM', points: -2000, approvedBy: { id: h.owner.userId } });
      const tooMuch = await request(server()).post(`${API}/loyalty/redeem`).set(h.desk).send({ memberId: member.body.id, folioId: ci.body.folioId, points: 500, approval: { approverId: h.owner.userId, pin: '2580' } }).expect(400);
      expect(tooMuch.body.code).toBe('LOYALTY_REDEMPTION_LIMIT');

      // Check out: points on pre-tax spend net of discounts, tier from nights.
      await db.query(`UPDATE reservations SET arrival_at = arrival_at - interval '2 days', departure_at = now() + interval '1 hour' WHERE id = $1`, [r.body.id]);
      await openShift(app, h.desk);
      const folio = await request(server()).get(`${API}/folios/${ci.body.folioId}`).set(h.desk).expect(200);
      await request(server()).post(`${API}/folios/${ci.body.folioId}/payments`).set(h.desk).send({ method: 'CASH', amountKobo: folio.body.balanceKobo ?? folio.body.totals.balanceKobo }).expect(201);
      const co = await request(server()).post(`${API}/reservations/${r.body.id}/check-out`).set(h.desk).send({}).expect(200);
      expect(co.body.reservation.loyalty.pointsEarned).toBeGreaterThan(0);
      const after = await request(server()).get(`${API}/loyalty/members/${member.body.id}`).set(auth).expect(200);
      expect(after.body.tier.name).toBe('Silver');
      expect(after.body.statement.map((t: { type: string }) => t.type)).toContain('EARN');

      // Expiry: an overdue lot expires (EXPIRE transaction).
      await db.query(`UPDATE loyalty_transactions SET expires_at = now() - interval '1 day' WHERE member_id = $1 AND type = 'ADJUST'`, [member.body.id]);
      const exp = await request(server()).post(`${API}/loyalty/jobs/expiry/run`).set(auth).expect(200);
      expect(exp.body.expiredLots).toBe(1);
      const final = await request(server()).get(`${API}/loyalty/members/${member.body.id}`).set(auth).expect(200);
      expect(final.body.statement[0].type).toBe('EXPIRE');
      expect(final.body.points).toBe(after.body.points + final.body.statement[0].points);
    });
  });

  // ---------------------------------------------------------------------------
  describe('custom domains', () => {
    it('verifies with the mock DNS and resolves the host only once verified', async () => {
      const h = await proHotel(1);
      const auth = h.owner.auth;
      const apex = await request(server()).post(`${API}/domains`).set(auth).send({ domain: 'myhotel.com.ng' }).expect(400);
      expect(apex.body.code).toBe('DOMAIN_APEX_NOT_SUPPORTED');
      const host = `book.hotel-${uniq()}.ng`;
      const d = await request(server()).post(`${API}/domains`).set(auth).send({ domain: `https://${host.toUpperCase()}/` }).expect(201);
      expect(d.body).toMatchObject({ domain: host, status: 'PENDING' });
      const pending = await request(server()).post(`${API}/domains/${d.body.id}/verify`).set(auth).expect(200);
      expect(pending.body.failures).toEqual(['TXT_MISSING', 'CNAME_MISSING']);
      await request(server()).get(`${API}/public/resolve-host`).query({ host }).expect(404);
      await request(server()).post(`${API}/domains/${d.body.id}/dev/publish`).set(auth).expect(200);
      const ok = await request(server()).post(`${API}/domains/${d.body.id}/verify`).set(auth).expect(200);
      expect(ok.body.status).toBe('VERIFIED');
      const resolved = await request(server()).get(`${API}/public/resolve-host`).query({ host }).expect(200);
      expect(resolved.body).toMatchObject({ kind: 'PROPERTY', canonicalHost: host });
      const other = await proHotel(1);
      const taken = await request(server()).post(`${API}/domains`).set(other.owner.auth).send({ domain: host }).expect(409);
      expect(taken.body.code).toBe('DOMAIN_TAKEN');
      await request(server()).delete(`${API}/domains/${d.body.id}`).set(auth).expect(200);
      await request(server()).get(`${API}/public/resolve-host`).query({ host }).expect(404);
    });
  });

  it('M5 features are locked on Growth', async () => {
    const h = await setupHotel(app, 1);
    for (const path of ['/pos/outlets', '/channels/connections', '/pricing/settings', '/inbox/conversations', '/loyalty/programme', '/domains']) {
      const res = await request(server()).get(`${API}${path}`).set(h.owner.auth).set('X-Forwarded-For', randomIp()).expect(403);
      expect(res.body.code).toBe('FEATURE_LOCKED');
    }
  });
});
