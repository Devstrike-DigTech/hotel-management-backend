import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type StockItem } from '../../generated/prisma/client.js';
import type { StockMovementType } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { addDays, diffDays, humanDate, isIsoDate, lagosDate, lagosStartOfDay } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { GuardService } from '../guard/guard.service.js';
import { appError, Err, k, paginate, primaryProperty } from '../ops/ops.helpers.js';
import { stockVariance } from './pos.logic.js';
import { inSeries } from '../../common/utils/in-series.js';

const num = (d: Prisma.Decimal | number | null | undefined) => (d === null || d === undefined ? 0 : Number(d));
const q3 = (x: number) => Math.round(x * 1000) / 1000;

export function toStockItemView(s: StockItem) {
  const onHand = num(s.onHand);
  const reorder = num(s.reorderLevel);
  return {
    id: s.id,
    name: s.name,
    unit: s.unit,
    category: s.category,
    sku: s.sku,
    onHand,
    reorderLevel: reorder,
    parLevel: s.parLevel === null ? null : num(s.parLevel),
    unitCostKobo: s.unitCostKobo,
    valueKobo: Math.round(Math.max(0, onHand) * s.unitCostKobo),
    lowStock: onHand <= reorder,
    active: s.active,
    updatedAt: s.updatedAt.toISOString(),
  };
}

export interface StockLink {
  stockItemId: string;
  quantity: number;
}

/**
 * Simple stock for POS items: on-hand per stock item, a movement ledger
 * (purchases at weighted average cost, sales on send, minibar, waste,
 * counts) and a variance report. Stock can go negative (a count corrects
 * it); that shows up as a shortage.
 */
@Injectable()
export class StockService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly guard: GuardService,
  ) {}

  /** Moves stock for sold / returned / minibar lines of POS items (inside the caller's transaction). */
  async moveForItems(
    tx: Tx,
    tenantId: string,
    propertyId: string,
    lines: { itemId: string; quantity: number }[],
    type: StockMovementType,
    ref: { orderId?: string | null; reference?: string | null; actor?: { id: string; name: string } | null },
  ): Promise<number> {
    if (!lines.length) return 0;
    const items = await tx.posItem.findMany({ where: { tenantId, id: { in: [...new Set(lines.map((l) => l.itemId))] } }, select: { id: true, stockLinks: true } });
    const byItem = new Map(items.map((i) => [i.id, (Array.isArray(i.stockLinks) ? i.stockLinks : []) as unknown as StockLink[]]));
    const sign = type === 'VOID_RETURN' || type === 'PURCHASE' ? 1 : -1;
    const totals = new Map<string, number>();
    for (const l of lines) {
      for (const link of byItem.get(l.itemId) ?? []) {
        totals.set(link.stockItemId, (totals.get(link.stockItemId) ?? 0) + link.quantity * l.quantity);
      }
    }
    let moved = 0;
    for (const [stockItemId, qty] of totals) {
      const quantity = q3(sign * qty);
      const exists = await tx.stockItem.findFirst({ where: { id: stockItemId, tenantId, propertyId }, select: { id: true } });
      if (!exists) continue;
      await tx.stockMovement.create({
        data: {
          tenantId,
          propertyId,
          stockItemId,
          type,
          quantity,
          orderId: ref.orderId ?? null,
          reference: ref.reference ?? null,
          createdById: ref.actor?.id ?? null,
          createdByName: ref.actor?.name ?? null,
        },
      });
      await tx.stockItem.update({ where: { id: stockItemId }, data: { onHand: { increment: quantity } } });
      moved++;
    }
    return moved;
  }

  list(user: AuthUser, q: { q?: string; lowStock?: boolean; category?: string }) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.stockItem.findMany({
        where: {
          tenantId: user.tenantId,
          active: true,
          ...(q.q && { name: { contains: q.q, mode: 'insensitive' } }),
          ...(q.category && { category: q.category }),
        },
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
      });
      const views = rows.map(toStockItemView);
      return q.lowStock ? views.filter((v) => v.lowStock) : views;
    });
  }

  alerts(user: AuthUser) {
    return this.list(user, { lowStock: true }).then((lowStock) => ({ lowStock }));
  }

  create(user: AuthUser, dto: { name: string; unit: string; category?: string; sku?: string; reorderLevel?: number; parLevel?: number; unitCostKobo?: number; openingQuantity?: number }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const clash = await tx.stockItem.findFirst({ where: { tenantId: user.tenantId, name: dto.name } });
      if (clash) throw appError(HttpStatus.CONFLICT, 'CONFLICT', `A stock item called ${dto.name} already exists`);
      const s = await tx.stockItem.create({
        data: {
          tenantId: user.tenantId,
          propertyId: p.id,
          name: dto.name,
          unit: dto.unit,
          category: dto.category ?? 'General',
          sku: dto.sku ?? null,
          reorderLevel: dto.reorderLevel ?? 0,
          parLevel: dto.parLevel ?? null,
          unitCostKobo: dto.unitCostKobo ?? 0,
          onHand: 0,
        },
      });
      if (dto.openingQuantity) {
        await tx.stockMovement.create({
          data: { tenantId: user.tenantId, propertyId: p.id, stockItemId: s.id, type: 'ADJUSTMENT', quantity: q3(dto.openingQuantity), unitCostKobo: s.unitCostKobo, note: 'Opening quantity', createdById: user.userId, createdByName: user.fullName },
        });
        await tx.stockItem.update({ where: { id: s.id }, data: { onHand: q3(dto.openingQuantity) } });
      }
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'stock.item_created', entityType: 'stock_item', entityId: s.id, metadata: { name: s.name }, ip });
      return toStockItemView(await tx.stockItem.findUniqueOrThrow({ where: { id: s.id } }));
    });
  }

  update(user: AuthUser, id: string, dto: { name?: string; unit?: string; category?: string; sku?: string; reorderLevel?: number; parLevel?: number | null; unitCostKobo?: number; active?: boolean }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const s = await tx.stockItem.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!s) throw AppException.notFound('Stock item');
      const updated = await tx.stockItem.update({ where: { id }, data: dto });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'stock.item_updated', entityType: 'stock_item', entityId: id, metadata: { changes: Object.keys(dto) }, ip });
      return toStockItemView(updated);
    });
  }

  remove(user: AuthUser, id: string, ip?: string) {
    return this.update(user, id, { active: false }, ip).then(() => ({ success: true }));
  }

  purchase(user: AuthUser, dto: { supplier?: string; reference?: string; lines: { stockItemId: string; quantity: number; unitCostKobo: number }[] }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const movements = [];
      for (const l of dto.lines) {
        const s = await tx.stockItem.findFirst({ where: { id: l.stockItemId, tenantId: user.tenantId } });
        if (!s) throw AppException.notFound('Stock item');
        const onHand = Math.max(0, num(s.onHand));
        // Weighted average cost over what is on hand and what arrived.
        const avg = onHand + l.quantity > 0 ? Math.round((onHand * s.unitCostKobo + l.quantity * l.unitCostKobo) / (onHand + l.quantity)) : l.unitCostKobo;
        const m = await tx.stockMovement.create({
          data: {
            tenantId: user.tenantId,
            propertyId: p.id,
            stockItemId: s.id,
            type: 'PURCHASE',
            quantity: q3(l.quantity),
            unitCostKobo: l.unitCostKobo,
            reference: dto.reference ?? null,
            note: dto.supplier ? `From ${dto.supplier}` : '',
            createdById: user.userId,
            createdByName: user.fullName,
          },
        });
        await tx.stockItem.update({ where: { id: s.id }, data: { onHand: { increment: q3(l.quantity) }, unitCostKobo: avg } });
        movements.push(this.movementView(m, s.name));
      }
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'stock.purchase', entityType: 'stock', entityId: null, metadata: { supplier: dto.supplier ?? null, reference: dto.reference ?? null, lines: dto.lines.length }, ip });
      return { movements };
    });
  }

  adjust(user: AuthUser, dto: { stockItemId: string; quantity: number; type: 'WASTE' | 'ADJUSTMENT'; note: string }, ip?: string) {
    if (!dto.quantity) throw Err.validation('quantity', 'quantity cannot be zero');
    return this.db.tenant(user.tenantId, async (tx) => {
      const s = await tx.stockItem.findFirst({ where: { id: dto.stockItemId, tenantId: user.tenantId } });
      if (!s) throw AppException.notFound('Stock item');
      const qty = dto.type === 'WASTE' ? -Math.abs(dto.quantity) : dto.quantity;
      const m = await tx.stockMovement.create({
        data: { tenantId: user.tenantId, propertyId: s.propertyId, stockItemId: s.id, type: dto.type, quantity: q3(qty), unitCostKobo: s.unitCostKobo, note: dto.note, createdById: user.userId, createdByName: user.fullName },
      });
      await tx.stockItem.update({ where: { id: s.id }, data: { onHand: { increment: q3(qty) } } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'stock.adjusted', entityType: 'stock_item', entityId: s.id, metadata: { name: s.name, quantity: qty, type: dto.type, note: dto.note }, ip });
      return this.movementView(m, s.name);
    });
  }

  /** A stock count: sets on-hand to what was counted and flags shortages (STOCK_VARIANCE). */
  count(user: AuthUser, dto: { note?: string; lines: { stockItemId: string; counted: number }[] }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const lines: { stockItemId: string; name: string; unit: string; expected: number; counted: number; variance: number; varianceValueKobo: number; unitCostKobo: number }[] = [];
      for (const l of dto.lines) {
        const s = await tx.stockItem.findFirst({ where: { id: l.stockItemId, tenantId: user.tenantId } });
        if (!s) throw AppException.notFound('Stock item');
        const expected = num(s.onHand);
        const variance = q3(l.counted - expected);
        lines.push({ stockItemId: s.id, name: s.name, unit: s.unit, expected, counted: l.counted, variance, varianceValueKobo: Math.round(variance * s.unitCostKobo), unitCostKobo: s.unitCostKobo });
      }
      const v = stockVariance(lines);
      const total = lines.reduce((a, l) => a + l.varianceValueKobo, 0);
      const count = await tx.stockCount.create({
        data: {
          tenantId: user.tenantId,
          propertyId: p.id,
          note: dto.note ?? '',
          lines: lines.map(({ unitCostKobo: _c, ...rest }) => rest) as unknown as Prisma.InputJsonValue,
          varianceValueKobo: total,
          flagged: v.flagged,
          countedById: user.userId,
          countedByName: user.fullName,
        },
      });
      for (const l of lines) {
        if (!l.variance) continue;
        await tx.stockMovement.create({
          data: { tenantId: user.tenantId, propertyId: p.id, stockItemId: l.stockItemId, type: 'COUNT', quantity: l.variance, unitCostKobo: l.unitCostKobo, countId: count.id, note: `Count ${humanDate(lagosDate())}`, createdById: user.userId, createdByName: user.fullName },
        });
        await tx.stockItem.update({ where: { id: l.stockItemId }, data: { onHand: q3(l.counted) } });
      }
      if (v.flagged) {
        const features = await this.guard.features(tx, user.tenantId);
        const short = lines.filter((l) => l.variance < 0).sort((a, b) => a.varianceValueKobo - b.varianceValueKobo);
        await this.guard.raise(tx, user.tenantId, features, {
          rule: 'STOCK_VARIANCE',
          severity: v.severity,
          title: `Stock count short by ₦${Math.round(v.shortageKobo / 100).toLocaleString('en-NG')}`,
          detail: `${user.fullName} counted ${lines.length} item${lines.length === 1 ? '' : 's'}. Largest shortages: ${short.slice(0, 3).map((l) => `${l.name} ${l.variance} ${l.unit}`).join(', ')}.`,
          dedupeKey: `STOCK_VARIANCE:${count.id}`,
          amountKobo: v.shortageKobo,
          userId: user.userId,
          userName: user.fullName,
          propertyId: p.id,
          evidence: { countId: count.id, lines: short.slice(0, 10) },
        });
      }
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'stock.counted', entityType: 'stock_count', entityId: count.id, metadata: { lines: lines.length, varianceValueKobo: total, flagged: v.flagged }, ip });
      return this.countView(count);
    });
  }

  private countView(c: { id: string; countedAt: Date; note: string; countedById: string | null; countedByName: string | null; lines: Prisma.JsonValue; varianceValueKobo: bigint; flagged: boolean }) {
    return {
      id: c.id,
      countedAt: c.countedAt.toISOString(),
      note: c.note,
      countedBy: c.countedById ? { id: c.countedById, fullName: c.countedByName ?? '' } : null,
      lines: c.lines,
      varianceValueKobo: k(c.varianceValueKobo),
      flagged: c.flagged,
    };
  }

  private movementView(m: { id: string; stockItemId: string; type: string; quantity: Prisma.Decimal; unitCostKobo: number | null; reference: string | null; note: string; orderId: string | null; createdById: string | null; createdByName: string | null; createdAt: Date }, name: string) {
    return {
      id: m.id,
      stockItemId: m.stockItemId,
      stockItemName: name,
      type: m.type,
      quantity: num(m.quantity),
      unitCostKobo: m.unitCostKobo,
      reference: m.reference,
      note: m.note,
      orderId: m.orderId,
      createdBy: m.createdById ? { id: m.createdById, fullName: m.createdByName ?? '' } : null,
      createdAt: m.createdAt.toISOString(),
    };
  }

  counts(user: AuthUser, page = 1, pageSize = 20) {
    const pg = paginate(page, pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const [rows, total] = await inSeries(
        () => tx.stockCount.findMany({ where: { tenantId: user.tenantId }, orderBy: { countedAt: 'desc' }, skip: pg.skip, take: pg.take }),
        () => tx.stockCount.count({ where: { tenantId: user.tenantId } }),
      );
      return { items: rows.map((c) => this.countView(c)), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  movements(user: AuthUser, q: { stockItemId?: string; type?: string; from?: string; to?: string; page?: number; pageSize?: number }) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const where: Prisma.StockMovementWhereInput = {
        tenantId: user.tenantId,
        ...(q.stockItemId && { stockItemId: q.stockItemId }),
        ...(q.type && { type: q.type as StockMovementType }),
        ...((q.from || q.to) && {
          createdAt: { ...(q.from && { gte: lagosStartOfDay(q.from) }), ...(q.to && { lt: lagosStartOfDay(addDays(q.to, 1)) }) },
        }),
      };
      const [rows, total] = await inSeries(
        () => tx.stockMovement.findMany({ where, orderBy: { createdAt: 'desc' }, skip: pg.skip, take: pg.take, include: { stockItem: { select: { name: true } } } }),
        () => tx.stockMovement.count({ where }),
      );
      return { items: rows.map((m) => this.movementView(m, m.stockItem.name)), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  /** Opening, purchases, sales, minibar, waste, adjustments, count variance and closing per item. */
  variance(user: AuthUser, from: string, to: string) {
    if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw Err.validation('from', 'from and to must be YYYY-MM-DD, from <= to');
    if (diffDays(from, to) > 92) throw Err.validation('to', 'The range can be at most 92 days');
    return this.db.tenant(user.tenantId, async (tx) => {
      const start = lagosStartOfDay(from);
      const end = lagosStartOfDay(addDays(to, 1));
      const items = await tx.stockItem.findMany({ where: { tenantId: user.tenantId }, orderBy: [{ category: 'asc' }, { name: 'asc' }] });
      const moves = await tx.stockMovement.findMany({ where: { tenantId: user.tenantId, createdAt: { gte: start } }, select: { stockItemId: true, type: true, quantity: true, createdAt: true, unitCostKobo: true } });
      const totals = { purchasedKobo: 0, soldCostKobo: 0, wasteKobo: 0, countVarianceKobo: 0 };
      const rows = items.map((s) => {
        const mine = moves.filter((m) => m.stockItemId === s.id);
        const inRange = mine.filter((m) => m.createdAt < end);
        const after = mine.filter((m) => m.createdAt >= end).reduce((a, m) => a + num(m.quantity), 0);
        const sumOf = (t: string[]) => q3(inRange.filter((m) => t.includes(m.type)).reduce((a, m) => a + num(m.quantity), 0));
        const closing = q3(num(s.onHand) - after);
        const movedInRange = inRange.reduce((a, m) => a + num(m.quantity), 0);
        const purchased = sumOf(['PURCHASE']);
        const sold = -sumOf(['SALE', 'VOID_RETURN']);
        const minibar = -sumOf(['MINIBAR']);
        const wasted = -sumOf(['WASTE']);
        const adjusted = sumOf(['ADJUSTMENT']);
        const countVariance = sumOf(['COUNT']);
        totals.purchasedKobo += inRange.filter((m) => m.type === 'PURCHASE').reduce((a, m) => a + num(m.quantity) * (m.unitCostKobo ?? s.unitCostKobo), 0);
        totals.soldCostKobo += Math.round((sold + minibar) * s.unitCostKobo);
        totals.wasteKobo += Math.round(wasted * s.unitCostKobo);
        totals.countVarianceKobo += Math.round(countVariance * s.unitCostKobo);
        return {
          stockItemId: s.id,
          name: s.name,
          unit: s.unit,
          opening: q3(closing - movedInRange),
          purchased,
          sold: q3(sold),
          minibar: q3(minibar),
          wasted: q3(wasted),
          adjusted,
          countVariance,
          closing,
          varianceValueKobo: Math.round(countVariance * s.unitCostKobo),
        };
      });
      return {
        from,
        to,
        items: rows,
        totals: {
          purchasedKobo: Math.round(totals.purchasedKobo),
          soldCostKobo: totals.soldCostKobo,
          wasteKobo: totals.wasteKobo,
          countVarianceKobo: totals.countVarianceKobo,
        },
      };
    });
  }
}
