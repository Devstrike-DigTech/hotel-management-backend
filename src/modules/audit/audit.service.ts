import { Injectable } from '@nestjs/common';
import type { AuditLog, Prisma } from '../../generated/prisma/client.js';
import type { AuthUser, PlatformPrincipal } from '../../common/auth-types.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { addDays, diffDays, isIsoDate, lagosStartOfDay } from '../../common/time/lagos.js';
import { Err } from '../ops/ops.helpers.js';

export type AuditActor =
  | { kind: 'user'; id: string; name: string }
  | { kind: 'platform'; id: string; name: string }
  | { kind: 'system'; name: string };

export interface AuditEntry {
  /** Null for platform-level events (only readable in the system context). */
  tenantId: string | null;
  actor: AuditActor | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export interface AuditItem {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actor: { id: string; fullName: string } | null;
  metadata: unknown;
  createdAt: string;
}

export const userActor = (u: AuthUser): AuditActor => ({
  kind: 'user',
  id: u.userId,
  name: u.fullName,
});

export const platformActor = (p: PlatformPrincipal): AuditActor => ({
  kind: 'platform',
  id: p.platformUserId,
  name: p.fullName,
});

export const SYSTEM_ACTOR: AuditActor = { kind: 'system', name: 'System' };

export interface AuditFilter {
  from?: string;
  to?: string;
  action?: string;
  actorId?: string;
  entityType?: string;
}

/** CSV cell, quoted when needed and protected against spreadsheet formula injection. */
export function csvCell(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toAuditItem(log: AuditLog): AuditItem {
  const actorId = log.actorUserId ?? log.actorPlatformUserId;
  return {
    id: log.id,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId,
    actor: actorId ? { id: actorId, fullName: log.actorName ?? '' } : null,
    metadata: log.metadata,
    createdAt: log.createdAt.toISOString(),
  };
}

/**
 * Append-only audit trail. `record` must be called with the same transaction
 * that performs the mutation, so the change and its audit entry commit (or
 * roll back) together.
 */
@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  async record(tx: Tx, entry: AuditEntry): Promise<void> {
    const a = entry.actor;
    await tx.auditLog.create({
      data: {
        tenantId: entry.tenantId,
        actorUserId: a?.kind === 'user' ? a.id : null,
        actorPlatformUserId: a?.kind === 'platform' ? a.id : null,
        actorName: a?.name ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
        ip: entry.ip ?? null,
      },
    });
  }

  private where(tenantId: string, f: AuditFilter): Prisma.AuditLogWhereInput {
    return {
      tenantId,
      ...((f.from || f.to) && {
        createdAt: { ...(f.from && { gte: lagosStartOfDay(f.from) }), ...(f.to && { lt: lagosStartOfDay(addDays(f.to, 1)) }) },
      }),
      ...(f.action && { action: { startsWith: f.action } }),
      ...(f.actorId && { actorUserId: f.actorId }),
      ...(f.entityType && { entityType: f.entityType }),
    };
  }

  async list(tenantId: string, page: number, pageSize: number, filter: AuditFilter = {}): Promise<{ items: AuditItem[]; total: number }> {
    return this.db.tenant(tenantId, async (tx) => {
      const where = this.where(tenantId, filter);
      const rows = await tx.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
      const total = await tx.auditLog.count({ where });
      return { items: rows.map(toAuditItem), total };
    });
  }

  /**
   * Audit trail export (Pro, `audit_export`) for a date range as CSV or JSON.
   * The export itself is recorded in the trail in the same transaction.
   */
  async export(user: AuthUser, q: { from: string; to: string; format?: 'csv' | 'json' }, ip?: string) {
    if (!isIsoDate(q.from) || !isIsoDate(q.to) || q.to < q.from) throw Err.validation('to', 'Give a valid date range (YYYY-MM-DD)');
    if (diffDays(q.from, q.to) > 366) throw Err.validation('to', 'The range can be at most 366 days');
    const format = q.format ?? 'csv';
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.auditLog.findMany({ where: this.where(user.tenantId, { from: q.from, to: q.to }), orderBy: { createdAt: 'asc' }, take: 100_000 });
      await this.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'audit.exported',
        entityType: 'audit_log',
        metadata: { from: q.from, to: q.to, format, count: rows.length },
        ip,
      });
      const filename = `audit-${q.from}-${q.to}.${format}`;
      if (format === 'json') {
        return { filename, contentType: 'application/json', body: JSON.stringify({ from: q.from, to: q.to, exportedAt: new Date().toISOString(), count: rows.length, items: rows.map((r) => ({ ...toAuditItem(r), ip: r.ip })) }) };
      }
      const cols = ['createdAt', 'actor', 'actorId', 'action', 'entityType', 'entityId', 'ip', 'metadata'];
      const lines = [cols.join(',')];
      for (const r of rows) {
        lines.push(
          [r.createdAt.toISOString(), r.actorName ?? '', r.actorUserId ?? r.actorPlatformUserId ?? '', r.action, r.entityType, r.entityId ?? '', r.ip ?? '', JSON.stringify(r.metadata ?? {})]
            .map(csvCell)
            .join(','),
        );
      }
      return { filename, contentType: 'text/csv; charset=utf-8', body: `${lines.join('\r\n')}\r\n` };
    });
  }

  /** Latest business activity (sign-in/sign-out events are left out). */
  async recent(tx: Tx, tenantId: string, take = 5): Promise<AuditItem[]> {
    const rows = await tx.auditLog.findMany({
      where: { tenantId, NOT: { action: { startsWith: 'auth.' } } },
      orderBy: { createdAt: 'desc' },
      take,
    });
    return rows.map(toAuditItem);
  }
}
