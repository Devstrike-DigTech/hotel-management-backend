import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { lagosYear } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { DocumentsService } from '../invoices/documents.service.js';
import { appError, parseClientCreatedAt, primaryProperty } from '../ops/ops.helpers.js';
import { PosService } from './pos.service.js';
import { StockService } from './stock.service.js';

/** How long after check-out a minibar count can still go on the stay's (open) folio. */
const AFTER_CHECKOUT_MS = 6 * 3_600_000;

/**
 * Minibar: par levels per room type (items of the property's MINIBAR
 * outlet) and consumption recorded by housekeeping, charged to the stay.
 */
@Injectable()
export class MinibarService {
  private readonly logger = new Logger(MinibarService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly docs: DocumentsService,
    private readonly pos: PosService,
    private readonly stock: StockService,
  ) {}

  private async outlet(tx: Tx, tenantId: string) {
    const o = await tx.posOutlet.findFirst({ where: { tenantId, type: 'MINIBAR', active: true }, orderBy: { createdAt: 'asc' } });
    if (!o) throw appError(HttpStatus.CONFLICT, 'CONFLICT', 'Set up a Minibar outlet with its items first');
    return o;
  }

  par(user: AuthUser, roomTypeId?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const types = await tx.roomType.findMany({ where: { tenantId: user.tenantId, ...(roomTypeId && { id: roomTypeId }) }, orderBy: { sortOrder: 'asc' }, select: { id: true } });
      const pars = await tx.minibarPar.findMany({ where: { tenantId: user.tenantId, roomTypeId: { in: types.map((t) => t.id) } }, include: { item: true } });
      return types.map((t) => ({
        roomTypeId: t.id,
        items: pars.filter((p) => p.roomTypeId === t.id && p.item.active).map((p) => ({ itemId: p.itemId, name: p.item.name, priceKobo: p.item.priceKobo, parQty: p.parQty })),
      }));
    });
  }

  setPar(user: AuthUser, dto: { roomTypeId: string; items: { itemId: string; parQty: number }[] }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rt = await tx.roomType.findFirst({ where: { id: dto.roomTypeId, tenantId: user.tenantId } });
      if (!rt) throw AppException.notFound('Room type');
      const outlet = await this.outlet(tx, user.tenantId);
      const ids = dto.items.map((i) => i.itemId);
      const items = await tx.posItem.findMany({ where: { tenantId: user.tenantId, id: { in: ids }, active: true } });
      if (items.length !== new Set(ids).size || items.some((i) => i.outletIds.length && !i.outletIds.includes(outlet.id))) {
        throw appError(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Minibar items must be sold in the Minibar outlet', { fields: { items: ['Minibar items must be sold in the Minibar outlet'] } });
      }
      await tx.minibarPar.deleteMany({ where: { tenantId: user.tenantId, roomTypeId: rt.id } });
      await tx.minibarPar.createMany({ data: dto.items.filter((i) => i.parQty > 0).map((i) => ({ tenantId: user.tenantId, propertyId: rt.propertyId, roomTypeId: rt.id, itemId: i.itemId, parQty: i.parQty })) });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'minibar.par_set', entityType: 'room_type', entityId: rt.id, metadata: { roomType: rt.name, items: dto.items.length }, ip });
      const pars = await tx.minibarPar.findMany({ where: { roomTypeId: rt.id }, include: { item: true } });
      return { roomTypeId: rt.id, items: pars.map((p) => ({ itemId: p.itemId, name: p.item.name, priceKobo: p.item.priceKobo, parQty: p.parQty })) };
    });
  }

  /** The stay a minibar count is charged to: in house, or just checked out with the folio still open. */
  private async stayFor(tx: Tx, tenantId: string, roomId: string) {
    const inHouse = await tx.reservation.findFirst({ where: { tenantId, roomId, status: 'CHECKED_IN' }, include: { guest: true, folio: true } });
    if (inHouse?.folio?.status === 'OPEN') return inHouse;
    const recent = await tx.reservation.findFirst({
      where: { tenantId, roomId, status: 'CHECKED_OUT', checkedOutAt: { gte: new Date(Date.now() - AFTER_CHECKOUT_MS) } },
      include: { guest: true, folio: true },
      orderBy: { checkedOutAt: 'desc' },
    });
    return recent?.folio?.status === 'OPEN' ? recent : null;
  }

  room(user: AuthUser, roomId: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const room = await tx.room.findFirst({ where: { id: roomId, tenantId: user.tenantId } });
      if (!room) throw AppException.notFound('Room');
      const stay = await this.stayFor(tx, user.tenantId, room.id);
      const pars = await tx.minibarPar.findMany({ where: { roomTypeId: room.roomTypeId }, include: { item: true } });
      return {
        room: { id: room.id, number: room.number, floor: room.floor, status: room.status },
        stay: stay ? { reservationId: stay.id, code: stay.code, guestName: stay.guest.fullName } : null,
        items: pars.filter((p) => p.item.active).map((p) => ({ itemId: p.itemId, name: p.item.name, priceKobo: p.item.priceKobo, parQty: p.parQty })),
      };
    });
  }

  async consumption(user: AuthUser, dto: { roomId: string; items: { itemId: string; quantity: number }[]; note?: string; housekeepingTaskId?: string; clientCreatedAt?: string }, ip?: string) {
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    const created = await this.db.tenant(user.tenantId, async (tx) => {
      const room = await tx.room.findFirst({ where: { id: dto.roomId, tenantId: user.tenantId } });
      if (!room) throw AppException.notFound('Room');
      const outlet = await this.outlet(tx, user.tenantId);
      const items = await tx.posItem.findMany({ where: { tenantId: user.tenantId, id: { in: dto.items.map((i) => i.itemId) }, active: true }, include: { category: true } });
      const byId = new Map(items.map((i) => [i.id, i]));
      for (const i of dto.items) {
        const it = byId.get(i.itemId);
        if (!it || (it.outletIds.length && !it.outletIds.includes(outlet.id))) throw appError(HttpStatus.CONFLICT, 'ITEM_UNAVAILABLE', 'Not a minibar item', { itemId: i.itemId });
      }
      const stay = await this.stayFor(tx, user.tenantId, room.id);
      const property = await primaryProperty(tx, user.tenantId);
      const year = lagosYear();
      const { seq } = await this.docs.nextNumber(tx, user.tenantId, 'POS_ORDER', year, await this.docs.propertyScope(tx, user.tenantId, property.id));
      const id = randomUUID();
      const now = clientCreatedAt ?? new Date();
      await tx.posOrder.create({
        data: {
          id,
          tenantId: user.tenantId,
          propertyId: property.id,
          outletId: outlet.id,
          number: `${outlet.code}-${String(seq).padStart(6, '0')}`,
          year,
          seq,
          roomId: room.id,
          reservationId: stay?.id ?? null,
          guestName: stay?.guest.fullName ?? null,
          notes: [`Minibar, room ${room.number}`, dto.note].filter(Boolean).join('. '),
          openedById: user.userId,
          openedByName: user.fullName,
          openedAt: now,
          clientCreatedAt,
        },
      });
      const lines: Prisma.PosOrderLineCreateManyInput[] = dto.items.map((i) => {
        const it = byId.get(i.itemId)!;
        return {
          tenantId: user.tenantId,
          propertyId: property.id,
          orderId: id,
          itemId: it.id,
          name: it.name,
          categoryName: it.category.name,
          quantity: i.quantity,
          unitPriceKobo: it.priceKobo,
          basePriceKobo: it.priceKobo,
          station: 'NONE',
          vat: it.vat,
          consumption: it.consumptionTax,
          status: 'SENT',
          sentAt: now,
          addedById: user.userId,
          addedByName: user.fullName,
        };
      });
      await tx.posOrderLine.createMany({ data: lines });
      await this.stock.moveForItems(tx, user.tenantId, property.id, dto.items, 'MINIBAR', { orderId: id, reference: `Room ${room.number}`, actor: { id: user.userId, name: user.fullName } });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'minibar.consumption',
        entityType: 'room',
        entityId: room.id,
        metadata: { room: room.number, items: dto.items.map((i) => `${byId.get(i.itemId)!.name} x${i.quantity}`), stay: stay?.code ?? null, housekeepingTaskId: dto.housekeepingTaskId ?? null, ...(clientCreatedAt && { clientCreatedAt: clientCreatedAt.toISOString() }) },
        ip,
      });
      return { id, stayId: stay?.id ?? null };
    });
    if (created.stayId) {
      try {
        const r = await this.pos.settle(user, created.id, { roomCharge: { reservationId: created.stayId } });
        return { order: r.order, charged: true, folioId: r.folioId };
      } catch (e) {
        this.logger.warn(`Minibar order ${created.id} left open for the desk: ${(e as Error).message}`);
      }
    }
    return { order: await this.pos.get(user, created.id), charged: false, folioId: null };
  }
}
