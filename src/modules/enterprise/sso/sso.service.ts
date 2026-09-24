import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { SsoConfig } from '../../../generated/prisma/client.js';
import type { StaffRole } from '../../../generated/prisma/enums.js';
import type { AuthUser } from '../../../common/auth-types.js';
import { SecretBox } from '../../../common/crypto/secret-box.js';
import { AppException, ErrorCode } from '../../../common/errors/app-exception.js';
import { safeRequest, UnsafeUrlError } from '../../../common/net/safe-fetch.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DbService } from '../../../prisma/db.service.js';
import { AuditService, userActor } from '../../audit/audit.service.js';
import { AuthService, type AuthResponse, type RequestMeta } from '../../auth/auth.service.js';
import { EntitlementsService } from '../../entitlements/entitlements.service.js';
import { RedisService } from '../../infra/redis.service.js';
import { Err } from '../../ops/ops.helpers.js';
import { WhiteLabelService } from '../white-label/white-label.service.js';
import { MockOidcService } from './mock-oidc.service.js';
import { defaultIssuer, emailDomainOf, IdTokenError, pkcePair, randomToken, verifyIdToken, type Discovery } from './oidc.js';

const SECRET_PURPOSE = 'sso-client-secret';
const STATE_TTL = 600;
const CODE_TTL = 120;
const JIT_ROLES: StaffRole[] = ['MANAGER', 'FRONT_DESK', 'HOUSEKEEPING', 'ACCOUNTANT', 'SUPERVISOR', 'MAINTENANCE', 'WAITER', 'KITCHEN'];

export interface SsoInput {
  provider: 'GOOGLE' | 'MICROSOFT' | 'OIDC';
  issuer?: string;
  clientId: string;
  clientSecret?: string;
  allowedDomains: string[];
  provisioning: 'JIT' | 'EXISTING_ONLY';
  defaultRole: string;
  enforced: boolean;
  breakGlassUserId?: string | null;
  enabled: boolean;
}

interface SsoState {
  tenantId: string;
  nonce: string;
  verifier: string;
  returnBase: string;
  returnPath: string;
  test: boolean;
  redirectUri: string;
}

class SsoFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Hotel single sign-on (M6, feature `sso`): OpenID Connect authorization code
 * flow with PKCE, state and nonce kept server-side, ID token verified against
 * the issuer's JWKS, just-in-time or existing-only staff, SSO-only with a
 * break-glass owner. The development issuer is served in-process.
 */
@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);
  private readonly discoveryCache = new Map<string, { at: number; d: Discovery }>();

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly box: SecretBox,
    private readonly redis: RedisService,
    private readonly auth: AuthService,
    private readonly entitlements: EntitlementsService,
    private readonly mock: MockOidcService,
    private readonly whiteLabel: WhiteLabelService,
  ) {}

  private get apiBase() {
    return this.config.get('API_PUBLIC_URL').replace(/\/$/, '');
  }

  private get adminBase() {
    return this.config.get('ADMIN_URL').replace(/\/$/, '');
  }

  redirectUri() {
    return `${this.apiBase}/api/v1/auth/sso/callback`;
  }

  private fetchOpts() {
    return { production: this.config.get('NODE_ENV') === 'production', allowPrivateHosts: this.config.get('OUTBOUND_ALLOW_PRIVATE_HOSTS'), timeoutMs: 10_000, maxBytes: 256 * 1024 };
  }

  private isMock(issuer: string) {
    return this.mock.enabled && issuer.replace(/\/$/, '') === this.mock.issuer;
  }

  // ---------------------------------------------------------------------------
  // Provider calls
  // ---------------------------------------------------------------------------

  async discover(issuer: string): Promise<Discovery> {
    if (this.isMock(issuer)) return this.mock.discovery();
    const hit = this.discoveryCache.get(issuer);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.d;
    let res;
    try {
      res = await safeRequest(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { method: 'GET', headers: { accept: 'application/json' } }, this.fetchOpts());
    } catch (e) {
      if (e instanceof UnsafeUrlError) throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, 'UNSAFE_URL', e.message, { reason: e.reason });
      throw e;
    }
    let d: Discovery;
    try {
      d = JSON.parse(res.body) as Discovery;
    } catch {
      throw Err.validation('issuer', 'The issuer did not return a discovery document');
    }
    if (res.status !== 200 || !d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) throw Err.validation('issuer', 'The issuer did not return a valid discovery document');
    this.discoveryCache.set(issuer, { at: Date.now(), d });
    return d;
  }

  private async jwks(issuer: string, uri: string) {
    if (this.isMock(issuer)) return this.mock.jwks() as unknown as { keys: [] };
    const res = await safeRequest(uri, { method: 'GET', headers: { accept: 'application/json' } }, this.fetchOpts());
    return JSON.parse(res.body) as { keys: [] };
  }

  private async exchangeCode(issuer: string, d: Discovery, c: SsoConfig, code: string, verifier: string, redirectUri: string) {
    const secret = c.clientSecretEnc ? this.box.open(c.clientSecretEnc, SECRET_PURPOSE) : '';
    const form = { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: c.clientId, client_secret: secret, code_verifier: verifier };
    if (this.isMock(issuer)) return this.mock.token(form);
    const res = await safeRequest(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    }, this.fetchOpts());
    if (res.status !== 200) throw new SsoFailure('SSO_TOKEN_INVALID', `Token endpoint answered ${res.status}`);
    return JSON.parse(res.body) as { id_token?: string };
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  view(c: SsoConfig) {
    return {
      enabled: c.enabled,
      provider: c.provider as SsoInput['provider'],
      issuer: c.issuer,
      clientId: c.clientId,
      clientSecretSet: !!c.clientSecretEnc,
      clientSecretLast4: c.clientSecretLast4,
      allowedDomains: c.allowedDomains,
      provisioning: c.provisioning as SsoInput['provisioning'],
      defaultRole: c.defaultRole,
      enforced: c.enforced,
      breakGlassUserId: c.breakGlassUserId,
      redirectUri: this.redirectUri(),
      lastTest: c.lastTestAt ? { at: c.lastTestAt.toISOString(), ok: !!c.lastTestOk, message: c.lastTestMessage ?? '', email: c.lastTestEmail } : null,
    };
  }

  private load(tenantId: string) {
    return this.db.control(tenantId, (tx) => tx.ssoConfig.findUnique({ where: { tenantId } }));
  }

  async get(u: AuthUser) {
    const c = await this.load(u.tenantId);
    return c ? this.view(c) : null;
  }

  async put(u: AuthUser, dto: SsoInput, ip?: string) {
    const issuer = defaultIssuer(dto.provider, dto.issuer);
    if (!issuer) throw Err.validation('issuer', 'The issuer URL is required');
    if (!JIT_ROLES.includes(dto.defaultRole as StaffRole)) throw Err.validation('defaultRole', `Choose one of ${JIT_ROLES.join(', ')}`);
    const domains = [...new Set(dto.allowedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
    if (!domains.length) throw Err.validation('allowedDomains', 'Add at least one email domain');
    if (domains.some((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) throw Err.validation('allowedDomains', 'Use domains such as yourhotel.com');
    await this.discover(issuer);
    const existing = await this.load(u.tenantId);
    if (!existing && !dto.clientSecret) throw Err.validation('clientSecret', 'The client secret is required');
    if (dto.breakGlassUserId) {
      const owner = await this.db.tenant(u.tenantId, (tx) => tx.user.findFirst({ where: { id: dto.breakGlassUserId!, tenantId: u.tenantId, role: 'OWNER', isActive: true } }));
      if (!owner) throw Err.validation('breakGlassUserId', 'The break-glass account must be an active owner');
    }
    if (dto.enforced && dto.enabled) {
      const breakGlass = dto.breakGlassUserId ?? existing?.breakGlassUserId;
      const recentTest = existing?.lastTestOk && existing.lastTestAt && Date.now() - existing.lastTestAt.getTime() < 24 * 3_600_000;
      if (!breakGlass || !recentTest) {
        throw new AppException(HttpStatus.CONFLICT, 'INVALID_STATE', 'SSO-only needs a break-glass owner and a successful test sign-in in the last 24 hours', {
          breakGlassSet: !!breakGlass,
          recentTest: !!recentTest,
        });
      }
    }
    const data = {
      enabled: dto.enabled,
      provider: dto.provider,
      issuer,
      clientId: dto.clientId.trim(),
      ...(dto.clientSecret && { clientSecretEnc: this.box.seal(dto.clientSecret, SECRET_PURPOSE), clientSecretLast4: dto.clientSecret.slice(-4) }),
      allowedDomains: domains,
      provisioning: dto.provisioning,
      defaultRole: dto.defaultRole,
      enforced: dto.enforced && dto.enabled,
      breakGlassUserId: dto.breakGlassUserId === undefined ? existing?.breakGlassUserId ?? null : dto.breakGlassUserId,
    };
    const row = await this.db.control(u.tenantId, async (tx) => {
      const r = await tx.ssoConfig.upsert({ where: { tenantId: u.tenantId }, create: { tenantId: u.tenantId, ...data }, update: data });
      await this.audit.recordControl(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'sso.configured', entityType: 'sso_config', entityId: u.tenantId, propertyId: null,
        metadata: { provider: dto.provider, issuer, enabled: dto.enabled, enforced: data.enforced, provisioning: dto.provisioning, secretChanged: !!dto.clientSecret }, ip,
      });
      return r;
    });
    return this.view(row);
  }

  async remove(u: AuthUser, ip?: string) {
    await this.db.control(u.tenantId, async (tx) => {
      const r = await tx.ssoConfig.deleteMany({ where: { tenantId: u.tenantId } });
      if (!r.count) throw AppException.notFound('SSO configuration');
      await this.audit.recordControl(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'sso.removed', entityType: 'sso_config', entityId: u.tenantId, propertyId: null, ip });
    });
    return { success: true };
  }

  async test(u: AuthUser) {
    const c = await this.load(u.tenantId);
    if (!c) throw AppException.notFound('SSO configuration');
    return { authorizeUrl: await this.authorizeUrl(c, { returnBase: this.adminBase, returnPath: '/settings/sso', test: true }) };
  }

  // ---------------------------------------------------------------------------
  // Sign-in flow
  // ---------------------------------------------------------------------------

  private async authorizeUrl(c: SsoConfig, o: { returnBase: string; returnPath: string; test: boolean; loginHint?: string }) {
    const d = await this.discover(c.issuer);
    const state = randomToken();
    const nonce = randomToken();
    const { verifier, challenge } = pkcePair();
    const st: SsoState = { tenantId: c.tenantId, nonce, verifier, returnBase: o.returnBase, returnPath: o.returnPath, test: o.test, redirectUri: this.redirectUri() };
    await this.redis.client.set(`sso:state:${state}`, JSON.stringify(st), 'EX', STATE_TTL);
    const url = new URL(d.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', c.clientId);
    url.searchParams.set('redirect_uri', st.redirectUri);
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (o.loginHint) url.searchParams.set('login_hint', o.loginHint);
    return url.toString();
  }

  /** Where the flow may return: the admin app, or a verified staff portal of the tenant. */
  private async returnTarget(tenantId: string, returnTo: string | undefined) {
    const admin = new URL(this.adminBase);
    if (!returnTo) return { base: this.adminBase, path: '/' };
    if (returnTo.startsWith('/') && !returnTo.startsWith('//')) return { base: this.adminBase, path: returnTo };
    let u: URL;
    try {
      u = new URL(returnTo);
    } catch {
      return { base: this.adminBase, path: '/' };
    }
    if (u.origin === admin.origin) return { base: this.adminBase, path: `${u.pathname}${u.search}` };
    const owner = await this.whiteLabel.isStaffPortalHost(u.hostname);
    if (owner === tenantId && (u.protocol === 'https:' || this.config.get('NODE_ENV') !== 'production')) return { base: u.origin, path: `${u.pathname}${u.search}` };
    return { base: this.adminBase, path: '/' };
  }

  /** GET /auth/sso/start: the IdP URL to redirect to. */
  async start(tenantSlug: string, returnTo?: string, loginHint?: string): Promise<string> {
    const tenant = await this.db.system((tx) => tx.tenant.findUnique({ where: { slug: tenantSlug.toLowerCase() }, select: { id: true } }));
    const c = tenant ? await this.load(tenant.id) : null;
    if (!tenant || !c?.enabled) return `${this.adminBase}/login?sso_error=SSO_DISABLED`;
    const ent = await this.entitlements.getEntitlements(tenant.id).catch(() => null);
    if (!ent?.features.includes('sso')) return `${this.adminBase}/login?sso_error=SSO_DISABLED`;
    const target = await this.returnTarget(tenant.id, returnTo);
    const hint = loginHint?.trim().toLowerCase();
    return this.authorizeUrl(c, { returnBase: target.base, returnPath: target.path, test: false, loginHint: hint && /^[^@\s]{1,64}@[^@\s]{1,190}$/.test(hint) ? hint : undefined });
  }

  async discoverByEmail(email: string) {
    const domain = emailDomainOf(email);
    if (!domain) return { sso: false, enforced: false, startUrl: null };
    const c = await this.db.system((tx) => tx.ssoConfig.findFirst({ where: { enabled: true, allowedDomains: { has: domain } } }));
    if (!c) return { sso: false, enforced: false, startUrl: null };
    const t = await this.db.system((tx) => tx.tenant.findUnique({ where: { id: c.tenantId }, select: { slug: true } }));
    return { sso: true, enforced: c.enforced, startUrl: `${this.apiBase}/api/v1/auth/sso/start?tenant=${encodeURIComponent(t?.slug ?? '')}` };
  }

  /** GET /auth/sso/callback: returns the URL to redirect the browser to. */
  async callback(q: { code?: string; state?: string; error?: string }, meta: RequestMeta): Promise<string> {
    const raw = q.state ? await this.redis.client.getdel(`sso:state:${q.state}`) : null;
    if (!raw) return `${this.adminBase}/login?sso_error=SSO_STATE_INVALID`;
    const st = JSON.parse(raw) as SsoState;
    const fail = async (code: string, message: string, email: string | null = null) => {
      if (st.test) {
        await this.recordTest(st.tenantId, false, message, email);
        return `${this.adminBase}/settings/sso?test=failed&message=${encodeURIComponent(message)}`;
      }
      return `${st.returnBase}/login?sso_error=${code}`;
    };
    if (q.error || !q.code) return fail('SSO_TOKEN_INVALID', q.error ? `The identity provider refused: ${q.error}` : 'No authorization code');
    const c = await this.load(st.tenantId);
    if (!c || (!c.enabled && !st.test)) return fail('SSO_DISABLED', 'SSO is not enabled');
    let email: string;
    let name: string;
    try {
      const d = await this.discover(c.issuer);
      const tokens = await this.exchangeCode(c.issuer, d, c, q.code, st.verifier, st.redirectUri);
      if (!tokens.id_token) throw new SsoFailure('SSO_TOKEN_INVALID', 'No ID token in the token response');
      const claims = verifyIdToken(tokens.id_token, await this.jwks(c.issuer, d.jwks_uri), { issuer: d.issuer.replace(/\/$/, '') === c.issuer ? d.issuer : c.issuer, audience: c.clientId, nonce: st.nonce });
      if (!claims.email) throw new SsoFailure('SSO_TOKEN_INVALID', 'The ID token has no email');
      if (claims.email_verified === false || claims.email_verified === 'false') throw new SsoFailure('SSO_TOKEN_INVALID', 'The email is not verified at the identity provider');
      email = claims.email.toLowerCase();
      name = claims.name ?? email.split('@')[0]!;
    } catch (e) {
      const code = e instanceof SsoFailure ? e.code : 'SSO_TOKEN_INVALID';
      const msg = e instanceof IdTokenError || e instanceof SsoFailure ? e.message : `Sign-in failed: ${(e as Error).message}`;
      this.logger.warn(`SSO callback for tenant ${st.tenantId} failed: ${msg}`);
      return fail(code, msg);
    }
    if (!c.allowedDomains.includes(emailDomainOf(email))) return fail('SSO_DOMAIN_NOT_ALLOWED', `${emailDomainOf(email)} is not an allowed domain`, email);
    if (st.test) {
      await this.recordTest(st.tenantId, true, `Signed in as ${email}`, email);
      return `${this.adminBase}/settings/sso?test=ok&message=${encodeURIComponent(`Signed in as ${email}`)}`;
    }
    let userId: string;
    try {
      userId = await this.findOrProvision(c, email, name);
    } catch (e) {
      if (e instanceof SsoFailure) return fail(e.code, e.message, email);
      if (e instanceof AppException && e.code === ErrorCode.LIMIT_REACHED) return fail('LIMIT_REACHED', 'The staff limit of the plan is reached', email);
      throw e;
    }
    const code = randomToken();
    await this.redis.client.set(`sso:code:${code}`, JSON.stringify({ tenantId: st.tenantId, userId, email, ip: meta.ip ?? null }), 'EX', CODE_TTL);
    return `${st.returnBase}/sso/complete#code=${code}${st.returnPath && st.returnPath !== '/' ? `&returnTo=${encodeURIComponent(st.returnPath)}` : ''}`;
  }

  private async recordTest(tenantId: string, ok: boolean, message: string, email: string | null) {
    await this.db.control(tenantId, (tx) =>
      tx.ssoConfig.updateMany({ where: { tenantId }, data: { lastTestAt: new Date(), lastTestOk: ok, lastTestMessage: message.slice(0, 300), lastTestEmail: email } }),
    );
  }

  private async findOrProvision(c: SsoConfig, email: string, name: string): Promise<string> {
    const existing = await this.db.tenant(c.tenantId, (tx) => tx.user.findFirst({ where: { tenantId: c.tenantId, email } }));
    if (existing) {
      if (!existing.isActive) throw new SsoFailure('SSO_USER_NOT_FOUND', 'This account is deactivated');
      return existing.id;
    }
    // Staff of another hotel with the same email cannot be created here.
    const elsewhere = await this.auth.findUserByEmail(email);
    if (elsewhere || c.provisioning !== 'JIT') throw new SsoFailure('SSO_USER_NOT_FOUND', 'No staff account for this email');
    const ent = await this.entitlements.getEntitlements(c.tenantId);
    return this.db.tenant(c.tenantId, async (tx) => {
      await this.entitlements.assertWithinLimit(ent, 'max_staff', 1, tx);
      const u = await tx.user.create({
        data: { tenantId: c.tenantId, email, fullName: name.slice(0, 120), phone: '', role: c.defaultRole as StaffRole, passwordHash: '!sso' },
      });
      await this.audit.record(tx, {
        tenantId: c.tenantId, actor: { kind: 'system', name: 'Single sign-on' }, action: 'staff.created_by_sso', entityType: 'user', entityId: u.id, propertyId: null,
        metadata: { email, role: c.defaultRole },
      });
      return u.id;
    });
  }

  /** POST /auth/sso/exchange */
  async exchange(code: string, meta: RequestMeta): Promise<AuthResponse> {
    const raw = await this.redis.client.getdel(`sso:code:${code}`);
    if (!raw) throw AppException.unauthorized('This sign-in link has expired. Start again.', 'SSO_STATE_INVALID');
    const v = JSON.parse(raw) as { tenantId: string; userId: string; email: string };
    return this.auth.signInUser(v.tenantId, v.userId, 'auth.sso_login', meta, { email: v.email });
  }
}
