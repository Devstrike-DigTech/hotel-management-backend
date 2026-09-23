import { fingerprint, stableStringify } from './idempotency.interceptor.js';

describe('idempotency fingerprint', () => {
  it('ignores key order and undefined fields', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [1, { z: 1, y: 2 }] }, u: undefined })).toBe('{"a":{"c":[1,{"y":2,"z":1}],"d":2},"b":1}');
    expect(fingerprint('POST', '/x', { a: 1, b: 2 })).toBe(fingerprint('post', '/x', { b: 2, a: 1 }));
  });
  it('changes with method, path or body', () => {
    const base = fingerprint('POST', '/folios/1/payments', { amountKobo: 100 });
    expect(fingerprint('PATCH', '/folios/1/payments', { amountKobo: 100 })).not.toBe(base);
    expect(fingerprint('POST', '/folios/2/payments', { amountKobo: 100 })).not.toBe(base);
    expect(fingerprint('POST', '/folios/1/payments', { amountKobo: 101 })).not.toBe(base);
  });
});
