import { Injectable, Logger } from '@nestjs/common';
import type { PlatformAuditLog, Prisma } from '../../../generated/prisma/client.js';
import type { PlatformPrincipal } from '../../../common/auth-types.js';
import { DbService, type Tx } from '../../../prisma/db.service.js';
import { csvCell } from '../../audit/audit.service.js';
import { addDays, diffDays, isIsoDate, lagosStartOfDay } from '../../../common/time/lagos.js';
import { Err } from '../../ops/ops.helpers.js';
import { inSeries } from '../../../common/utils/in-series.js';

export interface PlatformAuditEntry {
  actor?: Pick<PlatformPrincipal, 'platformUserId' | 'fullName' | 'role' | 'sessionId'> | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  tenantId?: string | null;
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PlatformAuditFilter {
  actorId?: string;
  action?: string;
  tenantId?: string;
  targetType?: string;
  from?: string;
  to?: string;
  q?: string;
}

const SECRET_KEYS = /pass(word)?|secret|token|code|otp|key|authorization|url$/i;

/** Copies a request body for the log with anything secret-looking replaced. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[...]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) && typeof v === 'string' && k !== 'confirmName' ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}...`;
  return value;
}

export function toPlatformAuditItem(r: PlatformAuditLog, tenants?: Map<string, { id: string; name: string; slug: string }>) {
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    actor: r.actorPlatformUserId ? { id: r.actorPlatformUserId, fullName: r.actorName ?? '', role: r.actorRole ?? '' } : null,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    tenant: r.tenantId ? (tenants?.get(r.tenantId) ?? { id: r.tenantId, name: '', slug: '' }) : null,
    method: r.method,
    path: r.path,
    statusCode: r.statusCode,
    ip: r.ip,
    userAgent: r.userAgent,
    sessionId: r.sessionId,
    metadata: r.metadata,
  };
}

/**
 * Append-only platform audit log (M6). Every non-GET platform request is
 * recorded by PlatformAuditInterceptor; services add domain events (logins,
 * step-ups, impersonation) with `record`.
 */
@Injectable()
export class PlatformAuditService {
  private readonly logger = new Logger(PlatformAuditService.name);

  constructor(private readonly db: DbService) {}

  async recordTx(tx: Tx, e: PlatformAuditEntry): Promise<void> {
    await tx.platformAuditLog.create({
      data: {
        actorPlatformUserId: e.actor?.platformUserId ?? null,
        actorName: e.actor?.fullName ?? null,
        actorRole: e.actor?.role ?? null,
        sessionId: e.actor?.sessionId ?? null,
        action: e.action,
        targetType: e.targetType ?? null,
        targetId: e.targetId ?? null,
        tenantId: e.tenantId ?? null,
        method: e.method ?? null,
        path: e.path?.slice(0, 500) ?? null,
        statusCode: e.statusCode ?? null,
        ip: e.ip ?? null,
        userAgent: e.userAgent?.slice(0, 300) ?? null,
        metadata: (e.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  /** Records in its own transaction; never throws (logs instead). */
  async record(e: PlatformAuditEntry): Promise<void> {
    try {
      await this.db.system((tx) => this.recordTx(tx, e));
    } catch (err) {
      this.logger.error(`Platform audit write failed for ${e.action}: ${(err as Error).message}`);
    }
  }

  private where(f: PlatformAuditFilter): Prisma.PlatformAuditLogWhereInput {
    return {
      ...(f.actorId && { actorPlatformUserId: f.actorId }),
      ...(f.action && { action: { startsWith: f.action } }),
      ...(f.tenantId && { tenantId: f.tenantId }),
      ...(f.targetType && { targetType: f.targetType }),
      ...((f.from || f.to) && {
        createdAt: { ...(f.from && { gte: lagosStartOfDay(f.from) }), ...(f.to && { lt: lagosStartOfDay(addDays(f.to, 1)) }) },
      }),
      ...(f.q && { OR: [{ action: { contains: f.q, mode: 'insensitive' as const } }, { actorName: { contains: f.q, mode: 'insensitive' as const } }, { path: { contains: f.q, mode: 'insensitive' as const } }] }),
    };
  }

  private async tenantNames(tx: Tx, ids: (string | null)[]) {
    const uniq = [...new Set(ids.filter((x): x is string => !!x))];
    if (!uniq.length) return new Map<string, { id: string; name: string; slug: string }>();
    const rows = await tx.tenant.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true, slug: true } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  async list(f: PlatformAuditFilter & { page?: number; pageSize?: number }) {
    const page = f.page ?? 1;
    const pageSize = Math.min(f.pageSize ?? 50, 200);
    return this.db.system(async (tx) => {
      const where = this.where(f);
      const [rows, total] = await inSeries(
        () => tx.platformAuditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
        () => tx.platformAuditLog.count({ where }),
      );
      const names = await this.tenantNames(tx, rows.map((r) => r.tenantId));
      return { items: rows.map((r) => toPlatformAuditItem(r, names)), total, page, pageSize };
    });
  }

  async export(actor: PlatformPrincipal, q: { from: string; to: string; format?: 'csv' | 'json' }, ip?: string) {
    if (!isIsoDate(q.from) || !isIsoDate(q.to) || q.to < q.from) throw Err.validation('to', 'Give a valid date range (YYYY-MM-DD)');
    if (diffDays(q.from, q.to) > 366) throw Err.validation('to', 'The range can be at most 366 days');
    const format = q.format ?? 'csv';
    const rows = await this.db.system((tx) => tx.platformAuditLog.findMany({ where: this.where({ from: q.from, to: q.to }), orderBy: { createdAt: 'asc' }, take: 200_000 }));
    await this.record({ actor, action: 'audit.exported', targetType: 'platform_audit_log', metadata: { from: q.from, to: q.to, format, count: rows.length }, ip });
    const filename = `platform-audit-${q.from}-${q.to}.${format}`;
    if (format === 'json') {
      return { filename, contentType: 'application/json', body: JSON.stringify({ from: q.from, to: q.to, exportedAt: new Date().toISOString(), count: rows.length, items: rows.map((r) => toPlatformAuditItem(r)) }) };
    }
    const cols = ['createdAt', 'actor', 'actorId', 'role', 'action', 'targetType', 'targetId', 'tenantId', 'method', 'path', 'status', 'ip', 'metadata'];
    const lines = [cols.join(',')];
    for (const r of rows) {
      lines.push(
        [r.createdAt.toISOString(), r.actorName ?? '', r.actorPlatformUserId ?? '', r.actorRole ?? '', r.action, r.targetType ?? '', r.targetId ?? '', r.tenantId ?? '', r.method ?? '', r.path ?? '', r.statusCode === null ? '' : String(r.statusCode), r.ip ?? '', JSON.stringify(r.metadata ?? {})]
          .map(csvCell)
          .join(','),
      );
    }
    return { filename, contentType: 'text/csv; charset=utf-8', body: `${lines.join('\r\n')}\r\n` };
  }
}
