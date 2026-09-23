import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PosItem, PosOutlet, Prisma } from '../../generated/prisma/client.js';
import type { KdsStation, PaymentMethod } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { assertCan, can } from '../../common/permissions/can.js';
import { addDays, lagosClock, lagosDate, lagosStartOfDay, lagosYear } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { CorporateService } from '../corporate/corporate.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { actorOf, LedgerService } from '../folios/ledger.service.js';
import { componentsFrom, type TaxComponent } from '../folios/tax.logic.js';
import { TaxSettingsService } from '../folios/tax-settings.service.js';
import { GuardService } from '../guard/guard.service.js';
import { DocumentsService } from '../invoices/documents.service.js';
import { appError, Err, k, paginate, parseClientCreatedAt, primaryProperty } from '../ops/ops.helpers.js';
import {
  guestNameMatches,
  happyHourPrice,
  initialAndSurname,
  orderTotals,
  voidSeverity,
  type PriceRuleLike,
} from './pos.logic.js';
import type {
  CreateItemDto,
  CreateOrderDto,
  CreateOutletDto,
  LineInputDto,
  OrderDiscountDto,
  OrdersQueryDto,
  PriceRuleDto,
  SettleDto,
  UpdateItemDto,
  UpdateOrderDto,
  UpdateOutletDto,
  UpdatePriceRuleDto,
  VoidLineDto,
} from './pos.dto.js';
import { StockService, type StockLink } from './stock.service.js';

export interface ModifierOption {
  id: string;
  name: string;
  priceKobo: number;
}
export interface ModifierGroup {
  id: string;
  name: string;
  required: boolean;
  multiple: boolean;
  options: ModifierOption[];
}
export interface LineModifier {
  groupId: string;
  group: string;
  optionId: string;
  option: string;
  priceKobo: number;
}

const DEFAULT_STATION: Record<string, KdsStation> = {
  RESTAURANT: 'KITCHEN',
  ROOM_SERVICE: 'KITCHEN',
  BAR: 'BAR',
  POOL_BAR: 'BAR',
  MINIBAR: 'NONE',
  LAUNDRY: 'NONE',
  SPA: 'NONE',
  OTHER: 'NONE',
};

const orderInclude = {
  outlet: true,
  lines: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.PosOrderInclude;
type OrderRow = Prisma.PosOrderGetPayload<{ include: typeof orderInclude }>;

const userRef = (id: string | null, name: string | null) => (id ? { id, fullName: name ?? '' } : null);
const naira = (kobo: number) => `₦${Math.round(kobo / 100).toLocaleString('en-NG')}`;

/** Normalises modifier groups from the menu editor (stable ids for options). */
function normaliseModifiers(groups: { id?: string; name: string; required: boolean; multiple: boolean; options: { id?: string; name: string; priceKobo: number }[] }[] | undefined): ModifierGroup[] {
  return (groups ?? []).map((g, gi) => ({
    id: g.id || `g${gi + 1}`,
    name: g.name,
    required: g.required,
    multiple: g.multiple,
    options: g.options.map((o, oi) => ({ id: o.id || `g${gi + 1}o${oi + 1}`, name: o.name, priceKobo: o.priceKobo })),
  }));
}

/**
 * Point of sale: outlets, menus, happy hours, orders, kitchen tickets,
 * voids, discounts, split bills and settlement (cash / transfer / POS in the
 * cashier's shift, charge to room, city ledger or complimentary). Every
 * posting goes through the M2 ledger, so taxes, receipts and shift
 * reconciliation work exactly as at the front desk.
 */
@Injectable()
export class PosService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly docs: DocumentsService,
    private readonly taxes: TaxSettingsService,
    private readonly guard: GuardService,
    private readonly corporate: CorporateService,
    private readonly entitlements: EntitlementsService,
    private readonly stock: StockService,
  ) {}

  // ---------------------------------------------------------------------------
  // Outlets
  // ---------------------------------------------------------------------------

  private async outletView(tx: Tx, o: PosOutlet) {
    const openOrders = await tx.posOrder.count({ where: { outletId: o.id, status: 'OPEN' } });
    return {
      id: o.id,
      propertyId: o.propertyId,
      name: o.name,
      code: o.code,
      type: o.type,
      active: o.active,
      defaultStation: o.defaultStation,
      serviceChargeApplies: o.serviceChargeApplies,
      allowRoomCharge: o.allowRoomCharge,
      allowCityLedger: o.allowCityLedger,
      sortOrder: o.sortOrder,
      openOrders,
    };
  }

  listOutlets(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.posOutlet.findMany({ where: { tenantId: user.tenantId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
      return Promise.all(rows.map((o) => this.outletView(tx, o)));
    });
  }

  createOutlet(user: AuthUser, dto: CreateOutletDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const clash = await tx.posOutlet.findFirst({ where: { tenantId: user.tenantId, code: dto.code } });
      if (clash) throw appError(HttpStatus.CONFLICT, 'CONFLICT', `Outlet code ${dto.code} is already used`);
      const o = await tx.posOutlet.create({
        data: {
          tenantId: user.tenantId,
          propertyId: p.id,
          name: dto.name,
          code: dto.code,
          type: dto.type,
          defaultStation: dto.defaultStation ?? DEFAULT_STATION[dto.type],
          serviceChargeApplies: dto.serviceChargeApplies ?? false,
          allowRoomCharge: dto.allowRoomCharge ?? true,
          allowCityLedger: dto.allowCityLedger ?? true,
          active: dto.active ?? true,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.outlet_created', entityType: 'pos_outlet', entityId: o.id, metadata: { name: o.name, code: o.code }, ip });
      return this.outletView(tx, o);
    });
  }

  updateOutlet(user: AuthUser, id: string, dto: UpdateOutletDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const o = await tx.posOutlet.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!o) throw AppException.notFound('Outlet');
      if (dto.code && dto.code !== o.code && (await tx.posOutlet.findFirst({ where: { tenantId: user.tenantId, code: dto.code } }))) {
        throw appError(HttpStatus.CONFLICT, 'CONFLICT', `Outlet code ${dto.code} is already used`);
      }
      const u = await tx.posOutlet.update({ where: { id }, data: dto });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.outlet_updated', entityType: 'pos_outlet', entityId: id, metadata: { changes: Object.keys(dto) }, ip });
      return this.outletView(tx, u);
    });
  }

  deleteOutlet(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const o = await tx.posOutlet.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!o) throw AppException.notFound('Outlet');
      if (await tx.posOrder.count({ where: { outletId: id } })) {
        throw appError(HttpStatus.CONFLICT, 'CONFLICT', `${o.name} has orders; deactivate it instead`);
      }
      await tx.posOutlet.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.outlet_deleted', entityType: 'pos_outlet', entityId: id, metadata: { name: o.name }, ip });
      return { success: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Categories
  // ---------------------------------------------------------------------------

  listCategories(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.posCategory.findMany({ where: { tenantId: user.tenantId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: { _count: { select: { items: { where: { active: true } } } } } });
      return rows.map((c) => ({ id: c.id, name: c.name, station: c.station, sortOrder: c.sortOrder, itemCount: c._count.items }));
    });
  }

  createCategory(user: AuthUser, dto: { name: string; station?: KdsStation | null; sortOrder?: number }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      if (await tx.posCategory.findFirst({ where: { tenantId: user.tenantId, name: dto.name } })) {
        throw appError(HttpStatus.CONFLICT, 'CONFLICT', `A category called ${dto.name} already exists`);
      }
      const c = await tx.posCategory.create({ data: { tenantId: user.tenantId, propertyId: p.id, name: dto.name, station: dto.station ?? null, sortOrder: dto.sortOrder ?? 0 } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.category_created', entityType: 'pos_category', entityId: c.id, metadata: { name: c.name }, ip });
      return { id: c.id, name: c.name, station: c.station, sortOrder: c.sortOrder, itemCount: 0 };
    });
  }

  updateCategory(user: AuthUser, id: string, dto: { name?: string; station?: KdsStation | null; sortOrder?: number }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const c = await tx.posCategory.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!c) throw AppException.notFound('Category');
      const u = await tx.posCategory.update({ where: { id }, data: dto });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.category_updated', entityType: 'pos_category', entityId: id, metadata: { changes: Object.keys(dto) }, ip });
      const itemCount = await tx.posItem.count({ where: { categoryId: id, active: true } });
      return { id: u.id, name: u.name, station: u.station, sortOrder: u.sortOrder, itemCount };
    });
  }

  deleteCategory(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const c = await tx.posCategory.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!c) throw AppException.notFound('Category');
      if (await tx.posItem.count({ where: { categoryId: id } })) throw appError(HttpStatus.CONFLICT, 'CONFLICT', `${c.name} still has items`);
      await tx.posCategory.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.category_deleted', entityType: 'pos_category', entityId: id, metadata: { name: c.name }, ip });
      return { success: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Items
  // ---------------------------------------------------------------------------

  private async itemView(tx: Tx, i: PosItem & { category?: { name: string } }) {
    const links = (Array.isArray(i.stockLinks) ? i.stockLinks : []) as unknown as StockLink[];
    const stock = links.length ? await tx.stockItem.findMany({ where: { id: { in: links.map((l) => l.stockItemId) } }, select: { id: true, name: true, unit: true } }) : [];
    const byId = new Map(stock.map((s) => [s.id, s]));
    const categoryName = i.category?.name ?? (await tx.posCategory.findUnique({ where: { id: i.categoryId }, select: { name: true } }))?.name ?? '';
    return {
      id: i.id,
      propertyId: i.propertyId,
      categoryId: i.categoryId,
      categoryName,
      name: i.name,
      description: i.description,
      priceKobo: i.priceKobo,
      outletIds: i.outletIds,
      available: i.available,
      vat: i.vat,
      consumptionTax: i.consumptionTax,
      modifiers: i.modifiers as unknown as ModifierGroup[],
      station: i.station,
      stockLinks: links.map((l) => ({ stockItemId: l.stockItemId, stockItemName: byId.get(l.stockItemId)?.name ?? '', unit: byId.get(l.stockItemId)?.unit ?? '', quantity: l.quantity })),
      imageUrl: i.imageUrl,
      sortOrder: i.sortOrder,
    };
  }

  listItems(user: AuthUser, q: { outletId?: string; categoryId?: string; available?: boolean; q?: string }) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.posItem.findMany({
        where: {
          tenantId: user.tenantId,
          active: true,
          ...(q.categoryId && { categoryId: q.categoryId }),
          ...(q.available !== undefined && { available: q.available }),
          ...(q.q && { name: { contains: q.q, mode: 'insensitive' } }),
          ...(q.outletId && { OR: [{ outletIds: { isEmpty: true } }, { outletIds: { has: q.outletId } }] }),
        },
        include: { category: { select: { name: true } } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      const out = [];
      for (const r of rows) out.push(await this.itemView(tx, r));
      return out;
    });
  }

  private async checkItemRefs(tx: Tx, tenantId: string, dto: { categoryId?: string; outletIds?: string[]; stockLinks?: { stockItemId: string }[] }) {
    if (dto.categoryId && !(await tx.posCategory.findFirst({ where: { id: dto.categoryId, tenantId } }))) throw AppException.notFound('Category');
    if (dto.outletIds?.length) {
      const n = await tx.posOutlet.count({ where: { tenantId, id: { in: dto.outletIds } } });
      if (n !== new Set(dto.outletIds).size) throw Err.validation('outletIds', 'Unknown outlet');
    }
    if (dto.stockLinks?.length) {
      const n = await tx.stockItem.count({ where: { tenantId, id: { in: dto.stockLinks.map((s) => s.stockItemId) } } });
      if (n !== new Set(dto.stockLinks.map((s) => s.stockItemId)).size) throw Err.validation('stockLinks', 'Unknown stock item');
    }
  }

  createItem(user: AuthUser, dto: CreateItemDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      await this.checkItemRefs(tx, user.tenantId, dto);
      const p = await primaryProperty(tx, user.tenantId);
      const i = await tx.posItem.create({
        data: {
          tenantId: user.tenantId,
          propertyId: p.id,
          categoryId: dto.categoryId,
          name: dto.name,
          description: dto.description ?? '',
          priceKobo: dto.priceKobo,
          outletIds: dto.outletIds ?? [],
          available: dto.available ?? true,
          vat: dto.vat ?? true,
          consumptionTax: dto.consumptionTax ?? true,
          modifiers: normaliseModifiers(dto.modifiers) as unknown as Prisma.InputJsonValue,
          station: dto.station ?? null,
          stockLinks: (dto.stockLinks ?? []) as unknown as Prisma.InputJsonValue,
          imageUrl: dto.imageUrl ?? null,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.item_created', entityType: 'pos_item', entityId: i.id, metadata: { name: i.name, priceKobo: i.priceKobo }, ip });
      return this.itemView(tx, i);
    });
  }

  updateItem(user: AuthUser, id: string, dto: UpdateItemDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const i = await tx.posItem.findFirst({ where: { id, tenantId: user.tenantId, active: true } });
      if (!i) throw AppException.notFound('Menu item');
      await this.checkItemRefs(tx, user.tenantId, dto);
      const { modifiers, stockLinks, ...rest } = dto;
      const u = await tx.posItem.update({
        where: { id },
        data: {
          ...rest,
          ...(modifiers !== undefined && { modifiers: normaliseModifiers(modifiers) as unknown as Prisma.InputJsonValue }),
          ...(stockLinks !== undefined && { stockLinks: stockLinks as unknown as Prisma.InputJsonValue }),
        },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'pos.item_updated',
        entityType: 'pos_item',
        entityId: id,
        metadata: { changes: Object.keys(dto), ...(dto.priceKobo !== undefined && { fromKobo: i.priceKobo, toKobo: dto.priceKobo }) },
        ip,
      });
      return this.itemView(tx, u);
    });
  }

  setAvailability(user: AuthUser, id: string, available: boolean, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const i = await tx.posItem.findFirst({ where: { id, tenantId: user.tenantId, active: true } });
      if (!i) throw AppException.notFound('Menu item');
      const u = await tx.posItem.update({ where: { id }, data: { available } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: available ? 'pos.item_available' : 'pos.item_unavailable', entityType: 'pos_item', entityId: id, metadata: { name: i.name }, ip });
      return this.itemView(tx, u);
    });
  }

  deleteItem(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const i = await tx.posItem.findFirst({ where: { id, tenantId: user.tenantId, active: true } });
      if (!i) throw AppException.notFound('Menu item');
      await tx.posItem.update({ where: { id }, data: { active: false, available: false } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.item_deleted', entityType: 'pos_item', entityId: id, metadata: { name: i.name }, ip });
      return { success: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Happy hours
  // ---------------------------------------------------------------------------

  private ruleView(r: PriceRuleLike) {
    return { id: r.id, name: r.name, active: r.active, outletIds: r.outletIds, categoryIds: r.categoryIds, itemIds: r.itemIds, daysOfWeek: r.daysOfWeek, startTime: r.startTime, endTime: r.endTime, adjustmentType: r.adjustmentType, value: r.value };
  }

  listRules(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.posPriceRule.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: 'asc' } });
      return rows.map((r) => this.ruleView(r as PriceRuleLike));
    });
  }

  createRule(user: AuthUser, dto: PriceRuleDto, ip?: string) {
    if (dto.adjustmentType === 'PERCENT' && dto.value > 10_000) throw Err.validation('value', 'A percentage is at most 10000 bps');
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const r = await tx.posPriceRule.create({
        data: {
          tenantId: user.tenantId,
          propertyId: p.id,
          name: dto.name,
          active: dto.active ?? true,
          outletIds: dto.outletIds ?? [],
          categoryIds: dto.categoryIds ?? [],
          itemIds: dto.itemIds ?? [],
          daysOfWeek: dto.daysOfWeek ?? [],
          startTime: dto.startTime,
          endTime: dto.endTime,
          adjustmentType: dto.adjustmentType,
          value: dto.value,
        },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.happy_hour_created', entityType: 'pos_price_rule', entityId: r.id, metadata: { name: r.name }, ip });
      return this.ruleView(r as PriceRuleLike);
    });
  }

  updateRule(user: AuthUser, id: string, dto: UpdatePriceRuleDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const r = await tx.posPriceRule.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!r) throw AppException.notFound('Happy hour');
      const u = await tx.posPriceRule.update({ where: { id }, data: dto });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.happy_hour_updated', entityType: 'pos_price_rule', entityId: id, metadata: { changes: Object.keys(dto) }, ip });
      return this.ruleView(u as PriceRuleLike);
    });
  }

  deleteRule(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const r = await tx.posPriceRule.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!r) throw AppException.notFound('Happy hour');
      await tx.posPriceRule.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.happy_hour_deleted', entityType: 'pos_price_rule', entityId: id, metadata: { name: r.name }, ip });
      return { success: true };
    });
  }

  /** When a rule in force now ends (Lagos), as an ISO instant. */
  private ruleEndsAt(rule: PriceRuleLike, now: Date): string {
    const today = lagosDate(now);
    const { hhmm } = lagosClock(now);
    const day = rule.endTime <= rule.startTime && hhmm >= rule.startTime ? addDays(today, 1) : today;
    return new Date(lagosStartOfDay(day).getTime() + (Number(rule.endTime.slice(0, 2)) * 60 + Number(rule.endTime.slice(3))) * 60_000).toISOString();
  }

  menu(user: AuthUser, outletId: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const outlet = await tx.posOutlet.findFirst({ where: { id: outletId, tenantId: user.tenantId } });
      if (!outlet) throw AppException.notFound('Outlet');
      const [cats, items, rules] = await Promise.all([
        tx.posCategory.findMany({ where: { tenantId: user.tenantId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
        tx.posItem.findMany({ where: { tenantId: user.tenantId, active: true, OR: [{ outletIds: { isEmpty: true } }, { outletIds: { has: outletId } }] }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
        tx.posPriceRule.findMany({ where: { tenantId: user.tenantId, active: true } }),
      ]);
      const now = new Date();
      const clock = lagosClock(now);
      const categories = [];
      for (const c of cats) {
        const mine = items.filter((i) => i.categoryId === c.id);
        if (!mine.length) continue;
        const views = [];
        for (const i of mine) {
          const hh = happyHourPrice(i.priceKobo, rules as PriceRuleLike[], { outletId, categoryId: c.id, itemId: i.id, ...clock });
          views.push({
            ...(await this.itemView(tx, { ...i, category: { name: c.name } })),
            currentPriceKobo: hh.priceKobo,
            happyHour: hh.rule ? { ruleId: hh.rule.id, name: hh.rule.name, endsAt: this.ruleEndsAt(hh.rule, now) } : null,
          });
        }
        categories.push({ id: c.id, name: c.name, station: c.station, sortOrder: c.sortOrder, itemCount: views.length, items: views });
      }
      return { outlet: await this.outletView(tx, outlet), categories, serverTime: now.toISOString() };
    });
  }

  // ---------------------------------------------------------------------------
  // Orders
  // ---------------------------------------------------------------------------

  private async loadOrder(tx: Tx, tenantId: string, id: string): Promise<OrderRow> {
    const o = await tx.posOrder.findFirst({ where: { id, tenantId }, include: orderInclude });
    if (!o) throw AppException.notFound('Order');
    return o;
  }

  private assertOpen(o: { status: string }) {
    if (o.status !== 'OPEN') throw appError(HttpStatus.CONFLICT, 'ORDER_NOT_OPEN', `This order is ${o.status.toLowerCase()}`, { status: o.status });
  }

  private async components(tx: Tx, tenantId: string, propertyId: string): Promise<TaxComponent[]> {
    return componentsFrom(await this.taxes.forProperty(tx, tenantId, propertyId));
  }

  private computeTotals(o: OrderRow, comps: TaxComponent[]) {
    const live = o.lines.filter((l) => l.status !== 'VOIDED');
    const r = orderTotals(
      live.map((l) => ({ id: l.id, name: l.name, quantity: l.quantity, lineTotalKobo: l.unitPriceKobo * l.quantity, vat: l.vat, consumption: l.consumption })),
      comps,
      o.outlet.serviceChargeApplies,
      o.discountMode ? { mode: o.discountMode as 'AMOUNT' | 'PERCENT', value: o.discountValue ?? 0 } : null,
    );
    return r;
  }

  async orderView(tx: Tx, o: OrderRow) {
    const comps = await this.components(tx, o.tenantId, o.propertyId);
    const { totals } = o.status === 'SETTLED' && o.totals ? { totals: o.totals as unknown as ReturnType<typeof orderTotals>['totals'] } : this.computeTotals(o, comps);
    const payments = (Array.isArray(o.payments) ? o.payments : []) as { method: string; amountKobo: number; reference: string | null; receiptId: string | null; receiptNumber: string | null }[];
    const paid = o.status === 'SETTLED' ? totals.totalKobo : 0;
    const room = o.roomId ? await tx.room.findFirst({ where: { id: o.roomId }, select: { id: true, number: true } }) : null;
    const res = o.reservationId ? await tx.reservation.findFirst({ where: { id: o.reservationId }, select: { id: true, code: true, guest: { select: { fullName: true } } } }) : null;
    const corp = o.corporateAccountId ? await tx.corporateAccount.findFirst({ where: { id: o.corporateAccountId }, select: { id: true, name: true } }) : null;
    const approverIds = [...new Set([...o.lines.map((l) => l.approvedById), o.discountApprovedBy].filter((x): x is string => !!x))];
    const approvers = new Map((approverIds.length ? await tx.user.findMany({ where: { id: { in: approverIds } }, select: { id: true, fullName: true } }) : []).map((u) => [u.id, u.fullName]));
    const approverRef = (id: string | null) => (id ? { id, fullName: approvers.get(id) ?? 'Former staff member' } : null);
    return {
      id: o.id,
      propertyId: o.propertyId,
      number: o.number,
      outlet: { id: o.outlet.id, name: o.outlet.name, code: o.outlet.code, type: o.outlet.type },
      status: o.status,
      tableLabel: o.tableLabel,
      room,
      reservation: res ? { id: res.id, code: res.code, guestName: res.guest.fullName } : null,
      guestName: o.guestName,
      covers: o.covers,
      lines: o.lines.map((l) => ({
        id: l.id,
        itemId: l.itemId,
        name: l.name,
        categoryName: l.categoryName,
        quantity: l.quantity,
        unitPriceKobo: l.unitPriceKobo,
        basePriceKobo: l.basePriceKobo,
        modifiers: l.modifiers as unknown as LineModifier[],
        note: l.note,
        station: l.station,
        status: l.status,
        lineTotalKobo: l.status === 'VOIDED' ? 0 : l.unitPriceKobo * l.quantity,
        sentAt: l.sentAt?.toISOString() ?? null,
        ticketId: l.ticketId,
        voidedAt: l.voidedAt?.toISOString() ?? null,
        voidReason: l.voidReason,
        voidedBy: userRef(l.voidedById, l.voidedByName),
        approvedBy: approverRef(l.approvedById),
        addedBy: userRef(l.addedById, l.addedByName),
        createdAt: l.createdAt.toISOString(),
      })),
      discount: o.discountMode
        ? {
            mode: o.discountMode,
            value: o.discountValue ?? 0,
            amountKobo: totals.discountKobo,
            reason: o.discountReason ?? '',
            approvedBy: approverRef(o.discountApprovedBy),
          }
        : null,
      totals: { ...totals, paidKobo: paid, dueKobo: Math.max(0, totals.totalKobo - paid) },
      settlement: o.settlement,
      payments,
      folioId: o.folioId,
      corporateAccount: corp,
      openedBy: userRef(o.openedById, o.openedByName),
      openedAt: o.openedAt.toISOString(),
      settledAt: o.settledAt?.toISOString() ?? null,
      settledBy: userRef(o.settledById, o.settledByName),
      cancelledAt: o.cancelledAt?.toISOString() ?? null,
      cancelReason: o.cancelReason,
      splitFromOrderId: o.splitFromOrderId,
      notes: o.notes,
      tipKobo: k(o.tipKobo),
      clientCreatedAt: o.clientCreatedAt?.toISOString() ?? null,
      updatedAt: o.updatedAt.toISOString(),
    };
  }

  list(user: AuthUser, q: OrdersQueryDto) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      // `q` also matches the room number of room-service / room-charge orders.
      const roomIds = q.q ? (await tx.room.findMany({ where: { tenantId: user.tenantId, number: { contains: q.q.trim(), mode: 'insensitive' } }, select: { id: true } })).map((r) => r.id) : [];
      const statuses = (q.status ?? 'OPEN').split(',').map((s) => s.trim().toUpperCase()).filter((s) => ['OPEN', 'SETTLED', 'CANCELLED'].includes(s));
      const where: Prisma.PosOrderWhereInput = {
        tenantId: user.tenantId,
        ...(statuses.length && { status: { in: statuses as ('OPEN' | 'SETTLED' | 'CANCELLED')[] } }),
        ...(q.outletId && { outletId: q.outletId }),
        ...(q.date && { openedAt: { gte: lagosStartOfDay(q.date), lt: lagosStartOfDay(addDays(q.date, 1)) } }),
        ...(q.q && {
          OR: [
            { number: { contains: q.q, mode: 'insensitive' } },
            { tableLabel: { contains: q.q, mode: 'insensitive' } },
            { guestName: { contains: q.q, mode: 'insensitive' } },
            ...(roomIds.length ? [{ roomId: { in: roomIds } }] : []),
          ],
        }),
      };
      const [rows, total] = await Promise.all([
        tx.posOrder.findMany({ where, include: orderInclude, orderBy: { openedAt: 'desc' }, skip: pg.skip, take: pg.take }),
        tx.posOrder.count({ where }),
      ]);
      const comps = new Map<string, TaxComponent[]>();
      const items = [];
      for (const o of rows) {
        if (!comps.has(o.propertyId)) comps.set(o.propertyId, await this.components(tx, user.tenantId, o.propertyId));
        const totals = o.status === 'SETTLED' && o.totals ? (o.totals as unknown as { totalKobo: number }) : this.computeTotals(o, comps.get(o.propertyId)!).totals;
        const room = o.roomId ? await tx.room.findFirst({ where: { id: o.roomId }, select: { id: true, number: true } }) : null;
        items.push({
          id: o.id,
          number: o.number,
          outlet: { id: o.outlet.id, name: o.outlet.name, code: o.outlet.code, type: o.outlet.type },
          status: o.status,
          tableLabel: o.tableLabel,
          room,
          guestName: o.guestName,
          covers: o.covers,
          openedAt: o.openedAt.toISOString(),
          settledAt: o.settledAt?.toISOString() ?? null,
          settlement: o.settlement,
          totalKobo: totals.totalKobo,
          dueKobo: o.status === 'OPEN' ? totals.totalKobo : 0,
          itemCount: o.lines.filter((l) => l.status !== 'VOIDED').reduce((a, l) => a + l.quantity, 0),
          pendingItems: o.lines.filter((l) => l.status === 'PENDING').reduce((a, l) => a + l.quantity, 0),
          openedBy: userRef(o.openedById, o.openedByName),
        });
      }
      return { items, total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  get(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => this.orderView(tx, await this.loadOrder(tx, user.tenantId, id)));
  }

  /** Builds new PENDING lines from LineInput (availability, outlet, modifiers, happy hour). */
  private async buildLines(tx: Tx, user: AuthUser, order: { id: string; propertyId: string; outlet: PosOutlet }, input: LineInputDto[]) {
    const items = await tx.posItem.findMany({ where: { tenantId: user.tenantId, id: { in: [...new Set(input.map((l) => l.itemId))] }, active: true }, include: { category: true } });
    const byId = new Map(items.map((i) => [i.id, i]));
    const rules = (await tx.posPriceRule.findMany({ where: { tenantId: user.tenantId, active: true } })) as PriceRuleLike[];
    const clock = lagosClock();
    const rows: Prisma.PosOrderLineCreateManyInput[] = [];
    for (const l of input) {
      const item = byId.get(l.itemId);
      if (!item) throw AppException.notFound('Menu item');
      if (!item.available || (item.outletIds.length && !item.outletIds.includes(order.outlet.id))) {
        throw appError(HttpStatus.CONFLICT, 'ITEM_UNAVAILABLE', `${item.name} is not available${item.available ? ` at ${order.outlet.name}` : ' right now'}`, { itemId: item.id });
      }
      const groups = item.modifiers as unknown as ModifierGroup[];
      const chosen = new Set(l.modifierOptionIds ?? []);
      const mods: LineModifier[] = [];
      for (const g of groups) {
        const picked = g.options.filter((o) => chosen.has(o.id));
        if (g.required && !picked.length) throw Err.validation('modifierOptionIds', `Choose ${g.name.toLowerCase()} for ${item.name}`);
        if (!g.multiple && picked.length > 1) throw Err.validation('modifierOptionIds', `Choose one ${g.name.toLowerCase()} for ${item.name}`);
        for (const o of picked) {
          mods.push({ groupId: g.id, group: g.name, optionId: o.id, option: o.name, priceKobo: o.priceKobo });
          chosen.delete(o.id);
        }
      }
      if (chosen.size) throw Err.validation('modifierOptionIds', `Unknown option for ${item.name}`);
      const hh = happyHourPrice(item.priceKobo, rules, { outletId: order.outlet.id, categoryId: item.categoryId, itemId: item.id, ...clock });
      const unit = hh.priceKobo + mods.reduce((a, m) => a + m.priceKobo, 0);
      rows.push({
        id: randomUUID(),
        tenantId: user.tenantId,
        propertyId: order.propertyId,
        orderId: order.id,
        itemId: item.id,
        name: item.name,
        categoryName: item.category.name,
        quantity: l.quantity,
        unitPriceKobo: unit,
        basePriceKobo: item.priceKobo + mods.reduce((a, m) => a + m.priceKobo, 0),
        modifiers: mods as unknown as Prisma.InputJsonValue,
        note: l.note ?? '',
        station: item.station ?? item.category.station ?? order.outlet.defaultStation,
        vat: item.vat,
        consumption: item.consumptionTax,
        addedById: user.userId,
        addedByName: user.fullName,
      });
    }
    return rows;
  }

  create(user: AuthUser, dto: CreateOrderDto, ip?: string) {
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    return this.db.tenant(user.tenantId, async (tx) => {
      if (dto.id) {
        const existing = await tx.posOrder.findFirst({ where: { id: dto.id, tenantId: user.tenantId } });
        if (existing) return this.orderView(tx, await this.loadOrder(tx, user.tenantId, dto.id));
      }
      const outlet = await tx.posOutlet.findFirst({ where: { id: dto.outletId, tenantId: user.tenantId } });
      if (!outlet || !outlet.active) throw AppException.notFound('Outlet');
      const target = await this.stayTarget(tx, user.tenantId, dto.roomId, dto.reservationId);
      const year = lagosYear();
      const scope = await this.docs.propertyScope(tx, user.tenantId, outlet.propertyId);
      const { seq } = await this.docs.nextNumber(tx, user.tenantId, 'POS_ORDER', year, scope);
      const id = dto.id ?? randomUUID();
      await tx.posOrder.create({
        data: {
          id,
          tenantId: user.tenantId,
          propertyId: outlet.propertyId,
          outletId: outlet.id,
          number: `${outlet.code}-${String(seq).padStart(6, '0')}`,
          year,
          seq,
          tableLabel: dto.tableLabel ?? null,
          roomId: target.roomId,
          reservationId: target.reservationId,
          guestName: dto.guestName ?? target.guestName,
          covers: dto.covers ?? 1,
          notes: dto.notes ?? '',
          openedById: user.userId,
          openedByName: user.fullName,
          openedAt: clientCreatedAt ?? new Date(),
          clientCreatedAt,
        },
      });
      if (dto.lines?.length) {
        const rows = await this.buildLines(tx, user, { id, propertyId: outlet.propertyId, outlet }, dto.lines);
        await tx.posOrderLine.createMany({ data: rows });
      }
      const order = await this.loadOrder(tx, user.tenantId, id);
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.order_opened', entityType: 'pos_order', entityId: id, metadata: { number: order.number, outlet: outlet.name, table: dto.tableLabel ?? null, ...(clientCreatedAt && { clientCreatedAt: clientCreatedAt.toISOString() }) }, ip });
      if (dto.send && order.lines.some((l) => l.status === 'PENDING')) await this.sendTx(tx, user, order);
      return this.orderView(tx, await this.loadOrder(tx, user.tenantId, id));
    });
  }

  /** Room / reservation on an order: a CHECKED_IN stay of this property (room service). */
  private async stayTarget(tx: Tx, tenantId: string, roomId?: string | null, reservationId?: string | null) {
    if (reservationId) {
      const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId }, include: { guest: { select: { fullName: true } } } });
      if (!r) throw AppException.notFound('Reservation');
      if (r.status !== 'CHECKED_IN') throw appError(HttpStatus.CONFLICT, 'ROOM_CHARGE_NOT_ALLOWED', 'Room service is for guests in house', { reason: 'NOT_IN_HOUSE' });
      return { roomId: r.roomId, reservationId: r.id, guestName: r.guest.fullName };
    }
    if (roomId) {
      const room = await tx.room.findFirst({ where: { id: roomId, tenantId } });
      if (!room) throw AppException.notFound('Room');
      const stay = await tx.reservation.findFirst({ where: { tenantId, roomId, status: 'CHECKED_IN' }, include: { guest: { select: { fullName: true } } } });
      return { roomId: room.id, reservationId: stay?.id ?? null, guestName: stay?.guest.fullName ?? null };
    }
    return { roomId: null, reservationId: null, guestName: null };
  }

  update(user: AuthUser, id: string, dto: UpdateOrderDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const o = await this.loadOrder(tx, user.tenantId, id);
      this.assertOpen(o);
      const target = dto.roomId !== undefined || dto.reservationId !== undefined ? await this.stayTarget(tx, user.tenantId, dto.roomId, dto.reservationId) : null;
      await tx.posOrder.update({
        where: { id },
        data: {
          ...(dto.tableLabel !== undefined && { tableLabel: dto.tableLabel || null }),
          ...(dto.covers !== undefined && { covers: dto.covers }),
          ...(dto.guestName !== undefined && { guestName: dto.guestName || null }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
          ...(target && { roomId: target.roomId, reservationId: target.reservationId, guestName: dto.guestName ?? target.guestName }),
        },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.order_updated', entityType: 'pos_order', entityId: id, metadata: { changes: Object.keys(dto) }, ip });
      return this.orderView(tx, await this.loadOrder(tx, user.tenantId, id));
    });
  }

  addLines(user: AuthUser, id: string, lines: LineInputDto[], ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const o = await this.loadOrder(tx, user.tenantId, id);
      this.assertOpen(o);
      const rows = await this.buildLines(tx, user, o, lines);
      await tx.posOrderLine.createMany({ data: rows });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.items_added', entityType: 'pos_order', entityId: id, metadata: { number: o.number, items: rows.map((r) => `${r.name} x${r.quantity}`) }, ip });
      return this.orderView(tx, await this.loadOrder(tx, user.tenantId, id));
    });
  }

  updateLine(user: AuthUser, id: string, lineId: string, dto: { quantity?: number; note?: string }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const o = await this.loadOrder(tx, user.tenantId, id);
      this.assertOpen(o);
      const line = o.lines.find((l) => l.id === lineId);
      if (!line) throw AppException.notFound('Order item');
      if (line.status !== 'PENDING') throw Err.invalidState(line.status, ['PENDING'], 'This item');
      await tx.posOrderLine.update({ where: { id: lineId }, data: { ...(dto.quantity !== undefined && { quantity: dto.quantity }), ...(dto.note !== undefined && { note: dto.note }) } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.item_changed', entityType: 'pos_order', entityId: id, metadata: { item: line.name, ...dto }, ip });
      return this.orderView(tx, await this.loadOrder(tx, user.tenantId, id));
    });
  }

  deleteLine(user: AuthUser, id: string, lineId: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const o = await this.loadOrder(tx, user.tenantId, id);
      this.assertOpen(o);
      const line = o.lines.find((l) => l.id === lineId);
      if (!line) throw AppException.notFound('Order item');
      if (line.status !== 'PENDING') throw Err.invalidState(line.status, ['PENDING'], 'This item');
      await tx.posOrderLine.delete({ where: { id: lineId } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.item_removed', entityType: 'pos_order', entityId: id, metadata: { item: line.name, quantity: line.quantity }, ip });
      return this.orderView(tx, await this.loadOrder(tx, user.tenantId, id));
    });
  }

  /** PENDING lines -> SENT; one ticket per station; stock deducted. */
  private async sendTx(tx: Tx, user: AuthUser, o: OrderRow) {
    const pending = o.lines.filter((l) => l.status === 'PENDING');
    if (!pending.length) throw appError(HttpStatus.CONFLICT, 'NOTHING_TO_SEND', 'Nothing new to send');
    const now = new Date();
    const tickets: string[] = [];
    const byStation = new Map<KdsStation, typeof pending>();
    for (const l of pending) byStation.set(l.station, [...(byStation.get(l.station) ?? []), l]);
    const scope = await this.docs.propertyScope(tx, user.tenantId, o.propertyId);
    const day = Number(lagosDate(now).replace(/-/g, ''));
    for (const [station, lines] of byStation) {
      let ticketId: string | null = null;
      if (station !== 'NONE') {
        const { seq } = await this.docs.nextNumber(tx, user.tenantId, 'KDS_TICKET', day, scope);
        const t = await tx.posTicket.create({
          data: {
            tenantId: user.tenantId,
            propertyId: o.propertyId,
            orderId: o.id,
            outletId: o.outletId,
            number: `${station === 'BAR' ? 'B' : 'K'}-${String(seq).padStart(3, '0')}`,
            station,
            serverId: user.userId,
            serverName: user.fullName,
          },
        });
        ticketId = t.id;
        tickets.push(t.id);
      }
      await tx.posOrderLine.updateMany({ where: { id: { in: lines.map((l) => l.id) } }, data: { status: 'SENT', sentAt: now, ticketId } });
    }
    await this.stock.moveForItems(tx, user.tenantId, o.propertyId, pending.map((l) => ({ itemId: l.itemId, quantity: l.quantity })), 'SALE', {
      orderId: o.id,
      reference: o.number,
      actor: { id: user.userId, name: user.fullName },
    });
    return tickets;
  }

  send(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const o = await this.loadOrder(tx, user.tenantId, id);
      this.assertOpen(o);
      const ids = await this.sendTx(tx, user, o);
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.sent', entityType: 'pos_order', entityId: id, metadata: { number: o.number, tickets: ids.length }, ip });
      const tickets = await tx.posTicket.findMany({ where: { id: { in: ids } }, include: { lines: true, order: { include: { outlet: true } } } });
      return { order: await this.orderView(tx, await this.loadOrder(tx, user.tenantId, id)), tickets: tickets.map((t) => ticketView(t)) };
    });
  }

  async voidLine(user: AuthUser, id: string, lineId: string, dto: VoidLineDto, ip?: string) {
    // Pass 1 (read): value and whether a second key is needed.
    const pre = await this.db.tenant(user.tenantId, async (tx) => {
      const o = await this.loadOrder(tx, user.tenantId, id);
      this.assertOpen(o);
      const line = o.lines.find((l) => l.id === lineId);
      if (!line) throw AppException.notFound('Order item');
      if (line.status !== 'SENT') throw Err.invalidState(line.status, ['SENT'], 'This item');
      const qty = Math.min(dto.quantity ?? line.quantity, line.quantity);
      const property = await tx.property.findFirstOrThrow({ where: { id: o.propertyId }, select: { posVoidApprovalKobo: true } });
      return { value: line.unitPriceKobo * qty, limit: property.posVoidApprovalKobo, features: await this.guard.features(tx, user.tenantId) };
    });
    const over = pre.value >= pre.limit;
    let approver: { id: string; fullName: string } | null = null;
    if (over && pre.features.includes('revenue_guard_full')) {
      if (!dto.approval) {
        throw appError(HttpStatus.FORBIDDEN, 'APPROVAL_REQUIRED', `Voiding ${naira(pre.value)} of sent items needs a manager's PIN`, { thresholdKobo: pre.limit, valueKobo: pre.value });
      }
      approver = await this.ledger.verifyApproval(user, dto.approval);
    }
    return this.db.tenant(user.tenantId, async (tx) => {
      const o = await this.loadOrder(tx, user.tenantId, id);
      this.assertOpen(o);
      const line = o.lines.find((l) => l.id === lineId);
      if (!line || line.status !== 'SENT') throw Err.invalidState(line?.status ?? 'VOIDED', ['SENT'], 'This item');
      const qty = Math.min(dto.quantity ?? line.quantity, line.quantity);
      const now = new Date();
      const voidData = { status: 'VOIDED' as const, voidedAt: now, voidReason: dto.reason, voidedById: user.userId, voidedByName: user.fullName, approvedById: approver?.id ?? null };
      if (qty < line.quantity) {
        await tx.posOrderLine.update({ where: { id: line.id }, data: { quantity: line.quantity - qty } });
        const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = line;
        await tx.posOrderLine.create({ data: { ...copy, modifiers: line.modifiers as Prisma.InputJsonValue, quantity: qty, ...voidData } });
      } else {
        await tx.posOrderLine.update({ where: { id: line.id }, data: voidData });
      }
      if (line.ticketId) {
        const live = await tx.posOrderLine.count({ where: { ticketId: line.ticketId, status: { not: 'VOIDED' } } });
        if (!live) await tx.posTicket.update({ where: { id: line.ticketId }, data: { status: 'CANCELLED' } });
      }
      if (dto.returnToStock) {
        await this.stock.moveForItems(tx, user.tenantId, o.propertyId, [{ itemId: line.itemId, quantity: qty }], 'VOID_RETURN', { orderId: o.id, reference: o.number, actor: { id: user.userId, name: user.fullName } });
      }
      const value = line.unitPriceKobo * qty;
      await this.guard.raise(tx, user.tenantId, pre.features, {
        rule: 'POS_VOID_AFTER_SEND',
        severity: voidSeverity(value, over && !approver),
        title: `${line.name} x${qty} voided after it was sent (${o.number})`,
        detail: `${user.fullName} voided ${naira(value)} on ${o.number} at ${o.outlet.name} after the ticket went to the ${line.station === 'BAR' ? 'bar' : 'kitchen'}. Reason: ${dto.reason}.${approver ? ` Approved by ${approver.fullName}.` : ''}`,
        dedupeKey: `POS_VOID_AFTER_SEND:${line.id}:${now.getTime()}`,
        amountKobo: value,
        userId: user.userId,
        userName: user.fullName,
        propertyId: o.propertyId,
        evidence: { orderId: o.id, orderNumber: o.number, item: line.name, quantity: qty, valueKobo: value, sentAt: line.sentAt?.toISOString() ?? null, approvedBy: approver?.fullName ?? null, returnToStock: !!dto.returnToStock },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'pos.item_voided',
        entityType: 'pos_order',
        entityId: id,
        metadata: { number: o.number, item: line.name, quantity: qty, valueKobo: value, reason: dto.reason, ...(approver && { approvedBy: approver.fullName }) },
        ip,
      });
      return this.orderView(tx, await this.loadOrder(tx, user.tenantId, id));
    });
  }

  async discount(user: AuthUser, id: string, dto: OrderDiscountDto, ip?: string) {
    if (dto.mode === 'PERCENT' && dto.value > 10_000) throw Err.validation('value', 'A percentage is at most 10000 bps');
    const pre = await this.db.tenant(user.tenantId, async (tx) => {
      const o = await this.loadOrder(tx, user.tenantId, id);
      this.assertOpen(o);
      const comps = await this.components(tx, user.tenantId, o.propertyId);
      const base = this.computeTotals({ ...o, discountMode: null, discountValue: null }, comps).totals.netKobo;
      if (base <= 0) throw AppException.badRequest('There is nothing to discount');
      const amount = dto.mode === 'PERCENT' ? Math.round((base * dto.value) / 10_000) : dto.value;
      if (amount > base) throw AppException.badRequest('The discount is larger than the bill', { baseKobo: base });
      const settings = await this.taxes.forProperty(tx, user.tenantId, o.propertyId);
      return { base, amount, bps: Math.round((amount * 10_000) / base), threshold: settings.discountApprovalThresholdBps, features: await this.guard.features(tx, user.tenantId) };
    });
    const over = pre.bps > pre.threshold;
    let approver: { id: string; fullName: string } | null = null;
    if (over && pre.features.includes('revenue_guard_full')) {
      if (!dto.approval) {
        throw appError(HttpStatus.FORBIDDEN, 'APPROVAL_REQUIRED', 'This discount needs a manager to approve it with their PIN', { thresholdBps: pre.threshold, discountBps: pre.bps });
      }
      approver = await this.ledger.verifyApproval(user, dto.approval);
    }
    return this.db.tenant(user.tenantId, async (tx) => {
      const o = await this.loadOrder(tx, user.tenantId, id);
      this.assertOpen(o);
      await tx.posOrder.update({ where: { id }, data: { discountMode: dto.mode, discountValue: dto.value, discountKobo: pre.amount, discountReason: dto.reason, discountApprovedBy: approver?.id ?? null } });
      if (over && !approver) {
        await this.guard.raise(tx, user.tenantId, pre.features, {
          rule: 'DISCOUNT_OVER_THRESHOLD',
          title: `Discount of ${(pre.bps / 100).toFixed(1)}% on ${o.number}`,
          detail: `${user.fullName} discounted ${o.number} at ${o.outlet.name} above the ${(pre.threshold / 100).toFixed(1)}% threshold without approval. Reason given: ${dto.reason}`,
          dedupeKey: `DISCOUNT_OVER_THRESHOLD:pos:${o.id}`,
          amountKobo: pre.amount,
          userId: user.userId,
          userName: user.fullName,
          propertyId: o.propertyId,
          evidence: { orderId: o.id, discountKobo: pre.amount, baseKobo: pre.base, discountBps: pre.bps, thresholdBps: pre.threshold },
        });
      }
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'pos.discount',
        entityType: 'pos_order',
        entityId: id,
        metadata: { number: o.number, discountKobo: pre.amount, discountBps: pre.bps, reason: dto.reason, ...(approver && { approvedBy: approver.fullName }) },
        ip,
      });
      return this.orderView(tx, await this.loadOrder(tx, user.tenantId, id));
    });
  }

  removeDiscount(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const o = await this.loadOrder(tx, user.tenantId, id);
      this.assertOpen(o);
      await tx.posOrder.update({ where: { id }, data: { discountMode: null, discountValue: null, discountKobo: 0, discountReason: null, discountApprovedBy: null } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.discount_removed', entityType: 'pos_order', entityId: id, metadata: { number: o.number }, ip });
      return this.orderView(tx, await this.loadOrder(tx, user.tenantId, id));
    });
  }

  split(user: AuthUser, id: string, lines: { lineId: string; quantity: number }[], ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const o = await this.loadOrder(tx, user.tenantId, id);
      this.assertOpen(o);
      const live = o.lines.filter((l) => l.status !== 'VOIDED');
      const moving = new Map<string, number>();
      for (const m of lines) moving.set(m.lineId, (moving.get(m.lineId) ?? 0) + m.quantity);
      for (const [lineId, qty] of moving) {
        const l = live.find((x) => x.id === lineId);
        if (!l) throw AppException.notFound('Order item');
        if (qty > l.quantity) throw Err.validation('quantity', `Only ${l.quantity} ${l.name} on the bill`);
      }
      const remaining = live.reduce((a, l) => a + l.quantity - (moving.get(l.id) ?? 0), 0);
      if (remaining <= 0) throw AppException.badRequest('Leave at least one item on the original bill');
      const year = lagosYear();
      const scope = await this.docs.propertyScope(tx, user.tenantId, o.propertyId);
      const { seq } = await this.docs.nextNumber(tx, user.tenantId, 'POS_ORDER', year, scope);
      const newId = randomUUID();
      await tx.posOrder.create({
        data: {
          id: newId,
          tenantId: user.tenantId,
          propertyId: o.propertyId,
          outletId: o.outletId,
          number: `${o.outlet.code}-${String(seq).padStart(6, '0')}`,
          year,
          seq,
          tableLabel: o.tableLabel,
          roomId: o.roomId,
          reservationId: o.reservationId,
          guestName: o.guestName,
          covers: 1,
          openedById: user.userId,
          openedByName: user.fullName,
          splitFromOrderId: o.id,
        },
      });
      for (const [lineId, qty] of moving) {
        const l = live.find((x) => x.id === lineId)!;
        if (qty === l.quantity) {
          await tx.posOrderLine.update({ where: { id: lineId }, data: { orderId: newId } });
        } else {
          await tx.posOrderLine.update({ where: { id: lineId }, data: { quantity: l.quantity - qty } });
          const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = l;
          await tx.posOrderLine.create({ data: { ...copy, modifiers: l.modifiers as Prisma.InputJsonValue, orderId: newId, quantity: qty } });
        }
      }
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.split', entityType: 'pos_order', entityId: id, metadata: { number: o.number, newOrderId: newId, lines: lines.length }, ip });
      return {
        order: await this.orderView(tx, await this.loadOrder(tx, user.tenantId, id)),
        newOrder: await this.orderView(tx, await this.loadOrder(tx, user.tenantId, newId)),
      };
    });
  }

  cancel(user: AuthUser, id: string, reason: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const o = await this.loadOrder(tx, user.tenantId, id);
      this.assertOpen(o);
      if (o.lines.some((l) => l.status === 'SENT')) {
        throw appError(HttpStatus.CONFLICT, 'ORDER_HAS_SENT_ITEMS', 'Void the items already sent to the kitchen or bar first');
      }
      await tx.posOrder.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pos.order_cancelled', entityType: 'pos_order', entityId: id, metadata: { number: o.number, reason }, ip });
      return this.orderView(tx, await this.loadOrder(tx, user.tenantId, id));
    });
  }

  bill(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const o = await this.loadOrder(tx, user.tenantId, id);
      const p = await tx.property.findFirstOrThrow({ where: { id: o.propertyId } });
      return {
        hotel: { name: p.name, address: p.address, area: p.area, city: p.city, phone: p.phone, logoUrl: p.logoUrl },
        outlet: o.outlet.name,
        order: await this.orderView(tx, o),
        printedAt: new Date().toISOString(),
      };
    });
  }

  inHouse(user: AuthUser, q?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const stays = await tx.reservation.findMany({
        where: {
          tenantId: user.tenantId,
          status: 'CHECKED_IN',
          ...(q && { OR: [{ room: { number: { contains: q, mode: 'insensitive' } } }, { guest: { fullName: { contains: q, mode: 'insensitive' } } }] }),
        },
        include: { room: true, guest: { include: { loyalty: { include: { tier: true } } } }, folio: { select: { id: true } } },
        orderBy: [{ room: { number: 'asc' } }],
      });
      const out = [];
      for (const s of stays) {
        const bal = s.folio ? await this.ledger.balance(tx, s.folio.id) : 0;
        out.push({
          reservationId: s.id,
          code: s.code,
          room: s.room ? { id: s.room.id, number: s.room.number } : null,
          guestName: s.guest.fullName,
          guestPhoneLast4: s.guest.phone ? s.guest.phone.slice(-4) : null,
          departureDate: lagosDate(s.departureAt),
          balanceKobo: bal,
          vip: s.guest.vip,
          loyaltyTier: s.guest.loyalty?.tier?.name ?? null,
        });
      }
      return out;
    });
  }

  // ---------------------------------------------------------------------------
  // Settlement
  // ---------------------------------------------------------------------------

  settle(user: AuthUser, id: string, dto: SettleDto, ip?: string) {
    const modes = [dto.payments?.length ? 'PAYMENT' : null, dto.roomCharge ? 'ROOM_CHARGE' : null, dto.cityLedger ? 'CITY_LEDGER' : null, dto.complimentary ? 'COMPLIMENTARY' : null].filter(Boolean);
    if (modes.length !== 1) throw Err.validation('payments', 'Settle with exactly one of payments, roomCharge, cityLedger or complimentary');
    const mode = modes[0] as 'PAYMENT' | 'ROOM_CHARGE' | 'CITY_LEDGER' | 'COMPLIMENTARY';
    if (mode === 'COMPLIMENTARY') assertCan(user, 'payments.special', 'Only a manager can make a bill complimentary');
    if (mode === 'CITY_LEDGER') assertCan(user, 'corporate.view', 'You cannot charge company accounts');
    if (mode === 'ROOM_CHARGE' && dto.roomCharge?.override) assertCan(user, 'frontdesk.override', 'Only a manager can override the guest name check');
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    return this.db.tenant(user.tenantId, async (tx) => {
      const o = await this.loadOrder(tx, user.tenantId, id);
      this.assertOpen(o);
      const actor = actorOf(user);
      // Items not yet sent (quick service at the counter) are sold now.
      const pending = o.lines.filter((l) => l.status === 'PENDING');
      if (pending.length) {
        await tx.posOrderLine.updateMany({ where: { id: { in: pending.map((l) => l.id) } }, data: { status: 'SENT', sentAt: new Date() } });
        await this.stock.moveForItems(tx, user.tenantId, o.propertyId, pending.map((l) => ({ itemId: l.itemId, quantity: l.quantity })), 'SALE', { orderId: o.id, reference: o.number, actor: { id: user.userId, name: user.fullName } });
      }
      const comps = await this.components(tx, user.tenantId, o.propertyId);
      const { totals, groups } = this.computeTotals(o, comps);
      if (totals.totalKobo <= 0) throw appError(HttpStatus.CONFLICT, 'NOTHING_TO_SEND', 'There is nothing to pay on this bill');
      const features = await this.guard.features(tx, user.tenantId);
      const itemsText = (lines: { name: string; quantity: number }[]) => lines.map((l) => `${l.name} x${l.quantity}`).join(', ');
      const receiptExtra = {
        pos: {
          orderNumber: o.number,
          outlet: o.outlet.name,
          tableLabel: o.tableLabel,
          lines: o.lines.filter((l) => l.status !== 'VOIDED').map((l) => ({ name: l.name, quantity: l.quantity, unitPriceKobo: l.unitPriceKobo, lineTotalKobo: l.unitPriceKobo * l.quantity })),
          tipKobo: dto.tipKobo ?? 0,
        },
      };

      /** Posts the sale (EXTRA per tax group, discount per group) onto a folio. */
      const postSale = async (folio: { id: string; status: string }, prefix: string) => {
        for (const g of groups) {
          const charge = await this.ledger.postExtra(tx, user.tenantId, folio, { description: `${prefix}: ${itemsText(g.lines)}`, enteredKobo: g.enteredKobo, comps: g.comps, clientCreatedAt }, actor);
          if (g.discountKobo > 0) {
            await this.ledger.postDiscountOn(tx, user.tenantId, folio, charge.id, {
              description: `Discount on ${prefix}`,
              discountKobo: g.discountKobo,
              comps: g.comps,
              reason: o.discountReason ?? 'POS discount',
              approvedById: o.discountApprovedBy,
              clientCreatedAt,
            }, actor);
          }
        }
      };
      const openPosFolio = async (guestId: string | null) =>
        tx.folio.create({ data: { tenantId: user.tenantId, propertyId: o.propertyId, kind: 'POS', name: `${o.outlet.name} ${o.number}`, guestId, createdById: user.userId, notes: o.tableLabel ? `Table ${o.tableLabel}` : '' } });

      let folioId: string;
      const payments: { method: string; amountKobo: number; reference: string | null; receiptId: string | null; receiptNumber: string | null }[] = [];
      const receipts: unknown[] = [];
      let shiftId: string | null = null;
      let corporateAccountId: string | null = null;
      let signature: string | null = null;

      if (mode === 'PAYMENT') {
        const tendered = dto.payments!.reduce((a, p) => a + p.amountKobo, 0);
        if (tendered !== totals.totalKobo) {
          throw appError(HttpStatus.BAD_REQUEST, 'PAYMENT_MISMATCH', `The payments add up to ${naira(tendered)}; the bill is ${naira(totals.totalKobo)}`, { dueKobo: totals.totalKobo, tenderedKobo: tendered });
        }
        const guestId = o.reservationId ? (await tx.reservation.findFirst({ where: { id: o.reservationId }, select: { guestId: true } }))?.guestId ?? null : null;
        const f = await openPosFolio(guestId);
        folioId = f.id;
        await postSale(f, `${o.outlet.name} ${o.number}`);
        for (const p of dto.payments!) {
          const loaded = await this.docs.loadFolio(tx, user.tenantId, f.id);
          const r = await this.ledger.postPayment(tx, user.tenantId, loaded, { method: p.method as PaymentMethod, amountKobo: p.amountKobo, reference: p.reference, clientCreatedAt, receiptExtra }, actor);
          shiftId = r.entry.shiftId;
          payments.push({ method: p.method, amountKobo: p.amountKobo, reference: p.reference ?? null, receiptId: r.receipt?.id ?? null, receiptNumber: r.receipt?.number ?? null });
          if (r.receipt) receipts.push(r.receipt);
        }
        await tx.folio.update({ where: { id: f.id }, data: { status: 'CLOSED', closedAt: new Date() } });
      } else if (mode === 'ROOM_CHARGE') {
        if (!o.outlet.allowRoomCharge) throw appError(HttpStatus.CONFLICT, 'ROOM_CHARGE_NOT_ALLOWED', `${o.outlet.name} does not take room charges`, { reason: 'NOT_IN_HOUSE' });
        const rc = dto.roomCharge!;
        const stay = await tx.reservation.findFirst({ where: { id: rc.reservationId, tenantId: user.tenantId }, include: { guest: true, folio: true, room: true } });
        if (!stay) throw AppException.notFound('Reservation');
        if (stay.status !== 'CHECKED_IN') throw appError(HttpStatus.CONFLICT, 'ROOM_CHARGE_NOT_ALLOWED', 'Only guests in house can charge to their room', { reason: 'NOT_IN_HOUSE' });
        if (!stay.roomId) throw appError(HttpStatus.CONFLICT, 'ROOM_CHARGE_NOT_ALLOWED', 'The stay has no room', { reason: 'NO_ROOM' });
        if (!stay.folio || stay.folio.status !== 'OPEN') throw appError(HttpStatus.CONFLICT, 'ROOM_CHARGE_NOT_ALLOWED', 'The guest folio is closed', { reason: 'FOLIO_CLOSED' });
        const matches = guestNameMatches(rc.guestName, stay.guest.fullName);
        if (!matches && !rc.override) {
          throw appError(HttpStatus.CONFLICT, 'ROOM_CHARGE_MISMATCH', `The name does not match the guest in room ${stay.room?.number ?? ''}`, { expectedName: initialAndSurname(stay.guest.fullName) });
        }
        folioId = stay.folio.id;
        await postSale(stay.folio, `${o.outlet.name} ${o.number}`);
        payments.push({ method: 'ROOM_CHARGE', amountKobo: totals.totalKobo, reference: stay.code, receiptId: null, receiptNumber: null });
        signature = rc.signatureDataUrl ?? null;
        if (!matches) {
          await this.guard.raise(tx, user.tenantId, features, {
            rule: 'ROOM_CHARGE_NO_GUEST',
            title: `${o.number} charged to room ${stay.room?.number ?? ''} by override`,
            detail: `${user.fullName} charged ${naira(totals.totalKobo)} to ${stay.code} although the name given ("${rc.guestName}") does not match the guest. Reason: ${rc.override!.reason}`,
            dedupeKey: `ROOM_CHARGE_NO_GUEST:${o.id}`,
            amountKobo: totals.totalKobo,
            reservationId: stay.id,
            roomId: stay.roomId,
            userId: user.userId,
            userName: user.fullName,
            evidence: { orderId: o.id, orderNumber: o.number, typedName: rc.guestName ?? null, reason: rc.override!.reason },
          });
        }
        await tx.posOrder.update({ where: { id: o.id }, data: { reservationId: stay.id, roomId: stay.roomId } });
      } else if (mode === 'CITY_LEDGER') {
        const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
        await this.entitlements.assertFeature(ent, 'promotions');
        if (!o.outlet.allowCityLedger) throw appError(HttpStatus.CONFLICT, 'CONFLICT', `${o.outlet.name} does not charge company accounts`);
        const account = await this.corporate.activeAccount(tx, user.tenantId, dto.cityLedger!.corporateAccountId);
        await this.corporate.assertCredit(tx, user.tenantId, account, totals.totalKobo, can(user, 'frontdesk.override'));
        const f = await openPosFolio(null);
        folioId = f.id;
        await postSale(f, `${o.outlet.name} ${o.number}`);
        const loaded = await this.docs.loadFolio(tx, user.tenantId, f.id);
        const r = await this.ledger.postPayment(tx, user.tenantId, loaded, { method: 'CITY_LEDGER', amountKobo: totals.totalKobo, reference: dto.cityLedger!.reference, note: account.name, receipt: false, clientCreatedAt }, actor);
        await this.corporate.chargeCheckout(tx, user.tenantId, {
          account,
          reservation: null,
          folioId: f.id,
          folioEntryId: r.entry.id,
          amountKobo: totals.totalKobo,
          actor: { id: user.userId, fullName: user.fullName },
          roomLabel: '',
          description: `${o.outlet.name} ${o.number}${dto.cityLedger!.signedBy ? `, signed by ${dto.cityLedger!.signedBy}` : ''}`,
          guestName: dto.cityLedger!.signedBy ?? o.guestName,
          propertyId: o.propertyId,
        });
        await tx.folio.update({ where: { id: f.id }, data: { status: 'CLOSED', closedAt: new Date() } });
        corporateAccountId = account.id;
        payments.push({ method: 'CITY_LEDGER', amountKobo: totals.totalKobo, reference: dto.cityLedger!.reference ?? null, receiptId: null, receiptNumber: null });
      } else {
        const f = await openPosFolio(null);
        folioId = f.id;
        await postSale(f, `${o.outlet.name} ${o.number}`);
        const loaded = await this.docs.loadFolio(tx, user.tenantId, f.id);
        await this.ledger.postPayment(tx, user.tenantId, loaded, { method: 'COMPLIMENTARY', amountKobo: totals.totalKobo, note: dto.complimentary!.reason, receipt: false, clientCreatedAt }, actor);
        await tx.folio.update({ where: { id: f.id }, data: { status: 'CLOSED', closedAt: new Date() } });
        payments.push({ method: 'COMPLIMENTARY', amountKobo: totals.totalKobo, reference: null, receiptId: null, receiptNumber: null });
      }

      await tx.posOrder.update({
        where: { id: o.id },
        data: {
          status: 'SETTLED',
          settlement: mode,
          payments: payments as unknown as Prisma.InputJsonValue,
          folioId,
          totals: totals as unknown as Prisma.InputJsonValue,
          netKobo: totals.netKobo,
          totalKobo: totals.totalKobo,
          taxKobo: totals.taxTotalKobo,
          discountKobo: totals.discountKobo,
          tipKobo: dto.tipKobo ?? 0,
          settledAt: clientCreatedAt ?? new Date(),
          settledById: user.userId,
          settledByName: user.fullName,
          shiftId,
          corporateAccountId,
          signature,
        },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'pos.settled',
        entityType: 'pos_order',
        entityId: o.id,
        metadata: { number: o.number, settlement: mode, totalKobo: totals.totalKobo, payments: payments.map((p) => `${p.method} ${p.amountKobo}`), ...(clientCreatedAt && { clientCreatedAt: clientCreatedAt.toISOString() }) },
        ip,
      });
      return { order: await this.orderView(tx, await this.loadOrder(tx, user.tenantId, o.id)), receipts, folioId };
    });
  }
}

type TicketRow = Prisma.PosTicketGetPayload<{ include: { lines: true; order: { include: { outlet: true } } } }>;

export function ticketView(t: TicketRow, roomNumber: string | null = null, now = new Date()) {
  return {
    id: t.id,
    number: t.number,
    station: t.station,
    status: t.status,
    order: { id: t.order.id, number: t.order.number, tableLabel: t.order.tableLabel, roomNumber, guestName: t.order.guestName, outletName: t.order.outlet.name },
    lines: t.lines.map((l) => ({
      lineId: l.id,
      name: l.name,
      quantity: l.quantity,
      modifiers: ((l.modifiers as unknown as LineModifier[]) ?? []).map((m) => m.option),
      note: l.note,
      voided: l.status === 'VOIDED',
    })),
    server: userRef(t.serverId, t.serverName),
    createdAt: t.createdAt.toISOString(),
    startedAt: t.startedAt?.toISOString() ?? null,
    readyAt: t.readyAt?.toISOString() ?? null,
    servedAt: t.servedAt?.toISOString() ?? null,
    elapsedSec: Math.max(0, Math.round((now.getTime() - t.createdAt.getTime()) / 1000)),
  };
}
