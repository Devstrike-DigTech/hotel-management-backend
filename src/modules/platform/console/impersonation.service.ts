import { HttpStatus, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { ImpersonationSession, Prisma } from '../../../generated/prisma/client.js';
import type { AuthUser, PlatformPrincipal } from '../../../common/auth-types.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { sha256Hex } from '../../../common/crypto/secret-box.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DbService } from '../../../prisma/db.service.js';
import { AuditService, toAuditItem } from '../../audit/audit.service.js';
import { TokenService } from '../../auth/token.service.js';
import { appError, Err } from '../../ops/ops.helpers.js';
import { ImpersonationGate } from '../security/impersonation-gate.js';
import { PlatformAuditService } from '../security/platform-audit.service.js';
import { SupportService } from './support.service.js';

const HANDOFF_MS = 2 * 60_000;
export const MAX_IMPERSONATION_MINUTES = 60;

export function impersonationView(s: ImpersonationSession, tenant: { id: string; name: string; slug: string }) {
  return {
    id: s.id,
    tenant,
    staff: { id: s.userId, fullName: s.userName, email: s.userEmail, role: s.userRole },
    platformUser: { id: s.platformUserId, fullName: s.platformUserName, email: s.platformUserEmail },
    reason: s.reason,
    writeReason: s.writeReason,
    mode: s.mode as 'READ_ONLY' | 'WRITE',
    startedAt: s.startedAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? (s.expiresAt <= new Date() ? s.expiresAt.toISOString() : null),
    endedBy: (s.endedBy ?? (!s.endedAt && s.expiresAt <= new Date() ? 'EXPIRED' : null)) as 'PLATFORM' | 'HOTEL_OWNER' | 'EXPIRED' | 'SELF' | null,
    supportRequestId: s.supportRequestId,
    requests: s.requests,
    writes: s.writes,
  };
}

export function bannerView(s: Pick<ImpersonationSession, 'id' | 'platformUserName' | 'mode' | 'reason' | 'expiresAt' | 'startedAt'>) {
  return {
    sessionId: s.id,
    platformUserName: s.platformUserName,
    mode: s.mode as 'READ_ONLY' | 'WRITE',
    reason: s.reason,
    expiresAt: s.expiresAt.toISOString(),
    startedAt: s.startedAt.toISOString(),
  };
}

/**
 * Support impersonation (M6): a platform user with `impersonate` (and a
 * fresh step-up) opens a time-boxed session (at most 60 minutes) as one hotel
 * staff member, with a mandatory reason. The admin app receives a one-time
 * handoff code and exchanges it for a staff token carrying the session id.
 * Sessions are read-only until write mode is switched on with a second
 * reason. Start, mode changes and end are written to both audit logs; every
 * write during the session is in the tenant's trail with the platform user's
 * name (see AuditService and ImpersonationInterceptor).
 */
@Injectable()
export class ImpersonationService {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly platformAudit: PlatformAuditService,
    private readonly gate: ImpersonationGate,
    private readonly support: SupportService,
  ) {}

  private async tenantRef(tenantId: string) {
    const t = await this.db.system((tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, slug: true } }));
    return t ?? { id: tenantId, name: '', slug: '' };
  }

  /** Tenant audit entry in the tenant's own database. */
  private async tenantAudit(tenantId: string, entry: { action: string; entityId: string; metadata: Record<string, unknown>; actor: { id: string; name: string }; ip?: string }) {
    await this.db.systemFor(tenantId, (tx) =>
      this.audit.record(tx, {
        tenantId,
        actor: { kind: 'platform', id: entry.actor.id, name: `${entry.actor.name} (${this.config.get('APP_NAME')} support)` },
        action: entry.action,
        entityType: 'impersonation_session',
        entityId: entry.entityId,
        propertyId: null,
        metadata: entry.metadata,
        ip: entry.ip,
      }),
    );
  }

  async start(p: PlatformPrincipal, dto: { tenantId: string; userId: string; reason: string; durationMinutes?: number; supportRequestId?: string }, ip?: string) {
    const minutes = Math.min(Math.max(dto.durationMinutes ?? 30, 5), MAX_IMPERSONATION_MINUTES);
    const tenant = await this.db.system((tx) => tx.tenant.findUnique({ where: { id: dto.tenantId }, select: { id: true, name: true, slug: true, lifecycle: true } }));
    if (!tenant || tenant.lifecycle === 'DELETED') throw AppException.notFound('Tenant');
    const staff = await this.db.systemFor(dto.tenantId, (tx) => tx.user.findFirst({ where: { id: dto.userId, tenantId: dto.tenantId } }));
    if (!staff) throw AppException.notFound('Staff member');
    if (!staff.isActive) throw Err.validation('userId', 'This staff member is deactivated');
    if (staff.role === 'OWNER' && p.role !== 'SUPER_ADMIN') throw appError(HttpStatus.FORBIDDEN, 'PLATFORM_FORBIDDEN', 'Only a super admin may open a session as an owner', { permission: 'SUPER_ADMIN' });
    const code = randomBytes(32).toString('base64url');
    const now = new Date();
    let s: ImpersonationSession;
    try {
      s = await this.db.system(async (tx) => {
        // An expired session of this platform user is closed first (one live session each).
        await tx.impersonationSession.updateMany({ where: { platformUserId: p.platformUserId, endedAt: null, expiresAt: { lte: now } }, data: { endedAt: now, endedBy: 'EXPIRED' } });
        return tx.impersonationSession.create({
          data: {
            tenantId: dto.tenantId, userId: staff.id, userName: staff.fullName, userEmail: staff.email, userRole: staff.role,
            platformUserId: p.platformUserId, platformUserName: p.fullName, platformUserEmail: p.email,
            reason: dto.reason.trim(), mode: 'READ_ONLY', startedAt: now, expiresAt: new Date(now.getTime() + minutes * 60_000),
            supportRequestId: dto.supportRequestId ?? null,
            handoffCodeHash: sha256Hex(`imp:${code}`), handoffExpiresAt: new Date(now.getTime() + HANDOFF_MS),
          },
        });
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'You already have a support session open; end it first', { status: 'ACTIVE', allowed: ['ENDED'] });
      throw e;
    }
    const meta = { sessionId: s.id, staffId: staff.id, staffName: staff.fullName, reason: s.reason, minutes, supportRequestId: s.supportRequestId };
    await this.platformAudit.record({ actor: p, action: 'impersonation.started', targetType: 'impersonation_session', targetId: s.id, tenantId: s.tenantId, ip, metadata: meta });
    await this.tenantAudit(s.tenantId, { action: 'impersonation.started', entityId: s.id, metadata: meta, actor: { id: p.platformUserId, name: p.fullName }, ip });
    if (s.supportRequestId) {
      await this.support.internalNote(s.supportRequestId, p, `Support session started as ${staff.fullName} (${minutes} minutes, read-only). Reason: ${s.reason}`).catch(() => undefined);
    }
    const handoffUrl = `${this.config.get('ADMIN_URL').replace(/\/$/, '')}/impersonate#code=${code}`;
    return { session: impersonationView(s, { id: tenant.id, name: tenant.name, slug: tenant.slug }), handoffUrl };
  }

  /** The admin app exchanges the one-time code for a staff token of the session. */
  async exchange(code: string, ip?: string) {
    const now = new Date();
    const s = await this.db.system(async (tx) => {
      const row = await tx.impersonationSession.findUnique({ where: { handoffCodeHash: sha256Hex(`imp:${code}`) } });
      if (!row || row.handoffUsedAt || !row.handoffExpiresAt || row.handoffExpiresAt <= now || row.endedAt || row.expiresAt <= now) return null;
      const claimed = await tx.impersonationSession.updateMany({ where: { id: row.id, handoffUsedAt: null }, data: { handoffUsedAt: now } });
      return claimed.count ? row : null;
    });
    if (!s) throw appError(HttpStatus.UNAUTHORIZED, 'IMPERSONATION_ENDED', 'This support link is invalid or has expired');
    const user = await this.db.systemFor(s.tenantId, (tx) => tx.user.findUnique({ where: { id: s.userId } }));
    if (!user || !user.isActive) throw appError(HttpStatus.UNAUTHORIZED, 'IMPERSONATION_ENDED', 'This staff member is no longer active');
    const accessToken = await this.tokens.signImpersonation(user, s.id, s.expiresAt);
    await this.platformAudit.record({ actor: { platformUserId: s.platformUserId, fullName: s.platformUserName, role: '' }, action: 'impersonation.handoff_used', targetType: 'impersonation_session', targetId: s.id, tenantId: s.tenantId, ip });
    return {
      accessToken,
      expiresAt: s.expiresAt.toISOString(),
      user: { id: user.id, fullName: user.fullName, email: user.email, phone: user.phone, role: user.role },
      impersonation: bannerView(s),
    };
  }

  private async load(id: string) {
    const s = await this.db.system((tx) => tx.impersonationSession.findUnique({ where: { id } }));
    if (!s) throw AppException.notFound('Support session');
    return s;
  }

  async list(q: { tenantId?: string; active?: string; page?: number; pageSize?: number }) {
    const page = q.page ?? 1;
    const pageSize = Math.min(q.pageSize ?? 20, 100);
    const now = new Date();
    const where: Prisma.ImpersonationSessionWhereInput = {
      ...(q.tenantId && { tenantId: q.tenantId }),
      ...(q.active === 'true' && { endedAt: null, expiresAt: { gt: now } }),
      ...(q.active === 'false' && { OR: [{ endedAt: { not: null } }, { expiresAt: { lte: now } }] }),
    };
    return this.db.system(async (tx) => {
      const rows = await tx.impersonationSession.findMany({ where, orderBy: { startedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize });
      const total = await tx.impersonationSession.count({ where });
      const tenants = await tx.tenant.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] } }, select: { id: true, name: true, slug: true } });
      const byId = new Map(tenants.map((t) => [t.id, t]));
      return { items: rows.map((r) => impersonationView(r, byId.get(r.tenantId) ?? { id: r.tenantId, name: '', slug: '' })), total, page, pageSize };
    });
  }

  async get(id: string) {
    const s = await this.load(id);
    const activity = await this.db.systemFor(s.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { tenantId: s.tenantId, createdAt: { gte: s.startedAt }, metadata: { path: ['impersonation', 'sessionId'], equals: s.id } }, orderBy: { createdAt: 'asc' }, take: 500 }),
    );
    return { ...impersonationView(s, await this.tenantRef(s.tenantId)), activity: activity.map((a) => toAuditItem(a)) };
  }

  async setWriteMode(p: PlatformPrincipal, id: string, enabled: boolean, reason: string | undefined, ip?: string) {
    const s = await this.load(id);
    if (s.endedAt || s.expiresAt <= new Date()) throw Err.invalidState('ENDED', ['ACTIVE'], 'This support session');
    if (s.platformUserId !== p.platformUserId && p.role !== 'SUPER_ADMIN') throw appError(HttpStatus.FORBIDDEN, 'PLATFORM_FORBIDDEN', 'Only the platform user who opened this session can change it', { permission: 'impersonate' });
    if (enabled && (!reason || reason.trim().length < 10)) throw Err.validation('reason', 'Give a reason (at least 10 characters) to allow changes');
    const updated = await this.db.system((tx) => tx.impersonationSession.update({ where: { id }, data: enabled ? { mode: 'WRITE', writeReason: reason!.trim() } : { mode: 'READ_ONLY' } }));
    this.gate.forget(id);
    const action = enabled ? 'impersonation.write_enabled' : 'impersonation.write_disabled';
    const meta = { sessionId: id, ...(enabled && { reason: reason!.trim() }) };
    await this.platformAudit.record({ actor: p, action, targetType: 'impersonation_session', targetId: id, tenantId: s.tenantId, ip, metadata: meta });
    await this.tenantAudit(s.tenantId, { action, entityId: id, metadata: meta, actor: { id: p.platformUserId, name: p.fullName }, ip });
    return impersonationView(updated, await this.tenantRef(s.tenantId));
  }

  async end(id: string, by: { kind: 'PLATFORM'; p: PlatformPrincipal } | { kind: 'HOTEL_OWNER' | 'SELF'; user: AuthUser }, ip?: string) {
    const s = await this.load(id);
    if (s.endedAt) return impersonationView(s, await this.tenantRef(s.tenantId));
    const updated = await this.db.system((tx) => tx.impersonationSession.update({ where: { id }, data: { endedAt: new Date(), endedBy: by.kind } }));
    this.gate.forget(id);
    const actor = by.kind === 'PLATFORM' ? { id: by.p.platformUserId, name: by.p.fullName } : { id: s.platformUserId, name: s.platformUserName };
    const meta = { sessionId: id, endedBy: by.kind, ...(by.kind !== 'PLATFORM' && { endedByUser: by.user.fullName }) };
    await this.platformAudit.record({
      actor: by.kind === 'PLATFORM' ? by.p : { platformUserId: s.platformUserId, fullName: s.platformUserName, role: '' },
      action: 'impersonation.ended', targetType: 'impersonation_session', targetId: id, tenantId: s.tenantId, ip, metadata: meta,
    });
    await this.tenantAudit(s.tenantId, { action: 'impersonation.ended', entityId: id, metadata: meta, actor, ip });
    return impersonationView(updated, await this.tenantRef(s.tenantId));
  }

  /** Counts requests and writes of a session (the interceptor calls this after each request). */
  async count(sessionId: string, write: boolean) {
    await this.db.system((tx) => tx.impersonationSession.update({ where: { id: sessionId }, data: { requests: { increment: 1 }, ...(write && { writes: { increment: 1 } }) } })).catch(() => undefined);
  }

  // Hotel side -----------------------------------------------------------------

  async current(u: AuthUser) {
    if (!u.impersonation) return null;
    const s = await this.load(u.impersonation.sessionId);
    return bannerView(s);
  }

  async hotelList(u: AuthUser, q: { page?: number; pageSize?: number }) {
    return this.list({ tenantId: u.tenantId, page: q.page, pageSize: q.pageSize });
  }

  async hotelEnd(u: AuthUser, id: string, ip?: string) {
    const s = await this.load(id);
    if (s.tenantId !== u.tenantId) throw AppException.notFound('Support session');
    if (u.impersonation) {
      if (u.impersonation.sessionId !== id) throw AppException.forbidden();
      return this.end(id, { kind: 'SELF', user: u }, ip);
    }
    if (u.role !== 'OWNER') throw AppException.forbidden('Only an owner can end a support session');
    return this.end(id, { kind: 'HOTEL_OWNER', user: u }, ip);
  }
}
