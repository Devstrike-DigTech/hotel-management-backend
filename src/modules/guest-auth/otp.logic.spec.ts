import { evaluateAttempt, generateOtp, hashOtp, maskedPhone, OTP_MAX_ATTEMPTS, otpMatches } from './otp.logic.js';

const SECRET = 'unit-otp-secret-0123456789abcdef0123456789';

describe('OTP hashing', () => {
  it('generates six digits, leading zeros included', () => {
    for (let i = 0; i < 200; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
  });

  it('stores only a keyed hash bound to the challenge', () => {
    const h = hashOtp(SECRET, 'challenge-a', '123456');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('123456');
    expect(hashOtp(SECRET, 'challenge-b', '123456')).not.toBe(h);
    expect(hashOtp('another-secret-0123456789abcdef0123456789', 'challenge-a', '123456')).not.toBe(h);
  });

  it('matches the right code only', () => {
    const h = hashOtp(SECRET, 'c1', '004217');
    expect(otpMatches(SECRET, 'c1', '004217', h)).toBe(true);
    expect(otpMatches(SECRET, 'c1', ' 004217 ', h)).toBe(true);
    expect(otpMatches(SECRET, 'c1', '004218', h)).toBe(false);
    expect(otpMatches(SECRET, 'c2', '004217', h)).toBe(false);
  });

  it('masks the phone for display', () => {
    expect(maskedPhone('+2348030000001')).toBe('+234803•••0001');
  });
});

describe('OTP attempts and lockout', () => {
  const now = new Date('2026-10-01T10:00:00Z');
  const fresh = { expiresAt: new Date('2026-10-01T10:05:00Z'), consumedAt: null, lockedAt: null, attempts: 0, maxAttempts: OTP_MAX_ATTEMPTS };

  it('counts down wrong codes and locks on the fifth', () => {
    const results = [0, 1, 2, 3, 4].map((attempts) => evaluateAttempt({ ...fresh, attempts }, false, now));
    expect(results.map((r) => (r.kind === 'invalid' ? r.attemptsLeft : r.kind))).toEqual([4, 3, 2, 1, 0]);
    expect(results[4]).toMatchObject({ kind: 'invalid', lockNow: true });
    expect(results[3]).toMatchObject({ lockNow: false });
  });

  it('refuses even the right code once locked, expired or used', () => {
    expect(evaluateAttempt({ ...fresh, attempts: 5 }, true, now).kind).toBe('locked');
    expect(evaluateAttempt({ ...fresh, lockedAt: now }, true, now).kind).toBe('locked');
    expect(evaluateAttempt({ ...fresh, expiresAt: now }, true, now).kind).toBe('expired');
    expect(evaluateAttempt({ ...fresh, consumedAt: now }, true, now).kind).toBe('expired');
    expect(evaluateAttempt(fresh, true, now).kind).toBe('ok');
  });
});
