import { createHmac } from 'node:crypto';
import type { AppConfigService } from '../../config/app-config.service.js';
import { addMonths } from './billing.periods.js';
import { eventKey } from './paystack-webhook.service.js';
import { PaystackClient } from './paystack.client.js';

const SECRET = 'sk_test_unit_0123456789';
const client = (secret: string | null = SECRET) =>
  new PaystackClient({
    get: (k: string) => (k === 'PAYSTACK_SECRET_KEY' ? (secret ?? undefined) : undefined),
    paystackEnabled: Boolean(secret),
  } as unknown as AppConfigService);

const sign = (body: Buffer, key = SECRET) =>
  createHmac('sha512', key).update(body).digest('hex');

describe('PaystackClient.verifySignature', () => {
  const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { id: 1 } }));

  it('accepts the HMAC-SHA512 of the raw body', () => {
    expect(client().verifySignature(body, sign(body))).toBe(true);
  });

  it('rejects a signature made with another key', () => {
    expect(client().verifySignature(body, sign(body, 'sk_other'))).toBe(false);
  });

  it('rejects a signature over a different body (re-serialised JSON)', () => {
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(client().verifySignature(reformatted, sign(body))).toBe(false);
  });

  it('rejects missing signature, missing body or missing key', () => {
    expect(client().verifySignature(body, undefined)).toBe(false);
    expect(client().verifySignature(undefined, sign(body))).toBe(false);
    expect(client(null).verifySignature(body, sign(body))).toBe(false);
  });
});

describe('eventKey', () => {
  it('uses the event type and data id', () => {
    const raw = Buffer.from('{}');
    expect(eventKey({ event: 'charge.success', data: { id: 42 } }, raw)).toBe('paystack:charge.success:42');
  });
  it('falls back to a body hash that is stable for identical retries', () => {
    const raw = Buffer.from('{"event":"x"}');
    expect(eventKey({ event: 'x' }, raw)).toBe(eventKey({ event: 'x' }, Buffer.from('{"event":"x"}')));
  });
});

describe('addMonths', () => {
  it('clamps to the end of shorter months', () => {
    expect(addMonths(new Date('2026-01-31T10:00:00Z'), 1).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addMonths(new Date('2026-03-15T10:00:00Z'), 12).toISOString()).toBe('2027-03-15T10:00:00.000Z');
  });
});
