import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { fingerprint } from '../src/modules/idempotency/idempotency.interceptor.js';
import { humanDate } from '../src/common/time/lagos.js';
import { API, createApp, ownerClient } from './helpers.js';
import { checkedInStay, guestInput, ID, lagosDay, openShift, REGISTRATION, setupHotel, type Hotel } from './m2-helpers.js';

describe('M2 follow-ups: occupancy, human dates, check-in picker, atomic idempotency', () => {
  let app: INestApplication;
  let h: Hotel;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createApp();
    h = await setupHotel(app, 4);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('daily flash counts in-house stays, not only posted charges', () => {
    let stayId: string;

    it('a guest who arrived yesterday is sold for tonight before the night audit posts the charge', async () => {
      const res = await request(server())
        .post(`${API}/reservations`)
        .set(h.desk)
        .send({ guest: guestInput(), roomTypeId: h.typeId, roomId: h.rooms[0].id, arrivalDate: lagosDay(-1), departureDate: lagosDay(2) })
        .expect(201);
      stayId = res.body.id;
      await request(server()).post(`${API}/reservations/${stayId}/check-in`).set(h.desk).send({ guest: ID, registration: REGISTRATION }).expect(200);

      const today = (await request(server()).get(`${API}/reports/daily`).query({ date: lagosDay(0) }).set(h.owner.auth).expect(200)).body;
      expect(today).toMatchObject({ roomsSold: 1, roomNightsPosted: 0, roomRevenuePostedKobo: 0, occupancyRate: 0.25, guestsInHouse: 1 });
      const yesterday = (await request(server()).get(`${API}/reports/daily`).query({ date: lagosDay(-1) }).set(h.owner.auth).expect(200)).body;
      expect(yesterday).toMatchObject({ roomsSold: 1, roomNightsPosted: 1, roomRevenuePostedKobo: 5_000_000, roomRevenueKobo: 5_000_000, adrKobo: 5_000_000 });
      const tomorrow = (await request(server()).get(`${API}/reports/daily`).query({ date: lagosDay(1) }).set(h.owner.auth).expect(200)).body;
      expect(tomorrow.roomsSold).toBe(1);
      const range = (await request(server()).get(`${API}/reports/range`).query({ from: lagosDay(-1), to: lagosDay(1) }).set(h.owner.auth).expect(200)).body;
      expect(range.totals).toMatchObject({ roomsSold: 3, roomNightsPosted: 1 });
    });

    it('folio lines use human Lagos dates, not ISO strings', async () => {
      const folio = (await request(server()).get(`${API}/reservations/${stayId}/folio`).set(h.owner.auth).expect(200)).body;
      const room = folio.entries.find((e: { type: string }) => e.type === 'ROOM');
      expect(room.description).toBe(`Room 101, night of ${humanDate(lagosDay(-1))}`);
      expect(room.description).toMatch(/^Room 101, night of (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2} \d{4}$/);
      const preview = (await request(server()).post(`${API}/digests/preview`).set(h.owner.auth).send({}).expect(200)).body;
      expect(preview.body.split('\n')[0]).toContain(humanDate(lagosDay(0)));
      expect(preview.body).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    });
  });

  describe('check-in room picker', () => {
    it('a room whose guest is still checked in is not offered for a check-in now', async () => {
      const occupied = await checkedInStay(app, h.desk, h, h.rooms[1].id, 1);
      // The guest leaves later today.
      const owner = ownerClient();
      await owner.connect();
      try {
        await owner.query(`UPDATE reservations SET departure_at = GREATEST(arrival_at, now()) + interval '2 hours' WHERE id = $1`, [occupied.id]);
      } finally {
        await owner.end();
      }
      const q = { roomTypeId: h.typeId, arrivalDate: lagosDay(0), departureDate: lagosDay(1) };
      const forCheckIn = (await request(server()).get(`${API}/availability/rooms`).query({ ...q, forCheckIn: 'true' }).set(h.desk).expect(200)).body;
      expect(forCheckIn.forCheckIn).toBe(true);
      const room = forCheckIn.rooms.find((r: { id: string }) => r.id === h.rooms[1].id);
      expect(room).toMatchObject({ free: false, checkInReady: false, reason: 'OCCUPIED', status: 'OCCUPIED' });
      expect(room.occupiedUntil).not.toBeNull();
      const clean = forCheckIn.rooms.find((r: { id: string }) => r.id === h.rooms[3].id);
      expect(clean).toMatchObject({ free: true, clean: true, checkInReady: true, reason: null, occupiedUntil: null });

      const plain = (await request(server()).get(`${API}/availability/rooms`).query(q).set(h.desk).expect(200)).body;
      expect(plain.rooms.find((r: { id: string }) => r.id === h.rooms[1].id)).toMatchObject({ checkInReady: false, reason: 'OCCUPIED' });

      // And check-in into it is refused.
      const res = await request(server())
        .post(`${API}/reservations`)
        .set(h.desk)
        .send({ guest: guestInput(), roomTypeId: h.typeId, arrivalDate: lagosDay(0), departureDate: lagosDay(1) })
        .expect(201);
      const ci = await request(server())
        .post(`${API}/reservations/${res.body.id}/check-in`)
        .set(h.desk)
        .send({ roomId: h.rooms[1].id, guest: ID, registration: REGISTRATION })
        .expect(409);
      expect(ci.body.code).toBe('ROOM_UNAVAILABLE');
    });
  });

  describe('Idempotency-Key is atomic with the business transaction', () => {
    let folioId: string;

    beforeAll(async () => {
      const stay = await checkedInStay(app, h.owner.auth, h, h.rooms[2].id);
      folioId = stay.folioId;
      await openShift(app, h.owner.auth);
    });

    const pay = (key: string, body: Record<string, unknown>) =>
      request(server()).post(`${API}/folios/${folioId}/payments`).set(h.owner.auth).set('Idempotency-Key', key).send(body);
    const paymentsWithRef = async (ref: string) =>
      (await request(server()).get(`${API}/folios/${folioId}`).set(h.owner.auth).expect(200)).body.entries.filter(
        (e: { type: string; paymentRef: string }) => e.type === 'PAYMENT' && e.paymentRef === ref,
      ).length;

    it('concurrent duplicates apply once: one 201, the rest 409 in progress or a replay', async () => {
      const key = `burst-${Date.now()}`;
      const body = { method: 'CASH', amountKobo: 12_345, reference: key };
      const results = await Promise.all(Array.from({ length: 8 }, () => pay(key, body)));
      const statuses = results.map((r) => r.status);
      expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
      expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
      for (const r of results.filter((x) => x.status === 409)) expect(r.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      const bodies = results.filter((r) => r.status === 201).map((r) => r.body.receipt.number);
      expect(new Set(bodies).size).toBe(1);
      expect(await paymentsWithRef(key)).toBe(1);
      // After completion every retry is a replay.
      const replay = await pay(key, body).expect(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      const owner = ownerClient();
      await owner.connect();
      try {
        const row = await owner.query(`SELECT applied, completed FROM idempotency_keys WHERE key = $1`, [key]);
        expect(row.rows[0]).toEqual({ applied: true, completed: true });
      } finally {
        await owner.end();
      }
    });

    it('after a crash between commit and response, a retry never applies the action again', async () => {
      const key = `crash-${Date.now()}`;
      const body = { method: 'CASH', amountKobo: 777, reference: key };
      const fp = fingerprint('POST', `${API}/folios/${folioId}/payments?`, body);
      const owner = ownerClient();
      await owner.connect();
      try {
        // Simulate: the payment's transaction committed (applied) but the process died before storing the response.
        await owner.query(
          `INSERT INTO idempotency_keys (tenant_id, key, fingerprint, completed, applied, created_at, expires_at)
           VALUES ($1, $2, $3, false, true, now() - interval '10 minutes', now() + interval '72 hours')`,
          [h.owner.tenantId, key, fp],
        );
        const res = await pay(key, body).expect(409);
        expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS', details: { applied: true } });
        expect(await paymentsWithRef(key)).toBe(0);

        // An abandoned reservation that never applied anything is taken over after the lease.
        const key2 = `abandoned-${Date.now()}`;
        const body2 = { method: 'CASH', amountKobo: 778, reference: key2 };
        await owner.query(
          `INSERT INTO idempotency_keys (tenant_id, key, fingerprint, completed, applied, created_at, expires_at)
           VALUES ($1, $2, $3, false, false, now() - interval '10 minutes', now() + interval '72 hours')`,
          [h.owner.tenantId, key2, fingerprint('POST', `${API}/folios/${folioId}/payments?`, body2)],
        );
        await pay(key2, body2).expect(201);
        expect(await paymentsWithRef(key2)).toBe(1);
      } finally {
        await owner.end();
      }
    });

    it('a failed request (nothing written) releases the key', async () => {
      const key = `fail-${Date.now()}`;
      const res = await pay(key, { method: 'COMPLIMENTARY', amountKobo: 1 }).set(h.desk);
      expect(res.status).toBe(403);
      const owner = ownerClient();
      await owner.connect();
      try {
        const row = await owner.query(`SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1`, [key]);
        expect(row.rows[0].n).toBe(0);
      } finally {
        await owner.end();
      }
    });
  });
});
