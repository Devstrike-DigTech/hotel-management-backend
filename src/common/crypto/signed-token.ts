import { createHmac, timingSafeEqual } from 'node:crypto';

export type TokenResult<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: 'invalid' | 'expired' };

/**
 * Compact stateless signed token: `base64url(json).base64url(hmac)`.
 * The payload must carry `exp` (unix seconds).
 */
export function signToken<T extends { exp: number }>(
  secret: string,
  purpose: string,
  payload: T,
): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${mac(secret, purpose, body)}`;
}

export function verifyToken<T extends { exp: number }>(
  secret: string,
  purpose: string,
  token: string,
  now: Date = new Date(),
): TokenResult<T> {
  const [body, sig] = token.split('.');
  if (!body || !sig) return { ok: false, reason: 'invalid' };
  const expected = Buffer.from(mac(secret, purpose, body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'invalid' };
  }
  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof payload.exp !== 'number') return { ok: false, reason: 'invalid' };
  if (payload.exp * 1000 < now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

function mac(secret: string, purpose: string, body: string): string {
  return createHmac('sha256', secret).update(`${purpose}.${body}`).digest('base64url');
}
