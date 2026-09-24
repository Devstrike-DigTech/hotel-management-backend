/** Minimal OIDC helpers (M6 SSO): PKCE, JWT (RS256) verification. Pure, unit tested. */
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

export const b64url = (buf: Buffer) => buf.toString('base64url');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function randomToken(bytes = 24): string {
  return b64url(randomBytes(bytes));
}

export interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
}

export class IdTokenError extends Error {}

/** Verifies an RS256 ID token against a JWKS and the expected issuer, audience and nonce. */
export function verifyIdToken(
  token: string,
  jwks: { keys: (JsonWebKey & { kid?: string; alg?: string })[] },
  expect: { issuer: string; audience: string; nonce: string; now?: number; skewSec?: number },
): IdTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new IdTokenError('Malformed ID token');
  const [h, p, sig] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: IdTokenClaims;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as IdTokenClaims;
  } catch {
    throw new IdTokenError('Malformed ID token');
  }
  if (header.alg !== 'RS256') throw new IdTokenError(`Unsupported algorithm ${header.alg ?? '(none)'}`);
  const candidates = jwks.keys.filter((k) => k.kty === 'RSA' && (!header.kid || k.kid === header.kid));
  const ok = candidates.some((k) => {
    try {
      const key = createPublicKey({ key: k, format: 'jwk' });
      return cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(sig, 'base64url'));
    } catch {
      return false;
    }
  });
  if (!ok) throw new IdTokenError('ID token signature does not verify');
  const now = expect.now ?? Math.floor(Date.now() / 1000);
  const skew = expect.skewSec ?? 60;
  if (claims.iss !== expect.issuer) throw new IdTokenError('Issuer mismatch');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expect.audience)) throw new IdTokenError('Audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp + skew < now) throw new IdTokenError('ID token expired');
  if (claims.nonce !== expect.nonce) throw new IdTokenError('Nonce mismatch');
  return claims;
}

export function emailDomainOf(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

/** Issuer of well-known providers. */
export function defaultIssuer(provider: string, issuer: string | undefined): string | null {
  if (provider === 'GOOGLE') return 'https://accounts.google.com';
  return issuer?.replace(/\/$/, '') || null;
}
