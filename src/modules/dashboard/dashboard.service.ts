import { Injectable } from '@nestjs/common';
import { RoomStatus } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { DbService } from '../../prisma/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { FrontDeskService } from '../front-desk/front-desk.service.js';
import { dbDate, lagosDate, lagosStartOfDay } from '../../common/time/lagos.js';
import { k, primaryProperty } from '../ops/ops.helpers.js';
import { PropertyService } from '../property/property.service.js';

@Injectable()
export class DashboardService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly frontDesk: FrontDeskService,
    private readonly properties: PropertyService,
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

      // M5: the current property, and the Pro cards (null without the feature).
      const current = await primaryProperty(tx, tenantId);
      const property = (await this.properties.summaries(tx, user)).find((x) => x.id === current.id) ?? null;
      const has = (f: string) => ent.features.includes(f);
      const dayStart = lagosStartOfDay(lagosDate(now));
      const pos = has('pos')
        ? {
            openOrders: await tx.posOrder.count({ where: { tenantId, status: 'OPEN' } }),
            salesTodayKobo: k((await tx.posOrder.aggregate({ where: { tenantId, status: 'SETTLED', settledAt: { gte: dayStart } }, _sum: { totalKobo: true } }))._sum.totalKobo),
            lowStock: (await tx.stockItem.findMany({ where: { tenantId, active: true }, select: { onHand: true, reorderLevel: true } })).filter((x) => Number(x.onHand) <= Number(x.reorderLevel)).length,
          }
        : null;
      const inbox = has('whatsapp_messaging')
        ? {
            unread: await tx.conversation.count({ where: { tenantId, status: { not: 'CLOSED' }, unreadCount: { gt: 0 } } }),
            overdue: await tx.conversation.count({ where: { tenantId, status: { not: 'CLOSED' }, slaDueAt: { lt: now } } }),
          }
        : null;
      const channels = has('channel_manager')
        ? {
            pendingPush: (await tx.channelConnection.count({ where: { tenantId, ariDirtySince: { not: null } } })) > 0,
            errors24h: await tx.channelSyncLog.count({ where: { tenantId, status: 'ERROR', startedAt: { gte: new Date(now.getTime() - 86_400_000) } } }),
            otaArrivalsToday: await tx.reservation.count({ where: { tenantId, source: 'OTA', status: { in: ['CONFIRMED', 'PENDING'] }, arrivalAt: { gte: dayStart, lt: new Date(dayStart.getTime() + 86_400_000) } } }),
          }
        : null;
      const pricingRow = has('dynamic_pricing') ? await tx.pricingSetting.findFirst({ where: { propertyId: current.id } }) : null;
      const pricing = has('dynamic_pricing')
        ? {
            pendingSuggestions: await tx.priceSuggestion.count({ where: { tenantId, status: 'PENDING', date: { gte: dbDate(lagosDate(now)) } } }),
            mode: pricingRow?.mode ?? 'OFF',
          }
        : null;

      return {
        property,
        pos,
        inbox,
        channels,
        pricing,
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
