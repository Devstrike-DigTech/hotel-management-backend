import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import request from 'supertest';
import { BookingTokens } from '../src/modules/booking/booking-tokens.service.js';
import { API, appRoleClient, createApp, ownerClient, setSignedPublic, setSignedTenant } from './helpers.js';
import { lagosDay } from './m2-helpers.js';
import {
  book,
  chargeSuccess,
  freshPhone,
  guestLogin,
  onlineHotel,
  otpFromOutbox,
  platformToken,
  postWebhook,
  randomIp,
  startPaystackStub,
  stopStub,
  type OnlineHotel,
  type PaystackStub,
} from './m3-helpers.js';

describe('M3 guest accounts, trips, reviews and isolation', () => {
  let app: INestApplication;
  let stub: PaystackStub;
  let db: pg.Client;

  beforeAll(async () => {
    stub = await startPaystackStub();
    app = await createApp();
    db = ownerClient();
    await db.connect();
  });
  afterAll(async () => {
    await db.end();
    await app.close();
    await stopStub(stub);
  });

  const server = () => app.getHttpServer();

  describe('phone OTP', () => {
    it('signs in with the code from the dev outbox and stores only a hash', async () => {
      const phone = freshPhone();
      const ip = randomIp();
      const start = await request(server()).post(`${API}/public/auth/otp/start`).set('X-Forwarded-For', ip).send({ phone: `0${phone.slice(4)}` }).expect(200);
      expect(start.body).toMatchObject({ channel: 'SMS', codeLength: 6, resendAfterSec: 60 });
      expect(start.body.maskedPhone).toBe(`${phone.slice(0, 7)}•••${phone.slice(-4)}`);
      const code = await otpFromOutbox(app, phone);
      const row = (await db.query(`SELECT code_hash FROM guest_otp_challenges WHERE id = $1`, [start.body.challengeId])).rows[0];
      expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.code_hash).not.toContain(code);
      const log = (await db.query(`SELECT body_text, tenant_id FROM notification_logs WHERE template = 'OTP' AND recipient = $1`, [phone])).rows[0];
      expect(log.body_text).not.toContain(code);
      expect(log.tenant_id).toBeNull();

      const again = await request(server()).post(`${API}/public/auth/otp/start`).set('X-Forwarded-For', ip).send({ phone });
      expect(again.status).toBe(429);
      expect(again.body.code).toBe('OTP_RESEND_TOO_SOON');

      const ok = await request(server()).post(`${API}/public/auth/otp/verify`).set('X-Forwarded-For', ip).send({ challengeId: start.body.challengeId, code }).expect(200);
      expect(ok.body).toMatchObject({ isNew: true, guest: { phone, profileComplete: false } });
      const me = await request(server()).get(`${API}/guest/me`).set('Authorization', `Bearer ${ok.body.accessToken}`).expect(200);
      expect(me.body.phone).toBe(phone);
      const reuse = await request(server()).post(`${API}/public/auth/otp/verify`).set('X-Forwarded-For', ip).send({ challengeId: start.body.challengeId, code });
      expect(reuse.status).toBe(410);
      expect(reuse.body.code).toBe('OTP_EXPIRED');
    });

    it('locks after five wrong codes, even for the right code, and blocks new codes for 15 minutes', async () => {
      const phone = freshPhone();
      const ip = randomIp();
      const start = await request(server()).post(`${API}/public/auth/otp/start`).set('X-Forwarded-For', ip).send({ phone }).expect(200);
      const code = await otpFromOutbox(app, phone);
      const wrong = code === '000000' ? '111111' : '000000';
      const lefts: number[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await request(server()).post(`${API}/public/auth/otp/verify`).set('X-Forwarded-For', ip).send({ challengeId: start.body.challengeId, code: wrong });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('OTP_INVALID');
        lefts.push(r.body.details.attemptsLeft);
      }
      expect(lefts).toEqual([4, 3, 2, 1]);
      const fifth = await request(server()).post(`${API}/public/auth/otp/verify`).set('X-Forwarded-For', ip).send({ challengeId: start.body.challengeId, code: wrong });
      expect(fifth.status).toBe(429);
      expect(fifth.body.code).toBe('OTP_LOCKED');
      const right = await request(server()).post(`${API}/public/auth/otp/verify`).set('X-Forwarded-For', ip).send({ challengeId: start.body.challengeId, code });
      expect(right.body.code).toBe('OTP_LOCKED');
      await db.query(`UPDATE guest_otp_challenges SET created_at = now() - interval '2 minutes' WHERE id = $1`, [start.body.challengeId]);
      const restart = await request(server()).post(`${API}/public/auth/otp/start`).set('X-Forwarded-For', ip).send({ phone });
      expect(restart.status).toBe(429);
      expect(restart.body.code).toBe('OTP_LOCKED');
      expect(new Date(restart.body.details.lockedUntil).getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    });

    it('rotates refresh tokens and revokes the family on reuse', async () => {
      const g = await guestLogin(app);
      const r1 = await request(server()).post(`${API}/public/auth/refresh`).set('X-Forwarded-For', randomIp()).send({ refreshToken: g.refresh }).expect(200);
      const reuse = await request(server()).post(`${API}/public/auth/refresh`).set('X-Forwarded-For', randomIp()).send({ refreshToken: g.refresh });
      expect(reuse.status).toBe(401);
      expect(reuse.body.code).toBe('REFRESH_TOKEN_REUSED');
      const dead = await request(server()).post(`${API}/public/auth/refresh`).set('X-Forwarded-For', randomIp()).send({ refreshToken: r1.body.refreshToken });
      expect(dead.status).toBe(401);
    });

    it('keeps guest, staff and platform tokens apart', async () => {
      const g = await guestLogin(app);
      const h = await onlineHotel(app, 1, { payout: false });
      expect((await request(server()).get(`${API}/me`).set('Authorization', `Bearer ${g.token}`)).status).toBe(401);
      expect((await request(server()).get(`${API}/guest/trips`).set(h.owner.auth)).status).toBe(401);
      expect((await request(server()).get(`${API}/platform/metrics`).set('Authorization', `Bearer ${g.token}`)).status).toBe(401);
      expect((await request(server()).get(`${API}/guest/trips`)).status).toBe(401);
    });

    it('sends a single-use magic link to a known email', async () => {
      const g = await guestLogin(app);
      const email = `magic-${Date.now()}@e2e.test`;
      await request(server()).patch(`${API}/guest/me`).set('Authorization', `Bearer ${g.token}`).send({ fullName: 'Magic Guest', email }).expect(200);
      await request(server()).post(`${API}/public/auth/email/start`).set('X-Forwarded-For', randomIp()).send({ email }).expect(200);
      const unknown = await request(server()).post(`${API}/public/auth/email/start`).set('X-Forwarded-For', randomIp()).send({ email: `nobody-${Date.now()}@e2e.test` }).expect(200);
      expect(unknown.body).toEqual({ sent: true });
      const out = await request(server()).get(`${API}/public/dev/outbox`).query({ to: email }).expect(200);
      const url = out.body.items.find((m: { template: string }) => m.template === 'MAGIC_LINK').meta.magicLinkUrl as string;
      const token = new URL(url).searchParams.get('token')!;
      const ok = await request(server()).post(`${API}/public/auth/email/verify`).send({ token }).expect(200);
      expect(ok.body.guest.id).toBe(g.account.id);
      expect((await request(server()).post(`${API}/public/auth/email/verify`).send({ token })).status).toBe(410);
    });
  });

  describe('trips', () => {
    let h: OnlineHotel;
    beforeAll(async () => {
      h = await onlineHotel(app, 3);
    });

    it('a guest sees only their own trips, by account and by verified phone', async () => {
      const a = await guestLogin(app);
      const b = await guestLogin(app);
      // A brand-new account has no name yet, so the booking asks for one.
      const nameless = await book(app, h, { guestToken: a.token, paymentMode: 'PAY_AT_HOTEL', checkIn: lagosDay(30) });
      expect(nameless.status).toBe(400);
      await request(server()).patch(`${API}/guest/me`).set('Authorization', `Bearer ${a.token}`).send({ fullName: 'Ada Account' }).expect(200);
      const mine = await book(app, h, { guestToken: a.token, paymentMode: 'PAY_AT_HOTEL', checkIn: lagosDay(30) });
      expect(mine.status).toBe(201);
      // A booking made without signing in, with B's phone, is linked when B signs in again.
      const anon = await book(app, h, { phone: b.phone, paymentMode: 'PAY_AT_HOTEL', checkIn: lagosDay(31) });
      expect(anon.status).toBe(201);
      await db.query(`UPDATE guest_otp_challenges SET created_at = now() - interval '2 minutes' WHERE phone = $1`, [b.phone]);
      const b2 = await guestLogin(app, b.phone);

      const ta = await request(server()).get(`${API}/guest/trips`).set('Authorization', `Bearer ${a.token}`).expect(200);
      const tb = await request(server()).get(`${API}/guest/trips`).set('Authorization', `Bearer ${b2.token}`).expect(200);
      const codes = (t: request.Response) => [...t.body.upcoming, ...t.body.past].map((x: { code: string }) => x.code);
      expect(codes(ta)).toEqual([mine.body.booking.code]);
      expect(codes(tb)).toEqual([anon.body.booking.code]);
      expect(ta.body.upcoming[0]).toMatchObject({ displayStatus: 'CONFIRMED', paymentMode: 'PAY_AT_HOTEL', canReview: false });

      // A trip token only opens its own booking.
      const tokenA = ta.body.upcoming[0].manageToken;
      expect((await request(server()).get(`${API}/public/trips/${anon.body.booking.code}`).query({ t: tokenA })).status).toBe(404);
      expect((await request(server()).get(`${API}/public/trips/${mine.body.booking.code}`).query({ t: 'garbage.token' })).status).toBe(404);
      const ok = await request(server()).get(`${API}/public/trips/${mine.body.booking.code}`).query({ t: tokenA }).expect(200);
      expect(ok.body.guest.phone).toBe(a.phone);
      const ics = await request(server()).get(`${API}/public/trips/${mine.body.booking.code}/calendar.ics`).query({ t: tokenA }).expect(200);
      expect(ics.headers['content-type']).toContain('text/calendar');
      expect(ics.text).toContain(`SUMMARY:Stay at`);
    });
  });

  describe('reviews', () => {
    let h: OnlineHotel;
    let platform: { Authorization: string };
    beforeAll(async () => {
      h = await onlineHotel(app, 3);
      platform = await platformToken(app);
    });

    it('only a checked-out stay can be reviewed, and only once', async () => {
      const b = await book(app, h, { checkIn: lagosDay(3) });
      await postWebhook(app, chargeSuccess(b.body.payment.reference, 10_750_000)).expect(200);
      const r = (await db.query(`SELECT id, tenant_id FROM reservations WHERE code = $1`, [b.body.booking.code])).rows[0];
      const early = app.get(BookingTokens).signReview(r.tenant_id, r.id, new Date());
      const body = { overall: 5, cleanliness: 5, service: 4, location: 4, value: 5, body: 'Lovely stay, spotless room and friendly staff throughout.', travellerType: 'COUPLE' };
      const tooSoon = await request(server()).post(`${API}/public/reviews`).set('X-Forwarded-For', randomIp()).send({ token: early.token, ...body });
      expect(tooSoon.status).toBe(409);
      expect(tooSoon.body.details.reason).toBe('NOT_CHECKED_OUT');

      await db.query(`UPDATE reservations SET status = 'CHECKED_OUT', checked_in_at = now() - interval '2 days', checked_out_at = now() - interval '5 hours' WHERE id = $1`, [r.id]);
      const trip = await request(server()).get(`${API}/public/trips/${b.body.booking.code}`).query({ t: b.body.manageToken }).expect(200);
      expect(trip.body.review).toMatchObject({ eligible: true, submitted: false });
      const token = trip.body.review.token as string;
      const ctx = await request(server()).get(`${API}/public/reviews/request`).query({ t: token }).expect(200);
      expect(ctx.body).toMatchObject({ eligible: true, displayName: 'Amaka T.' });

      const created = await request(server()).post(`${API}/public/reviews`).set('X-Forwarded-For', randomIp()).send({ token, ...body }).expect(201);
      expect(created.body).toMatchObject({ status: 'PUBLISHED', displayName: 'Amaka T.', verifiedStay: true });
      const twice = await request(server()).post(`${API}/public/reviews`).set('X-Forwarded-For', randomIp()).send({ token, ...body });
      expect(twice.status).toBe(409);
      expect(twice.body.details.reason).toBe('ALREADY_REVIEWED');

      const pub = await request(server()).get(`${API}/public/hotels/${h.slug}/reviews`).set('X-Forwarded-For', randomIp()).expect(200);
      expect(pub.body.summary).toMatchObject({ rating: 5, count: 1, subscores: { service: 4 } });
      const card = await request(server()).get(`${API}/public/hotels/${h.slug}`).expect(200);
      expect(card.body).toMatchObject({ rating: 5, reviewCount: 1 });
      const staffSummary = await request(server()).get(`${API}/reviews/summary`).set(h.owner.auth).expect(200);
      expect(staffSummary.body).toMatchObject({ rating: 5, count: 1, unreplied: 1, distribution: { '5': 1 } });

      // Hotel replies (editable); the platform can hide, which drops it from the aggregates.
      const reviewId = created.body.id;
      await request(server()).put(`${API}/reviews/${reviewId}/reply`).set(h.owner.auth).send({ body: 'Thank you, we hope to see you again.' }).expect(200);
      const edited = await request(server()).put(`${API}/reviews/${reviewId}/reply`).set(h.owner.auth).send({ body: 'Thank you, see you again soon.' }).expect(200);
      expect(edited.body.hotelReply.body).toBe('Thank you, see you again soon.');
      const hidden = await request(server()).patch(`${API}/platform/reviews/${reviewId}`).set(platform).send({ status: 'HIDDEN', reason: 'PII' }).expect(200);
      expect(hidden.body.moderation).toMatchObject({ reason: 'PII' });
      const after = await request(server()).get(`${API}/public/hotels/${h.slug}/reviews`).set('X-Forwarded-For', randomIp()).expect(200);
      expect(after.body).toMatchObject({ total: 0, summary: { count: 0, rating: null } });
    });

    it('text with contact details is held as FLAGGED for moderation', async () => {
      const b = await book(app, h, { checkIn: lagosDay(4), paymentMode: 'PAY_AT_HOTEL' });
      const r = (await db.query(`SELECT id, tenant_id FROM reservations WHERE code = $1`, [b.body.booking.code])).rows[0];
      await db.query(`UPDATE reservations SET status = 'CHECKED_OUT', checked_out_at = now() - interval '1 day' WHERE id = $1`, [r.id]);
      const { token } = app.get(BookingTokens).signReview(r.tenant_id, r.id, new Date(Date.now() - 86_400_000));
      const res = await request(server())
        .post(`${API}/public/reviews`)
        .set('X-Forwarded-For', randomIp())
        .send({ token, overall: 4, cleanliness: 4, service: 4, location: 4, value: 4, body: 'Good stay. Call me on 0803 555 0199 if you need a reference.', travellerType: 'SOLO' })
        .expect(201);
      expect(res.body.status).toBe('FLAGGED');
      const queue = await request(server()).get(`${API}/platform/reviews`).set(platform).expect(200);
      expect(queue.body.items[0].status).toBe('FLAGGED');
    });
  });

  describe('seeded marketplace data', () => {
    it('every hotel card rating and count equals its published review rows', async () => {
      const rows = (
        await db.query(`SELECT p.slug, count(r.id)::int AS n, round(avg(r.overall)::numeric, 1)::float AS avg
                          FROM properties p LEFT JOIN reviews r ON r.property_id = p.id AND r.status IN ('PUBLISHED', 'FLAGGED')
                         WHERE p.slug IN ('palmwine-house', 'ikoyi-lantern', 'eko-tides', 'bodija-heights') GROUP BY p.slug`)
      ).rows as { slug: string; n: number; avg: number | null }[];
      expect(rows).toHaveLength(4);
      for (const r of rows) {
        const card = await request(server()).get(`${API}/public/hotels/${r.slug}`).expect(200);
        expect(r.n).toBeGreaterThan(0);
        expect(card.body.reviewCount).toBe(r.n);
        expect(card.body.rating).toBe(r.avg);
        const dist = card.body.reviewSummary.distribution as Record<string, number>;
        expect(Object.values(dist).reduce((a, b) => a + b, 0)).toBe(r.n);
      }
      const total = (await db.query(`SELECT count(*)::int AS n FROM reviews`)).rows[0].n;
      expect(total).toBeGreaterThanOrEqual(60);
    });
  });

  describe('row-level security for M3 tables', () => {
    it('hotel_app cannot touch platform-level guest identity at all', async () => {
      const c = appRoleClient();
      await c.connect();
      try {
        for (const t of ['guest_accounts', 'guest_otp_challenges', 'guest_refresh_tokens']) {
          await expect(c.query(`SELECT count(*) FROM ${t}`)).rejects.toThrow(/permission denied/);
        }
      } finally {
        await c.end();
      }
    });

    it('booking payments, commission, reviews and notification logs are tenant-isolated', async () => {
      const a = await onlineHotel(app, 1);
      const b = await onlineHotel(app, 1);
      const bk = await book(app, a, { checkIn: lagosDay(25) });
      await postWebhook(app, chargeSuccess(bk.body.payment.reference, 10_750_000)).expect(200);
      const c = appRoleClient();
      await c.connect();
      try {
        const count = async (tenant: string, table: string) => {
          await c.query('BEGIN');
          await setSignedTenant(c, tenant);
          const n = Number((await c.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
          await c.query('ROLLBACK');
          return n;
        };
        for (const t of ['booking_payments', 'commission_entries', 'notification_logs', 'payout_accounts']) {
          expect(await count(a.owner.tenantId, t)).toBeGreaterThan(0);
          expect(await count(b.owner.tenantId, t)).toBe(t === 'payout_accounts' ? 1 : 0);
        }
        // Outside any context nothing is visible; the platform-only OTP log rows never are.
        expect(Number((await c.query(`SELECT count(*) FROM booking_payments`)).rows[0].count)).toBe(0);
        await c.query('BEGIN');
        await setSignedTenant(c, a.owner.tenantId);
        expect(Number((await c.query(`SELECT count(*) FROM notification_logs WHERE tenant_id IS NULL`)).rows[0].count)).toBe(0);
        await expect(c.query(`UPDATE commission_entries SET amount_kobo = 0`)).rejects.toThrow(/permission denied/);
        await c.query('ROLLBACK');
        // The availability function answers only in the signed public context.
        const ids = [(await db.query(`SELECT id FROM properties WHERE tenant_id = $1`, [a.owner.tenantId])).rows[0].id];
        const call = `SELECT count(*) FROM app_public_room_type_peaks($1::uuid[], now(), now() + interval '60 days')`;
        expect(Number((await c.query(call, [ids])).rows[0].count)).toBe(0);
        await c.query('BEGIN');
        await setSignedPublic(c);
        expect(Number((await c.query(call, [ids])).rows[0].count)).toBe(1);
        expect(Number((await c.query(`SELECT count(*) FROM booking_payments`)).rows[0].count)).toBe(0);
        await c.query('ROLLBACK');
      } finally {
        await c.end();
      }
    });

    it('the dev outbox exists outside production only', async () => {
      const res = await request(server()).get(`${API}/public/dev/outbox`).expect(200);
      expect(Array.isArray(res.body.items)).toBe(true);
    });
  });
});
