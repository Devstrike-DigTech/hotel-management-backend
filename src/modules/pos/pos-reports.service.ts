import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../common/auth-types.js';
import { addDays, dateRange, diffDays, isIsoDate, lagosClock, lagosDate, lagosStartOfDay } from '../../common/time/lagos.js';
import { DbService } from '../../prisma/db.service.js';
import { Err, k } from '../ops/ops.helpers.js';

interface Payment {
  method: string;
  amountKobo: number;
}

/** POS sales: by outlet, item, category, hour, day, settlement and cashier, plus voids. */
@Injectable()
export class PosReportsService {
  constructor(private readonly db: DbService) {}

  sales(user: AuthUser, from: string, to: string, outletId?: string) {
    if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw Err.validation('from', 'from and to must be YYYY-MM-DD, from <= to');
    if (diffDays(from, to) + 1 > 92) throw Err.validation('to', 'The range can be at most 92 days');
    return this.db.tenant(user.tenantId, async (tx) => {
      const window = { gte: lagosStartOfDay(from), lt: lagosStartOfDay(addDays(to, 1)) };
      const orders = await tx.posOrder.findMany({
        where: { tenantId: user.tenantId, status: 'SETTLED', settledAt: window, ...(outletId && { outletId }) },
        include: { outlet: true, lines: true },
      });
      const voidLines = await tx.posOrderLine.findMany({
        where: { tenantId: user.tenantId, status: 'VOIDED', voidedAt: window, ...(outletId && { order: { outletId } }) },
        include: { order: { select: { number: true } } },
        orderBy: { voidedAt: 'desc' },
      });
      const approverIds = [...new Set(voidLines.map((v) => v.approvedById).filter((x): x is string => !!x))];
      const approvers = new Map((approverIds.length ? await tx.user.findMany({ where: { id: { in: approverIds } }, select: { id: true, fullName: true } }) : []).map((u) => [u.id, u.fullName]));

      const totals = { orders: 0, covers: 0, itemsSold: 0, grossKobo: 0, discountKobo: 0, netKobo: 0, taxKobo: 0, totalKobo: 0, voidCount: 0, voidKobo: 0, avgOrderKobo: 0, tipsKobo: 0 };
      const byOutlet = new Map<string, { outlet: { id: string; name: string; type: string }; orders: number; netKobo: number; totalKobo: number }>();
      const byItem = new Map<string, { itemId: string; name: string; category: string; quantity: number; netKobo: number }>();
      const byCategory = new Map<string, { category: string; quantity: number; netKobo: number }>();
      const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0, netKobo: 0 }));
      const byDay = new Map(dateRange(from, to).map((d) => [d, { date: d, orders: 0, netKobo: 0 }]));
      const bySettlement = new Map<string, { settlement: string; count: number; amountKobo: number }>();
      const byCashier = new Map<string, { user: { id: string; fullName: string }; orders: number; totalKobo: number; voids: number }>();

      for (const o of orders) {
        const net = k(o.netKobo);
        const total = k(o.totalKobo);
        const live = o.lines.filter((l) => l.status !== 'VOIDED');
        const gross = live.reduce((a, l) => a + l.unitPriceKobo * l.quantity, 0);
        totals.orders++;
        totals.covers += o.covers;
        totals.itemsSold += live.reduce((a, l) => a + l.quantity, 0);
        totals.grossKobo += gross;
        totals.discountKobo += k(o.discountKobo);
        totals.netKobo += net;
        totals.taxKobo += k(o.taxKobo);
        totals.totalKobo += total;
        totals.tipsKobo += k(o.tipKobo);
        const ob = byOutlet.get(o.outletId) ?? { outlet: { id: o.outlet.id, name: o.outlet.name, type: o.outlet.type }, orders: 0, netKobo: 0, totalKobo: 0 };
        ob.orders++;
        ob.netKobo += net;
        ob.totalKobo += total;
        byOutlet.set(o.outletId, ob);
        // Net per line: the order's net spread by the line's share of the gross.
        for (const l of live) {
          const lineNet = gross ? Math.round((net * l.unitPriceKobo * l.quantity) / gross) : 0;
          const it = byItem.get(l.itemId) ?? { itemId: l.itemId, name: l.name, category: l.categoryName, quantity: 0, netKobo: 0 };
          it.quantity += l.quantity;
          it.netKobo += lineNet;
          byItem.set(l.itemId, it);
          const c = byCategory.get(l.categoryName) ?? { category: l.categoryName, quantity: 0, netKobo: 0 };
          c.quantity += l.quantity;
          c.netKobo += lineNet;
          byCategory.set(l.categoryName, c);
        }
        const at = o.settledAt!;
        const h = byHour[Number(lagosClock(at).hhmm.slice(0, 2))];
        h.orders++;
        h.netKobo += net;
        const d = byDay.get(lagosDate(at));
        if (d) {
          d.orders++;
          d.netKobo += net;
        }
        const pays = (Array.isArray(o.payments) ? o.payments : []) as unknown as Payment[];
        for (const p of pays) {
          const s = bySettlement.get(p.method) ?? { settlement: p.method, count: 0, amountKobo: 0 };
          s.count++;
          s.amountKobo += p.amountKobo;
          bySettlement.set(p.method, s);
        }
        const who = o.settledById ?? o.openedById;
        if (who) {
          const c = byCashier.get(who) ?? { user: { id: who, fullName: o.settledByName ?? o.openedByName ?? '' }, orders: 0, totalKobo: 0, voids: 0 };
          c.orders++;
          c.totalKobo += total;
          byCashier.set(who, c);
        }
      }
      for (const v of voidLines) {
        totals.voidCount++;
        totals.voidKobo += v.unitPriceKobo * v.quantity;
        if (v.voidedById) {
          const c = byCashier.get(v.voidedById) ?? { user: { id: v.voidedById, fullName: v.voidedByName ?? '' }, orders: 0, totalKobo: 0, voids: 0 };
          c.voids++;
          byCashier.set(v.voidedById, c);
        }
      }
      totals.avgOrderKobo = totals.orders ? Math.round(totals.totalKobo / totals.orders) : 0;
      return {
        from,
        to,
        totals,
        byOutlet: [...byOutlet.values()].sort((a, b) => b.netKobo - a.netKobo),
        byItem: [...byItem.values()].sort((a, b) => b.netKobo - a.netKobo).slice(0, 50),
        byCategory: [...byCategory.values()].sort((a, b) => b.netKobo - a.netKobo),
        byHour,
        byDay: [...byDay.values()],
        bySettlement: [...bySettlement.values()],
        byCashier: [...byCashier.values()].sort((a, b) => b.totalKobo - a.totalKobo),
        voids: voidLines.slice(0, 100).map((v) => ({
          orderNumber: v.order.number,
          itemName: v.name,
          quantity: v.quantity,
          amountKobo: v.unitPriceKobo * v.quantity,
          reason: v.voidReason ?? '',
          voidedBy: v.voidedById ? { id: v.voidedById, fullName: v.voidedByName ?? '' } : null,
          approvedBy: v.approvedById ? { id: v.approvedById, fullName: approvers.get(v.approvedById) ?? '' } : null,
          voidedAt: v.voidedAt!.toISOString(),
          afterSend: !!v.sentAt,
        })),
      };
    });
  }
}
