import type { INestApplication } from '@nestjs/common';
import { createHmac, randomInt } from 'node:crypto';
import http from 'node:http';
import request from 'supertest';
import { API, platformAuth, signup, uniq, type SignedUp } from './helpers.js';
import { lagosDay } from './m2-helpers.js';

export type Auth = { Authorization: string };

export interface StubInit {
  reference: string;
  amount: number;
  email: string;
  subaccount?: string;
  transaction_charge?: number;
  bearer?: string;
  channels?: string[];
  callback_url: string;
  metadata: Record<string, unknown>;
}

/** A stateful stand-in for https://api.paystack.co (PAYSTACK_BASE_URL points here). */
export interface PaystackStub {
  server: http.Server;
  inits: Map<string, StubInit>;
  refunds: { transaction: string; amount: number }[];
  /** Transactions the "guest" has paid (verify answers success for them). */
  paid: Set<string>;
  refundStatus: 'pending' | 'processed' | 'reject';
}

export function startPaystackStub(): Promise<PaystackStub> {
  const stub: PaystackStub = { server: null as unknown as http.Server, inits: new Map(), refunds: [], paid: new Set(), refundStatus: 'pending' };
  stub.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const url = new URL(req.url ?? '/', 'http://stub');
      const send = (status: number, data: unknown, message = 'ok') => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: status < 400, message, data }));
      };
      if (url.pathname === '/transaction/initialize') {
        const init = body as unknown as StubInit;
        stub.inits.set(init.reference, init);
        return send(200, { authorization_url: `https://checkout.paystack.test/${init.reference}`, access_code: `ac_${init.reference}`, reference: init.reference });
      }
      if (url.pathname.startsWith('/transaction/verify/')) {
        const ref = decodeURIComponent(url.pathname.split('/').pop()!);
        const init = stub.inits.get(ref);
        if (!init) return send(404, null, 'Transaction reference not found');
        const ok = stub.paid.has(ref);
        return send(200, { status: ok ? 'success' : 'abandoned', amount: init.amount, currency: 'NGN', paid_at: ok ? new Date().toISOString() : null, channel: ok ? 'card' : null, id: 9_000_000 + randomInt(999_999), metadata: init.metadata });
      }
      if (url.pathname === '/refund') {
        if (stub.refundStatus === 'reject') return send(400, null, 'Refund declined');
        stub.refunds.push({ transaction: String(body.transaction), amount: Number(body.amount) });
        return send(200, { id: 7_000_000 + stub.refunds.length, status: stub.refundStatus });
      }
      if (url.pathname === '/bank') return send(200, [{ code: '058', name: 'Guaranty Trust Bank', slug: 'guaranty-trust-bank', type: 'nuban', active: true }]);
      if (url.pathname === '/bank/resolve') {
        const acct = url.searchParams.get('account_number') ?? '';
        return acct.startsWith('000') ? send(422, null, 'Could not resolve account name') : send(200, { account_name: 'E2E TEST HOSPITALITY', account_number: acct });
      }
      if (url.pathname === '/subaccount' || url.pathname.startsWith('/subaccount/')) return send(200, { subaccount_code: `ACCT_e2e${uniq()}`, is_verified: true });
      // M1 subscription checkout and anything else.
      return send(200, { authorization_url: 'https://checkout.paystack.test/abc', access_code: 'abc', reference: 'x' });
    });
  });
  const port = Number(new URL(process.env.PAYSTACK_BASE_URL!).port);
  return new Promise((resolve) => stub.server.listen(port, '127.0.0.1', () => resolve(stub)));
}

export const stopStub = (s: PaystackStub) => new Promise((r) => s.server.close(r));

/** A random client IP per test, so per-IP rate limits never leak between tests or runs. */
export function randomIp(): string {
  return `10.${randomInt(255)}.${randomInt(255)}.${1 + randomInt(250)}`;
}

let phoneCounter = randomInt(1_000_000);
/** A fresh Nigerian mobile number (per-phone limits never collide). */
export function freshPhone(): string {
  phoneCounter = (phoneCounter + 7919) % 100_000_000;
  return `+23470${String(phoneCounter).padStart(8, '0')}`;
}

export function signWebhook(raw: string, key = process.env.PAYSTACK_SECRET_KEY!): string {
  return createHmac('sha512', key).update(raw).digest('hex');
}

export interface OnlineHotel {
  owner: SignedUp;
  slug: string;
  typeId: string;
  rooms: { id: string; number: string }[];
}

/** Growth-trial hotel with one room type (5,000,000 kobo a night), `roomCount` rooms and a payout subaccount. */
export async function onlineHotel(app: INestApplication, roomCount = 2, opts: { payout?: boolean } = {}): Promise<OnlineHotel> {
  const server = app.getHttpServer();
  const owner = await signup(app, 'Online');
  const type = await request(server)
    .post(`${API}/room-types`)
    .set(owner.auth)
    .send({ name: `Deluxe ${uniq()}`, basePriceKobo: 5_000_000, capacity: 2, bedType: 'King', sizeSqm: 24 })
    .expect(201);
  const rooms = (
    await request(server).post(`${API}/rooms/bulk`).set(owner.auth).send({ roomTypeId: type.body.id, floor: 1, from: 101, to: 100 + roomCount }).expect(201)
  ).body.map((r: { id: string; number: string }) => ({ id: r.id, number: r.number }));
  if (opts.payout !== false) {
    await request(server).put(`${API}/payouts/account`).set(owner.auth).send({ bankCode: '058', accountNumber: '0123456789' }).expect(200);
  }
  const prop = await request(server).get(`${API}/property`).set(owner.auth).expect(200);
  return { owner, slug: prop.body.slug as string, typeId: type.body.id as string, rooms };
}

export interface BookOpts {
  channel?: 'MARKETPLACE' | 'BOOKING_SITE';
  paymentMode?: 'ONLINE' | 'PAY_AT_HOTEL';
  checkIn?: string;
  nights?: number;
  phone?: string;
  guestToken?: string;
  ip?: string;
}

export async function quote(app: INestApplication, h: OnlineHotel, o: BookOpts = {}): Promise<request.Response> {
  const checkIn = o.checkIn ?? lagosDay(10);
  return request(app.getHttpServer())
    .post(`${API}/public/quotes`)
    .set('X-Forwarded-For', o.ip ?? randomIp())
    .send({ hotelSlug: h.slug, roomTypeId: h.typeId, channel: o.channel ?? 'MARKETPLACE', checkIn, checkOut: lagosDay(daysFromToday(checkIn) + (o.nights ?? 2)), adults: 2 });
}

export async function book(app: INestApplication, h: OnlineHotel, o: BookOpts = {}): Promise<request.Response> {
  const q = await quote(app, h, o);
  if (q.status !== 200) return q;
  const req = request(app.getHttpServer())
    .post(`${API}/public/bookings`)
    .set('X-Forwarded-For', o.ip ?? randomIp());
  if (o.guestToken) req.set('Authorization', `Bearer ${o.guestToken}`);
  return req.send({
    quoteToken: q.body.quoteToken,
    paymentMode: o.paymentMode ?? 'ONLINE',
    guest: o.guestToken ? undefined : { fullName: 'Amaka Test', phone: o.phone ?? freshPhone(), email: `guest-${uniq()}@e2e.test` },
    consent: true,
  });
}

export function daysFromToday(date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${lagosDay(0)}T00:00:00Z`)) / 86_400_000);
}

export function chargeSuccess(reference: string, amount: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    event: 'charge.success',
    data: { id: randomInt(1, 2_000_000_000), reference, amount, currency: 'NGN', status: 'success', paid_at: new Date().toISOString(), channel: 'card', metadata: { kind: 'booking' }, ...extra },
  });
}

export function postWebhook(app: INestApplication, raw: string, signature = signWebhook(raw)) {
  return request(app.getHttpServer()).post(`${API}/billing/webhooks/paystack`).set('Content-Type', 'application/json').set('x-paystack-signature', signature).send(raw);
}

export async function platformToken(app: INestApplication): Promise<Auth> {
  return platformAuth(app);
}

/** Signs a guest in with the OTP from the dev outbox. */
export async function guestLogin(app: INestApplication, phone = freshPhone()) {
  const server = app.getHttpServer();
  const ip = randomIp();
  const start = await request(server).post(`${API}/public/auth/otp/start`).set('X-Forwarded-For', ip).send({ phone }).expect(200);
  const code = await otpFromOutbox(app, phone);
  const res = await request(server).post(`${API}/public/auth/otp/verify`).set('X-Forwarded-For', ip).send({ challengeId: start.body.challengeId, code }).expect(200);
  return { token: res.body.accessToken as string, refresh: res.body.refreshToken as string, phone, account: res.body.guest as { id: string } };
}

export async function otpFromOutbox(app: INestApplication, phone: string): Promise<string> {
  const res = await request(app.getHttpServer()).get(`${API}/public/dev/outbox`).query({ to: phone, limit: 5 }).expect(200);
  const m = (res.body.items as { template: string; meta: { otpCode?: string } }[]).find((x) => x.template === 'OTP');
  if (!m?.meta.otpCode) throw new Error(`no OTP in the outbox for ${phone}`);
  return m.meta.otpCode;
}
