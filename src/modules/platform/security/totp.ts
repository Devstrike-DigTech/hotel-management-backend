import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238 over RFC 4226 HOTP): HMAC-SHA1, 6 digits, 30-second steps.
 * Verification accepts one step either side for clock drift and reports the
 * matched step so a code can never be used twice.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret (160 bits, base32). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: string, counter: number, digits = TOTP_DIGITS): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totpStep(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
}

export function totp(secret: string, at: Date = new Date()): string {
  return hotp(secret, totpStep(at));
}

/** Seconds until the current code changes. */
export function totpSecondsLeft(at: Date = new Date()): number {
  return TOTP_STEP_SECONDS - (Math.floor(at.getTime() / 1000) % TOTP_STEP_SECONDS);
}

/** The matched time step, or null. `window` steps are accepted either side. */
export function verifyTotp(secret: string, code: string, at: Date = new Date(), window = 1): number | null {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const now = totpStep(at);
  for (let d = -window; d <= window; d++) {
    const expected = hotp(secret, now + d);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return now + d;
  }
  return null;
}

export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Ten recovery codes like "k7qm-2xpw". */
export function newRecoveryCodes(n = 10): string[] {
  const codes: string[] = [];
  while (codes.length < n) {
    const bytes = randomBytes(8);
    const s = [...bytes].map((b) => RC_ALPHABET[b % RC_ALPHABET.length]).join('');
    const code = `${s.slice(0, 4)}-${s.slice(4, 8)}`;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

export function normaliseRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
}
