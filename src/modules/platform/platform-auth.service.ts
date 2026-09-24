import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import type { PlatformSession, PlatformUser } from '../../generated/prisma/client.js';
import { PLATFORM_AUDIENCE, PLATFORM_MFA_AUDIENCE, type PlatformPrincipal, type PlatformTokenPayload } from '../../common/auth-types.js';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { SecretBox, sha256Hex } from '../../common/crypto/secret-box.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { argon2Options } from '../auth/auth.service.js';
import { TokenService } from '../auth/token.service.js';
import { RedisService } from '../infra/redis.service.js';
import { Err } from '../ops/ops.helpers.js';
import { ipAllowed, isValidCidr, normaliseIp } from './security/cidr.js';
import { PlatformAuditService } from './security/platform-audit.service.js';
import { platformPermissionsFor, STEP_UP_SECONDS } from './security/platform-permissions.js';
import { ipNotAllowed, PLATFORM_IDLE_MS, PLATFORM_SESSION_MS, sessionRevoked } from './security/platform-session.service.js';
import { newRecoveryCodes, newTotpSecret, normaliseRecoveryCode, otpauthUri, totp, TOTP_STEP_SECONDS, totpSecondsLeft, totpStep, verifyTotp } from './security/totp.js';

const DUMMY = argon2.hash('timing-equaliser-not-a-password');
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
const MFA_TOKEN_TTL_SEC = 300;
const ACCESS_TTL_SEC = 15 * 60;
export const TOTP_PURPOSE = 'platform:totp';
/** Stored instead of a password hash until an invitation is accepted. */
export const NO_PASSWORD = '!invited';

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

interface MfaTokenPayload {
  sub: string;
  jti: string;
  kind: 'verify' | 'enrol';
}

function locked(until: Date) {
  return new AppException(HttpStatus.LOCKED, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', { lockedUntil: until.toISOString() });
}

function mfaTokenInvalid() {
  return new AppException(HttpStatus.UNAUTHORIZED, 'MFA_TOKEN_INVALID', 'Your sign-in step expired. Enter your email and password again.');
}

export function sessionView(s: PlatformSession, currentId?: string) {
  const stepUpUntil = s.stepUpAt ? new Date(s.stepUpAt.getTime() + STEP_UP_SECONDS * 1000) : null;
  return {
    id: s.id,
    current: s.id === currentId,
    ip: s.ip,
    userAgent: s.userAgent,
    createdAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    mfaMethod: s.mfaMethod as 'totp' | 'recovery_code',
    stepUpUntil: stepUpUntil && stepUpUntil > new Date() ? stepUpUntil.toISOString() : null,
    revokedAt: s.revokedAt?.toISOString() ?? null,
  };
}

/** Hash of a recovery code (keyed, so a database dump alone cannot test guesses offline). */
export function hashRecoveryCode(secret: string, code: string): string {
  return createHmac('sha256', secret).update(`platform-recovery:${normaliseRecoveryCode(code)}`).digest('hex');
}

/**
 * Platform console sign-in (M6): password, then mandatory TOTP (enrolment on
 * first sign-in), recovery codes, revocable sessions with rotating refresh
 * tokens, step-up for sensitive actions, lockout after five failures and an
 * optional IP allowlist per user.
 */
@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    private readonly secrets: SecretBox,
    private readonly redis: RedisService,
    private readonly audit: PlatformAuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Step 1: password
  // ---------------------------------------------------------------------------

  async login(email: string, password: string, meta: RequestMeta) {
    const user = await this.db.system((tx) => tx.platformUser.findUnique({ where: { email: email.toLowerCase().trim() } }));
    const now = new Date();
    if (user?.lockedUntil && user.lockedUntil > now) {
      await this.audit.record({ actor: this.actorOf(user), action: 'auth.login_locked', targetType: 'platform_user', targetId: user.id, ip: meta.ip, userAgent: meta.userAgent });
      throw locked(user.lockedUntil);
    }
    const hash = user && user.passwordHash !== NO_PASSWORD ? user.passwordHash : await DUMMY;
    const ok = await argon2.verify(hash, password).catch(() => false);
    if (!user || !ok || !user.isActive || user.passwordHash === NO_PASSWORD) {
      if (user) throw await this.registerFailure(user, 'password', meta);
      throw AppException.unauthorized('Email or password is incorrect', ErrorCode.INVALID_CREDENTIALS);
    }
    if (!ipAllowed(meta.ip, user.ipAllowlist)) {
      await this.audit.record({ actor: this.actorOf(user), action: 'auth.ip_refused', targetType: 'platform_user', targetId: user.id, ip: meta.ip, userAgent: meta.userAgent });
      throw ipNotAllowed(meta.ip);
    }
    return this.challenge(user, user.totpSecretEnc ? 'verify' : 'enrol');
  }

  private async challenge(user: PlatformUser, kind: 'verify' | 'enrol') {
    const payload: MfaTokenPayload = { sub: user.id, jti: randomUUID(), kind };
    const mfaToken = await this.jwt.signAsync(payload, {
      secret: this.config.get('JWT_PLATFORM_SECRET'),
      audience: PLATFORM_MFA_AUDIENCE,
      issuer: this.config.get('APP_DOMAIN'),
      expiresIn: MFA_TOKEN_TTL_SEC,
    });
    return {
      status: kind === 'verify' ? ('MFA_REQUIRED' as const) : ('MFA_ENROLMENT_REQUIRED' as const),
      mfaToken,
      mfaTokenExpiresAt: new Date(Date.now() + MFA_TOKEN_TTL_SEC * 1000).toISOString(),
    };
  }

  private async readMfaToken(token: string, kind: 'verify' | 'enrol'): Promise<{ payload: MfaTokenPayload; user: PlatformUser }> {
    let payload: MfaTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<MfaTokenPayload>(token, {
        secret: this.config.get('JWT_PLATFORM_SECRET'),
        audience: PLATFORM_MFA_AUDIENCE,
        issuer: this.config.get('APP_DOMAIN'),
      });
    } catch {
      throw mfaTokenInvalid();
    }
    if (payload.kind !== kind) throw mfaTokenInvalid();
    if (await this.redis.client.exists(`platform:mfa-used:${payload.jti}`).catch(() => 0)) throw mfaTokenInvalid();
    const user = await this.db.system((tx) => tx.platformUser.findUnique({ where: { id: payload.sub } }));
    if (!user || !user.isActive) throw mfaTokenInvalid();
    if (user.lockedUntil && user.lockedUntil > new Date()) throw locked(user.lockedUntil);
    return { payload, user };
  }

  /** Marks a login step token used (one sign-in per password step). */
  private async consume(jti: string): Promise<void> {
    const ok = await this.redis.client.set(`platform:mfa-used:${jti}`, '1', 'EX', MFA_TOKEN_TTL_SEC + 60, 'NX').catch(() => 'OK');
    if (ok !== 'OK') throw mfaTokenInvalid();
  }

  // ---------------------------------------------------------------------------
  // Step 2: TOTP enrolment or verification
  // ---------------------------------------------------------------------------

  async enrolStart(mfaToken: string) {
    const { user } = await this.readMfaToken(mfaToken, 'enrol');
    const secret = newTotpSecret();
    await this.db.system((tx) => tx.platformUser.update({ where: { id: user.id }, data: { totpPendingSecretEnc: this.secrets.seal(secret, `${TOTP_PURPOSE}:${user.id}`) } }));
    const issuer = `${this.config.get('APP_NAME')} Console`;
    const uri = otpauthUri(secret, user.email, issuer);
    const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#1B1A17', light: '#FFFFFF' } });
    return { secret, otpauthUri: uri, qrSvg, issuer, account: user.email };
  }

  async enrolVerify(mfaToken: string, code: string, meta: RequestMeta) {
    const { payload, user } = await this.readMfaToken(mfaToken, 'enrol');
    if (!user.totpPendingSecretEnc) throw Err.validation('code', 'Start the enrolment first');
    const secret = this.secrets.open(user.totpPendingSecretEnc, `${TOTP_PURPOSE}:${user.id}`);
    const step = verifyTotp(secret, code);
    if (step === null) throw await this.registerFailure(user, 'totp', meta);
    if (!(await this.freshStep(user.id, step))) throw await this.replayed(user, meta);
    await this.consume(payload.jti);
    const recoveryCodes = newRecoveryCodes();
    const result = await this.db.system(async (tx) => {
      await tx.platformUser.update({
        where: { id: user.id },
        data: { totpSecretEnc: this.secrets.seal(secret, `${TOTP_PURPOSE}:${user.id}`), totpPendingSecretEnc: null, mfaEnabledAt: new Date() },
      });
      await tx.platformRecoveryCode.deleteMany({ where: { platformUserId: user.id } });
      await tx.platformRecoveryCode.createMany({ data: recoveryCodes.map((c) => ({ platformUserId: user.id, codeHash: this.hashRecovery(c) })) });
      await this.audit.recordTx(tx, { actor: this.actorOf(user), action: 'auth.mfa_enrolled', targetType: 'platform_user', targetId: user.id, ip: meta.ip, userAgent: meta.userAgent });
      return this.startSession(tx, user, 'totp', meta);
    });
    return { ...result, recoveryCodes };
  }

  async verify(mfaToken: string, input: { code?: string; recoveryCode?: string }, meta: RequestMeta) {
    const { payload, user } = await this.readMfaToken(mfaToken, 'verify');
    const method = await this.checkSecondFactor(user, input, meta);
    await this.consume(payload.jti);
    return this.db.system(async (tx) => this.startSession(tx, user, method, meta));
  }

  /** Verifies a TOTP or recovery code (counting failures); returns the method used. */
  private async checkSecondFactor(user: PlatformUser, input: { code?: string; recoveryCode?: string }, meta: RequestMeta): Promise<'totp' | 'recovery_code'> {
    if (!!input.code === !!input.recoveryCode) throw Err.validation('code', 'Give either a code from your authenticator app or a recovery code');
    if (!user.totpSecretEnc) throw Err.validation('code', 'Two-factor sign-in is not set up for this account');
    if (input.code) {
      const secret = this.secrets.open(user.totpSecretEnc, `${TOTP_PURPOSE}:${user.id}`);
      const step = verifyTotp(secret, input.code);
      if (step !== null) {
        if (await this.freshStep(user.id, step)) return 'totp';
        // A correct code seen before (replay, double submit): refused, but it
        // is not a guessing attempt, so it does not count toward the lockout.
        throw await this.replayed(user, meta);
      }
      throw await this.registerFailure(user, 'totp', meta);
    }
    const hash = this.hashRecovery(input.recoveryCode!);
    const used = await this.db.system((tx) =>
      tx.platformRecoveryCode.updateMany({ where: { platformUserId: user.id, codeHash: hash, usedAt: null }, data: { usedAt: new Date() } }),
    );
    if (used.count === 1) {
      await this.audit.record({ actor: this.actorOf(user), action: 'auth.recovery_code_used', targetType: 'platform_user', targetId: user.id, ip: meta.ip, userAgent: meta.userAgent });
      return 'recovery_code';
    }
    throw await this.registerFailure(user, 'recovery_code', meta);
  }

  private async replayed(user: PlatformUser, meta: RequestMeta): Promise<AppException> {
    await this.audit.record({ actor: this.actorOf(user), action: 'auth.totp_replayed', targetType: 'platform_user', targetId: user.id, ip: meta.ip, userAgent: meta.userAgent });
    return new AppException(HttpStatus.UNAUTHORIZED, 'MFA_CODE_ALREADY_USED', 'That code was already used. Wait for the next one.', { secondsLeft: totpSecondsLeft() });
  }

  /** A TOTP time step may be used once per user (replay protection). */
  private async freshStep(userId: string, step: number): Promise<boolean> {
    const r = await this.redis.client.set(`platform:totp-used:${userId}:${step}`, '1', 'EX', 120, 'NX').catch(() => 'OK');
    return r === 'OK';
  }

  private hashRecovery(code: string): string {
    return hashRecoveryCode(this.config.get('JWT_REFRESH_SECRET'), code);
  }

  /** Counts a failed password or code; locks the account after five in a row. Returns the error to throw. */
  private async registerFailure(user: PlatformUser, kind: 'password' | 'totp' | 'recovery_code', meta: RequestMeta): Promise<AppException> {
    const now = new Date();
    const updated = await this.db.system(async (tx) => {
      const u = await tx.platformUser.update({ where: { id: user.id }, data: { failedAttempts: { increment: 1 } } });
      let lockedUntil: Date | null = null;
      if (u.failedAttempts >= MAX_FAILED_ATTEMPTS) {
        lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60_000);
        await tx.platformUser.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil } });
      }
      await this.audit.recordTx(tx, {
        actor: this.actorOf(user), action: lockedUntil ? 'auth.locked' : `auth.${kind}_failed`, targetType: 'platform_user', targetId: user.id,
        ip: meta.ip, userAgent: meta.userAgent, metadata: { attempts: u.failedAttempts },
      });
      return { attempts: u.failedAttempts, lockedUntil };
    });
    if (updated.lockedUntil) return locked(updated.lockedUntil);
    if (kind === 'password') return AppException.unauthorized('Email or password is incorrect', ErrorCode.INVALID_CREDENTIALS);
    return new AppException(HttpStatus.UNAUTHORIZED, 'INVALID_MFA_CODE', 'That code is not right', { attemptsLeft: MAX_FAILED_ATTEMPTS - updated.attempts });
  }

  // ---------------------------------------------------------------------------
  // Sessions and tokens
  // ---------------------------------------------------------------------------

  private async startSession(tx: Tx, user: PlatformUser, method: 'totp' | 'recovery_code', meta: RequestMeta) {
    const now = new Date();
    const session = await tx.platformSession.create({
      data: {
        platformUserId: user.id,
        ip: normaliseIp(meta.ip) || null,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
        mfaMethod: method,
        stepUpAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + PLATFORM_SESSION_MS),
      },
    });
    const fresh = await tx.platformUser.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: now } });
    await this.audit.recordTx(tx, {
      actor: { ...this.actorOf(fresh), sessionId: session.id }, action: 'auth.login', targetType: 'platform_session', targetId: session.id,
      ip: meta.ip, userAgent: meta.userAgent, metadata: { mfaMethod: method },
    });
    return this.issue(tx, fresh, session);
  }

  private async issue(tx: Tx, user: PlatformUser, session: PlatformSession) {
    const refreshToken = randomBytes(32).toString('base64url');
    await tx.platformRefreshToken.create({ data: { sessionId: session.id, tokenHash: this.tokens.hashRefresh(`platform:${refreshToken}`) } });
    const payload: PlatformTokenPayload = { sub: user.id, email: user.email, role: user.role, name: user.fullName, sid: session.id };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get('JWT_PLATFORM_SECRET'),
      audience: PLATFORM_AUDIENCE,
      issuer: this.config.get('APP_DOMAIN'),
      expiresIn: ACCESS_TTL_SEC,
    });
    const remaining = await tx.platformRecoveryCode.count({ where: { platformUserId: user.id, usedAt: null } });
    return {
      status: 'OK' as const,
      accessToken,
      accessTokenExpiresAt: new Date(Date.now() + ACCESS_TTL_SEC * 1000).toISOString(),
      refreshToken,
      user: this.meView(user, session, remaining),
    };
  }

  async refresh(presented: string, meta: RequestMeta) {
    const hash = this.tokens.hashRefresh(`platform:${presented}`);
    const now = new Date();
    const outcome = await this.db.system(async (tx) => {
      const t = await tx.platformRefreshToken.findUnique({ where: { tokenHash: hash }, include: { session: { include: { user: true } } } });
      if (!t) return { kind: 'invalid' as const };
      const s = t.session;
      if (t.rotatedAt) {
        await tx.platformSession.update({ where: { id: s.id }, data: { revokedAt: now, revokeReason: 'refresh_reuse' } });
        await this.audit.recordTx(tx, { actor: { ...this.actorOf(s.user), sessionId: s.id }, action: 'auth.refresh_reuse_detected', targetType: 'platform_session', targetId: s.id, ip: meta.ip });
        return { kind: 'reused' as const };
      }
      if (s.revokedAt || s.expiresAt <= now || now.getTime() - s.lastSeenAt.getTime() > PLATFORM_IDLE_MS || !s.user.isActive) return { kind: 'ended' as const };
      if (!ipAllowed(meta.ip, s.user.ipAllowlist)) return { kind: 'ip' as const };
      const claimed = await tx.platformRefreshToken.updateMany({ where: { id: t.id, rotatedAt: null }, data: { rotatedAt: now } });
      if (claimed.count === 0) {
        await tx.platformSession.update({ where: { id: s.id }, data: { revokedAt: now, revokeReason: 'refresh_reuse' } });
        return { kind: 'reused' as const };
      }
      const session = await tx.platformSession.update({ where: { id: s.id }, data: { lastSeenAt: now } });
      return { kind: 'ok' as const, response: await this.issue(tx, s.user, session) };
    });
    if (outcome.kind === 'reused') {
      throw AppException.unauthorized('This refresh token was already used. The session has been signed out.', ErrorCode.REFRESH_TOKEN_REUSED);
    }
    if (outcome.kind === 'invalid') throw AppException.unauthorized('Refresh token is invalid', ErrorCode.INVALID_REFRESH_TOKEN);
    if (outcome.kind === 'ip') throw ipNotAllowed(meta.ip);
    if (outcome.kind === 'ended') throw sessionRevoked();
    return outcome.response;
  }

  async logout(p: PlatformPrincipal, meta: RequestMeta) {
    await this.db.system(async (tx) => {
      await tx.platformSession.updateMany({ where: { id: p.sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'logout' } });
      await this.audit.recordTx(tx, { actor: p, action: 'auth.logout', targetType: 'platform_session', targetId: p.sessionId ?? null, ip: meta.ip, userAgent: meta.userAgent });
    });
    return { success: true };
  }

  async me(p: PlatformPrincipal) {
    return this.db.system(async (tx) => {
      const user = await tx.platformUser.findUnique({ where: { id: p.platformUserId } });
      const session = p.sessionId ? await tx.platformSession.findUnique({ where: { id: p.sessionId } }) : null;
      if (!user || !user.isActive || !session) throw AppException.unauthorized();
      const remaining = await tx.platformRecoveryCode.count({ where: { platformUserId: user.id, usedAt: null } });
      return this.meView(user, session, remaining);
    });
  }

  meView(user: PlatformUser, session: PlatformSession, recoveryCodesRemaining: number) {
    const view = sessionView(session, session.id);
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      permissions: [...platformPermissionsFor(user.role)],
      mfaEnabled: !!user.totpSecretEnc,
      recoveryCodesRemaining,
      ipAllowlist: user.ipAllowlist,
      stepUpUntil: view.stepUpUntil,
      session: view,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    };
  }

  async stepUp(p: PlatformPrincipal, input: { code?: string; recoveryCode?: string }, meta: RequestMeta) {
    const user = await this.db.system((tx) => tx.platformUser.findUniqueOrThrow({ where: { id: p.platformUserId } }));
    if (user.lockedUntil && user.lockedUntil > new Date()) throw locked(user.lockedUntil);
    const method = await this.checkSecondFactor(user, input, meta);
    const now = new Date();
    await this.db.system(async (tx) => {
      await tx.platformSession.update({ where: { id: p.sessionId }, data: { stepUpAt: now } });
      await tx.platformUser.update({ where: { id: user.id }, data: { failedAttempts: 0 } });
      await this.audit.recordTx(tx, { actor: p, action: 'auth.step_up', targetType: 'platform_session', targetId: p.sessionId ?? null, ip: meta.ip, userAgent: meta.userAgent, metadata: { method } });
    });
    return { stepUpUntil: new Date(now.getTime() + STEP_UP_SECONDS * 1000).toISOString() };
  }

  async sessions(p: PlatformPrincipal, userId = p.platformUserId) {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const rows = await this.db.system((tx) => tx.platformSession.findMany({ where: { platformUserId: userId, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 100 }));
    return rows.map((s) => sessionView(s, p.sessionId));
  }

  async revokeSession(p: PlatformPrincipal, id: string, meta: RequestMeta, userId = p.platformUserId) {
    await this.db.system(async (tx) => {
      const s = await tx.platformSession.findFirst({ where: { id, platformUserId: userId } });
      if (!s) throw AppException.notFound('Session');
      await tx.platformSession.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: userId === p.platformUserId ? 'revoked' : 'revoked_by_admin' } });
      await this.audit.recordTx(tx, { actor: p, action: 'auth.session_revoked', targetType: 'platform_session', targetId: id, ip: meta.ip, metadata: { userId } });
    });
    return { success: true };
  }

  async revokeOthers(p: PlatformPrincipal, meta: RequestMeta) {
    return this.db.system(async (tx) => {
      const r = await tx.platformSession.updateMany({ where: { platformUserId: p.platformUserId, revokedAt: null, NOT: { id: p.sessionId } }, data: { revokedAt: new Date(), revokeReason: 'revoked' } });
      await this.audit.recordTx(tx, { actor: p, action: 'auth.sessions_revoked', targetType: 'platform_user', targetId: p.platformUserId, ip: meta.ip, metadata: { count: r.count } });
      return { revoked: r.count };
    });
  }

  async regenerateRecoveryCodes(p: PlatformPrincipal, meta: RequestMeta) {
    const codes = newRecoveryCodes();
    await this.db.system(async (tx) => {
      await tx.platformRecoveryCode.deleteMany({ where: { platformUserId: p.platformUserId } });
      await tx.platformRecoveryCode.createMany({ data: codes.map((c) => ({ platformUserId: p.platformUserId, codeHash: this.hashRecovery(c) })) });
      await this.audit.recordTx(tx, { actor: p, action: 'auth.recovery_codes_regenerated', targetType: 'platform_user', targetId: p.platformUserId, ip: meta.ip });
    });
    return { recoveryCodes: codes };
  }

  async changePassword(p: PlatformPrincipal, current: string, next: string, meta: RequestMeta) {
    const user = await this.db.system((tx) => tx.platformUser.findUniqueOrThrow({ where: { id: p.platformUserId } }));
    const ok = await argon2.verify(user.passwordHash, current).catch(() => false);
    if (!ok) throw await this.registerFailure(user, 'password', meta);
    const hash = await argon2.hash(next, argon2Options);
    await this.db.system(async (tx) => {
      await tx.platformUser.update({ where: { id: user.id }, data: { passwordHash: hash, passwordChangedAt: new Date() } });
      await tx.platformSession.updateMany({ where: { platformUserId: user.id, revokedAt: null, NOT: { id: p.sessionId } }, data: { revokedAt: new Date(), revokeReason: 'password_changed' } });
      await this.audit.recordTx(tx, { actor: p, action: 'auth.password_changed', targetType: 'platform_user', targetId: user.id, ip: meta.ip });
    });
    return { success: true };
  }

  async setIpAllowlist(p: PlatformPrincipal, cidrs: string[], meta: RequestMeta) {
    const list = [...new Set(cidrs.map((c) => c.trim()).filter(Boolean))];
    const bad = list.filter((c) => !isValidCidr(c));
    if (bad.length) throw Err.validation('cidrs', `Not a valid address or CIDR range: ${bad.join(', ')}`);
    if (list.length && !ipAllowed(meta.ip, list)) {
      throw Err.validation('cidrs', `The list must include your current address (${normaliseIp(meta.ip)}) so you do not lock yourself out`);
    }
    await this.db.system(async (tx) => {
      await tx.platformUser.update({ where: { id: p.platformUserId }, data: { ipAllowlist: list } });
      await this.audit.recordTx(tx, { actor: p, action: 'auth.ip_allowlist_changed', targetType: 'platform_user', targetId: p.platformUserId, ip: meta.ip, metadata: { cidrs: list } });
    });
    return this.me(p);
  }

  // ---------------------------------------------------------------------------
  // Invitations
  // ---------------------------------------------------------------------------

  private async inviteUser(token: string) {
    const user = await this.db.system((tx) => tx.platformUser.findUnique({ where: { inviteTokenHash: sha256Hex(`invite:${token}`) } }));
    if (!user || !user.inviteExpiresAt || user.inviteExpiresAt <= new Date() || !user.isActive) throw AppException.notFound('Invitation');
    return user;
  }

  async invite(token: string) {
    const u = await this.inviteUser(token);
    return { email: u.email, fullName: u.fullName, role: u.role, expiresAt: u.inviteExpiresAt!.toISOString() };
  }

  async acceptInvite(token: string, password: string, fullName: string | undefined, meta: RequestMeta) {
    const u = await this.inviteUser(token);
    const hash = await argon2.hash(password, argon2Options);
    const user = await this.db.system(async (tx) => {
      const updated = await tx.platformUser.update({
        where: { id: u.id },
        data: { passwordHash: hash, inviteTokenHash: null, inviteExpiresAt: null, passwordChangedAt: new Date(), ...(fullName && { fullName }) },
      });
      await this.audit.recordTx(tx, { actor: this.actorOf(updated), action: 'auth.invite_accepted', targetType: 'platform_user', targetId: u.id, ip: meta.ip });
      return updated;
    });
    return this.challenge(user, 'enrol');
  }

  /** Development only: the current code of an enrolled account (Playwright, local sign-in). */
  async devTotp(email: string) {
    if (this.config.isProduction) throw AppException.notFound();
    const user = await this.db.system((tx) => tx.platformUser.findUnique({ where: { email: email.toLowerCase() } }));
    if (!user?.totpSecretEnc) throw AppException.notFound('Enrolled platform user');
    const secret = this.secrets.open(user.totpSecretEnc, `${TOTP_PURPOSE}:${user.id}`);
    // A code whose time step has not been used yet (one step either side is accepted).
    const now = new Date();
    for (const d of [0, 1, -1]) {
      const at = new Date(now.getTime() + d * TOTP_STEP_SECONDS * 1000);
      const used = await this.redis.client.exists(`platform:totp-used:${user.id}:${totpStep(at)}`).catch(() => 0);
      if (!used) return { code: totp(secret, at), secondsLeft: totpSecondsLeft(now) + d * TOTP_STEP_SECONDS };
    }
    return { code: totp(secret, now), secondsLeft: totpSecondsLeft(now) };
  }

  private actorOf(u: Pick<PlatformUser, 'id' | 'fullName' | 'role'>) {
    return { platformUserId: u.id, fullName: u.fullName, role: u.role };
  }
}
