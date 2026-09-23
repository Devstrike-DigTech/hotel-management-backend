import type { INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { API, createApp, ownerClient, uniq } from './helpers.js';
import { checkedInStay, guestInput, ID, lagosDay, login, REGISTRATION, setupHotel, type Auth, type Hotel } from './m2-helpers.js';
import { freshPhone, onlineHotel, randomIp, startPaystackStub, stopStub, type OnlineHotel, type PaystackStub } from './m3-helpers.js';

/** Day of the week (0 = Sunday) of a YYYY-MM-DD date. */
const dow = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
/** The first date >= lagosDay(from) that falls on `day`. */
function nextDow(day: number, from = 3): string {
  for (let i = from; i < from + 7; i++) if (dow(lagosDay(i)) === day) return lagosDay(i);
  throw new Error('unreachable');
}
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('M4 Growth tier', () => {
  let app: INestApplication;
  let db: pg.Client;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createApp();
    db = ownerClient();
    await db.connect();
  });

  afterAll(async () => {
    await db.end();
    await app.close();
  });

  async function staff(owner: Auth, body: { role?: string; roleId?: string }, as: Auth = owner) {
    const email = `staff-${uniq()}@e2e.test`;
    const res = await request(server())
      .post(`${API}/staff`)
      .set(as)
      .send({ fullName: `Staff ${uniq()}`, email, phone: freshPhone(), password: 'Passw0rd!x', ...body });
    return { res, email, auth: res.status === 201 ? await login(app, email) : null, id: res.body.id as string };
  }

  // ---------------------------------------------------------------------------
  describe('rate resolution', () => {
    let h: Hotel;
    beforeAll(async () => {
      h = await setupHotel(app, 3);
    });

    it('prices each night: overrides beat rules, higher priority wins, days of the week apply', async () => {
      const fri = nextDow(5);
      const sun = addDays(fri, 2);
      const auth = h.owner.auth;
      await request(server()).post(`${API}/rate-rules`).set(auth).send({ name: 'Weekend +10%', dateFrom: lagosDay(0), dateTo: lagosDay(60), daysOfWeek: [5, 6], adjustment: { type: 'PERCENT', value: 1_000 }, priority: 10 }).expect(201);
      // A higher-priority rule on the Saturday only.
      await request(server()).post(`${API}/rate-rules`).set(auth).send({ name: 'Festival +50%', dateFrom: addDays(fri, 1), dateTo: addDays(fri, 1), adjustment: { type: 'PERCENT', value: 5_000 }, priority: 20 }).expect(201);
      // A lower-priority rule that loses everywhere it overlaps.
      await request(server()).post(`${API}/rate-rules`).set(auth).send({ name: 'Low season -20%', dateFrom: lagosDay(0), dateTo: lagosDay(60), adjustment: { type: 'PERCENT', value: -2_000 }, priority: 1 }).expect(201);
      await request(server()).put(`${API}/rate-overrides`).set(auth).send({ roomTypeIds: [h.typeId], from: addDays(fri, 3), to: addDays(fri, 3), rateKobo: 7_777_700, note: 'Conference' }).expect(200);

      const q = await request(server()).post(`${API}/rates/quote`).set(h.desk).send({ roomTypeId: h.typeId, arrivalDate: addDays(fri, -1), departureDate: addDays(fri, 4) }).expect(200);
      expect(q.body.nights.map((n: { date: string; rateKobo: number; source: string; ruleName: string | null }) => [n.date, n.rateKobo, n.source, n.ruleName])).toEqual([
        [addDays(fri, -1), 4_000_000, 'RULE', 'Low season -20%'],
        [fri, 5_500_000, 'RULE', 'Weekend +10%'],
        [addDays(fri, 1), 7_500_000, 'RULE', 'Festival +50%'],
        [sun, 4_000_000, 'RULE', 'Low season -20%'],
        [addDays(fri, 3), 7_777_700, 'OVERRIDE', null],
      ]);
      expect(q.body.roomTotalKobo).toBe(4_000_000 + 5_500_000 + 7_500_000 + 4_000_000 + 7_777_700);
      expect(q.body.breakdown.totalKobo).toBeGreaterThan(q.body.roomTotalKobo);
    });

    it('snapshots per-night prices at booking; later rule changes do not reprice the stay', async () => {
      const fri = nextDow(5, 10);
      const res = await request(server())
        .post(`${API}/reservations`)
        .set(h.desk)
        .send({ guest: guestInput(), roomTypeId: h.typeId, arrivalDate: fri, departureDate: addDays(fri, 2) })
        .expect(201);
      const before = (await request(server()).get(`${API}/reservations/${res.body.id}`).set(h.desk).expect(200)).body;
      expect(before.nightlyRates.map((n: { rateKobo: number }) => n.rateKobo)).toEqual([5_500_000, 5_500_000]);
      const rules = (await request(server()).get(`${API}/rate-rules`).set(h.owner.auth).expect(200)).body as { id: string; name: string }[];
      const weekend = rules.find((r) => r.name === 'Weekend +10%')!;
      await request(server()).patch(`${API}/rate-rules/${weekend.id}`).set(h.owner.auth).send({ adjustment: { type: 'PERCENT', value: 3_000 } }).expect(200);
      const after = (await request(server()).get(`${API}/reservations/${res.body.id}`).set(h.desk).expect(200)).body;
      expect(after.nightlyRates).toEqual(before.nightlyRates);
      // A new quote sees the new rule.
      const q = await request(server()).post(`${API}/rates/quote`).set(h.desk).send({ roomTypeId: h.typeId, arrivalDate: fri, departureDate: addDays(fri, 1) }).expect(200);
      expect(q.body.nights[0].rateKobo).toBe(6_500_000);
    });

    it('rate plans expose structured terms (no label parsing)', async () => {
      const nrf = await request(server())
        .post(`${API}/rate-plans`)
        .set(h.owner.auth)
        .send({ code: 'NRF', name: 'Non-refundable', kind: 'NON_REFUNDABLE', pricing: 'DERIVED', adjustment: { type: 'PERCENT', value: -1_000 }, cancellationPolicy: { nonRefundable: true, freeCancellationHours: 0, lateCancellationFeePct: 100 } })
        .expect(201);
      expect(nrf.body).toMatchObject({ discountPct: 10, surchargePct: null, negotiated: false, nonRefundable: true, refundable: false, label: '-10%, Non-refundable' });
      const plans = (await request(server()).get(`${API}/rate-plans`).set(h.desk).expect(200)).body as { code: string; isBar: boolean; discountPct: number | null; refundable: boolean }[];
      expect(plans[0]).toMatchObject({ code: 'BAR', isBar: true, discountPct: null, refundable: true });
      const slug = (await request(server()).get(`${API}/property`).set(h.owner.auth).expect(200)).body.slug as string;
      const pub = await request(server()).get(`${API}/public/hotels/${slug}`).set('X-Forwarded-For', randomIp()).expect(200);
      const rt = pub.body.roomTypes.find((t: { id: string }) => t.id === h.typeId);
      expect(rt.ratePlans.find((p: { code: string }) => p.code === 'NRF')).toMatchObject({ discountPct: 10, nonRefundable: true, refundable: false, pricing: 'DERIVED', adjustment: { type: 'PERCENT', value: -1_000 } });
    });

    it('only staff with rates.manage can set a custom price', async () => {
      const body = { guest: guestInput(), roomTypeId: h.typeId, arrivalDate: lagosDay(20), departureDate: lagosDay(21), rateKobo: 1_000_000 };
      const denied = await request(server()).post(`${API}/reservations`).set(h.desk).send(body).expect(403);
      expect(denied.body).toMatchObject({ code: 'FORBIDDEN', details: { permission: 'rates.manage' } });
      await request(server()).post(`${API}/reservations`).set(h.manager).send(body).expect(201);
    });

    it('the night audit posts each night at its own snapshot rate', async () => {
      const T = lagosDay(0);
      const nightly = [
        { date: T, rateKobo: 5_000_000 },
        { date: addDays(T, 1), rateKobo: 6_200_000 },
        { date: addDays(T, 2), rateKobo: 5_500_000 },
      ];
      const res = await request(server())
        .post(`${API}/reservations`)
        .set(h.owner.auth)
        .send({ guest: guestInput(), roomTypeId: h.typeId, roomId: h.rooms[2].id, arrivalDate: T, departureDate: addDays(T, 3), nightlyRates: nightly })
        .expect(201);
      await request(server()).post(`${API}/reservations/${res.body.id}/check-in`).set(h.desk).send({ guest: ID, registration: REGISTRATION }).expect(200);
      // Move the stay two days into the past (as if checked in two days ago), keeping the per-night prices.
      const shifted = nightly.map((n, i) => ({ date: addDays(T, i - 2), rateKobo: n.rateKobo, baseRateKobo: n.rateKobo, source: 'MANUAL', ruleId: null, ruleName: null, discountKobo: 0 }));
      await db.query(
        `UPDATE reservations SET arrival_at = arrival_at - interval '2 days', departure_at = departure_at - interval '2 days',
                checked_in_at = checked_in_at - interval '2 days', nightly_rates = $2::jsonb WHERE id = $1`,
        [res.body.id, JSON.stringify(shifted)],
      );
      await request(server()).post(`${API}/night-audit/run`).set(h.owner.auth).send({ businessDate: addDays(T, -2) }).expect(200);
      await request(server()).post(`${API}/night-audit/run`).set(h.owner.auth).send({ businessDate: addDays(T, -1) }).expect(200);
      const folio = (await request(server()).get(`${API}/reservations/${res.body.id}/folio`).set(h.owner.auth).expect(200)).body;
      const rooms = (folio.entries as { type: string; businessDate: string; amountKobo: number }[]).filter((e) => e.type === 'ROOM');
      const byDate = new Map(rooms.map((e) => [e.businessDate, e.amountKobo]));
      expect(byDate.get(addDays(T, -2))).toBe(5_000_000);
      expect(byDate.get(addDays(T, -1))).toBe(6_200_000);
    });
  });

  // ---------------------------------------------------------------------------
  describe('promo codes', () => {
    let h: OnlineHotel;
    let stub: PaystackStub;
    const checkIn = lagosDay(30);
    const quote = (body: Record<string, unknown>) =>
      request(server())
        .post(`${API}/public/quotes`)
        .set('X-Forwarded-For', randomIp())
        .send({ hotelSlug: h.slug, roomTypeId: h.typeId, channel: 'MARKETPLACE', checkIn, checkOut: addDays(checkIn, 2), adults: 2, ...body });

    afterAll(() => stopStub(stub));
    beforeAll(async () => {
      stub = await startPaystackStub();
      h = await onlineHotel(app, 3);
      const mk = (body: Record<string, unknown>) => request(server()).post(`${API}/promo-codes`).set(h.owner.auth).send(body).expect(201);
      await mk({ code: 'SAVE10', type: 'PERCENT', value: 1_000 });
      await mk({ code: 'LONG4', type: 'FREE_NIGHT', value: 4 });
      await mk({ code: 'ONCE', type: 'AMOUNT', value: 1_000_000, maxUses: 1 });
      await mk({ code: 'OLD', type: 'PERCENT', value: 1_500, validFrom: lagosDay(-40), validTo: lagosDay(-1) });
      await mk({ code: 'DESKONLY', type: 'PERCENT', value: 1_000, channels: ['FRONT_DESK'] });
    });

    it('applies a percent code to every night on the net price', async () => {
      const q = await quote({ promoCode: 'save10' }).expect(200);
      expect(q.body.breakdown).toMatchObject({ roomSubtotalKobo: 10_000_000, discountKobo: 1_000_000, promo: { code: 'SAVE10', discountKobo: 1_000_000 } });
      // VAT on the discounted room price: (100,000 - 10,000) x 7.5%.
      expect(q.body.breakdown.totalKobo).toBe(9_675_000);
    });

    it('rejects codes by stay length, dates and channel with guest-readable messages', async () => {
      const short = await quote({ promoCode: 'LONG4' }).expect(400);
      expect(short.body).toMatchObject({ code: 'PROMO_INVALID', details: { reason: 'MIN_NIGHTS' } });
      expect(short.body.message).toBe('LONG4 needs at least 4 nights');
      expect((await quote({ promoCode: 'OLD' }).expect(400)).body.details.reason).toBe('EXPIRED');
      expect((await quote({ promoCode: 'DESKONLY' }).expect(400)).body.details.reason).toBe('CHANNEL');
      expect((await quote({ promoCode: 'NOPE' }).expect(400)).body.details.reason).toBe('NOT_FOUND');
      const long = await quote({ promoCode: 'LONG4', checkOut: addDays(checkIn, 4) }).expect(200);
      expect(long.body.breakdown.discountKobo).toBe(5_000_000);
    });

    it('counts a use on booking, refuses it when used up and gives it back on cancellation', async () => {
      const q1 = await quote({ promoCode: 'ONCE' }).expect(200);
      const b1 = await request(server())
        .post(`${API}/public/bookings`)
        .set('X-Forwarded-For', randomIp())
        .send({ quoteToken: q1.body.quoteToken, paymentMode: 'PAY_AT_HOTEL', guest: { fullName: 'Amaka Test', phone: freshPhone(), email: `g-${uniq()}@e2e.test` }, consent: true })
        .expect(201);
      const list = (await request(server()).get(`${API}/promo-codes`).set(h.owner.auth).expect(200)).body as { code: string; uses: number; status: string }[];
      expect(list.find((p) => p.code === 'ONCE')).toMatchObject({ uses: 1, status: 'USED_UP' });
      expect((await quote({ promoCode: 'ONCE' }).expect(400)).body.details.reason).toBe('USED_UP');

      const r = await db.query(`SELECT id FROM reservations WHERE code = $1`, [b1.body.booking.code]);
      await request(server()).post(`${API}/reservations/${r.rows[0].id}/cancel`).set(h.owner.auth).send({ reason: 'Guest changed plans' }).expect(200);
      const again = (await request(server()).get(`${API}/promo-codes`).set(h.owner.auth).expect(200)).body as { code: string; uses: number; status: string }[];
      expect(again.find((p) => p.code === 'ONCE')).toMatchObject({ uses: 0, status: 'ACTIVE' });
      await quote({ promoCode: 'ONCE' }).expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('room blocks and availability', () => {
    let h: Hotel;
    beforeAll(async () => {
      h = await setupHotel(app, 2);
    });

    it('takes a blocked room out of availability, bookings and quotes', async () => {
      const from = lagosDay(5);
      const block = await request(server())
        .post(`${API}/room-blocks`)
        .set(h.owner.auth)
        .send({ roomId: h.rooms[0].id, from: `${from}T12:00:00+01:00`, to: `${addDays(from, 2)}T12:00:00+01:00`, reason: 'AC compressor replacement' })
        .expect(201);
      expect(block.body).toMatchObject({ room: { id: h.rooms[0].id }, active: false });

      const grid = await request(server()).get(`${API}/availability`).query({ from: addDays(from, -1), to: addDays(from, 2) }).set(h.desk).expect(200);
      const days = grid.body.roomTypes.find((t: { roomType: { id: string } }) => t.roomType.id === h.typeId).days as { date: string; blocked: number; available: number }[];
      expect(days.map((d) => [d.date, d.blocked, d.available])).toEqual([
        [addDays(from, -1), 0, 2],
        [from, 1, 1],
        [addDays(from, 1), 1, 1],
        [addDays(from, 2), 0, 2],
      ]);

      // Booking the blocked room itself is refused.
      const refused = await request(server())
        .post(`${API}/reservations`)
        .set(h.desk)
        .send({ guest: guestInput(), roomTypeId: h.typeId, roomId: h.rooms[0].id, arrivalDate: addDays(from, 1), departureDate: addDays(from, 2) })
        .expect(409);
      expect(refused.body).toMatchObject({ code: 'ROOM_UNAVAILABLE', details: { reason: 'BLOCKED' } });

      // With the other room taken, the type is sold out for those nights.
      await request(server())
        .post(`${API}/reservations`)
        .set(h.desk)
        .send({ guest: guestInput(), roomTypeId: h.typeId, roomId: h.rooms[1].id, arrivalDate: from, departureDate: addDays(from, 2) })
        .expect(201);
      const full = await request(server())
        .post(`${API}/reservations`)
        .set(h.desk)
        .send({ guest: guestInput(), roomTypeId: h.typeId, arrivalDate: addDays(from, 1), departureDate: addDays(from, 2) })
        .expect(409);
      expect(full.body.code).toBe('ROOM_UNAVAILABLE');
      const q = await request(server()).post(`${API}/rates/quote`).set(h.desk).send({ roomTypeId: h.typeId, arrivalDate: from, departureDate: addDays(from, 1) }).expect(200);
      expect(q.body.available).toBe(0);
    });

    it('refuses a block over an assigned stay unless forced', async () => {
      const from = lagosDay(15);
      const stay = await request(server())
        .post(`${API}/reservations`)
        .set(h.desk)
        .send({ guest: guestInput(), roomTypeId: h.typeId, roomId: h.rooms[0].id, arrivalDate: from, departureDate: addDays(from, 1) })
        .expect(201);
      const body = { roomId: h.rooms[0].id, from: `${from}T00:00:00+01:00`, to: `${addDays(from, 3)}T00:00:00+01:00`, reason: 'Repainting' };
      const conflict = await request(server()).post(`${API}/room-blocks`).set(h.owner.auth).send(body).expect(409);
      expect(conflict.body.code).toBe('BLOCK_CONFLICT');
      const forced = await request(server()).post(`${API}/room-blocks`).set(h.owner.auth).send({ ...body, force: true }).expect(201);
      expect(forced.body.displaced.map((d: { reservationId: string }) => d.reservationId)).toContain(stay.body.id);
      const moved = (await request(server()).get(`${API}/reservations/${stay.body.id}`).set(h.desk).expect(200)).body;
      expect(moved.room).toBeNull();
    });

    it('front desk cannot create blocks', async () => {
      const res = await request(server())
        .post(`${API}/room-blocks`)
        .set(h.desk)
        .send({ roomId: h.rooms[1].id, from: `${lagosDay(40)}T00:00:00+01:00`, to: `${lagosDay(41)}T00:00:00+01:00`, reason: 'x' })
        .expect(403);
      expect(res.body.details).toEqual({ permission: 'maintenance.manage' });
    });
  });

  // ---------------------------------------------------------------------------
  describe('permissions and custom roles', () => {
    let h: Hotel;
    beforeAll(async () => {
      h = await setupHotel(app, 1);
    });

    it('/me lists the effective permissions', async () => {
      const me = await request(server()).get(`${API}/me`).set(h.desk).expect(200);
      expect(me.body.permissions).toContain('frontdesk.checkin');
      expect(me.body.permissions).not.toContain('folio.void');
      expect(me.body.user).toMatchObject({ role: 'FRONT_DESK', roleId: 'FRONT_DESK', roleName: 'Front desk' });
      const owner = await request(server()).get(`${API}/me`).set(h.owner.auth).expect(200);
      expect(owner.body.permissions).toContain('payouts.manage');
    });

    it('a custom role grants exactly its permissions, and edits apply on the next request', async () => {
      const role = await request(server()).post(`${API}/roles`).set(h.owner.auth).send({ name: 'Night Auditor', permissions: ['reports.view', 'reservations.view'] }).expect(201);
      expect(role.body).toMatchObject({ system: false, key: null, permissions: ['reports.view', 'reservations.view'] });
      const s = await staff(h.owner.auth, { roleId: role.body.id });
      expect(s.res.status).toBe(201);
      expect(s.res.body).toMatchObject({ role: 'CUSTOM', roleId: role.body.id, roleName: 'Night Auditor' });
      await request(server()).get(`${API}/reservations`).set(s.auth!).expect(200);
      const denied = await request(server()).post(`${API}/night-audit/run`).set(s.auth!).send({}).expect(403);
      expect(denied.body).toMatchObject({ code: 'FORBIDDEN', details: { permission: 'settings.manage' } });
      await request(server()).get(`${API}/housekeeping/board`).set(s.auth!).expect(403);

      await request(server()).patch(`${API}/roles/${role.body.id}`).set(h.owner.auth).send({ permissions: ['reports.view', 'reservations.view', 'housekeeping.view'] }).expect(200);
      // Same token: the guard reloads the role on every request.
      await request(server()).get(`${API}/housekeeping/board`).set(s.auth!).expect(200);

      const inUse = await request(server()).delete(`${API}/roles/${role.body.id}`).set(h.owner.auth).expect(409);
      expect(inUse.body.code).toBe('ROLE_IN_USE');
      const sys = await request(server()).patch(`${API}/roles/FRONT_DESK`).set(h.owner.auth).send({ name: 'Desk' }).expect(409);
      expect(sys.body.code).toBe('SYSTEM_ROLE_READ_ONLY');
    });

    it('nobody can grant permissions they do not hold', async () => {
      // A manager holds everything except payouts.manage.
      const esc = await request(server()).post(`${API}/roles`).set(h.manager).send({ name: 'Payout clerk', permissions: ['payouts.manage'] }).expect(403);
      expect(esc.body).toMatchObject({ code: 'PERMISSION_ESCALATION', details: { missing: ['payouts.manage'] } });
      await request(server()).post(`${API}/roles`).set(h.manager).send({ name: 'Reports only', permissions: ['reports.view'] }).expect(201);

      // A custom role with staff.manage cannot hand out more than it has, nor create owners or managers.
      const hr = await request(server()).post(`${API}/roles`).set(h.owner.auth).send({ name: 'HR', permissions: ['staff.manage', 'reservations.view'] }).expect(201);
      const clerk = await staff(h.owner.auth, { roleId: hr.body.id });
      const up = await request(server()).post(`${API}/roles`).set(clerk.auth!).send({ name: 'Voider', permissions: ['folio.void'] }).expect(403);
      expect(up.body.code).toBe('PERMISSION_ESCALATION');
      const mgr = await staff(h.owner.auth, { role: 'MANAGER' }, clerk.auth!);
      expect(mgr.res.status).toBe(403);
      expect(mgr.res.body.code).toBe('PERMISSION_ESCALATION');
      // Owners are made (and changed) only by owners.
      await request(server()).patch(`${API}/staff/${clerk.id}`).set(clerk.auth!).send({ role: 'OWNER' }).expect(403);
      await request(server()).patch(`${API}/staff/${h.owner.userId}`).set(h.manager).send({ isActive: false }).expect(403);
      // A manager cannot change someone who holds more than they do (payouts.manage via a custom role).
      const payouts = await request(server()).post(`${API}/roles`).set(h.owner.auth).send({ name: 'Payouts', permissions: ['payouts.manage'] }).expect(201);
      const treasurer = await staff(h.owner.auth, { roleId: payouts.body.id });
      const touch = await request(server()).patch(`${API}/staff/${treasurer.id}`).set(h.manager).send({ role: 'FRONT_DESK' }).expect(403);
      expect(touch.body.code).toBe('PERMISSION_ESCALATION');
      const widen = await request(server()).patch(`${API}/roles/${hr.body.id}`).set(clerk.auth!).send({ permissions: ['staff.manage', 'reservations.view', 'reports.financial'] }).expect(403);
      expect(widen.body.code).toBe('PERMISSION_ESCALATION');
      // Within its own permissions it is fine.
      const desk = await staff(h.owner.auth, { roleId: hr.body.id }, clerk.auth!);
      expect(desk.res.status).toBe(201);
    });

    it('nobody changes their own role or deactivates themselves', async () => {
      await request(server()).patch(`${API}/staff/${h.owner.userId}`).set(h.owner.auth).send({ role: 'MANAGER' }).expect(400);
      await request(server()).patch(`${API}/staff/${h.owner.userId}`).set(h.owner.auth).send({ isActive: false }).expect(400);
      await request(server()).patch(`${API}/staff/${h.managerId}`).set(h.manager).send({ role: 'OWNER' }).expect(403);
    });

    it('audit export needs audit_export (Pro)', async () => {
      const res = await request(server()).get(`${API}/audit-logs/export`).query({ from: lagosDay(-1), to: lagosDay(0) }).set(h.owner.auth).expect(403);
      expect(res.body.code).toBe('FEATURE_LOCKED');
    });
  });

  // ---------------------------------------------------------------------------
  describe('housekeeping inspection', () => {
    let h: Hotel;
    let housekeeper: Auth;
    let supervisor: Auth;
    const roomStatus = async (id: string) => (await db.query(`SELECT status FROM rooms WHERE id = $1`, [id])).rows[0].status as string;
    beforeAll(async () => {
      h = await setupHotel(app, 2);
      housekeeper = (await staff(h.owner.auth, { role: 'HOUSEKEEPING' })).auth!;
      supervisor = (await staff(h.owner.auth, { role: 'SUPERVISOR' })).auth!;
      await request(server()).put(`${API}/housekeeping/settings`).set(h.owner.auth).send({ requireInspection: true, stayoverEnabled: true, deepCleanEveryStays: [] }).expect(200);
    });

    it('a cleaned room waits for inspection; a failed inspection sends it back', async () => {
      const stay = await checkedInStay(app, h.desk, h, h.rooms[0].id);
      const out = await request(server()).post(`${API}/reservations/${stay.id}/check-out`).set(h.manager).send({ override: { reason: 'Settles later' } }).expect(200);
      expect(out.body.reservation.room.status).toBe('VACANT_DIRTY');

      const tasks = (await request(server()).get(`${API}/housekeeping/tasks`).set(housekeeper).expect(200)).body as { id: string; type: string; room: { id: string }; checklist: { id: string }[] }[];
      const task = tasks.find((t) => t.room.id === h.rooms[0].id)!;
      expect(task.type).toBe('CHECKOUT_CLEAN');
      expect(task.checklist.length).toBeGreaterThan(5);

      await request(server()).post(`${API}/housekeeping/tasks/${task.id}/start`).set(housekeeper).send({}).expect(200);
      const done = await request(server())
        .post(`${API}/housekeeping/tasks/${task.id}/finish`)
        .set(housekeeper)
        .send({ checklist: task.checklist.map((c) => ({ id: c.id, done: true })) })
        .expect(200);
      expect(done.body).toMatchObject({ status: 'DONE', checklistDone: task.checklist.length });
      // Room stays dirty until a supervisor passes it; the housekeeper cannot mark it clean.
      const flip = await request(server()).patch(`${API}/rooms/${h.rooms[0].id}/status`).set(housekeeper).send({ status: 'VACANT_CLEAN' }).expect(409);
      expect(flip.body.code).toBe('INSPECTION_REQUIRED');
      await request(server()).post(`${API}/housekeeping/tasks/${task.id}/inspect`).set(housekeeper).send({ result: 'PASS' }).expect(403);

      const queue = (await request(server()).get(`${API}/housekeeping/inspections`).set(supervisor).expect(200)).body as { id: string }[];
      expect(queue.map((t) => t.id)).toContain(task.id);
      await request(server()).post(`${API}/housekeeping/tasks/${task.id}/inspect`).set(supervisor).send({ result: 'FAIL' }).expect(400);
      const rejected = await request(server()).post(`${API}/housekeeping/tasks/${task.id}/inspect`).set(supervisor).send({ result: 'FAIL', note: 'Mirror streaked' }).expect(200);
      expect(rejected.body).toMatchObject({ status: 'REJECTED', basePriority: 'HIGH', inspectionNote: 'Mirror streaked' });
      expect(await roomStatus(h.rooms[0].id)).toBe('VACANT_DIRTY');

      await request(server()).post(`${API}/housekeeping/tasks/${task.id}/start`).set(housekeeper).send({}).expect(200);
      await request(server()).post(`${API}/housekeeping/tasks/${task.id}/finish`).set(housekeeper).send({}).expect(200);
      const passed = await request(server()).post(`${API}/housekeeping/tasks/${task.id}/inspect`).set(supervisor).send({ result: 'PASS' }).expect(200);
      expect(passed.body.status).toBe('INSPECTED');
      expect(await roomStatus(h.rooms[0].id)).toBe('VACANT_CLEAN');
    });

    it('generates one stayover task per occupied room per day and lets housekeepers skip for DND', async () => {
      await checkedInStay(app, h.desk, h, h.rooms[1].id, 3);
      const first = await request(server()).post(`${API}/housekeeping/jobs/stayover/run`).set(supervisor).send({}).expect(200);
      expect(first.body.created).toBe(1);
      const again = await request(server()).post(`${API}/housekeeping/jobs/stayover/run`).set(supervisor).send({}).expect(200);
      expect(again.body.created).toBe(0);
      const tasks = (await request(server()).get(`${API}/housekeeping/tasks`).query({ type: 'STAYOVER' }).set(housekeeper).expect(200)).body as { id: string }[];
      const skipped = await request(server()).post(`${API}/housekeeping/tasks/${tasks[0].id}/skip`).set(housekeeper).send({ reason: 'DND' }).expect(200);
      expect(skipped.body).toMatchObject({ status: 'SKIPPED', skippedReason: 'DND' });
    });
  });

  // ---------------------------------------------------------------------------
  describe('check-out creates the cleaning task', () => {
    let h: Hotel;
    beforeAll(async () => {
      h = await setupHotel(app, 1);
      await request(server()).put(`${API}/housekeeping/settings`).set(h.owner.auth).send({ requireInspection: false, stayoverEnabled: true, deepCleanEveryStays: [{ roomTypeId: h.typeId, every: 2 }] }).expect(200);
      await request(server()).put(`${API}/housekeeping/checklists`).set(h.owner.auth).send({ roomTypeId: h.typeId, taskType: 'CHECKOUT_CLEAN', items: [{ label: 'Bed made with fresh linen' }, { label: 'Bathroom disinfected' }] }).expect(200);
      await request(server()).put(`${API}/housekeeping/checklists`).set(h.owner.auth).send({ roomTypeId: h.typeId, taskType: 'DEEP_CLEAN', items: [{ label: 'Mattress turned' }] }).expect(200);
    });

    const checkOut = async (roomId: string) => {
      const stay = await checkedInStay(app, h.desk, h, roomId);
      const out = await request(server()).post(`${API}/reservations/${stay.id}/check-out`).set(h.manager).send({ override: { reason: 'Company settles by transfer' } });
      expect(out.status).toBe(200);
      return out.body;
    };
    const openTasks = async () =>
      (await request(server()).get(`${API}/housekeeping/tasks`).query({ roomId: h.rooms[0].id }).set(h.owner.auth).expect(200)).body as { id: string; type: string; status: string; source: string; checklist: { label: string }[] }[];

    it('a check-out opens one CHECKOUT_CLEAN task with the room type checklist', async () => {
      const out = await checkOut(h.rooms[0].id);
      expect(out.reservation.room.status).toBe('VACANT_DIRTY');
      const tasks = await openTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ type: 'CHECKOUT_CLEAN', status: 'OPEN', source: 'CHECKOUT' });
      expect(tasks[0].checklist.map((c) => c.label)).toEqual(['Bed made with fresh linen', 'Bathroom disinfected']);
      await request(server()).post(`${API}/housekeeping/tasks/${tasks[0].id}/finish`).set(h.owner.auth).send({}).expect(200);
      expect((await db.query(`SELECT status FROM rooms WHERE id = $1`, [h.rooms[0].id])).rows[0].status).toBe('VACANT_CLEAN');
    });

    it('every Nth stay is a deep clean, and a damaged checklist template never breaks the check-out', async () => {
      await db.query(`UPDATE housekeeping_checklists SET items = '"not a list"'::jsonb WHERE tenant_id = $1 AND task_type = 'DEEP_CLEAN'`, [h.owner.tenantId]);
      await checkOut(h.rooms[0].id);
      const tasks = await openTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ type: 'DEEP_CLEAN', source: 'DEEP_CLEAN_RULE' });
      expect(tasks[0].checklist.length).toBeGreaterThan(5); // built-in deep-clean list
    });
  });

  // ---------------------------------------------------------------------------
  describe('corporate accounts and the city ledger', () => {
    let h: Hotel;
    let accountId: string;
    beforeAll(async () => {
      h = await setupHotel(app, 2);
      const acct = await request(server())
        .post(`${API}/corporate-accounts`)
        .set(h.owner.auth)
        .send({ name: `Deltaline ${uniq()}`, email: 'ap@deltaline.test', creditLimitKobo: 5_000_000, paymentTermsDays: 30, billingCycle: 'MONTHLY' })
        .expect(201);
      accountId = acct.body.id;
    });

    it('refuses a check-out to the city ledger over the credit limit, then allows it within', async () => {
      const res = await request(server())
        .post(`${API}/reservations`)
        .set(h.desk)
        .send({ guest: guestInput(), roomTypeId: h.typeId, roomId: h.rooms[0].id, arrivalDate: lagosDay(0), departureDate: lagosDay(1), corporateAccountId: accountId })
        .expect(201);
      await request(server()).post(`${API}/reservations/${res.body.id}/check-in`).set(h.desk).send({ guest: ID, registration: REGISTRATION }).expect(200);
      // Balance 53,750 (50,000 + VAT) > limit 50,000.
      const over = await request(server()).post(`${API}/reservations/${res.body.id}/check-out`).set(h.desk).send({ cityLedger: true }).expect(409);
      expect(over.body).toMatchObject({ code: 'CREDIT_LIMIT_EXCEEDED' });
      await request(server()).patch(`${API}/corporate-accounts/${accountId}`).set(h.owner.auth).send({ creditLimitKobo: 20_000_000 }).expect(200);
      const out = await request(server()).post(`${API}/reservations/${res.body.id}/check-out`).set(h.desk).send({ cityLedger: true }).expect(200);
      expect(out.body.reservation.status).toBe('CHECKED_OUT');
      expect(out.body.cityLedger.charge).toMatchObject({ amountKobo: 5_375_000, accountId });
      expect(out.body.cityLedger.invoice).toBeNull(); // MONTHLY: waits for the statement
      const acct = (await request(server()).get(`${API}/corporate-accounts/${accountId}`).set(h.owner.auth).expect(200)).body;
      expect(acct).toMatchObject({ outstandingKobo: 5_375_000, uninvoicedKobo: 5_375_000, availableCreditKobo: 20_000_000 - 5_375_000 });
      const flags = await request(server()).get(`${API}/guard/flags`).query({ rule: 'CHECKOUT_WITH_BALANCE' }).set(h.owner.auth).expect(200);
      expect(flags.body.total).toBe(0);
    });

    it('issues a statement, ages it, and takes part payments', async () => {
      const inv = await request(server()).post(`${API}/city-ledger/invoices`).set(h.owner.auth).send({ accountId }).expect(201);
      expect(inv.body).toMatchObject({ number: expect.stringMatching(/^CL-\d{4}-000001$/), totalKobo: 5_375_000, status: 'OPEN', bucket: 'CURRENT' });
      expect(inv.body.lines).toHaveLength(1);
      await db.query(`UPDATE city_ledger_invoices SET issue_date = issue_date - 45, due_date = due_date - 45 WHERE id = $1`, [inv.body.id]);
      const summary = (await request(server()).get(`${API}/city-ledger/summary`).set(h.owner.auth).expect(200)).body;
      expect(summary.aging).toEqual({ CURRENT: 0, D31_60: 5_375_000, D61_90: 0, D90_PLUS: 0 });
      expect(summary.overdueKobo).toBe(5_375_000);

      const paid = await request(server()).post(`${API}/city-ledger/invoices/${inv.body.id}/payments`).set(h.owner.auth).send({ amountKobo: 2_000_000, method: 'TRANSFER', reference: 'DOS/0001' }).expect(201);
      expect(paid.body).toMatchObject({ status: 'PARTIALLY_PAID', paidKobo: 2_000_000, balanceKobo: 3_375_000 });
      await request(server()).post(`${API}/city-ledger/invoices/${inv.body.id}/payments`).set(h.owner.auth).send({ amountKobo: 9_000_000, method: 'TRANSFER' }).expect(400);
      const after = (await request(server()).get(`${API}/city-ledger/summary`).set(h.owner.auth).expect(200)).body;
      expect(after.aging.D31_60).toBe(3_375_000);
      expect(after.outstandingKobo).toBe(3_375_000);
    });
  });

  // ---------------------------------------------------------------------------
  describe('WhatsApp webhook', () => {
    const secret = process.env.WHATSAPP_APP_SECRET!;
    const payload = (from: string, text: string) =>
      JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { messages: [{ id: `wamid.${uniq()}`, from, type: 'text', text: { body: text } }] } }] }] });
    const sign = (raw: string, key = secret) => `sha256=${createHmac('sha256', key).update(raw).digest('hex')}`;
    const post = (raw: string, sig?: string) => {
      const r = request(server()).post(`${API}/webhooks/whatsapp`).set('Content-Type', 'application/json');
      if (sig !== undefined) r.set('X-Hub-Signature-256', sig);
      return r.send(raw);
    };

    it('answers the verification challenge only with the verify token', async () => {
      const ok = await request(server()).get(`${API}/webhooks/whatsapp`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': process.env.WHATSAPP_VERIFY_TOKEN, 'hub.challenge': '8812' }).expect(200);
      expect(ok.text).toBe('8812');
      await request(server()).get(`${API}/webhooks/whatsapp`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '8812' }).expect(403);
    });

    it('rejects deliveries without a valid signature', async () => {
      const raw = payload('2348000000123', '1');
      expect((await post(raw).expect(401)).body.code).toBe('INVALID_SIGNATURE');
      await post(raw, sign(raw, 'not-the-secret')).expect(401);
      await post(raw, sign(`${raw} `)).expect(401);
      await post(raw, 'sha256=abc').expect(401);
    });

    it('accepts signed deliveries (unknown senders are ignored) and ignores duplicates', async () => {
      const raw = payload('2348000000123', 'DIGEST');
      expect((await post(raw, sign(raw)).expect(200)).body).toMatchObject({ received: true });
      expect((await post(raw, sign(raw)).expect(200)).body).toMatchObject({ received: true });
      const rows = await db.query(`SELECT count(*)::int AS n FROM whatsapp_inbound WHERE body = 'DIGEST' AND from_phone LIKE '%2348000000123'`);
      expect(rows.rows[0].n).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('trusted client IP', () => {
    // POST /public/reviews allows 10 an hour per client IP (counted before validation).
    const submit = (headers: Record<string, string>) => {
      const r = request(server()).post(`${API}/public/reviews`);
      for (const [k, v] of Object.entries(headers)) r.set(k, v);
      return r.send({});
    };

    it('ignores a spoofed X-Client-IP without the proxy secret', async () => {
      const socketIp = randomIp();
      let last: request.Response | null = null;
      for (let i = 0; i < 11; i++) last = await submit({ 'X-Forwarded-For': socketIp, 'X-Client-IP': randomIp() });
      expect(last!.status).toBe(429);
      const wrong = await submit({ 'X-Forwarded-For': socketIp, 'X-Client-IP': randomIp(), 'X-Proxy-Auth': 'guess' });
      expect(wrong.status).toBe(429);
    });

    it('limits per visitor IP when the web server vouches for it', async () => {
      const webServerIp = randomIp();
      const secret = process.env.TRUSTED_PROXY_SECRET!;
      // Many visitors behind the same web server are counted separately.
      for (let i = 0; i < 15; i++) {
        const res = await submit({ 'X-Forwarded-For': webServerIp, 'X-Client-IP': randomIp(), 'X-Proxy-Auth': secret });
        expect(res.status).toBe(400);
      }
      // One visitor still hits the limit.
      const visitor = randomIp();
      let last: request.Response | null = null;
      for (let i = 0; i < 11; i++) last = await submit({ 'X-Forwarded-For': webServerIp, 'X-Client-IP': visitor, 'X-Proxy-Auth': secret });
      expect(last!.status).toBe(429);
    });
  });
});
