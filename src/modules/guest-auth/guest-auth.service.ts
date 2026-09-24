import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { waTemplateFor } from '../whatsapp/templates.registry.js';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { GuestAccount } from '../../generated/prisma/client.js';
import { GUEST_AUDIENCE, type GuestPrincipal, type GuestTokenPayload } from '../../common/auth-types.js';
import { signToken, verifyToken } from '../../common/crypto/signed-token.js';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { normalisePhone } from '../../common/utils/phone.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService } from '../../prisma/db.service.js';
import { BookingViewService, stayInclude } from '../booking/booking-view.service.js';
import { RateLimitService } from '../infra/rate-limit.js';
import { NotificationService } from '../notifications/notification.service.js';
import { renderTemplate } from '../notifications/templates/templates.js';
import { appError, Err } from '../ops/ops.helpers.js';
import {
  evaluateAttempt,
  generateOtp,
  hashOtp,
  MAGIC_LINK_TTL_MS,
  maskedPhone,
  OTP_LENGTH,
  OTP_LOCK_MS,
  OTP_MAX_ATTEMPTS,
  OTP_PER_HOUR,
  OTP_RESEND_MS,
  OTP_TTL_MS,
  otpMatches,
} from './otp.logic.js';

const REFRESH_DAYS = 30;

interface MagicPayload {
  cid: string;
  n: string;
  exp: number;
}

/**
 * Platform-level guest accounts (one per phone number, across all hotels).
 * Everything here uses the platform role: guest identity tables are not
 * visible to the tenant role at all.
 */
@Injectable()
export class GuestAuthService {
  private readonly logger = new Logger(GuestAuthService.name);

  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    private readonly notifications: NotificationService,
    private readonly limits: RateLimitService,
    private readonly views: BookingViewService,
  ) {}

  private get tokenSecret() {
    return this.config.get('GUEST_TOKEN_SECRET');
  }

  private brand() {
    return { appName: this.config.get('APP_NAME'), appDomain: this.config.get('APP_DOMAIN'), supportEmail: this.config.get('SUPPORT_EMAIL') };
  }

  view(a: GuestAccount) {
    return { id: a.id, phone: a.phone, email: a.email, fullName: a.fullName, profileComplete: a.fullName.trim().length >= 2, createdAt: a.createdAt.toISOString() };
  }

  // ---------------------------------------------------------------------------
  // OTP
  // ---------------------------------------------------------------------------

  async otpStart(raw: string, channel: 'SMS' | 'WHATSAPP' = 'SMS', ip?: string) {
    const phone = normalisePhone(raw);
    if (!phone) throw Err.validation('phone', 'Enter a valid phone number, e.g. 0803 123 4567');
    await this.limits.consume(`otp-start:ip:${ip ?? 'unknown'}`, 20, 3600, 'ip');
    const now = new Date();
    const recent = await this.db.system((tx) =>
      tx.guestOtpChallenge.findMany({
        where: { kind: 'OTP', phone, createdAt: { gte: new Date(now.getTime() - 3_600_000) } },
        orderBy: { createdAt: 'desc' },
      }),
    );
    const locked = recent.find((c) => c.lockedAt && c.lockedAt.getTime() + OTP_LOCK_MS > now.getTime());
    if (locked) {
      throw appError(HttpStatus.TOO_MANY_REQUESTS, 'OTP_LOCKED', 'Too many wrong codes. Try again in 15 minutes.', {
        lockedUntil: new Date(locked.lockedAt!.getTime() + OTP_LOCK_MS).toISOString(),
      });
    }
    if (recent[0] && now.getTime() - recent[0].createdAt.getTime() < OTP_RESEND_MS) {
      const wait = Math.ceil((OTP_RESEND_MS - (now.getTime() - recent[0].createdAt.getTime())) / 1000);
      throw appError(HttpStatus.TOO_MANY_REQUESTS, 'OTP_RESEND_TOO_SOON', `Please wait ${wait} seconds before asking for a new code.`, { retryAfterSec: wait });
    }
    if (recent.length >= OTP_PER_HOUR) {
      throw appError(HttpStatus.TOO_MANY_REQUESTS, ErrorCode.RATE_LIMITED, 'Too many codes for this number. Try again later.', { retryAfterSec: 3600, scope: 'phone' });
    }
    const id = randomUUID();
    const code = generateOtp();
    const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
    await this.db.system(async (tx) => {
      // Only the newest code for a number works.
      await tx.guestOtpChallenge.updateMany({ where: { kind: 'OTP', phone, consumedAt: null }, data: { consumedAt: now } });
      await tx.guestOtpChallenge.create({
        data: { id, kind: 'OTP', phone, channel, codeHash: hashOtp(this.tokenSecret, id, code), expiresAt, maxAttempts: OTP_MAX_ATTEMPTS, ip: ip ?? null },
      });
    });
    const rendered = renderTemplate(this.brand(), { template: 'OTP', code, minutes: OTP_TTL_MS / 60_000 });
    await this.notifications.sendSensitive({
      tenantId: null,
      template: 'OTP',
      channel,
      to: phone,
      subject: null,
      text: rendered.sms,
      html: null,
      redactedText: rendered.sms.replace(code, '••••••'),
      meta: { otpCode: code },
      waTemplate: channel === 'WHATSAPP' ? waTemplateFor({ template: 'OTP', code, minutes: OTP_TTL_MS / 60_000 }) : null,
    });
    return { challengeId: id, channel, maskedPhone: maskedPhone(phone), expiresAt: expiresAt.toISOString(), resendAfterSec: OTP_RESEND_MS / 1000, codeLength: OTP_LENGTH };
  }

  async otpVerify(challengeId: string, code: string, ip?: string) {
    await this.limits.consume(`otp-verify:ip:${ip ?? 'unknown'}`, 30, 600, 'ip');
    const now = new Date();
    // The attempt is recorded in its own transaction so a wrong code counts even though the request fails.
    const outcome = await this.db.system(async (tx) => {
      await tx.$queryRaw`SELECT id FROM guest_otp_challenges WHERE id = ${challengeId}::uuid FOR UPDATE`;
      const c = await tx.guestOtpChallenge.findUnique({ where: { id: challengeId } });
      if (!c || c.kind !== 'OTP' || !c.phone) return { kind: 'expired' as const };
      const res = evaluateAttempt(c, otpMatches(this.tokenSecret, c.id, code, c.codeHash), now);
      if (res.kind === 'locked') return { kind: 'locked' as const, lockedUntil: new Date((c.lockedAt ?? now).getTime() + OTP_LOCK_MS) };
      if (res.kind === 'expired') return { kind: 'expired' as const };
      if (res.kind === 'invalid') {
        await tx.guestOtpChallenge.update({ where: { id: c.id }, data: { attempts: { increment: 1 }, ...(res.lockNow && { lockedAt: now }) } });
        return res.lockNow ? { kind: 'locked' as const, lockedUntil: new Date(now.getTime() + OTP_LOCK_MS) } : { kind: 'invalid' as const, attemptsLeft: res.attemptsLeft };
      }
      await tx.guestOtpChallenge.update({ where: { id: c.id }, data: { consumedAt: now, attempts: { increment: 1 } } });
      const existing = await tx.guestAccount.findUnique({ where: { phone: c.phone } });
      const account = existing
        ? await tx.guestAccount.update({ where: { id: existing.id }, data: { lastLoginAt: now } })
        : await tx.guestAccount.create({ data: { phone: c.phone, lastLoginAt: now } });
      if (!existing) {
        // Seed the profile from the most recent hotel guest record with this phone.
        const g = await tx.guest.findFirst({ where: { phone: c.phone, anonymisedAt: null }, orderBy: { updatedAt: 'desc' } });
        if (g) {
          await tx.guestAccount.update({ where: { id: account.id }, data: { fullName: g.fullName, email: g.email ?? null } });
          account.fullName = g.fullName;
          account.email = g.email ?? null;
        }
      }
      // Verified phone: every hotel's guest record with this number now belongs to the account.
      await tx.guest.updateMany({ where: { phone: c.phone, guestAccountId: null }, data: { guestAccountId: account.id } });
      return { kind: 'ok' as const, account, isNew: !existing };
    });
    if (outcome.kind === 'ok') {
      // M6: guest records of hotels with a dedicated database are linked there.
      const phone = outcome.account.phone;
      for (const r of this.db.router.activeDedicated()) {
        await this.db.systemFor(r.tenantId, (tx) => tx.guest.updateMany({ where: { phone, guestAccountId: null }, data: { guestAccountId: outcome.account.id } })).catch(() => undefined);
      }
    }
    switch (outcome.kind) {
      case 'expired':
        throw appError(HttpStatus.GONE, 'OTP_EXPIRED', 'This code has expired. Ask for a new one.');
      case 'locked':
        throw appError(HttpStatus.TOO_MANY_REQUESTS, 'OTP_LOCKED', 'Too many wrong codes. Try again in 15 minutes.', { lockedUntil: outcome.lockedUntil.toISOString() });
      case 'invalid':
        throw appError(HttpStatus.BAD_REQUEST, 'OTP_INVALID', `That code is not right. ${outcome.attemptsLeft} ${outcome.attemptsLeft === 1 ? 'try' : 'tries'} left.`, {
          attemptsLeft: outcome.attemptsLeft,
        });
    }
    return this.issue(outcome.account, outcome.isNew);
  }

  // ---------------------------------------------------------------------------
  // Email magic link
  // ---------------------------------------------------------------------------

  async emailStart(emailRaw: string, ip?: string) {
    const email = emailRaw.trim().toLowerCase();
    await this.limits.consume(`magic:ip:${ip ?? 'unknown'}`, 10, 3600, 'ip');
    await this.limits.consume(`magic:email:${email}`, 3, 3600, 'email');
    const account = await this.db.system((tx) => tx.guestAccount.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } }));
    if (!account) return { sent: true as const };
    const id = randomUUID();
    const nonce = randomBytes(18).toString('base64url');
    const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);
    await this.db.system((tx) =>
      tx.guestOtpChallenge.create({ data: { id, kind: 'MAGIC_LINK', email, channel: 'EMAIL', codeHash: hashOtp(this.tokenSecret, id, nonce), expiresAt, maxAttempts: 1, ip: ip ?? null } }),
    );
    const token = signToken<MagicPayload>(this.tokenSecret, 'magic', { cid: id, n: nonce, exp: Math.floor(expiresAt.getTime() / 1000) });
    const url = `${this.config.get('WEB_URL')}/account/verify?token=${encodeURIComponent(token)}`;
    const rendered = renderTemplate(this.brand(), { template: 'MAGIC_LINK', url, minutes: MAGIC_LINK_TTL_MS / 60_000, fullName: account.fullName });
    await this.notifications.sendSensitive({
      tenantId: null,
      guestAccountId: account.id,
      template: 'MAGIC_LINK',
      channel: 'EMAIL',
      to: email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      redactedText: rendered.text.split(url).join('[sign-in link]'),
      meta: { magicLinkUrl: url },
    });
    return { sent: true as const };
  }

  async emailVerify(token: string) {
    const res = verifyToken<MagicPayload>(this.tokenSecret, 'magic', token);
    if (!res.ok) {
      if (res.reason === 'expired') throw appError(HttpStatus.GONE, 'LINK_EXPIRED', 'This sign-in link has expired. Ask for a new one.');
      throw appError(HttpStatus.BAD_REQUEST, 'LINK_INVALID', 'This sign-in link is not valid.');
    }
    const now = new Date();
    const outcome = await this.db.system(async (tx) => {
      await tx.$queryRaw`SELECT id FROM guest_otp_challenges WHERE id = ${res.payload.cid}::uuid FOR UPDATE`;
      const c = await tx.guestOtpChallenge.findUnique({ where: { id: res.payload.cid } });
      if (!c || c.kind !== 'MAGIC_LINK' || !c.email) return null;
      if (c.consumedAt || c.expiresAt <= now || !otpMatches(this.tokenSecret, c.id, res.payload.n, c.codeHash)) return null;
      await tx.guestOtpChallenge.update({ where: { id: c.id }, data: { consumedAt: now, attempts: 1 } });
      const account = await tx.guestAccount.findFirst({ where: { email: { equals: c.email, mode: 'insensitive' } } });
      if (!account) return null;
      return tx.guestAccount.update({ where: { id: account.id }, data: { lastLoginAt: now } });
    });
    if (!outcome) throw appError(HttpStatus.GONE, 'LINK_EXPIRED', 'This sign-in link has already been used or has expired.');
    return this.issue(outcome, false);
  }

  // ---------------------------------------------------------------------------
  // Tokens
  // ---------------------------------------------------------------------------

  private hashRefresh(token: string): string {
    return createHmac('sha256', this.config.get('JWT_REFRESH_SECRET')).update(`guest:${token}`).digest('hex');
  }

  private async issue(account: GuestAccount, isNew: boolean, familyId: string = randomUUID()) {
    const ttl = this.config.get('GUEST_ACCESS_TTL_SECONDS');
    const payload: GuestTokenPayload = { sub: account.id, phone: account.phone };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get('GUEST_JWT_SECRET'),
      audience: GUEST_AUDIENCE,
      issuer: this.config.get('APP_DOMAIN'),
      expiresIn: ttl,
    });
    const refreshToken = randomBytes(32).toString('base64url');
    await this.db.system((tx) =>
      tx.guestRefreshToken.create({
        data: { guestAccountId: account.id, familyId, tokenHash: this.hashRefresh(refreshToken), expiresAt: new Date(Date.now() + REFRESH_DAYS * 86_400_000) },
      }),
    );
    return { accessToken, refreshToken, expiresIn: ttl, guest: this.view(account), isNew };
  }

  async refresh(token: string, ip?: string) {
    await this.limits.consume(`guest-refresh:ip:${ip ?? 'unknown'}`, 60, 60, 'ip');
    const hash = this.hashRefresh(token);
    const now = new Date();
    const outcome = await this.db.system(async (tx) => {
      const row = await tx.guestRefreshToken.findUnique({ where: { tokenHash: hash }, include: { account: true } });
      if (!row || row.expiresAt <= now) return { kind: 'invalid' as const };
      if (row.revokedAt) {
        if (row.revokeReason === 'rotated') {
          await tx.guestRefreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'reuse_detected' } });
          return { kind: 'reused' as const };
        }
        return { kind: 'invalid' as const };
      }
      const claimed = await tx.guestRefreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: now, revokeReason: 'rotated' } });
      if (claimed.count === 0) {
        await tx.guestRefreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: now, revokeReason: 'reuse_detected' } });
        return { kind: 'reused' as const };
      }
      return { kind: 'ok' as const, account: row.account, familyId: row.familyId };
    });
    if (outcome.kind === 'invalid') throw AppException.unauthorized('Your session has ended. Please sign in again.', ErrorCode.INVALID_REFRESH_TOKEN);
    if (outcome.kind === 'reused') throw AppException.unauthorized('Your session was used elsewhere. Please sign in again.', ErrorCode.REFRESH_TOKEN_REUSED);
    return this.issue(outcome.account, false, outcome.familyId);
  }

  async logout(token: string) {
    const hash = this.hashRefresh(token);
    await this.db.system(async (tx) => {
      const row = await tx.guestRefreshToken.findUnique({ where: { tokenHash: hash } });
      if (row) await tx.guestRefreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'logout' } });
    });
    return { success: true as const };
  }

  // ---------------------------------------------------------------------------
  // Signed-in guest
  // ---------------------------------------------------------------------------

  async me(g: GuestPrincipal) {
    const a = await this.db.system((tx) => tx.guestAccount.findUnique({ where: { id: g.guestAccountId } }));
    if (!a) throw AppException.unauthorized();
    return this.view(a);
  }

  async updateMe(g: GuestPrincipal, dto: { fullName?: string; email?: string | null }) {
    const a = await this.db.system((tx) =>
      tx.guestAccount.update({
        where: { id: g.guestAccountId },
        data: {
          ...(dto.fullName !== undefined && { fullName: dto.fullName.trim() }),
          ...(dto.email !== undefined && { email: dto.email ? dto.email.trim().toLowerCase() : null }),
        },
      }),
    );
    return this.view(a);
  }

  /**
   * Trips across hotels. Read with the platform role, strictly filtered to
   * this account: bookings made while signed in, or at any hotel whose guest
   * record carries the account's verified phone.
   */
  async trips(g: GuestPrincipal, now = new Date()) {
    // M6: across the shared and every dedicated database.
    const parts = await this.db.systemAll(async (tx, t) => {
      const rows = await tx.reservation.findMany({
        where: {
          ...t.tenants,
          OR: [{ guestAccountId: g.guestAccountId }, { guest: { guestAccountId: g.guestAccountId } }],
          AND: [{ OR: [{ cancelReason: null }, { cancelReason: { not: 'PAYMENT_INIT_FAILED' } }] }],
        },
        include: stayInclude,
        orderBy: { arrivalAt: 'asc' },
        take: 200,
      });
      // M5: points earned per stay (loyalty).
      const earned = rows.length ? await tx.loyaltyTransaction.findMany({ where: { type: 'EARN', reservationId: { in: rows.map((r) => r.id) } }, select: { reservationId: true, points: true } }) : [];
      return { rows, earned };
    });
    const rows = parts.flatMap((p) => p.rows).sort((a, b) => a.arrivalAt.getTime() - b.arrivalAt.getTime());
    const earned = parts.flatMap((p) => p.earned);
    const earnedBy = new Map(earned.map((e) => [e.reservationId, e.points]));
    type Trip = ReturnType<BookingViewService['tripSummary']> & { pointsEarned: number | null };
    const upcoming: Trip[] = [];
    const past: Trip[] = [];
    for (const r of rows) {
      const t = { ...this.views.tripSummary(r, now), pointsEarned: earnedBy.get(r.id) ?? null };
      const active = ['AWAITING_PAYMENT', 'CONFIRMED', 'CHECKED_IN'].includes(t.displayStatus) && r.departureAt > now;
      (active ? upcoming : past).push(t);
    }
    past.reverse();
    return { upcoming, past };
  }
}
