import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type { StaffRole } from '../../generated/prisma/enums.js';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { randomSuffix, slugify } from '../../common/utils/slug.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { sha256Hex } from '../../common/crypto/secret-box.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { LoginDto, SignupDto } from './auth.dto.js';
import { TokenService } from './token.service.js';

export const TRIAL_DAYS = 14;
export const SIGNUP_PLAN_CODE = 'growth';

export interface AuthUserView {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  role: StaffRole;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUserView;
}

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export interface FoundUser {
  id: string;
  tenant_id: string;
  email: string;
  full_name: string;
  role: string;
  password_hash: string;
  is_active: boolean;
}

interface FoundToken {
  id: string;
  tenant_id: string;
  user_id: string;
  family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

// Verifying against a real hash when the email is unknown keeps login timing
// uniform, so response time does not reveal which emails are registered.
const DUMMY_HASH_PROMISE = argon2.hash('timing-equaliser-not-a-password');

/** OWASP-recommended argon2id parameters (19 MiB, t=2, p=1). */
export const argon2Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} satisfies argon2.HashOptions;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  hashPassword(password: string): Promise<string> {
    return argon2.hash(password, argon2Options);
  }

  // ---------------------------------------------------------------------------
  // Signup: creates tenant + property + owner + Growth trial in ONE tenant
  // transaction. The tenant id is generated up-front and set as app.tenant_id,
  // so every insert passes the RLS WITH CHECK clause without a bypass.
  // ---------------------------------------------------------------------------
  async signup(dto: SignupDto, meta: RequestMeta): Promise<AuthResponse> {
    if (await this.findUserByEmail(dto.email)) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.EMAIL_TAKEN,
        'An account with this email already exists',
      );
    }
    const plan = await this.db.prisma.plan.findUnique({
      where: { code: SIGNUP_PLAN_CODE },
    });
    if (!plan) {
      throw new Error(`Signup plan "${SIGNUP_PLAN_CODE}" is not seeded`);
    }
    const passwordHash = await this.hashPassword(dto.password);
    const base = slugify(dto.hotelName);

    for (let attempt = 0; attempt < 6; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
      const tenantId = randomUUID();
      try {
        return await this.db.tenant(tenantId, async (tx) => {
          const now = new Date();
          await tx.tenant.create({
            data: {
              id: tenantId,
              name: dto.hotelName,
              slug,
              city: dto.city,
              state: dto.state,
            },
          });
          const property = await tx.property.create({
            data: {
              tenantId,
              name: dto.hotelName,
              slug,
              city: dto.city,
              state: dto.state,
              phone: dto.phone,
              email: dto.email,
            },
          });
          // Every hotel sells at its Best Available Rate from day one (M4 rates).
          await tx.ratePlan.create({
            data: {
              tenantId,
              propertyId: property.id,
              code: 'BAR',
              name: 'Best Available Rate',
              description: "Flexible rate at the day's best price.",
              kind: 'BAR',
              isBar: true,
              pricing: 'DERIVED',
            },
          });
          const user = await tx.user.create({
            data: {
              tenantId,
              email: dto.email,
              fullName: dto.fullName,
              phone: dto.phone,
              role: 'OWNER',
              passwordHash,
              lastLoginAt: now,
            },
          });
          const trialEndsAt = new Date(
            now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000,
          );
          await tx.subscription.create({
            data: {
              tenantId,
              planId: plan.id,
              status: 'TRIALING',
              interval: 'MONTHLY',
              trialEndsAt,
            },
          });
          const actor = { kind: 'user' as const, id: user.id, name: user.fullName };
          await this.audit.record(tx, {
            tenantId,
            actor,
            action: 'tenant.signup',
            entityType: 'tenant',
            entityId: tenantId,
            metadata: {
              hotelName: dto.hotelName,
              propertyId: property.id,
              plan: SIGNUP_PLAN_CODE,
              trialEndsAt: trialEndsAt.toISOString(),
            },
            ip: meta.ip,
          });
          return this.issue(tx, user, randomUUID(), meta);
        });
      } catch (err) {
        if (isUniqueViolation(err, 'slug')) continue;
        if (isUniqueViolation(err, 'email')) {
          throw new AppException(
            HttpStatus.CONFLICT,
            ErrorCode.EMAIL_TAKEN,
            'An account with this email already exists',
          );
        }
        throw err;
      }
    }
    throw AppException.conflict('Could not allocate a unique hotel address');
  }

  async login(dto: LoginDto, meta: RequestMeta): Promise<AuthResponse> {
    const found = await this.findUserByEmail(dto.email);
    const hash = found?.password_hash ?? (await DUMMY_HASH_PROMISE);
    const ok = await argon2.verify(hash, dto.password).catch(() => false);
    if (!found || !ok || !found.is_active) {
      throw AppException.unauthorized(
        'Email or password is incorrect',
        ErrorCode.INVALID_CREDENTIALS,
      );
    }
    await this.assertPasswordAllowed(found);
    return this.db.tenant(found.tenant_id, async (tx) => {
      const user = await tx.user.update({
        where: { id: found.id },
        data: { lastLoginAt: new Date() },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: { kind: 'user', id: user.id, name: user.fullName },
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
        ip: meta.ip,
      });
      return this.issue(tx, user, randomUUID(), meta);
    });
  }

  /**
   * Rotates a refresh token. The presented token is revoked and replaced by a
   * new one in the same family. Presenting a token that was already rotated
   * means it was copied: the whole family is revoked (every device that
   * descended from that login must sign in again).
   */
  async refresh(presented: string, meta: RequestMeta): Promise<AuthResponse> {
    const hash = this.tokens.hashRefresh(presented);
    const token = await this.findRefreshToken(hash);
    if (!token) {
      throw AppException.unauthorized(
        'Refresh token is invalid',
        ErrorCode.INVALID_REFRESH_TOKEN,
      );
    }

    const outcome = await this.db.tenant(token.tenant_id, async (tx) => {
      const current = await tx.refreshToken.findUnique({
        where: { id: token.id },
      });
      if (!current) return { kind: 'invalid' as const };

      if (current.revokedAt) {
        if (current.revokeReason === 'rotated') {
          await this.revokeFamily(tx, current.familyId, 'reuse_detected');
          await this.audit.record(tx, {
            tenantId: current.tenantId,
            actor: null,
            action: 'auth.refresh_reuse_detected',
            entityType: 'user',
            entityId: current.userId,
            metadata: { familyId: current.familyId },
            ip: meta.ip,
          });
          return { kind: 'reused' as const };
        }
        return { kind: 'invalid' as const };
      }
      if (current.expiresAt.getTime() <= Date.now()) {
        return { kind: 'invalid' as const };
      }

      // Conditional revoke: if a concurrent request rotated this token first,
      // count is 0 and we treat this presentation as reuse.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: current.id, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'rotated' },
      });
      if (claimed.count === 0) {
        await this.revokeFamily(tx, current.familyId, 'reuse_detected');
        return { kind: 'reused' as const };
      }

      const user = await tx.user.findUnique({ where: { id: current.userId } });
      if (!user || !user.isActive) {
        await this.revokeFamily(tx, current.familyId, 'user_inactive');
        return { kind: 'invalid' as const };
      }
      const issued = await this.issueWithId(tx, user, current.familyId, meta);
      await tx.refreshToken.update({
        where: { id: current.id },
        data: { replacedById: issued.refreshTokenId },
      });
      return { kind: 'ok' as const, response: issued.response };
    });

    if (outcome.kind === 'reused') {
      this.logger.warn(
        `Refresh token reuse detected for tenant ${token.tenant_id}; family revoked`,
      );
      throw AppException.unauthorized(
        'Refresh token was already used. All sessions from this login have been signed out.',
        ErrorCode.REFRESH_TOKEN_REUSED,
      );
    }
    if (outcome.kind === 'invalid') {
      throw AppException.unauthorized(
        'Refresh token is invalid or expired',
        ErrorCode.INVALID_REFRESH_TOKEN,
      );
    }
    return outcome.response;
  }

  /** Revokes the presented token's family. Idempotent; never errors. */
  async logout(presented: string, meta: RequestMeta): Promise<void> {
    const hash = this.tokens.hashRefresh(presented);
    const token = await this.findRefreshToken(hash);
    if (!token) return;
    await this.db.tenant(token.tenant_id, async (tx) => {
      const revoked = await this.revokeFamily(tx, token.family_id, 'logout');
      if (revoked > 0) {
        await this.audit.record(tx, {
          tenantId: token.tenant_id,
          actor: null,
          action: 'auth.logout',
          entityType: 'user',
          entityId: token.user_id,
          ip: meta.ip,
        });
      }
    });
  }

  /**
   * M6 SSO: a tenant that enforces SSO refuses password sign-in, except for
   * its break-glass owner.
   */
  private async assertPasswordAllowed(found: FoundUser): Promise<void> {
    const sso = await this.db.control(found.tenant_id, (tx) =>
      tx.ssoConfig.findUnique({ where: { tenantId: found.tenant_id } }),
    );
    if (!sso?.enabled || !sso.enforced || sso.breakGlassUserId === found.id) return;
    const slug = await this.db.control(found.tenant_id, (tx) =>
      tx.tenant.findUnique({ where: { id: found.tenant_id }, select: { slug: true } }),
    );
    const base = this.config.get('API_PUBLIC_URL').replace(/\/$/, '');
    throw new AppException(
      HttpStatus.FORBIDDEN,
      'SSO_REQUIRED',
      'Your hotel signs in with single sign-on. Use the SSO button.',
      { startUrl: `${base}/api/v1/auth/sso/start?tenant=${encodeURIComponent(slug?.slug ?? '')}` },
    );
  }

  // ---------------------------------------------------------------------------
  // M6: owner set-up links (Enterprise onboarding from the console).
  // ---------------------------------------------------------------------------

  private async setupToken(token: string) {
    const row = await this.db.system((tx) =>
      tx.ownerSetupToken.findUnique({ where: { tokenHash: sha256Hex(`owner-setup:${token}`) } }),
    );
    if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
      throw AppException.notFound('Set-up link');
    }
    return row;
  }

  async setupPasswordInfo(token: string) {
    const row = await this.setupToken(token);
    const t = await this.db.system((tx) =>
      tx.tenant.findUnique({ where: { id: row.tenantId }, select: { name: true } }),
    );
    return {
      email: row.email,
      fullName: row.fullName,
      hotelName: t?.name ?? '',
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  async setupPassword(token: string, password: string, meta: RequestMeta): Promise<AuthResponse> {
    const row = await this.setupToken(token);
    const claimed = await this.db.system((tx) =>
      tx.ownerSetupToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
    );
    if (claimed.count === 0) throw AppException.notFound('Set-up link');
    const passwordHash = await this.hashPassword(password);
    return this.db.tenant(row.tenantId, async (tx) => {
      const user = await tx.user.update({
        where: { id: row.userId },
        data: { passwordHash, lastLoginAt: new Date(), isActive: true },
      });
      await this.audit.record(tx, {
        tenantId: row.tenantId,
        actor: { kind: 'user', id: user.id, name: user.fullName },
        action: 'auth.owner_setup_completed',
        entityType: 'user',
        entityId: user.id,
        ip: meta.ip,
      });
      return this.issue(tx, user, randomUUID(), meta);
    });
  }

  /** Signs a staff member in (SSO callback exchange). */
  async signInUser(tenantId: string, userId: string, action: string, meta: RequestMeta, metadata?: Record<string, unknown>): Promise<AuthResponse> {
    return this.db.tenant(tenantId, async (tx) => {
      const user = await tx.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
      if (!user.isActive) throw AppException.unauthorized('This account is deactivated', ErrorCode.INVALID_CREDENTIALS);
      await this.audit.record(tx, {
        tenantId,
        actor: { kind: 'user', id: user.id, name: user.fullName },
        action,
        entityType: 'user',
        entityId: user.id,
        metadata,
        ip: meta.ip,
      });
      return this.issue(tx, user, randomUUID(), meta);
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * M6: staff of a tenant with a dedicated database live there. The shared
   * database answers first; a match whose tenant has moved is re-read from
   * its dedicated database (the shared copy may be stale until it is
   * purged), and an unknown email is looked up in every dedicated database.
   */
  async findUserByEmail(email: string): Promise<FoundUser | undefined> {
    const lookup = async (client: { $queryRaw: PrismaClient['$queryRaw'] }) =>
      (await client.$queryRaw<FoundUser[]>`SELECT * FROM app_auth_find_user(${email.toLowerCase()})`)[0];
    const shared = await lookup(this.db.prisma);
    const route = shared ? this.db.router.dedicated(shared.tenant_id) : null;
    if (shared && !route) return shared;
    if (route) return this.db.router.use(route, (c) => lookup(c.app));
    return this.db.findAcross(lookup);
  }

  private async findRefreshToken(hash: string): Promise<FoundToken | undefined> {
    const lookup = async (client: { $queryRaw: PrismaClient['$queryRaw'] }) =>
      (await client.$queryRaw<FoundToken[]>`SELECT * FROM app_auth_find_refresh_token(${hash})`)[0];
    const shared = await lookup(this.db.prisma);
    const route = shared ? this.db.router.dedicated(shared.tenant_id) : null;
    if (shared && !route) return shared;
    if (route) return this.db.router.use(route, (c) => lookup(c.app));
    return this.db.findAcross(lookup);
  }

  private async revokeFamily(
    tx: Tx,
    familyId: string,
    reason: string,
  ): Promise<number> {
    const res = await tx.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    return res.count;
  }

  private async issue(
    tx: Tx,
    user: Parameters<AuthService['issueWithId']>[1],
    familyId: string,
    meta: RequestMeta,
  ): Promise<AuthResponse> {
    return (await this.issueWithId(tx, user, familyId, meta)).response;
  }

  private async issueWithId(
    tx: Tx,
    user: {
      id: string;
      tenantId: string;
      email: string;
      fullName: string;
      phone: string;
      role: StaffRole;
    },
    familyId: string,
    meta: RequestMeta,
  ): Promise<{ response: AuthResponse; refreshTokenId: string }> {
    const refreshToken = this.tokens.newRefreshSecret();
    const record = await tx.refreshToken.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        familyId,
        tokenHash: this.tokens.hashRefresh(refreshToken),
        expiresAt: this.tokens.refreshExpiry(),
        ip: meta.ip?.slice(0, 64),
        userAgent: meta.userAgent?.slice(0, 256),
      },
    });
    const accessToken = await this.tokens.signStaffAccess(user);
    return {
      refreshTokenId: record.id,
      response: {
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
          phone: user.phone,
          role: user.role,
        },
      },
    };
  }
}

export function isUniqueViolation(err: unknown, field: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code !== 'P2002') return false;
  const target = JSON.stringify(err.meta ?? {});
  return target.includes(field);
}
