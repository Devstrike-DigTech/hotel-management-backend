import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { API, createApp, ownerClient, platformAuth } from './helpers.js';
import { guestInput, ID, lagosDay, REGISTRATION, setupHotel, type Hotel } from './m2-helpers.js';

describe('Reservations, availability and check-in rules', () => {
  let app: INestApplication;
  let h: Hotel;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createApp();
    h = await setupHotel(app, 3);
  });

  afterAll(async () => {
    await app.close();
  });

  const book = (body: Record<string, unknown>, auth = h.owner.auth) =>
    request(server())
      .post(`${API}/reservations`)
      .set(auth)
      .send({ guest: guestInput(), roomTypeId: h.typeId, ...body });

  it('rejects double booking of one room under concurrency (database exclusion constraint)', async () => {
    const roomId = h.rooms[0].id;
    const window = { roomId, arrivalDate: lagosDay(10), departureDate: lagosDay(13) };
    const results = await Promise.all(Array.from({ length: 8 }, () => book(window)));
    const ok = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    for (const r of rejected) expect(r.body.code).toBe('ROOM_UNAVAILABLE');
    // A touching stay (checkout day = next arrival day) is fine.
    await book({ roomId, arrivalDate: lagosDay(13), departureDate: lagosDay(14) }).expect(201);
  });

  it('the database itself refuses an overlapping active stay, even for the owner role', async () => {
    const owner = ownerClient();
    await owner.connect();
    try {
      const { rows } = await owner.query(
        `SELECT * FROM reservations WHERE room_id = $1 AND status = 'CONFIRMED' ORDER BY arrival_at LIMIT 1`,
        [h.rooms[0].id],
      );
      const r = rows[0];
      await expect(
        owner.query(
          `INSERT INTO reservations (id, tenant_id, property_id, code, guest_id, room_type_id, room_id, arrival_at, departure_at, rate_kobo, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'SQL-TEST', $3, $4, $5, $6::timestamptz + interval '1 hour', $7, 1, now())`,
          [r.tenant_id, r.property_id, r.guest_id, r.room_type_id, r.room_id, r.arrival_at, r.departure_at],
        ),
      ).rejects.toThrow(/reservations_no_overlap/);
    } finally {
      await owner.end();
    }
  });

  it('two concurrent transactions cannot both commit overlapping stays (no application lock involved)', async () => {
    const c1 = ownerClient();
    const c2 = ownerClient();
    await c1.connect();
    await c2.connect();
    try {
      const { rows } = await c1.query(`SELECT * FROM reservations WHERE tenant_id = $1 LIMIT 1`, [h.owner.tenantId]);
      const r = rows[0];
      const insert = (c: typeof c1, code: string) =>
        c.query(
          `INSERT INTO reservations (id, tenant_id, property_id, code, guest_id, room_type_id, room_id, arrival_at, departure_at, rate_kobo, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now() + interval '50 days', now() + interval '52 days', 1, now())`,
          [r.tenant_id, r.property_id, code, r.guest_id, r.room_type_id, h.rooms[2].id],
        );
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      await insert(c1, 'RACE-1');
      const second = insert(c2, 'RACE-2'); // blocks on c1's uncommitted row
      await c1.query('COMMIT');
      await expect(second).rejects.toThrow(/reservations_no_overlap/);
      await c2.query('ROLLBACK');
      const n = await c1.query(`SELECT count(*)::int AS n FROM reservations WHERE code IN ('RACE-1', 'RACE-2')`);
      expect(n.rows[0].n).toBe(1);
      await c1.query(`UPDATE reservations SET status = 'CANCELLED' WHERE code = 'RACE-1'`);
    } finally {
      await c1.end();
      await c2.end();
    }
  });

  it('caps unassigned bookings at the sellable rooms of the type, under concurrency', async () => {
    const window = { arrivalDate: lagosDay(30), departureDate: lagosDay(32) };
    const results = await Promise.all(Array.from({ length: 6 }, () => book(window)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    const rejected = results.filter((r) => r.status === 409);
    expect(rejected).toHaveLength(3);
    expect(rejected[0].body.details.scope).toBe('ROOM_TYPE');
    const grid = await request(server()).get(`${API}/availability`).query({ from: lagosDay(30), to: lagosDay(31) }).set(h.owner.auth).expect(200);
    expect(grid.body.roomTypes[0].days.map((d: { available: number }) => d.available)).toEqual([0, 0]);
  });

  it('gates day-use stays behind hourly_bookings', async () => {
    const platform = await platformAuth(app);
    const arrivalAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const departureAt = new Date(Date.now() + 4 * 60 * 60_000).toISOString();
    await request(server()).put(`${API}/platform/tenants/${h.owner.tenantId}/features`).set(platform).send({ featureCode: 'hourly_bookings', enabled: false }).expect(200);
    const locked = await book({ stayType: 'DAY_USE', roomId: h.rooms[2].id, arrivalAt, departureAt }).expect(403);
    expect(locked.body.code).toBe('FEATURE_LOCKED');
    expect(locked.body.details.feature).toBe('hourly_bookings');
    await request(server()).delete(`${API}/platform/tenants/${h.owner.tenantId}/features/hourly_bookings`).set(platform).expect(200);
    const ok = await book({ stayType: 'DAY_USE', roomId: h.rooms[2].id, arrivalAt, departureAt }).expect(201);
    expect(ok.body.stayType).toBe('DAY_USE');
    expect(ok.body.hours).toBe(3);
    expect(ok.body.rateKobo).toBe(1_000_000);
    // Minimum two hours.
    const short = await book({ stayType: 'DAY_USE', arrivalAt, departureAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString() }).expect(400);
    expect(short.body.code).toBe('VALIDATION_ERROR');
  });

  it('check-in requires a clean room; only a manager can override (flagged)', async () => {
    const room = h.rooms[1];
    const res = await book({ roomId: room.id, arrivalDate: lagosDay(0), departureDate: lagosDay(1) }, h.desk).expect(201);
    await request(server()).patch(`${API}/rooms/${room.id}/status`).set(h.owner.auth).send({ status: 'VACANT_DIRTY' }).expect(200);
    const body = { guest: ID, registration: REGISTRATION };
    const dirty = await request(server()).post(`${API}/reservations/${res.body.id}/check-in`).set(h.desk).send(body).expect(409);
    expect(dirty.body.code).toBe('ROOM_NOT_CLEAN');
    await request(server())
      .post(`${API}/reservations/${res.body.id}/check-in`)
      .set(h.desk)
      .send({ ...body, override: { reason: 'Guest insists' } })
      .expect(403);
    const ok = await request(server())
      .post(`${API}/reservations/${res.body.id}/check-in`)
      .set(h.manager)
      .send({ ...body, override: { reason: 'Inspected, only the bin needed emptying' } })
      .expect(200);
    expect(ok.body.status).toBe('CHECKED_IN');
    expect(ok.body.room.status).toBe('OCCUPIED');
    // First night + VAT 7.5% posted at check-in.
    expect(ok.body.balanceKobo).toBe(5_375_000);
    const flags = await request(server()).get(`${API}/guard/flags`).query({ rule: 'DIRTY_OVERRIDE_CHECKIN' }).set(h.owner.auth).expect(200);
    expect(flags.body.items.some((f: { reservation: { id: string } }) => f.reservation?.id === res.body.id)).toBe(true);
  });

  it('check-in without a complete register is refused unless registering later', async () => {
    const res = await book({ arrivalDate: lagosDay(0), departureDate: lagosDay(1) }, h.desk).expect(201);
    const pick = await request(server())
      .get(`${API}/availability/rooms`)
      .query({ roomTypeId: h.typeId, arrivalDate: lagosDay(0), departureDate: lagosDay(1), excludeReservationId: res.body.id })
      .set(h.desk)
      .expect(200);
    const room = pick.body.rooms.find((r: { free: boolean; clean: boolean }) => r.free && r.clean);
    const inc = await request(server()).post(`${API}/reservations/${res.body.id}/check-in`).set(h.desk).send({ roomId: room.id }).expect(400);
    expect(inc.body.code).toBe('REGISTRATION_INCOMPLETE');
    expect(inc.body.details.missing).toEqual(expect.arrayContaining(['registration.arrivingFrom', 'guest.idNumber']));
    const later = await request(server()).post(`${API}/reservations/${res.body.id}/check-in`).set(h.desk).send({ roomId: room.id, registerLater: true }).expect(200);
    expect(later.body.registrationComplete).toBe(false);
    const done = await request(server())
      .put(`${API}/reservations/${res.body.id}/registration`)
      .set(h.desk)
      .send({ ...REGISTRATION, guest: ID })
      .expect(200);
    expect(done.body.registrationComplete).toBe(true);
    expect(done.body.registration.completedAt).not.toBeNull();
  });

  it('front desk cannot set a custom rate', async () => {
    const res = await book({ arrivalDate: lagosDay(40), departureDate: lagosDay(41), rateKobo: 100 }, h.desk).expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('tape chart lists rooms and stays; unassigned stays are separate', async () => {
    const res = await request(server()).get(`${API}/tape-chart`).query({ from: lagosDay(0), to: lagosDay(35) }).set(h.desk).expect(200);
    expect(res.body.rooms.map((r: { number: string }) => r.number)).toEqual(['101', '102', '103']);
    expect(res.body.stays.length).toBeGreaterThan(0);
    expect(res.body.unassigned.length).toBeGreaterThanOrEqual(3);
  });

  it('moving an unassigned stay onto an occupied window re-validates availability', async () => {
    const list = await request(server()).get(`${API}/reservations`).query({ from: lagosDay(30), to: lagosDay(31) }).set(h.desk).expect(200);
    const target = list.body.items[0];
    const res = await request(server())
      .patch(`${API}/reservations/${target.id}`)
      .set(h.desk)
      .send({ roomId: h.rooms[0].id, arrivalDate: lagosDay(11), departureDate: lagosDay(12) })
      .expect(409);
    expect(res.body.code).toBe('ROOM_UNAVAILABLE');
  });
});
