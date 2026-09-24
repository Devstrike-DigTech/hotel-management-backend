import { HttpStatus, Injectable } from '@nestjs/common';
import type { PlatformPrincipal } from '../../../common/auth-types.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { DbService } from '../../../prisma/db.service.js';
import { ipAllowed, normaliseIp } from './cidr.js';
import { platformPermissionsFor } from './platform-permissions.js';

/** A platform session dies after 60 minutes without a request (or a refresh). */
export const PLATFORM_IDLE_MS = 60 * 60_000;
/** ... and 12 hours after sign-in whatever happens. */
export const PLATFORM_SESSION_MS = 12 * 3_600_000;

export function sessionRevoked(message = 'Your console session has ended. Sign in again.') {
  return new AppException(HttpStatus.UNAUTHORIZED, 'SESSION_REVOKED', message);
}

export function ipNotAllowed(ip: string | undefined) {
  return new AppException(HttpStatus.FORBIDDEN, 'IP_NOT_ALLOWED', 'Your network address is not on this account\'s allowlist', { ip: normaliseIp(ip) || null });
}

/**
 * Checks the platform session behind every platform request (M6): the
 * session exists, is not revoked, expired or idle, the user is active, and
 * the request comes from an allowed network. Touches `lastSeenAt` at most
 * once a minute.
 */
@Injectable()
export class PlatformSessionService {
  constructor(private readonly db: DbService) {}

  async validate(sessionId: string | undefined, userId: string, ip: string | undefined): Promise<PlatformPrincipal> {
    if (!sessionId) throw sessionRevoked();
    const now = new Date();
    const s = await this.db.system((tx) => tx.platformSession.findUnique({ where: { id: sessionId }, include: { user: true } }));
    if (!s || s.platformUserId !== userId || s.revokedAt || s.expiresAt <= now || now.getTime() - s.lastSeenAt.getTime() > PLATFORM_IDLE_MS) {
      throw sessionRevoked();
    }
    if (!s.user.isActive) throw sessionRevoked('This console account is no longer active');
    if (!ipAllowed(ip, s.user.ipAllowlist)) throw ipNotAllowed(ip);
    if (now.getTime() - s.lastSeenAt.getTime() > 60_000) {
      await this.db.system((tx) => tx.platformSession.update({ where: { id: s.id }, data: { lastSeenAt: now } })).catch(() => undefined);
    }
    return {
      platformUserId: s.user.id,
      email: s.user.email,
      role: s.user.role,
      fullName: s.user.fullName,
      sessionId: s.id,
      permissions: platformPermissionsFor(s.user.role),
      stepUpAt: s.stepUpAt,
    };
  }
}
