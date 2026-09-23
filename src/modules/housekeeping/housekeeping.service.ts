import { Injectable } from '@nestjs/common';
import type { HousekeepingTask, Room } from '../../generated/prisma/client.js';
import type { HousekeepingTaskReason, HousekeepingTaskStatus } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { parseClientCreatedAt } from '../ops/ops.helpers.js';

type TaskRow = HousekeepingTask & { room: Room; reservation: { code: string } | null };

function toView(t: TaskRow) {
  return {
    id: t.id,
    room: { id: t.room.id, number: t.room.number, floor: t.room.floor, status: t.room.status },
    status: t.status,
    reason: t.reason,
    reservationCode: t.reservation?.code ?? null,
    notes: t.notes,
    createdAt: t.createdAt.toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
    completedBy: t.completedById ? { id: t.completedById, fullName: t.completedByName ?? '' } : null,
  };
}

@Injectable()
export class HousekeepingService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** Creates a cleaning task when the tenant has the housekeeping feature. */
  async createTask(
    tx: Tx,
    tenantId: string,
    features: readonly string[],
    input: { roomId: string; reason: HousekeepingTaskReason; reservationId?: string | null; notes?: string },
  ): Promise<void> {
    if (!features.includes('housekeeping')) return;
    const open = await tx.housekeepingTask.findFirst({
      where: { tenantId, roomId: input.roomId, status: { in: ['PENDING', 'IN_PROGRESS'] } },
    });
    if (open) return;
    await tx.housekeepingTask.create({
      data: { tenantId, roomId: input.roomId, reason: input.reason, reservationId: input.reservationId ?? null, notes: input.notes ?? '' },
    });
  }

  list(user: AuthUser, status?: string) {
    const statuses = (status ? status.split(',') : ['PENDING', 'IN_PROGRESS']).filter((s) =>
      ['PENDING', 'IN_PROGRESS', 'DONE'].includes(s),
    ) as HousekeepingTaskStatus[];
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.housekeepingTask.findMany({
        where: { tenantId: user.tenantId, status: { in: statuses } },
        include: { room: true, reservation: { select: { code: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      return rows.map(toView);
    });
  }

  update(user: AuthUser, id: string, dto: { status: HousekeepingTaskStatus; notes?: string; clientCreatedAt?: string }, ip?: string) {
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    return this.db.tenant(user.tenantId, async (tx) => {
      const t = await tx.housekeepingTask.findFirst({ where: { id, tenantId: user.tenantId }, include: { room: true } });
      if (!t) throw AppException.notFound('Task');
      const done = dto.status === 'DONE';
      const updated = await tx.housekeepingTask.update({
        where: { id },
        data: {
          status: dto.status,
          ...(dto.notes !== undefined && { notes: dto.notes }),
          ...(done
            ? { completedAt: new Date(), completedById: user.userId, completedByName: user.fullName }
            : { completedAt: null, completedById: null, completedByName: null }),
        },
        include: { room: true, reservation: { select: { code: true } } },
      });
      if (done && t.room.status === 'VACANT_DIRTY') {
        await tx.room.update({ where: { id: t.roomId }, data: { status: 'VACANT_CLEAN' } });
        updated.room.status = 'VACANT_CLEAN';
      }
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'housekeeping.task_updated',
        entityType: 'housekeeping_task',
        entityId: id,
        metadata: { room: t.room.number, from: t.status, to: dto.status, ...(clientCreatedAt && { clientCreatedAt: clientCreatedAt.toISOString() }) },
        ip,
      });
      return toView(updated);
    });
  }
}
