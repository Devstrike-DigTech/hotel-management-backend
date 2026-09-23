import { Injectable } from '@nestjs/common';
import type { AuditLog, Prisma } from '../../generated/prisma/client.js';
import type { AuthUser, PlatformPrincipal } from '../../common/auth-types.js';
import { DbService, type Tx } from '../../prisma/db.service.js';

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

  async list(
    tenantId: string,
    page: number,
    pageSize: number,
  ): Promise<{ items: AuditItem[]; total: number }> {
    return this.db.tenant(tenantId, async (tx) => {
      const rows = await tx.auditLog.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
      const total = await tx.auditLog.count({ where: { tenantId } });
      return { items: rows.map(toAuditItem), total };
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
