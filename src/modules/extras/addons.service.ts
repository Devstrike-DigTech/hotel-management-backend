import { HttpStatus, Injectable } from '@nestjs/common';
import type { Extra, PickupPoint, Prisma, ReservationExtra, Transfer } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { assertCan } from '../../common/permissions/can.js';
import { runInProperty } from '../../common/property-scope.js';
import { emitDomainEvent } from '../../common/domain-events.js';
import { AppException } from '../../common/errors/app-exception.js';
import { addDays, diffDays, lagosDate, lagosDateTime, nightsBetween } from '../../common/time/lagos.js';
import { normalisePhone } from '../../common/utils/phone.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { issuesError } from '../booking-form/form.errors.js';
import type { ValidationIssue } from '../booking-form/form.logic.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { actorOf, LedgerService, type Actor } from '../folios/ledger.service.js';
import { componentsFrom, type TaxComponent } from '../folios/tax.logic.js';
import { TaxSettingsService } from '../folios/tax-settings.service.js';
import { DocumentsService } from '../invoices/documents.service.js';
import { advisoryLock, appError } from '../ops/ops.helpers.js';
import { AvailabilityService } from '../reservations/availability.service.js';
import type { DeskTransferDto, ExtraSelectionDto, PublicExtrasQueryDto } from './extras.dto.js';
import {
  capIssue,
  detailsSummary,
  extraRuleIssue,
  LIVE_TRANSFER,
  priceExtra,
  quoteTransfer,
  taxed,
  type AddOnLine,
  type ChannelCode,
  type ExtraSelection,
  type QuotedExtra,
  type QuotedTransfer,
  type StayInfo,
  type TransferSelection,
} from './extras.logic.js';
import { ExtrasService, extraLike, pointLike } from './extras.service.js';
import { publicPickupPoint } from '../site/theme.service.js';

/** Frozen in the quote token: extra id, quantity, entered amount. */
export type FrozenExtra = [string, number, number];
/** Frozen in the quote token: direction, point id, vehicle id, passengers, scheduledAt, entered amount. */
export type FrozenTransfer = ['ARRIVAL' | 'DEPARTURE', string, string | null, number, string, number];

export interface PricedAddOns {
  extras: QuotedExtra[];
  transfers: QuotedTransfer[];
  lines: AddOnLine[];
  issues: ValidationIssue[];
}

export interface TransferInput extends QuotedTransfer {
  details?: Record<string, unknown>;
  luggage?: number | null;
  contactPhone?: string | null;
  notes?: string | null;
}

const ACTIVE_STAY = ['PENDING', 'CONFIRMED', 'CHECKED_IN'] as const;

export function stayInfoOf(r: { arrivalAt: Date; departureAt: Date; adults: number; children: number; stayType: string }): StayInfo {
  return {
    arrivalDate: lagosDate(r.arrivalAt),
    departureDate: lagosDate(r.departureAt),
    arrivalAt: r.arrivalAt,
    nights: r.stayType === 'DAY_USE' ? 0 : nightsBetween(r.arrivalAt, r.departureAt),
    adults: r.adults,
    children: r.children,
    dayUse: r.stayType === 'DAY_USE',
  };
}

/**
 * Paid extras and transfers on bookings (M7): prices selections for quotes
 * (the quote token freezes the amounts), creates the booking's lines, posts
 * them to the folio (online payment: on confirmation; pay at hotel / desk:
 * at check-in), voids them when removed or cancelled, and lets the desk add
 * or remove them later.
 */
@Injectable()
export class AddOnsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly availability: AvailabilityService,
    private readonly taxes: TaxSettingsService,
    private readonly ledger: LedgerService,
    private readonly docs: DocumentsService,
    private readonly extras: ExtrasService,
  ) {}

  // ---------------------------------------------------------------------------
  // Pricing
  // ---------------------------------------------------------------------------

  private async soldByDate(tx: Tx, tenantId: string, extraId: string, dates: string[], excludeReservationId?: string): Promise<Map<string, number>> {
    const rows = await tx.reservationExtra.findMany({
      where: {
        tenantId,
        extraId,
        status: 'ACTIVE',
        serviceDates: { hasSome: dates },
        reservation: { status: { in: [...ACTIVE_STAY] } },
        ...(excludeReservationId && { reservationId: { not: excludeReservationId } }),
      },
      select: { quantity: true, pricing: true, serviceDates: true },
    });
    const out = new Map<string, number>();
    for (const r of rows) for (const d of r.serviceDates) out.set(d, (out.get(d) ?? 0) + (r.pricing === 'PER_UNIT' ? r.quantity : 1));
    return out;
  }

  /** Early check-in / late check-out need a free room of the type around the stay. */
  private async timingIssue(tx: Tx, tenantId: string, e: Extra, roomTypeId: string, stay: StayInfo, checkIn: string, checkOut: string): Promise<string | null> {
    if (e.kind === 'EARLY_CHECK_IN') {
      const d = addDays(stay.arrivalDate, -1);
      const free = (await this.availability.freeByType(tx, tenantId, [roomTypeId], lagosDateTime(d, checkIn), lagosDateTime(stay.arrivalDate, checkOut))).get(roomTypeId) ?? 0;
      return free < 1 ? 'Early check-in is not possible on this date' : null;
    }
    if (e.kind === 'LATE_CHECK_OUT') {
      const d = stay.departureDate;
      const free = (await this.availability.freeByType(tx, tenantId, [roomTypeId], lagosDateTime(d, checkIn), lagosDateTime(addDays(d, 1), checkOut))).get(roomTypeId) ?? 0;
      return free < 1 ? 'Late check-out is not possible on this date' : null;
    }
    return null;
  }

  /**
   * Prices extras and transfers for a stay. Issues use the paths of the
   * request (`extras[i]`, `transfers[i].*`) so web can map them.
   */
  async price(
    tx: Tx,
    tenantId: string,
    propertyId: string,
    input: {
      extras?: ExtraSelection[];
      transfers?: TransferSelection[];
      channel: ChannelCode;
      stay: StayInfo;
      roomTypeId: string;
      comps: TaxComponent[];
      now?: Date;
      enforceLeadTime: boolean;
      /** Pickup lead times (default: enforceLeadTime). Booking time checks them with the PICKUP answer instead. */
      transferLeadTime?: boolean;
      pickupAllowed: boolean;
      /** Lock capped extras (booking time). */
      lock?: boolean;
      excludeReservationId?: string;
      /** Booking time: amounts frozen in the quote (index-aligned). */
      frozenExtraAmounts?: number[];
      frozenTransferAmounts?: number[];
    },
  ): Promise<PricedAddOns> {
    const now = input.now ?? new Date();
    const out: PricedAddOns = { extras: [], transfers: [], lines: [], issues: [] };
    const sels = input.extras ?? [];
    const trs = input.transfers ?? [];
    if (!sels.length && !trs.length) return out;
    const ent = await this.entitlements.getEntitlements(tenantId, tx);
    const offered = ent.features.includes('paid_extras');
    const property = await tx.property.findFirstOrThrow({ where: { id: propertyId, tenantId } });

    if (sels.length) {
      const rows = await tx.extra.findMany({ where: { tenantId, propertyId, id: { in: sels.map((s) => s.extraId) } } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const seen = new Set<string>();
      for (const [i, sel] of sels.entries()) {
        const path = `extras[${i}]`;
        const e = byId.get(sel.extraId);
        if (!offered) {
          out.issues.push({ path, fieldKey: 'extras', code: 'NOT_AVAILABLE', message: `${property.name} does not offer extras online` });
          continue;
        }
        if (!e) {
          out.issues.push({ path: `${path}.extraId`, fieldKey: 'extras', code: 'INACTIVE', message: 'This extra is not available' });
          continue;
        }
        if (seen.has(e.id)) {
          out.issues.push({ path, fieldKey: 'extras', code: 'DUPLICATE_KEY', message: `${e.name} is already in the booking` });
          continue;
        }
        seen.add(e.id);
        const like = extraLike(e);
        const rule = extraRuleIssue(like, input.channel, input.stay, now, { enforceLeadTime: input.enforceLeadTime });
        if (rule) {
          out.issues.push({ path, fieldKey: 'extras', code: rule.code, message: rule.message });
          continue;
        }
        const priced = priceExtra(like, sel, input.stay, input.comps, path);
        if (!priced.quoted) {
          out.issues.push(...priced.issues);
          continue;
        }
        let q = priced.quoted;
        const frozen = input.frozenExtraAmounts?.[i];
        if (frozen !== undefined && frozen !== q.amountKobo) q = { ...q, amountKobo: frozen, ...taxed(frozen, e.taxable ? input.comps : []) };
        const timing = await this.timingIssue(tx, tenantId, e, input.roomTypeId, input.stay, property.checkInTime, property.checkOutTime);
        if (timing) {
          out.issues.push({ path, fieldKey: 'extras', code: 'NOT_AVAILABLE', message: timing });
          continue;
        }
        if (e.dailyCap !== null) {
          if (input.lock) await advisoryLock(tx, `extra-cap:${e.id}`);
          const cap = capIssue(like, q, await this.soldByDate(tx, tenantId, e.id, q.serviceDates, input.excludeReservationId));
          if (cap) {
            out.issues.push({ path, fieldKey: 'extras', code: cap.code, message: cap.message, meta: cap.meta });
            continue;
          }
        }
        out.extras.push(q);
        out.lines.push({ kind: 'EXTRA', refId: e.id, description: q.description, amountKobo: q.amountKobo, netKobo: q.netKobo, taxKobo: q.taxKobo, totalKobo: q.totalKobo, taxes: q.taxes });
      }
    }

    if (trs.length) {
      const points = await tx.pickupPoint.findMany({ where: { tenantId, propertyId, id: { in: trs.map((t) => t.pickupPointId) } } });
      const byId = new Map(points.map((p) => [p.id, p]));
      const dirs = new Set<string>();
      for (const [i, sel] of trs.entries()) {
        const path = `transfers[${i}]`;
        if (!offered || !input.pickupAllowed) {
          out.issues.push({ path, fieldKey: 'arrivalPickup', code: 'NOT_AVAILABLE', message: `${property.name} does not offer pickups here` });
          continue;
        }
        if (dirs.has(sel.direction)) {
          out.issues.push({ path: `${path}.direction`, fieldKey: 'arrivalPickup', code: 'DUPLICATE_KEY', message: `Only one ${sel.direction === 'ARRIVAL' ? 'arrival pickup' : 'departure drop-off'} per booking` });
          continue;
        }
        dirs.add(sel.direction);
        const p = byId.get(sel.pickupPointId) ?? null;
        const r = quoteTransfer(p ? pointLike(p) : null, sel, input.stay, input.comps, path, now, { enforceLeadTime: input.transferLeadTime ?? input.enforceLeadTime, hotelPhone: property.phone || null });
        if (!r.quoted) {
          out.issues.push(...r.issues);
          continue;
        }
        let q = r.quoted;
        const frozen = input.frozenTransferAmounts?.[i];
        if (frozen !== undefined && frozen !== q.amountKobo) q = { ...q, amountKobo: frozen, ...taxed(frozen, p!.taxable ? input.comps : []) };
        out.transfers.push(q);
        out.lines.push({ kind: 'TRANSFER', refId: p!.id, description: q.description, amountKobo: q.amountKobo, netKobo: q.netKobo, taxKobo: q.taxKobo, totalKobo: q.totalKobo, taxes: q.taxes });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Lines on a reservation
  // ---------------------------------------------------------------------------

  /** Creates the booking's extra lines and transfers (inside the booking transaction). */
  async createLines(
    tx: Tx,
    input: { tenantId: string; propertyId: string; reservationId: string; source: 'ONLINE' | 'FRONT_DESK'; extras: QuotedExtra[]; transfers: TransferInput[]; comps: TaxComponent[]; actor: Actor; guestPhone: string | null; transferStatus?: 'REQUESTED' | 'CONFIRMED' },
  ): Promise<{ extraIds: string[]; transferIds: string[] }> {
    const extraIds: string[] = [];
    for (const q of input.extras) {
      const row = await tx.reservationExtra.create({
        data: {
          tenantId: input.tenantId,
          propertyId: input.propertyId,
          reservationId: input.reservationId,
          extraId: q.extraId,
          name: q.name,
          category: q.category as ReservationExtra['category'],
          pricing: q.pricing,
          quantity: q.quantity,
          persons: q.persons,
          nights: q.nights,
          unitPriceKobo: q.unitPriceKobo,
          amountKobo: q.amountKobo,
          netKobo: q.netKobo,
          taxKobo: q.taxKobo,
          taxComponents: (q.taxes.length ? input.comps : []) as unknown as Prisma.InputJsonValue,
          description: q.description,
          serviceDates: q.serviceDates,
          source: input.source,
          createdById: input.actor.userId,
          createdByName: input.actor.fullName,
        },
      });
      extraIds.push(row.id);
    }
    const transferIds: string[] = [];
    for (const t of input.transfers) {
      const status = input.transferStatus ?? (input.source === 'FRONT_DESK' ? 'CONFIRMED' : 'REQUESTED');
      const row = await tx.transfer.create({
        data: {
          tenantId: input.tenantId,
          propertyId: input.propertyId,
          reservationId: input.reservationId,
          direction: t.direction,
          status,
          pickupPointId: t.pickupPointId,
          pickupPointName: t.pickupPointName,
          kind: t.kind,
          details: (t.details ?? {}) as Prisma.InputJsonValue,
          scheduledAt: new Date(t.scheduledAt),
          passengers: t.passengers,
          luggage: t.luggage ?? null,
          vehicleOptionId: t.vehicleOptionId,
          vehicleName: t.vehicleName,
          vehicleMaxPassengers: t.vehicleMaxPassengers,
          amountKobo: t.amountKobo,
          netKobo: t.netKobo,
          taxKobo: t.taxKobo,
          taxComponents: (t.taxes.length ? input.comps : []) as unknown as Prisma.InputJsonValue,
          contactPhone: normalisePhone(t.contactPhone ?? '') ?? input.guestPhone,
          notes: t.notes ?? null,
          source: input.source,
          events: [{ at: new Date().toISOString(), status, note: input.source === 'ONLINE' ? 'Requested with the booking' : 'Added at the front desk', by: input.actor.fullName }] as Prisma.InputJsonValue,
        },
      });
      transferIds.push(row.id);
      await emitDomainEvent(tx, { tenantId: input.tenantId, propertyId: input.propertyId, type: 'transfer.created', object: await this.partnerTransfer(tx, row) });
    }
    return { extraIds, transferIds };
  }

  /** Posts every active, unposted extra and live, unposted transfer of a reservation to its folio. */
  async postPending(tx: Tx, tenantId: string, reservationId: string, actor: Actor): Promise<number> {
    const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId }, include: { folio: { select: { id: true } } } });
    if (!r?.folio) return 0;
    const extras = await tx.reservationExtra.findMany({ where: { tenantId, reservationId, status: 'ACTIVE', folioEntryId: null }, orderBy: { createdAt: 'asc' } });
    const transfers = await tx.transfer.findMany({ where: { tenantId, reservationId, status: { in: [...LIVE_TRANSFER, 'COMPLETED'] }, folioEntryId: null }, orderBy: { createdAt: 'asc' } });
    if (!extras.length && !transfers.length) return 0;
    const folio = await this.docs.loadFolio(tx, tenantId, r.folio.id);
    if (folio.status !== 'OPEN') return 0;
    let n = 0;
    for (const e of extras) {
      const entry = await this.ledger.postExtra(tx, tenantId, folio, { description: e.description, enteredKobo: e.amountKobo, comps: (e.taxComponents as unknown as TaxComponent[]) ?? [] }, actor);
      await tx.reservationExtra.update({ where: { id: e.id }, data: { folioEntryId: entry.id, postedAt: new Date() } });
      n++;
    }
    for (const t of transfers) {
      const entry = await this.ledger.postExtra(tx, tenantId, folio, { description: transferLine(t), enteredKobo: t.amountKobo, comps: (t.taxComponents as unknown as TaxComponent[]) ?? [] }, actor);
      await tx.transfer.update({ where: { id: t.id }, data: { folioEntryId: entry.id, postedAt: new Date() } });
      n++;
    }
    return n;
  }

  /** A stay that will not happen: lines cancelled, posted ones voided, transfers cancelled. */
  async release(tx: Tx, tenantId: string, reservationId: string, why: string): Promise<void> {
    const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId }, include: { folio: { select: { id: true, status: true } } } });
    if (!r) return;
    const actor: Actor = { userId: null, fullName: 'System' };
    const extras = await tx.reservationExtra.findMany({ where: { tenantId, reservationId, status: 'ACTIVE' } });
    for (const e of extras) {
      if (e.folioEntryId && r.folio && r.folio.status === 'OPEN') await this.ledger.voidChargeTx(tx, tenantId, r.folio.id, e.folioEntryId, actor, why);
      await tx.reservationExtra.update({ where: { id: e.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    }
    const transfers = await tx.transfer.findMany({ where: { tenantId, reservationId, status: { in: LIVE_TRANSFER.filter((s) => s !== 'PICKED_UP') } } });
    for (const t of transfers) {
      if (t.folioEntryId && r.folio && r.folio.status === 'OPEN') await this.ledger.voidChargeTx(tx, tenantId, r.folio.id, t.folioEntryId, actor, why);
      const events = [...eventsOf(t), { at: new Date().toISOString(), status: 'CANCELLED', note: why, by: 'System' }];
      const row = await tx.transfer.update({ where: { id: t.id }, data: { status: 'CANCELLED', events: events as Prisma.InputJsonValue } });
      await emitDomainEvent(tx, { tenantId, propertyId: row.propertyId, type: 'transfer.updated', object: await this.partnerTransfer(tx, row) });
    }
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  extraView(e: ReservationExtra) {
    return {
      id: e.id,
      reservationId: e.reservationId,
      extraId: e.extraId,
      name: e.name,
      category: e.category,
      pricing: e.pricing,
      quantity: e.quantity,
      persons: e.persons,
      nights: e.nights,
      unitPriceKobo: e.unitPriceKobo,
      amountKobo: e.amountKobo,
      netKobo: e.netKobo,
      taxKobo: e.taxKobo,
      totalKobo: e.netKobo + e.taxKobo,
      description: e.description,
      serviceDates: e.serviceDates,
      status: e.status as 'ACTIVE' | 'CANCELLED',
      source: e.source as 'ONLINE' | 'FRONT_DESK',
      posted: !!e.folioEntryId,
      postedAt: e.postedAt?.toISOString() ?? null,
      folioEntryId: e.folioEntryId,
      createdAt: e.createdAt.toISOString(),
      createdBy: e.createdByName,
    };
  }

  async linesOf(tx: Tx, tenantId: string, reservationIds: string[]) {
    if (!reservationIds.length) return { extras: new Map<string, ReservationExtra[]>(), transfers: new Map<string, Transfer[]>() };
    const [extras, transfers] = [
      await tx.reservationExtra.findMany({ where: { tenantId, reservationId: { in: reservationIds } }, orderBy: { createdAt: 'asc' } }),
      await tx.transfer.findMany({ where: { tenantId, reservationId: { in: reservationIds } }, orderBy: [{ direction: 'asc' }, { createdAt: 'asc' }] }),
    ];
    const ex = new Map<string, ReservationExtra[]>();
    for (const e of extras) ex.set(e.reservationId, [...(ex.get(e.reservationId) ?? []), e]);
    const tr = new Map<string, Transfer[]>();
    for (const t of transfers) tr.set(t.reservationId, [...(tr.get(t.reservationId) ?? []), t]);
    return { extras: ex, transfers: tr };
  }

  /** Partner API / webhook shape of a transfer. */
  async partnerTransfer(tx: Tx, t: Transfer) {
    return {
      id: t.id,
      reservationId: t.reservationId,
      propertyId: t.propertyId,
      direction: t.direction,
      status: t.status,
      pickupPoint: { id: t.pickupPointId, name: t.pickupPointName, kind: t.kind, city: (await tx.pickupPoint.findUnique({ where: { id: t.pickupPointId }, select: { city: true } }))?.city ?? '' },
      scheduledAt: t.scheduledAt.toISOString(),
      passengers: t.passengers,
      vehicleName: t.vehicleName,
      totalKobo: t.netKobo + t.taxKobo,
      detailsSummary: detailsSummary(t.kind, (t.details ?? {}) as Record<string, unknown>, namesOf(t)),
      driver: t.driverName ? { name: t.driverName, phone: t.driverPhone ?? '', vehiclePlate: t.vehiclePlate ?? '' } : null,
      updatedAt: t.updatedAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Front desk
  // ---------------------------------------------------------------------------

  private async deskReservation(tx: Tx, tenantId: string, id: string) {
    const r = await tx.reservation.findFirst({ where: { id, tenantId }, include: { folio: { select: { id: true, status: true } }, bookingPayments: { select: { status: true } }, guest: { select: { phone: true } } } });
    if (!r) throw AppException.notFound('Reservation');
    if (!['PENDING', 'CONFIRMED', 'CHECKED_IN'].includes(r.status)) throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', `This reservation is ${r.status.toLowerCase().replace('_', ' ')}`, { status: r.status, allowed: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] });
    return r;
  }

  /** Posted at once when the guest is in house or the booking was paid online. */
  private postsNow(r: { status: string; bookingPayments: { status: string }[] }): boolean {
    return r.status === 'CHECKED_IN' || r.bookingPayments.some((p) => ['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(p.status));
  }

  listForReservation(u: AuthUser, reservationId: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId: u.tenantId }, select: { id: true } });
      if (!r) throw AppException.notFound('Reservation');
      return (await tx.reservationExtra.findMany({ where: { tenantId: u.tenantId, reservationId }, orderBy: { createdAt: 'asc' } })).map((e) => this.extraView(e));
    });
  }

  async addExtra(u: AuthUser, reservationId: string, dto: ExtraSelectionDto, ip?: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const r = await this.deskReservation(tx, u.tenantId, reservationId);
      const comps = componentsFrom(await this.taxes.forProperty(tx, u.tenantId, r.propertyId));
      const priced = await this.price(tx, u.tenantId, r.propertyId, {
        extras: [dto],
        channel: 'FRONT_DESK',
        stay: stayInfoOf(r),
        roomTypeId: r.roomTypeId,
        comps,
        enforceLeadTime: false,
        pickupAllowed: true,
        lock: true,
        excludeReservationId: r.id,
      });
      if (priced.issues.length) throw issuesError(priced.issues);
      const { extraIds } = await this.createLines(tx, { tenantId: u.tenantId, propertyId: r.propertyId, reservationId: r.id, source: 'FRONT_DESK', extras: priced.extras, transfers: [], comps, actor: actorOf(u), guestPhone: r.guest.phone });
      if (this.postsNow(r)) await this.postPending(tx, u.tenantId, r.id, actorOf(u));
      await this.audit.record(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'reservation.extra_added', entityType: 'reservation', entityId: r.id,
        metadata: { code: r.code, extra: priced.extras[0]!.name, totalKobo: priced.extras[0]!.totalKobo }, ip,
      });
      return this.extraView(await tx.reservationExtra.findUniqueOrThrow({ where: { id: extraIds[0] } }));
    });
  }

  async removeExtra(u: AuthUser, reservationId: string, lineId: string, ip?: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const r = await this.deskReservation(tx, u.tenantId, reservationId);
      const line = await tx.reservationExtra.findFirst({ where: { id: lineId, reservationId, tenantId: u.tenantId } });
      if (!line) throw AppException.notFound('Extra');
      if (line.status === 'CANCELLED') return { success: true };
      if (line.folioEntryId) {
        assertCan(u, 'folio.void', 'Removing an extra already on the folio voids it: only a manager can do that');
        if (r.folio) await this.ledger.voidChargeTx(tx, u.tenantId, r.folio.id, line.folioEntryId, actorOf(u), `Extra removed: ${line.name}`);
      }
      await tx.reservationExtra.update({ where: { id: line.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'reservation.extra_removed', entityType: 'reservation', entityId: r.id, metadata: { code: r.code, extra: line.name, posted: !!line.folioEntryId }, ip });
      return { success: true };
    });
  }

  /** Desk pickup / drop-off: CONFIRMED at once; lead time not enforced. */
  async addTransfer(u: AuthUser, reservationId: string, dto: DeskTransferDto, detailsCheck: (tx: Tx, kind: PickupPoint['kind'], details: unknown) => Promise<{ value: Record<string, unknown>; issues: ValidationIssue[] }>, ip?: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const r = await this.deskReservation(tx, u.tenantId, reservationId);
      const comps = componentsFrom(await this.taxes.forProperty(tx, u.tenantId, r.propertyId));
      const live = await tx.transfer.findFirst({ where: { reservationId: r.id, direction: dto.direction, status: { notIn: ['CANCELLED', 'NO_SHOW'] } } });
      if (live) throw issuesError([{ path: 'direction', fieldKey: 'arrivalPickup', code: 'DUPLICATE_KEY', message: `This booking already has ${dto.direction === 'ARRIVAL' ? 'an arrival pickup' : 'a departure drop-off'}` }]);
      const priced = await this.price(tx, u.tenantId, r.propertyId, { transfers: [dto], channel: 'FRONT_DESK', stay: stayInfoOf(r), roomTypeId: r.roomTypeId, comps, enforceLeadTime: false, pickupAllowed: true });
      const q = priced.transfers[0];
      const point = await tx.pickupPoint.findFirst({ where: { id: dto.pickupPointId, tenantId: u.tenantId } });
      const details = point && dto.details ? await detailsCheck(tx, point.kind, dto.details) : { value: {}, issues: [] };
      const issues = [...priced.issues, ...details.issues.map((i) => ({ ...i, path: i.path.replace(/^answers\.arrivalPickup\.details/, 'details') }))];
      if (issues.length || !q) throw issuesError(issues);
      const { transferIds } = await this.createLines(tx, {
        tenantId: u.tenantId, propertyId: r.propertyId, reservationId: r.id, source: 'FRONT_DESK', extras: [],
        transfers: [{ ...q, details: details.value, luggage: dto.luggage ?? null, contactPhone: dto.contactPhone ?? null, notes: dto.notes ?? null }],
        comps, actor: actorOf(u), guestPhone: r.guest.phone,
      });
      if (this.postsNow(r)) await this.postPending(tx, u.tenantId, r.id, actorOf(u));
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'transfer.created', entityType: 'transfer', entityId: transferIds[0]!, metadata: { code: r.code, direction: q.direction, point: q.pickupPointName, totalKobo: q.totalKobo }, ip });
      return transferIds[0]!;
    });
  }

  async removeTransfer(u: AuthUser, reservationId: string, transferId: string, ip?: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const r = await this.deskReservation(tx, u.tenantId, reservationId);
      const t = await tx.transfer.findFirst({ where: { id: transferId, reservationId, tenantId: u.tenantId } });
      if (!t) throw AppException.notFound('Transfer');
      if (!LIVE_TRANSFER.includes(t.status) || t.status === 'PICKED_UP') throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', `This transfer is ${t.status.toLowerCase().replace('_', ' ')}`, { status: t.status, allowed: LIVE_TRANSFER.filter((s) => s !== 'PICKED_UP') });
      if (t.folioEntryId) {
        assertCan(u, 'folio.void', 'Cancelling a transfer already on the folio voids it: only a manager can do that');
        if (r.folio) await this.ledger.voidChargeTx(tx, u.tenantId, r.folio.id, t.folioEntryId, actorOf(u), `Transfer cancelled: ${t.pickupPointName}`);
      }
      const events = [...eventsOf(t), { at: new Date().toISOString(), status: 'CANCELLED', note: 'Cancelled at the front desk', by: u.fullName }];
      const row = await tx.transfer.update({ where: { id: t.id }, data: { status: 'CANCELLED', events: events as Prisma.InputJsonValue } });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'transfer.status_changed', entityType: 'transfer', entityId: t.id, metadata: { code: r.code, from: t.status, to: 'CANCELLED' }, ip });
      await emitDomainEvent(tx, { tenantId: u.tenantId, propertyId: row.propertyId, type: 'transfer.updated', object: await this.partnerTransfer(tx, row) });
      return { success: true };
    });
  }

  /** Desk pricing preview. */
  quoteForDesk(u: AuthUser, dto: { extras: ExtraSelectionDto[]; arrivalDate: string; departureDate: string; adults: number; children?: number; channel?: ChannelCode }) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const p = await tx.property.findFirstOrThrow({ where: { id: u.propertyId!, tenantId: u.tenantId } });
      const comps = componentsFrom(await this.taxes.forProperty(tx, u.tenantId, p.id));
      const nights = Math.max(0, diffDays(dto.arrivalDate, dto.departureDate));
      const stay: StayInfo = { arrivalDate: dto.arrivalDate, departureDate: dto.departureDate, arrivalAt: lagosDateTime(dto.arrivalDate, p.checkInTime), nights, adults: dto.adults, children: dto.children ?? 0, dayUse: nights === 0 };
      const type = await tx.roomType.findFirst({ where: { tenantId: u.tenantId, propertyId: p.id }, select: { id: true } });
      const priced = await this.price(tx, u.tenantId, p.id, { extras: dto.extras, channel: dto.channel ?? 'FRONT_DESK', stay, roomTypeId: type?.id ?? '', comps, enforceLeadTime: false, pickupAllowed: true });
      return {
        extras: priced.extras,
        subtotalKobo: priced.extras.reduce((a, e) => a + e.netKobo, 0),
        taxKobo: priced.extras.reduce((a, e) => a + e.taxKobo, 0),
        totalKobo: priced.extras.reduce((a, e) => a + e.totalKobo, 0),
        issues: priced.issues,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Public
  // ---------------------------------------------------------------------------

  publicPickupPoints(ref: { id: string; tenantId: string }) {
    return runInProperty(ref.tenantId, ref.id, () =>
      this.db.tenant(ref.tenantId, async (tx) => {
        const ent = await this.entitlements.getEntitlements(ref.tenantId, tx);
        if (!ent.features.includes('paid_extras')) return [];
        return (await tx.pickupPoint.findMany({ where: { tenantId: ref.tenantId, propertyId: ref.id, active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })).map(publicPickupPoint);
      }),
    );
  }

  publicCompanies(ref: { id: string; tenantId: string }) {
    return this.db.tenant(ref.tenantId, (tx) => this.extras.companiesTx(tx, ref.tenantId));
  }

  async publicExtras(ref: { id: string; tenantId: string }, q: PublicExtrasQueryDto, resolveStay: (p: { checkInTime: string; checkOutTime: string }) => StayInfo | null) {
    return runInProperty(ref.tenantId, ref.id, () =>
      this.db.tenant(ref.tenantId, async (tx) => {
        const ent = await this.entitlements.getEntitlements(ref.tenantId, tx);
        if (!ent.features.includes('paid_extras')) return [];
        const p = await tx.property.findFirstOrThrow({ where: { id: ref.id } });
        const channel = q.channel ?? (p.listedOnMarketplace ? 'MARKETPLACE' : 'BOOKING_SITE');
        const rows = await tx.extra.findMany({ where: { tenantId: ref.tenantId, propertyId: ref.id, active: true, channels: { has: channel } }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
        const stay = resolveStay(p);
        const comps = componentsFrom(await this.taxes.forProperty(tx, ref.tenantId, ref.id));
        const type = stay ? await tx.roomType.findFirst({ where: { tenantId: ref.tenantId, propertyId: ref.id }, orderBy: { sortOrder: 'asc' }, select: { id: true } }) : null;
        const out = [];
        for (const e of rows) {
          let available: boolean | null = null;
          let reason: string | null = null;
          let price: QuotedExtra | null = null;
          if (stay) {
            const priced = await this.price(tx, ref.tenantId, ref.id, { extras: [{ extraId: e.id }], channel, stay, roomTypeId: type?.id ?? '', comps, enforceLeadTime: true, pickupAllowed: false });
            available = priced.issues.length === 0;
            reason = priced.issues[0]?.message ?? null;
            price = priced.extras[0] ?? null;
          }
          out.push({
            id: e.id,
            name: e.name,
            description: e.description,
            imageUrl: e.imageUrl,
            category: e.category,
            kind: e.kind,
            pricing: e.pricing,
            priceKobo: e.priceKobo,
            maxUnits: e.maxUnits,
            taxable: e.taxable,
            availability: e.availability,
            available,
            unavailableReason: reason,
            price,
          });
        }
        return out;
      }),
    );
  }
}

export function eventsOf(t: Pick<Transfer, 'events'>): { at: string; status: string | null; note: string | null; by: string | null }[] {
  return Array.isArray(t.events) ? (t.events as { at: string; status: string | null; note: string | null; by: string | null }[]) : [];
}

export function namesOf(t: Pick<Transfer, 'details'>): { company?: string | null; route?: string | null } {
  const d = (t.details ?? {}) as Record<string, unknown>;
  return { company: typeof d.transportCompanyName === 'string' ? d.transportCompanyName : null, route: typeof d.trainRouteName === 'string' ? d.trainRouteName : null };
}

function transferLine(t: Transfer): string {
  const what = t.direction === 'ARRIVAL' ? (t.kind === 'AIRPORT' ? 'Airport pickup' : 'Arrival pickup') : t.kind === 'AIRPORT' ? 'Airport drop-off' : 'Departure drop-off';
  return `${what}: ${t.pickupPointName}, ${t.vehicleName}`;
}
