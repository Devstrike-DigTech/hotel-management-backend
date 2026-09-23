import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import request from 'supertest';
import { API, createApp, ownerClient } from './helpers.js';
import { lagosDay } from './m2-helpers.js';
import {
  book,
  chargeSuccess,
  freshPhone,
  onlineHotel,
  platformToken,
  postWebhook,
  quote,
  randomIp,
  startPaystackStub,
  stopStub,
  type OnlineHotel,
  type PaystackStub,
} from './m3-helpers.js';

describe('M3 online booking, holds and Paystack', () => {
  let app: INestApplication;
  let stub: PaystackStub;
  let db: pg.Client;
  let platform: { Authorization: string };

  beforeAll(async () => {
    stub = await startPaystackStub();
    app = await createApp();
    db = ownerClient();
    await db.connect();
    platform = await platformToken(app);
  });
  afterAll(async () => {
    await db.end();
    await app.close();
    await stopStub(stub);
  });

  const server = () => app.getHttpServer();
  const reservation = async (code: string) => (await db.query(`SELECT * FROM reservations WHERE code = $1`, [code])).rows[0];
  const commission = async (resId: string) =>
    (await db.query(`SELECT kind, accrual, amount_kobo::int AS amount FROM commission_entries WHERE reservation_id = $1 ORDER BY created_at`, [resId])).rows as { kind: string; accrual: boolean; amount: number }[];

  describe('search and quotes', () => {
    let h: OnlineHotel;
    beforeAll(async () => {
      h = await onlineHotel(app, 2);
    });

    it('quotes the authoritative price with VAT and signs it', async () => {
      const q = await quote(app, h, { nights: 2 });
      expect(q.status).toBe(200);
      expect(q.body.breakdown).toMatchObject({ roomSubtotalKobo: 10_000_000, taxTotalKobo: 750_000, totalKobo: 10_750_000, firstNightTotalKobo: 5_375_000 });
      expect(q.body.paymentOptions.map((o: { available: boolean }) => o.available)).toEqual([true, true]);
      expect(q.body.quoteToken).toMatch(/\./);
    });

    it('availability-aware search lists the hotel only while a room is free', async () => {
      const checkIn = lagosDay(40);
      const search = () =>
        request(server())
          .get(`${API}/public/hotels`)
          .set('X-Forwarded-For', randomIp())
          .query({ checkIn, checkOut: lagosDay(41), q: h.slug.replace(/^online-/, ''), pageSize: 48 });
      const before = await search().expect(200);
      const card = before.body.items.find((c: { slug: string }) => c.slug === h.slug);
      expect(card.searchAvailability).toMatchObject({ nights: 1, availableRoomTypes: 1, cheapestRateKobo: 5_000_000, cheapestTotalKobo: 5_375_000 });
      expect(card).toMatchObject({ onlinePayment: true, payAtHotel: true });
      expect((await book(app, h, { checkIn, nights: 1, paymentMode: 'PAY_AT_HOTEL' })).status).toBe(201);
      expect((await book(app, h, { checkIn, nights: 1, paymentMode: 'PAY_AT_HOTEL' })).status).toBe(201);
      const after = await search().expect(200);
      expect(after.body.items.find((c: { slug: string }) => c.slug === h.slug)).toBeUndefined();
      const avail = await request(server()).get(`${API}/public/hotels/${h.slug}/availability`).set('X-Forwarded-For', randomIp()).query({ checkIn, checkOut: lagosDay(41) }).expect(200);
      expect(avail.body.roomTypes[0]).toMatchObject({ available: 0, bookable: false, unavailableReason: 'SOLD_OUT' });
    });

    it('rejects a tampered quote token and the marketplace channel for an unlisted hotel', async () => {
      const q = await quote(app, h);
      const [body, sig] = (q.body.quoteToken as string).split('.');
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), total: 100 })).toString('base64url');
      const res = await request(server()).post(`${API}/public/bookings`).set('X-Forwarded-For', randomIp()).send({ quoteToken: `${forged}.${sig}`, paymentMode: 'PAY_AT_HOTEL', guest: { fullName: 'X Y', phone: freshPhone() }, consent: true });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('QUOTE_INVALID');

      await request(server()).patch(`${API}/property`).set(h.owner.auth).send({ listedOnMarketplace: false }).expect(200);
      const blocked = await quote(app, h, { channel: 'MARKETPLACE' });
      expect(blocked.status).toBe(400);
      expect(blocked.body.code).toBe('CHANNEL_NOT_ALLOWED');
      expect((await quote(app, h, { channel: 'BOOKING_SITE' })).status).toBe(200);
      await request(server()).patch(`${API}/property`).set(h.owner.auth).send({ listedOnMarketplace: true }).expect(200);
    });
  });

  describe('holds', () => {
    it('a hold blocks double-selling the last room under concurrency', async () => {
      const h = await onlineHotel(app, 1);
      const checkIn = lagosDay(12);
      const [q1, q2] = await Promise.all([quote(app, h, { checkIn }), quote(app, h, { checkIn })]);
      const send = (token: string) =>
        request(server())
          .post(`${API}/public/bookings`)
          .set('X-Forwarded-For', randomIp())
          .send({ quoteToken: token, paymentMode: 'ONLINE', guest: { fullName: 'Race Guest', phone: freshPhone(), email: 'race@e2e.test' }, consent: true });
      const results = await Promise.all([send(q1.body.quoteToken), send(q2.body.quoteToken)]);
      const statuses = results.map((r) => r.status).sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);
      const lost = results.find((r) => r.status === 409)!;
      expect(lost.body.code).toBe('ROOM_UNAVAILABLE');
      const won = results.find((r) => r.status === 201)!;
      expect(won.body.booking.displayStatus).toBe('AWAITING_PAYMENT');
      expect(won.body.booking.hold.secondsLeft).toBeGreaterThan(19 * 60);
      expect(won.body.payment.authorizationUrl).toContain('checkout.paystack.test');
      // The hold keeps the room off sale for everyone else.
      const again = await quote(app, h, { checkIn });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ROOM_UNAVAILABLE');
    });

    it('hold expiry frees the inventory and tells the guest', async () => {
      const h = await onlineHotel(app, 1);
      const checkIn = lagosDay(13);
      const b = await book(app, h, { checkIn });
      expect(b.status).toBe(201);
      await db.query(`UPDATE reservations SET hold_expires_at = now() - interval '1 minute' WHERE code = $1`, [b.body.booking.code]);
      const sweep = await request(server()).post(`${API}/platform/jobs/holds/sweep`).set(platform).expect(200);
      expect(sweep.body.expired).toBeGreaterThanOrEqual(1);
      const r = await reservation(b.body.booking.code);
      expect(r.status).toBe('CANCELLED');
      expect(r.cancel_reason).toBe('HOLD_EXPIRED');
      const view = await request(server()).get(`${API}/public/trips/${b.body.booking.code}`).query({ t: b.body.manageToken }).expect(200);
      expect(view.body.displayStatus).toBe('EXPIRED');
      const logs = await db.query(`SELECT template FROM notification_logs WHERE reservation_id = $1`, [r.id]);
      expect(logs.rows.map((x) => x.template)).toContain('HOLD_EXPIRED');
      expect((await quote(app, h, { checkIn })).status).toBe(200);
    });

    it('retrying the same quote returns the same booking instead of a second hold', async () => {
      const h = await onlineHotel(app, 2);
      const q = await quote(app, h);
      const body = { quoteToken: q.body.quoteToken, paymentMode: 'ONLINE', guest: { fullName: 'Retry Guest', phone: freshPhone(), email: 'retry@e2e.test' }, consent: true };
      const a = await request(server()).post(`${API}/public/bookings`).set('X-Forwarded-For', randomIp()).send(body).expect(201);
      const b = await request(server()).post(`${API}/public/bookings`).set('X-Forwarded-For', randomIp()).send(body).expect(201);
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(b.body.booking.code).toBe(a.body.booking.code);
      expect(b.body.payment.reference).toBe(a.body.payment.reference);
    });
  });

  describe('webhook', () => {
    let h: OnlineHotel;
    let booking: request.Response;
    let raw: string;

    beforeAll(async () => {
      h = await onlineHotel(app, 2);
      booking = await book(app, h, { channel: 'MARKETPLACE' });
      expect(booking.status).toBe(201);
    });

    it('initialises a split payment: subaccount, commission as transaction charge, subaccount bears fees', () => {
      const init = stub.inits.get(booking.body.payment.reference)!;
      expect(init.amount).toBe(10_750_000);
      expect(init.subaccount).toMatch(/^ACCT_e2e/);
      expect(init.transaction_charge).toBe(860_000); // 8% (Growth) of room + tax
      expect(init.bearer).toBe('subaccount');
      expect(init.channels).toEqual(['card', 'bank_transfer', 'ussd', 'bank']);
      expect(init.metadata).toMatchObject({ kind: 'booking', tenantId: h.owner.tenantId });
    });

    it('rejects a bad signature and changes nothing', async () => {
      const bad = chargeSuccess(booking.body.payment.reference, 10_750_000);
      const res = await postWebhook(app, bad, 'deadbeef');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_SIGNATURE');
      expect((await reservation(booking.body.booking.code)).status).toBe('PENDING');
    });

    it('charge.success confirms the booking, posts the payment with a receipt and collects commission', async () => {
      raw = chargeSuccess(booking.body.payment.reference, 10_750_000);
      const res = await postWebhook(app, raw).expect(200);
      expect(res.body).toMatchObject({ received: true, handled: true });
      const r = await reservation(booking.body.booking.code);
      expect(r).toMatchObject({ status: 'CONFIRMED', guarantee_type: 'PREPAID', hold_expires_at: null });
      const entries = await db.query(`SELECT e.type, e.amount_kobo::int AS amount, e.payment_method, e.payment_ref, e.shift_id FROM folio_entries e JOIN folios f ON f.id = e.folio_id WHERE f.reservation_id = $1`, [r.id]);
      expect(entries.rows).toEqual([{ type: 'PAYMENT', amount: -10_750_000, payment_method: 'CARD_ONLINE', payment_ref: booking.body.payment.reference, shift_id: null }]);
      const receipts = await db.query(`SELECT number FROM receipts rc JOIN folios f ON f.id = rc.folio_id WHERE f.reservation_id = $1`, [r.id]);
      expect(receipts.rows[0].number).toMatch(/^RCT-\d{4}-\d{6}$/);
      expect(await commission(r.id)).toEqual([{ kind: 'COLLECTED', accrual: false, amount: 860_000 }]);
      const logs = await db.query(`SELECT template, channel FROM notification_logs WHERE reservation_id = $1 ORDER BY template`, [r.id]);
      const templates = logs.rows.map((x) => `${x.template}:${x.channel}`);
      expect(templates).toEqual(expect.arrayContaining(['BOOKING_CONFIRMED:EMAIL', 'BOOKING_CONFIRMED:SMS', 'PAYMENT_RECEIPT:EMAIL', 'HOTEL_NEW_BOOKING:EMAIL']));
      const verify = await request(server()).get(`${API}/public/payments/${booking.body.payment.reference}/verify`).set('X-Forwarded-For', randomIp()).expect(200);
      expect(verify.body).toMatchObject({ state: 'SUCCESS', paymentStatus: 'SUCCEEDED' });
      expect(verify.body.booking).toMatchObject({ displayStatus: 'CONFIRMED', paidKobo: 10_750_000, outstandingKobo: 0 });
    });

    it('a duplicate webhook is acknowledged and not applied twice', async () => {
      const res = await postWebhook(app, raw).expect(200);
      expect(res.body).toMatchObject({ received: true, duplicate: true });
      // A second event id for the same reference (Paystack retry with new id) is also a no-op.
      await postWebhook(app, chargeSuccess(booking.body.payment.reference, 10_750_000)).expect(200);
      const r = await reservation(booking.body.booking.code);
      const payments = await db.query(`SELECT count(*)::int AS n FROM folio_entries e JOIN folios f ON f.id = e.folio_id WHERE f.reservation_id = $1 AND e.type = 'PAYMENT'`, [r.id]);
      expect(payments.rows[0].n).toBe(1);
      expect(await commission(r.id)).toHaveLength(1);
    });

    it('the callback verification confirms too when the webhook is late (both idempotent)', async () => {
      const b = await book(app, h, { checkIn: lagosDay(20) });
      stub.paid.add(b.body.payment.reference);
      const v = await request(server()).get(`${API}/public/payments/${b.body.payment.reference}/verify`).set('X-Forwarded-For', randomIp()).expect(200);
      expect(v.body.state).toBe('SUCCESS');
      await postWebhook(app, chargeSuccess(b.body.payment.reference, 10_750_000)).expect(200);
      const r = await reservation(b.body.booking.code);
      const n = await db.query(`SELECT count(*)::int AS n FROM folio_entries e JOIN folios f ON f.id = e.folio_id WHERE f.reservation_id = $1 AND e.type = 'PAYMENT'`, [r.id]);
      expect(n.rows[0].n).toBe(1);
    });
  });

  describe('channels and commission', () => {
    it('BOOKING_SITE pays zero commission', async () => {
      const h = await onlineHotel(app, 2);
      const b = await book(app, h, { channel: 'BOOKING_SITE' });
      expect(b.status).toBe(201);
      expect(stub.inits.get(b.body.payment.reference)!.transaction_charge).toBe(0);
      await postWebhook(app, chargeSuccess(b.body.payment.reference, 10_750_000)).expect(200);
      const r = await reservation(b.body.booking.code);
      expect(r).toMatchObject({ status: 'CONFIRMED', source: 'BOOKING_SITE', commission_bps: 0 });
      expect(await commission(r.id)).toEqual([]);
    });

    it('pay at hotel confirms at once and accrues commission as a receivable', async () => {
      const h = await onlineHotel(app, 2, { payout: false });
      const online = await book(app, h, { paymentMode: 'ONLINE' });
      expect(online.status).toBe(409);
      expect(online.body.code).toBe('ONLINE_PAYMENT_UNAVAILABLE');
      const b = await book(app, h, { paymentMode: 'PAY_AT_HOTEL' });
      expect(b.status).toBe(201);
      expect(b.body.payment).toBeNull();
      expect(b.body.booking).toMatchObject({ displayStatus: 'CONFIRMED', paymentMode: 'PAY_AT_HOTEL', guaranteeType: 'NONE', outstandingKobo: 10_750_000 });
      const r = await reservation(b.body.booking.code);
      expect(await commission(r.id)).toEqual([{ kind: 'ACCRUED', accrual: false, amount: 860_000 }]);
      const rec = await request(server()).get(`${API}/platform/commission/receivables`).set(platform).expect(200);
      expect(rec.body.items.find((i: { tenantId: string }) => i.tenantId === h.owner.tenantId)).toMatchObject({ accruedKobo: 860_000, dueKobo: 860_000 });
      // A no-show reverses the accrual.
      await db.query(`UPDATE reservations SET arrival_at = now() - interval '2 hours', departure_at = now() + interval '20 hours' WHERE id = $1`, [r.id]);
      await request(server()).post(`${API}/reservations/${r.id}/no-show`).set(h.owner.auth).send({ reason: 'Did not arrive' }).expect(200);
      expect((await commission(r.id)).map((c) => `${c.kind}:${c.accrual}:${c.amount}`)).toEqual(['ACCRUED:false:860000', 'REVERSED:true:860000']);
    });
  });

  describe('orphaned payments', () => {
    it('a late payment for a room that has gone is refunded in full and flagged', async () => {
      const h = await onlineHotel(app, 1);
      const checkIn = lagosDay(15);
      const late = await book(app, h, { checkIn });
      await db.query(`UPDATE reservations SET hold_expires_at = now() - interval '1 minute' WHERE code = $1`, [late.body.booking.code]);
      await request(server()).post(`${API}/platform/jobs/holds/sweep`).set(platform).expect(200);
      const other = await book(app, h, { checkIn, paymentMode: 'PAY_AT_HOTEL' });
      expect(other.status).toBe(201);

      const refundsBefore = stub.refunds.length;
      await postWebhook(app, chargeSuccess(late.body.payment.reference, 10_750_000)).expect(200);
      const pay = (await db.query(`SELECT status, orphan_reason FROM booking_payments WHERE reference = $1`, [late.body.payment.reference])).rows[0];
      expect(pay).toEqual({ status: 'ORPHANED', orphan_reason: 'LATE_NO_INVENTORY' });
      expect(stub.refunds.slice(refundsBefore)).toEqual([{ transaction: late.body.payment.reference, amount: 10_750_000 }]);
      const r = await reservation(late.body.booking.code);
      expect(r.status).toBe('CANCELLED');
      const refund = (await db.query(`SELECT status, reason, amount_kobo::int AS amount FROM booking_refunds WHERE reservation_id = $1`, [r.id])).rows[0];
      expect(refund).toMatchObject({ reason: 'PAYMENT_ORPHANED', amount: 10_750_000, status: 'PENDING' });
      const flag = (await db.query(`SELECT rule, severity FROM guard_flags WHERE reservation_id = $1`, [r.id])).rows[0];
      expect(flag).toEqual({ rule: 'PAYMENT_ORPHANED', severity: 'HIGH' });
      const logs = (await db.query(`SELECT template, audience FROM notification_logs WHERE reservation_id = $1`, [r.id])).rows.map((x) => `${x.template}:${x.audience}`);
      expect(logs).toEqual(expect.arrayContaining(['PAYMENT_ORPHANED_REFUND:GUEST', 'ORPHANED_PAYMENT_ALERT:HOTEL', 'ORPHANED_PAYMENT_ALERT:PLATFORM']));
      const orphans = await request(server()).get(`${API}/platform/payments/orphaned`).set(platform).expect(200);
      expect(orphans.body.items.map((o: { reference: string }) => o.reference)).toContain(late.body.payment.reference);
      const v = await request(server()).get(`${API}/public/payments/${late.body.payment.reference}/verify`).set('X-Forwarded-For', randomIp()).expect(200);
      expect(v.body.state).toBe('ORPHANED');
      const tx = await request(server()).get(`${API}/payouts/transactions`).set(h.owner.auth).expect(200);
      expect(tx.body.items.find((x: { reference: string }) => x.reference === late.body.payment.reference)).toMatchObject({
        status: 'ORPHANED',
        orphanReason: 'LATE_NO_INVENTORY',
        refundedKobo: 10_750_000,
        refundStatus: 'PENDING',
        commissionStatus: 'REVERSED',
        netKobo: 0,
      });

      // refund.processed from Paystack closes it.
      const n = stub.refunds.length + 7_000_000;
      await postWebhook(app, JSON.stringify({ event: 'refund.processed', data: { id: n, transaction_reference: late.body.payment.reference, status: 'processed', amount: 10_750_000 } })).expect(200);
      expect((await db.query(`SELECT status FROM booking_refunds WHERE reservation_id = $1`, [r.id])).rows[0].status).toBe('PROCESSED');
    });

    it('a late payment while the room is still free revives the booking', async () => {
      const h = await onlineHotel(app, 1);
      const b = await book(app, h, { checkIn: lagosDay(16) });
      await db.query(`UPDATE reservations SET hold_expires_at = now() - interval '1 minute' WHERE code = $1`, [b.body.booking.code]);
      await request(server()).post(`${API}/platform/jobs/holds/sweep`).set(platform).expect(200);
      await postWebhook(app, chargeSuccess(b.body.payment.reference, 10_750_000)).expect(200);
      expect((await reservation(b.body.booking.code)).status).toBe('CONFIRMED');
    });

    it('an amount mismatch is orphaned and refunded, not confirmed', async () => {
      const h = await onlineHotel(app, 2);
      const b = await book(app, h);
      await postWebhook(app, chargeSuccess(b.body.payment.reference, 100)).expect(200);
      const pay = (await db.query(`SELECT status, orphan_reason FROM booking_payments WHERE reference = $1`, [b.body.payment.reference])).rows[0];
      expect(pay).toEqual({ status: 'ORPHANED', orphan_reason: 'AMOUNT_MISMATCH' });
      expect((await reservation(b.body.booking.code)).status).toBe('PENDING');
    });
  });

  describe('cancellations and refunds', () => {
    it('guest cancel inside the free window refunds in full and reverses the commission', async () => {
      const h = await onlineHotel(app, 2);
      const b = await book(app, h, { checkIn: lagosDay(20) });
      await postWebhook(app, chargeSuccess(b.body.payment.reference, 10_750_000)).expect(200);
      const t = b.body.manageToken;
      const code = b.body.booking.code;
      const preview = await request(server()).get(`${API}/public/trips/${code}/cancel-preview`).query({ t }).expect(200);
      expect(preview.body).toMatchObject({ canCancel: true, free: true, feeKobo: 0, refundKobo: 10_750_000 });
      const before = stub.refunds.length;
      const res = await request(server()).post(`${API}/public/trips/${code}/cancel`).query({ t }).set('X-Forwarded-For', randomIp()).send({ reason: 'Plans changed' }).expect(200);
      expect(res.body.booking).toMatchObject({ status: 'CANCELLED', displayStatus: 'CANCELLED' });
      expect(res.body.cancellation).toMatchObject({ feeKobo: 0, refundKobo: 10_750_000, refundStatus: 'PENDING' });
      expect(stub.refunds.slice(before)).toEqual([{ transaction: b.body.payment.reference, amount: 10_750_000 }]);
      const r = await reservation(code);
      expect(r.cancelled_by).toBe('GUEST');
      expect((await commission(r.id)).map((c) => `${c.kind}:${c.amount}`)).toEqual(['COLLECTED:860000', 'REVERSED:860000']);
      const folio = await db.query(`SELECT e.type, e.amount_kobo::int AS amount FROM folio_entries e JOIN folios f ON f.id = e.folio_id WHERE f.reservation_id = $1 ORDER BY e.created_at`, [r.id]);
      expect(folio.rows).toEqual([
        { type: 'PAYMENT', amount: -10_750_000 },
        { type: 'REFUND', amount: 10_750_000 },
      ]);
      // Paystack confirms the refund.
      const refundRow = (await db.query(`SELECT provider_refund_id FROM booking_refunds WHERE reservation_id = $1`, [r.id])).rows[0];
      await postWebhook(app, JSON.stringify({ event: 'refund.processed', data: { id: Number(refundRow.provider_refund_id), transaction_reference: b.body.payment.reference, status: 'processed' } })).expect(200);
      expect((await db.query(`SELECT status FROM booking_payments WHERE reference = $1`, [b.body.payment.reference])).rows[0].status).toBe('REFUNDED');
      // Cannot cancel twice.
      const again = await request(server()).post(`${API}/public/trips/${code}/cancel`).query({ t }).set('X-Forwarded-For', randomIp()).send({});
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('INVALID_STATE');
    });

    it('a late guest cancel keeps the first night and reverses commission in proportion', async () => {
      const h = await onlineHotel(app, 2);
      const b = await book(app, h, { checkIn: lagosDay(1), nights: 2 });
      await postWebhook(app, chargeSuccess(b.body.payment.reference, 10_750_000)).expect(200);
      const res = await request(server()).post(`${API}/public/trips/${b.body.booking.code}/cancel`).query({ t: b.body.manageToken }).set('X-Forwarded-For', randomIp()).send({}).expect(200);
      expect(res.body.cancellation).toMatchObject({ free: false, feeKobo: 5_375_000, refundKobo: 5_375_000 });
      const r = await reservation(b.body.booking.code);
      expect((await commission(r.id)).map((c) => `${c.kind}:${c.amount}`)).toEqual(['COLLECTED:860000', 'REVERSED:430000']);
      const folio = await db.query(`SELECT e.type, e.amount_kobo::int AS amount FROM folio_entries e JOIN folios f ON f.id = e.folio_id WHERE f.reservation_id = $1 ORDER BY e.created_at`, [r.id]);
      expect(folio.rows.reduce((a, e) => a + e.amount, 0)).toBe(0);
      expect(folio.rows.map((e) => e.type)).toEqual(['PAYMENT', 'EXTRA', 'REFUND']);
    });

    it('a hotel cancel of a paid booking refunds in full', async () => {
      const h = await onlineHotel(app, 2);
      const b = await book(app, h, { checkIn: lagosDay(2), nights: 1 });
      await postWebhook(app, chargeSuccess(b.body.payment.reference, 5_375_000)).expect(200);
      const r = await reservation(b.body.booking.code);
      const withFee = await request(server()).post(`${API}/reservations/${r.id}/cancel`).set(h.owner.auth).send({ reason: 'Burst pipe', feeKobo: 100 });
      expect(withFee.status).toBe(400);
      const res = await request(server()).post(`${API}/reservations/${r.id}/cancel`).set(h.owner.auth).send({ reason: 'Burst pipe in the room' }).expect(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.online).toMatchObject({ cancelledBy: 'HOTEL', refunds: [expect.objectContaining({ amountKobo: 5_375_000, reason: 'HOTEL_CANCELLED' })] });
      expect(res.body.online.commission).toMatchObject({ collectedKobo: 430_000, reversedKobo: 430_000, netKobo: 0 });
      const logs = (await db.query(`SELECT template FROM notification_logs WHERE reservation_id = $1`, [r.id])).rows.map((x) => x.template);
      expect(logs).toContain('BOOKING_CANCELLED');
      const staffLog = await request(server()).get(`${API}/reservations/${r.id}/notifications`).set(h.owner.auth).expect(200);
      expect(staffLog.body.map((n: { template: string }) => n.template)).toContain('BOOKING_CANCELLED');
      expect(staffLog.body[0].recipientMasked).toMatch(/•••/);
    });
  });

  describe('hotel views', () => {
    it('lists show payment mode and hold countdown; the feed shows online bookings', async () => {
      const h = await onlineHotel(app, 2);
      const since = new Date(Date.now() - 1000).toISOString();
      const b = await book(app, h);
      const list = await request(server()).get(`${API}/reservations`).set(h.owner.auth).expect(200);
      const item = list.body.items.find((x: { code: string }) => x.code === b.body.booking.code);
      expect(item).toMatchObject({ source: 'MARKETPLACE', paymentMode: 'ONLINE', status: 'PENDING' });
      expect(new Date(item.holdExpiresAt).getTime()).toBeGreaterThan(Date.now());
      const detail = await request(server()).get(`${API}/reservations/${item.id}`).set(h.owner.auth).expect(200);
      expect(detail.body.online.payments[0]).toMatchObject({ status: 'INITIALIZED', commissionKobo: 860_000, commissionStatus: 'PENDING', commissionTakenKobo: 0 });
      expect(detail.body.online.commission).toMatchObject({ collectedKobo: 0, pendingKobo: 860_000 });
      const feed = await request(server()).get(`${API}/online-bookings/feed`).query({ since }).set(h.owner.auth).expect(200);
      expect(feed.body.items[0]).toMatchObject({ code: b.body.booking.code, event: 'NEW_BOOKING', displayStatus: 'AWAITING_PAYMENT' });
      expect(feed.body.counts.activeHolds).toBe(1);
      const settings = await request(server()).get(`${API}/booking-settings`).set(h.owner.auth).expect(200);
      expect(settings.body).toMatchObject({ payoutReady: true, commissionBps: 800, cancellationPolicy: { freeCancellationHours: 48 } });
    });
  });

  describe('rate limits', () => {
    it('public quotes trip 429 after 30 a minute from one IP', async () => {
      const ip = randomIp();
      let last: request.Response | null = null;
      for (let i = 0; i < 31; i++) {
        last = await request(server()).post(`${API}/public/quotes`).set('X-Forwarded-For', ip).send({ hotelSlug: 'no-such-hotel', roomTypeId: '00000000-0000-0000-0000-000000000000', channel: 'MARKETPLACE', checkIn: lagosDay(5), checkOut: lagosDay(6) });
      }
      expect(last!.status).toBe(429);
      expect(last!.body).toMatchObject({ code: 'RATE_LIMITED', details: { scope: 'ip' } });
      expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
      // Another IP is not affected.
      const other = await request(server()).post(`${API}/public/quotes`).set('X-Forwarded-For', randomIp()).send({ hotelSlug: 'no-such-hotel', roomTypeId: '00000000-0000-0000-0000-000000000000', channel: 'MARKETPLACE', checkIn: lagosDay(5), checkOut: lagosDay(6) });
      expect(other.status).toBe(404);
    });
  });
});
