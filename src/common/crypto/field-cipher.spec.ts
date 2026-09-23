import { FieldCipher, last4Of, maskIdNumber } from './field-cipher.js';
import { signToken, verifyToken } from './signed-token.js';

const key = 'unit-test-guest-data-key-0123456789abcdef';

describe('FieldCipher', () => {
  it('round-trips and uses a fresh IV per value', () => {
    const c = new FieldCipher(key);
    const a = c.encrypt('12345678901', 'tenant-a');
    const b = c.encrypt('12345678901', 'tenant-a');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toContain('12345678901');
    expect(c.decrypt(a, 'tenant-a')).toBe('12345678901');
  });

  it('fails with the wrong tenant (AAD) or a tampered value', () => {
    const c = new FieldCipher(key);
    const a = c.encrypt('A01234567', 'tenant-a');
    expect(() => c.decrypt(a, 'tenant-b')).toThrow();
    const parts = a.split(':');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => c.decrypt(parts.join(':'), 'tenant-a')).toThrow();
  });

  it('fails with another key', () => {
    const a = new FieldCipher(key).encrypt('A01234567', 't');
    expect(() => new FieldCipher(`${key}-other`).decrypt(a, 't')).toThrow();
  });

  it('masks ID numbers', () => {
    expect(maskIdNumber(last4Of('1234 5678 4821'))).toBe('••••••4821');
    expect(maskIdNumber(null)).toBeNull();
  });
});

describe('signed tokens', () => {
  const secret = 'unit-test-share-secret-0123456789abcdef';
  it('verifies, rejects tampering, other purposes and expiry', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = signToken(secret, 'doc', { id: 'x', exp });
    expect(verifyToken(secret, 'doc', token)).toEqual({ ok: true, payload: { id: 'x', exp } });
    expect(verifyToken(secret, 'file', token)).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyToken(secret, 'doc', `${token}x`)).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyToken(secret, 'doc', token, new Date(Date.now() + 120_000))).toEqual({ ok: false, reason: 'expired' });
  });
});
