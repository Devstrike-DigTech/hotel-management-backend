import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../../common/errors/app-exception.js';
import { DbService } from '../../../prisma/db.service.js';

export interface GateSession {
  id: string;
  tenantId: string;
  userId: string;
  platformUserId: string;
  platformUserName: string;
  mode: 'READ_ONLY' | 'WRITE';
  expiresAt: Date;
  active: boolean;
}

/** Hotel routes a read-only support session may still POST to (read-style actions). */
export const READ_ONLY_ALLOWED_WRITES = [/\/impersonation\/end$/, /\/rates\/quote$/, /\/auth\/logout$/, /\/announcements\/[^/]+\/seen$/];

export function impersonationEnded() {
  return new AppException(HttpStatus.UNAUTHORIZED, 'IMPERSONATION_ENDED', 'This support session has ended');
}

export function impersonationReadOnly(sessionId: string) {
  return new AppException(HttpStatus.FORBIDDEN, 'IMPERSONATION_READ_ONLY', 'This support session is read-only. Ask the platform user to enable write access.', { sessionId });
}

/**
 * Validates impersonation tokens on every hotel request (M6). Sessions are
 * cached for two seconds, so an ended session or a mode change applies
 * almost at once (and at once on this instance: `forget` is called).
 */
@Injectable()
export class ImpersonationGate {
  private readonly cache = new Map<string, { at: number; s: GateSession | null }>();

  constructor(private readonly db: DbService) {}

  forget(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  async session(sessionId: string): Promise<GateSession | null> {
    const hit = this.cache.get(sessionId);
    if (hit && Date.now() - hit.at < 2000) return hit.s;
    const row = await this.db.system((tx) => tx.impersonationSession.findUnique({ where: { id: sessionId } }));
    const s: GateSession | null = row
      ? {
          id: row.id, tenantId: row.tenantId, userId: row.userId, platformUserId: row.platformUserId, platformUserName: row.platformUserName,
          mode: row.mode === 'WRITE' ? 'WRITE' : 'READ_ONLY', expiresAt: row.expiresAt, active: !row.endedAt,
        }
      : null;
    this.cache.set(sessionId, { at: Date.now(), s });
    if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value!);
    return s;
  }

  /** The live session for a token, or throws IMPERSONATION_ENDED. */
  async check(sessionId: string, tenantId: string, userId: string): Promise<GateSession> {
    const s = await this.session(sessionId);
    if (!s || !s.active || s.expiresAt <= new Date() || s.tenantId !== tenantId || s.userId !== userId) throw impersonationEnded();
    return s;
  }
}
