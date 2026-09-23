import { Injectable } from '@nestjs/common';
import { RoomStatus } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { DbService } from '../../prisma/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { FrontDeskService } from '../front-desk/front-desk.service.js';

@Injectable()
export class DashboardService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly frontDesk: FrontDeskService,
  ) {}

  summary(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const groups = await tx.room.groupBy({
        by: ['status'],
        where: { tenantId: user.tenantId },
        _count: { _all: true },
      });
      const byStatus = Object.fromEntries(
        Object.values(RoomStatus).map((s) => [s, 0]),
      ) as Record<RoomStatus, number>;
      for (const g of groups) byStatus[g.status] = g._count._all;
      const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
      const sellable = total - byStatus.OUT_OF_ORDER;
      const occupancyRate =
        sellable > 0
          ? Math.round((byStatus.OCCUPIED / sellable) * 10_000) / 10_000
          : 0;

      const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
      const usage = await this.entitlements.getUsage(user.tenantId, tx);
      const recentActivity = await this.audit.recent(tx, user.tenantId, 5);
      const ops = await this.frontDesk.summaryTx(tx, user);
      const tenantId = user.tenantId;
      const now = new Date();
      const housekeeping = ent.features.includes('housekeeping')
        ? {
            open: await tx.housekeepingTask.count({ where: { tenantId, status: { in: ['OPEN', 'ASSIGNED', 'REJECTED'] } } }),
            inProgress: await tx.housekeepingTask.count({ where: { tenantId, status: 'IN_PROGRESS' } }),
            awaitingInspection: await tx.housekeepingTask.count({ where: { tenantId, status: 'DONE', inspectedAt: null, type: { in: ['CHECKOUT_CLEAN', 'DEEP_CLEAN', 'INSPECTION', 'CUSTOM'] } } }),
            urgent: await tx.housekeepingTask.count({ where: { tenantId, priority: 'URGENT', status: { in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REJECTED'] } } }),
          }
        : null;
      const maintenance = ent.features.includes('maintenance')
        ? {
            open: await tx.maintenanceTicket.count({ where: { tenantId, status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
            overdue: await tx.maintenanceTicket.count({ where: { tenantId, status: { notIn: ['RESOLVED', 'CLOSED'] }, slaDueAt: { lt: now } } }),
            blockedRooms: (await tx.roomBlock.findMany({ where: { tenantId, startsAt: { lte: now }, endsAt: { gt: now }, releasedAt: null }, select: { roomId: true }, distinct: ['roomId'] })).length,
          }
        : null;

      return {
        rooms: { total, byStatus },
        occupancyRate,
        staffCount: usage.staff,
        subscription: ent.subscription,
        usage,
        limits: ent.limits,
        recentActivity,
        ...ops,
        housekeeping,
        maintenance,
      };
    });
  }
}
