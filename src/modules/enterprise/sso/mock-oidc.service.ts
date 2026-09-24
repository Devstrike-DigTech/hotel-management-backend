import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { AppException } from '../../../common/errors/app-exception.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DbService } from '../../../prisma/db.service.js';
import { b64url, randomToken, type Discovery } from './oidc.js';

export const MOCK_CLIENT_ID = 'dev-client';
export const MOCK_CLIENT_SECRET = 'dev-secret';

interface PendingCode {
  clientId: string;
  redirectUri: string;
  nonce: string | null;
  email: string;
  name: string;
  challenge: string | null;
  expiresAt: number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Development OIDC provider (M6): discovery, authorize (a small sign-in page,
 * or straight through with `login_hint`), token (authorization code + PKCE),
 * JWKS and userinfo. The key pair lives in memory; never enabled in
 * production.
 */
@Injectable()
export class MockOidcService {
  private readonly privateKey: KeyObject;
  private readonly jwk: Record<string, unknown>;
  private readonly kid: string;
  private readonly codes = new Map<string, PendingCode>();
  private readonly accessTokens = new Map<string, { email: string; name: string; expiresAt: number }>();

  constructor(
    private readonly config: AppConfigService,
    private readonly db: DbService,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    this.kid = createHash('sha256').update(JSON.stringify(this.jwk)).digest('hex').slice(0, 16);
  }

  get enabled(): boolean {
    if (this.config.get('NODE_ENV') === 'production') return false;
    return this.config.get('OIDC_MOCK_ENABLED') ?? true;
  }

  get issuer(): string {
    return `${this.config.get('API_PUBLIC_URL').replace(/\/$/, '')}/api/v1/dev/oidc`;
  }

  assertEnabled() {
    if (!this.enabled) throw AppException.notFound('Route');
  }

  discovery(): Discovery & Record<string, unknown> {
    const i = this.issuer;
    return {
      issuer: i,
      authorization_endpoint: `${i}/authorize`,
      token_endpoint: `${i}/token`,
      jwks_uri: `${i}/jwks`,
      userinfo_endpoint: `${i}/userinfo`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid', 'email', 'profile'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    };
  }

  jwks() {
    return { keys: [{ ...this.jwk, kid: this.kid, alg: 'RS256', use: 'sig' }] };
  }

  /** Emails a developer can pick on the sign-in page (staff of tenants using this issuer). */
  async knownEmails(): Promise<string[]> {
    const configs = await this.db.system((tx) => tx.ssoConfig.findMany({ where: { issuer: this.issuer }, select: { tenantId: true } }));
    const out: string[] = [];
    for (const c of configs) {
      const users = await this.db.systemFor(c.tenantId, (tx) => tx.user.findMany({ where: { tenantId: c.tenantId, isActive: true }, select: { email: true }, orderBy: { email: 'asc' }, take: 30 }));
      out.push(...users.map((u) => u.email));
    }
    return [...new Set(out)];
  }

  /** Issues a code for `email` and returns the redirect URL. */
  authorize(q: Record<string, string | undefined>, email: string): string {
    if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email.trim())) throw new AppException(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'login_hint must be an email address');
    if (q.response_type !== 'code') throw new AppException(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'response_type must be code');
    if (q.client_id !== MOCK_CLIENT_ID) throw new AppException(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'Unknown client_id');
    if (!q.redirect_uri) throw new AppException(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', 'redirect_uri is required');
    const code = randomToken();
    const clean = email.trim().toLowerCase();
    this.codes.set(code, {
      clientId: q.client_id,
      redirectUri: q.redirect_uri,
      nonce: q.nonce ?? null,
      email: clean,
      name: clean.split('@')[0]!.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      challenge: q.code_challenge ?? null,
      expiresAt: Date.now() + 5 * 60_000,
    });
    const u = new URL(q.redirect_uri);
    u.searchParams.set('code', code);
    if (q.state) u.searchParams.set('state', q.state);
    return u.toString();
  }

  signInPage(q: Record<string, string | undefined>, emails: string[]): string {
    const hidden = Object.entries(q)
      .filter(([k, v]) => v !== undefined && k !== 'login_hint')
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v!)}">`)
      .join('');
    const buttons = emails.map((e) => `<button type="submit" name="login_hint" value="${esc(e)}">${esc(e)}</button>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Development sign-in</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px;color:#1b1b1b}button{display:block;width:100%;margin:6px 0;padding:10px;text-align:left;border:1px solid #ccc;background:#fff;border-radius:6px;cursor:pointer}input[type=email]{width:100%;padding:10px;box-sizing:border-box}</style></head>
<body><h1>Development identity provider</h1><p>Not for production. Choose an account to sign in as.</p>
<form method="get" action="authorize">${hidden}${buttons}</form><form method="get" action="authorize">${hidden}<p>Or any email:</p><input type="email" name="login_hint" placeholder="name@yourhotel.com" required><button type="submit">Continue</button></form></body></html>`;
  }

  private signJwt(claims: Record<string, unknown>): string {
    const header = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: this.kid })));
    const payload = b64url(Buffer.from(JSON.stringify(claims)));
    const sig = cryptoSign('RSA-SHA256', Buffer.from(`${header}.${payload}`), this.privateKey);
    return `${header}.${payload}.${b64url(sig)}`;
  }

  token(body: Record<string, string | undefined>, basic?: string) {
    let clientId = body.client_id;
    let secret = body.client_secret;
    if (basic?.startsWith('Basic ')) {
      const [id, s] = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':');
      clientId = decodeURIComponent(id ?? '');
      secret = decodeURIComponent(s ?? '');
    }
    const fail = (error: string) => new AppException(HttpStatus.BAD_REQUEST, 'BAD_REQUEST', error, { error });
    if (clientId !== MOCK_CLIENT_ID || secret !== MOCK_CLIENT_SECRET) throw fail('invalid_client');
    if (body.grant_type !== 'authorization_code' || !body.code) throw fail('unsupported_grant_type');
    const c = this.codes.get(body.code);
    this.codes.delete(body.code);
    if (!c || c.expiresAt < Date.now() || c.redirectUri !== body.redirect_uri) throw fail('invalid_grant');
    if (c.challenge) {
      const got = body.code_verifier ? b64url(createHash('sha256').update(body.code_verifier).digest()) : '';
      if (got !== c.challenge) throw fail('invalid_grant');
    }
    const now = Math.floor(Date.now() / 1000);
    const idToken = this.signJwt({
      iss: this.issuer, aud: c.clientId, sub: createHash('sha256').update(c.email).digest('hex').slice(0, 24), iat: now, exp: now + 600,
      ...(c.nonce && { nonce: c.nonce }), email: c.email, email_verified: true, name: c.name,
    });
    const access = randomToken();
    this.accessTokens.set(access, { email: c.email, name: c.name, expiresAt: Date.now() + 600_000 });
    return { access_token: access, token_type: 'Bearer', expires_in: 600, id_token: idToken, scope: 'openid email profile' };
  }

  userinfo(auth: string | undefined) {
    const t = this.accessTokens.get(auth?.replace(/^Bearer /, '') ?? '');
    if (!t || t.expiresAt < Date.now()) throw AppException.unauthorized('invalid_token');
    return { sub: createHash('sha256').update(t.email).digest('hex').slice(0, 24), email: t.email, email_verified: true, name: t.name };
  }
}
