import type { INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import request from 'supertest';
import { API, createApp, signup, type SignedUp } from './helpers.js';

const SECRET = process.env.PAYSTACK_SECRET_KEY!;
const sign = (raw: string, key = SECRET) => createHmac('sha512', key).update(raw).digest('hex');

/** Stands in for https://api.paystack.co (PAYSTACK_BASE_URL points here). */
function startPaystackStub(): Promise<{ server: http.Server; calls: unknown[] }> {
  const calls: unknown[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          status: true,
          message: 'Authorization URL created',
          data: { authorization_url: 'https://checkout.paystack.test/abc', access_code: 'abc', reference: 'x' },
        }),
      );
    });
  });
  const port = Number(new URL(process.env.PAYSTACK_BASE_URL!).port);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, calls })));
}

describe('Billing and Paystack webhooks', () => {
  let app: INestApplication;
  let stub: { server: http.Server; calls: unknown[] };
  let t: SignedUp;

  beforeAll(async () => {
    stub = await startPaystackStub();
    app = await createApp();
    t = await signup(app, 'Billing');
  });
  afterAll(async () => {
    await app.close();
    await new Promise((r) => stub.server.close(r));
  });

  const post = (raw: string, signature?: string) => {
    const req = request(app.getHttpServer())
      .post(`${API}/billing/webhooks/paystack`)
      .set('Content-Type', 'application/json');
    if (signature !== undefined) req.set('x-paystack-signature', signature);
    return req.send(raw);
  };

  it('checkout creates a pending invoice and returns the Paystack URL', async () => {
    const res = await request(app.getHttpServer())
      .post(`${API}/billing/checkout`)
      .set(t.auth)
      .send({ planCode: 'pro', interval: 'MONTHLY' })
      .expect(200);
    expect(res.body).toEqual({ authorizationUrl: 'https://checkout.paystack.test/abc', reference: expect.stringMatching(/^INV-/) });
    expect(stub.calls.at(-1)).toMatchObject({
      path: '/transaction/initialize',
      auth: `Bearer ${SECRET}`,
      body: { amount: 18_000_000, currency: 'NGN', reference: res.body.reference },
    });
  });

  it('rejects a webhook with no signature', async () => {
    const res = await post(JSON.stringify({ event: 'charge.success', data: { id: 1 } })).expect(401);
    expect(res.body.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects a webhook signed with the wrong key', async () => {
    const raw = JSON.stringify({ event: 'charge.success', data: { id: 2 } });
    const res = await post(raw, sign(raw, 'sk_test_attacker')).expect(401);
    expect(res.body.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects a webhook whose body was altered after signing', async () => {
    const raw = JSON.stringify({ event: 'charge.success', data: { id: 3, amount: 100 } });
    const tampered = raw.replace('100', '999999999');
    await post(tampered, sign(raw)).expect(401);
  });

  it('a valid charge.success activates the subscription, and a replay is ignored', async () => {
    const checkout = await request(app.getHttpServer())
      .post(`${API}/billing/checkout`)
      .set(t.auth)
      .send({ planCode: 'pro', interval: 'MONTHLY' })
      .expect(200);
    const reference = checkout.body.reference;
    const raw = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 900_000_001,
        reference,
        amount: 18_000_000,
        currency: 'NGN',
        status: 'success',
        customer: { customer_code: 'CUS_e2e', email: t.email },
      },
    });

    const first = await post(raw, sign(raw)).expect(200);
    expect(first.body).toEqual({ received: true, handled: true });

    const me = await request(app.getHttpServer()).get(`${API}/me`).set(t.auth).expect(200);
    expect(me.body.subscription).toMatchObject({ planCode: 'pro', status: 'ACTIVE' });

    const invoices = await request(app.getHttpServer()).get(`${API}/billing/invoices`).set(t.auth).expect(200);
    const inv = invoices.body.find((i: { reference: string }) => i.reference === reference);
    expect(inv).toMatchObject({ status: 'PAID', amountKobo: 18_000_000, planCode: 'pro' });

    const periodEnd = me.body.subscription.currentPeriodEnd;
    const replay = await post(raw, sign(raw)).expect(200);
    expect(replay.body).toEqual({ received: true, duplicate: true });
    const again = await request(app.getHttpServer()).get(`${API}/me`).set(t.auth).expect(200);
    expect(again.body.subscription.currentPeriodEnd).toBe(periodEnd);
  });

  it('an underpaid charge does not activate anything', async () => {
    const u = await signup(app, 'Underpaid');
    const checkout = await request(app.getHttpServer())
      .post(`${API}/billing/checkout`)
      .set(u.auth)
      .send({ planCode: 'growth', interval: 'YEARLY' })
      .expect(200);
    const raw = JSON.stringify({
      event: 'charge.success',
      data: { id: 900_000_002, reference: checkout.body.reference, amount: 100, currency: 'NGN' },
    });
    await post(raw, sign(raw)).expect(200);
    const me = await request(app.getHttpServer()).get(`${API}/me`).set(u.auth).expect(200);
    expect(me.body.subscription.status).toBe('TRIALING');
  });

  it('invoice.payment_failed moves an ACTIVE subscription to PAST_DUE', async () => {
    const raw = JSON.stringify({
      event: 'invoice.payment_failed',
      data: { id: 900_000_003, customer: { customer_code: 'CUS_e2e' } },
    });
    await post(raw, sign(raw)).expect(200);
    const me = await request(app.getHttpServer()).get(`${API}/me`).set(t.auth).expect(200);
    expect(me.body.subscription.status).toBe('PAST_DUE');
  });
});
