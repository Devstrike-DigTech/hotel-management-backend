import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Prisma, Transfer } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { emitDomainEvent } from '../../common/domain-events.js';
import { AppException } from '../../common/errors/app-exception.js';
import { addDays, humanDateTime, lagosDate, lagosStartOfDay } from '../../common/time/lagos.js';
import { normalisePhone } from '../../common/utils/phone.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { BookingNotifier } from '../booking/booking-notifier.service.js';
import { runAfter } from '../booking/booking-payments.service.js';
import { BookingViewService } from '../booking/booking-view.service.js';
import { issuesError } from '../booking-form/form.errors.js';
import { LedgerService } from '../folios/ledger.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import type { TransferContext } from '../notifications/templates/templates.js';
import { appError, Err } from '../ops/ops.helpers.js';
import type { AssignDriverDto, TransferDelayDto, TransferQueryDto, TransferStatusDto, UpdateTransferDto } from './extras.dto.js';
import { AddOnsService, eventsOf, namesOf } from './addons.service.js';
import { canMove, detailsSummary, LIVE_TRANSFER, type TransferStatusCode } from './extras.logic.js';

const include = {
  reservation: { select: { id: true, code: true, status: true, contactPhone: true, arrivalAt: true, departureAt: true, guest: { select: { fullName: true, phone: true } }, room: { select: { number: true } } } },
  pickupPoint: { select: { city: true, shortName: true, notesForGuest: true } },
} satisfies Prisma.TransferInclude;

type Row = Prisma.TransferGetPayload<{ include: typeof include }>;

const ALL: TransferStatusCode[] = ['REQUESTED', 'CONFIRMED', 'DRIVER_ASSIGNED', 'EN_ROUTE', 'PICKED_UP', 'COMPLETED', 'NO_SHOW', 'CANCELLED'];

export function directionLabel(t: Pick<Transfer, 'direction' | 'kind'>): string {
  if (t.direction === 'ARRIVAL') return t.kind === 'AIRPORT' ? 'Airport pickup' : 'Arrival pickup';
  return t.kind === 'AIRPORT' ? 'Airport drop-off' : 'Departure drop-off';
}

/**
 * The transfers board (M7): upcoming pickups and drop-offs by time, driver
 * assignment with a guest message (WhatsApp / SMS and email; dev outbox),
 * a mobile-friendly status flow and delay notes.
 */
const MOVING = ['EN_ROUTE', 'PICKED_UP'];

@Injectable()
export class TransfersService {
  private readonly logger = new Logger(TransfersService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly addOns: AddOnsService,
    private readonly notifications: NotificationService,
    private readonly notifier: BookingNotifier,
    private readonly views: BookingViewService,
    private readonly ledger: LedgerService,
  ) {}

  view(t: Row) {
    const d = (t.details ?? {}) as Record<string, unknown>;
    return {
      id: t.id,
      propertyId: t.propertyId,
      reservationId: t.reservationId,
      reservation: {
        code: t.reservation.code,
        status: t.reservation.status,
        guestName: t.reservation.guest.fullName,
        guestPhone: t.reservation.contactPhone ?? t.reservation.guest.phone,
        roomNumber: t.reservation.room?.number ?? null,
        arrivalDate: lagosDate(t.reservation.arrivalAt),
        departureDate: lagosDate(t.reservation.departureAt),
      },
      direction: t.direction,
      directionLabel: directionLabel(t),
      status: t.status,
      pickupPoint: { id: t.pickupPointId, name: t.pickupPointName, shortName: t.pickupPoint.shortName, kind: t.kind, city: t.pickupPoint.city },
      details: d,
      detailsSummary: detailsSummary(t.kind, d, namesOf(t)),
      scheduledAt: t.scheduledAt.toISOString(),
      scheduledHuman: humanDateTime(t.scheduledAt),
      passengers: t.passengers,
      luggage: t.luggage,
      vehicleOption: t.vehicleOptionId ? { id: t.vehicleOptionId, name: t.vehicleName, maxPassengers: t.vehicleMaxPassengers } : null,
      vehicleName: t.vehicleName,
      amountKobo: t.amountKobo,
      taxKobo: t.taxKobo,
      totalKobo: t.netKobo + t.taxKobo,
      contactPhone: t.contactPhone,
      driver: t.driverName ? { name: t.driverName, phone: t.driverPhone ?? '', vehiclePlate: t.vehiclePlate ?? '', vehicleDescription: t.vehicleDescription, assignedAt: t.assignedAt?.toISOString() ?? null } : null,
      delayNote: t.delayNote,
      notes: t.notes,
      notesForGuest: t.pickupPoint.notesForGuest,
      events: eventsOf(t),
      posted: !!t.folioEntryId,
      source: t.source as 'ONLINE' | 'FRONT_DESK',
      lastNotifiedAt: t.lastNotifiedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }

  /** Guest-facing shape (trip page, confirmation card): driver only once assigned. */
  guestView(t: Row) {
    const v = this.view(t);
    const showDriver = ['DRIVER_ASSIGNED', 'EN_ROUTE', 'PICKED_UP', 'COMPLETED'].includes(t.status);
    return {
      id: v.id,
      direction: v.direction,
      directionLabel: v.directionLabel,
      status: v.status,
      pickupPointName: v.pickupPoint.name,
      kind: v.pickupPoint.kind,
      scheduledAt: v.scheduledAt,
      passengers: v.passengers,
      vehicleName: v.vehicleName,
      totalKobo: v.totalKobo,
      detailsSummary: v.detailsSummary,
      notesForGuest: v.notesForGuest,
      driver: showDriver && v.driver ? { name: v.driver.name, phone: v.driver.phone, vehiclePlate: v.driver.vehiclePlate, vehicleDescription: v.driver.vehicleDescription } : null,
      delayNote: v.delayNote,
    };
  }

  async forReservations(tx: Tx, tenantId: string, reservationIds: string[]) {
    if (!reservationIds.length) return new Map<string, Row[]>();
    const rows = await tx.transfer.findMany({ where: { tenantId, reservationId: { in: reservationIds } }, include, orderBy: [{ direction: 'asc' }, { createdAt: 'asc' }] });
    const out = new Map<string, Row[]>();
    for (const r of rows) out.set(r.reservationId, [...(out.get(r.reservationId) ?? []), r]);
    return out;
  }

  private async load(tx: Tx, tenantId: string, id: string): Promise<Row> {
    const t = await tx.transfer.findFirst({ where: { id, tenantId }, include });
    if (!t) throw AppException.notFound('Transfer');
    return t;
  }

  // ---------------------------------------------------------------------------
  // Board
  // ---------------------------------------------------------------------------

  list(u: AuthUser, q: TransferQueryDto) {
    const from = q.from ?? q.date ?? lagosDate();
    const to = q.to ?? q.date ?? from;
    if (to < from) throw Err.validation('to', '"to" must not be before "from"');
    const statuses = q.status ? q.status.split(',').map((s) => s.trim().toUpperCase()).filter((s): s is TransferStatusCode => (ALL as string[]).includes(s)) : null;
    return this.db.tenant(u.tenantId, async (tx) => {
      const rows = await tx.transfer.findMany({
        where: {
          tenantId: u.tenantId,
          scheduledAt: { gte: lagosStartOfDay(from), lt: lagosStartOfDay(addDays(to, 1)) },
          status: statuses?.length ? { in: statuses } : { not: 'CANCELLED' },
          ...(q.direction && { direction: q.direction }),
        },
        include,
        orderBy: { scheduledAt: 'asc' },
      });
      const items = rows.map((r) => this.view(r));
      return {
        items,
        counts: {
          arrivals: rows.filter((r) => r.direction === 'ARRIVAL' && r.status !== 'CANCELLED').length,
          departures: rows.filter((r) => r.direction === 'DEPARTURE' && r.status !== 'CANCELLED').length,
          unassigned: rows.filter((r) => r.status === 'REQUESTED' || r.status === 'CONFIRMED').length,
          inProgress: rows.filter((r) => r.status === 'DRIVER_ASSIGNED' || r.status === 'EN_ROUTE' || r.status === 'PICKED_UP').length,
          done: rows.filter((r) => r.status === 'COMPLETED').length,
        },
      };
    });
  }

  async todayTx(tx: Tx, tenantId: string) {
    const today = lagosDate();
    const rows = await tx.transfer.findMany({
      where: { tenantId, scheduledAt: { gte: lagosStartOfDay(today), lt: lagosStartOfDay(addDays(today, 1)) }, status: { notIn: ['CANCELLED'] } },
      include,
      orderBy: { scheduledAt: 'asc' },
    });
    return {
      date: today,
      arrivals: rows.filter((r) => r.direction === 'ARRIVAL').length,
      departures: rows.filter((r) => r.direction === 'DEPARTURE').length,
      unassigned: rows.filter((r) => r.status === 'REQUESTED' || r.status === 'CONFIRMED').length,
      inProgress: rows.filter((r) => r.status === 'DRIVER_ASSIGNED' || r.status === 'EN_ROUTE' || r.status === 'PICKED_UP').length,
      // Live transfers of the day, those already moving first, then by time (late ones stay on the board).
      next: rows
        .filter((r) => LIVE_TRANSFER.includes(r.status))
        .sort((a, b) => Number(MOVING.includes(b.status)) - Number(MOVING.includes(a.status)) || a.scheduledAt.getTime() - b.scheduledAt.getTime())
        .slice(0, 5)
        .map((r) => this.view(r)),
    };
  }

  today(u: AuthUser) {
    return this.db.tenant(u.tenantId, (tx) => this.todayTx(tx, u.tenantId));
  }

  get(u: AuthUser, id: string) {
    return this.db.tenant(u.tenantId, async (tx) => this.view(await this.load(tx, u.tenantId, id)));
  }

  // ---------------------------------------------------------------------------
  // Changes
  // ---------------------------------------------------------------------------

  private async changed(tx: Tx, u: AuthUser, before: Row, data: Prisma.TransferUpdateInput, event: { status: string | null; note: string | null }, ip?: string, action = 'transfer.status_changed') {
    const events = [...eventsOf(before), { at: new Date().toISOString(), status: event.status, note: event.note, by: u.fullName }];
    const row = await tx.transfer.update({ where: { id: before.id }, data: { ...data, events: events as Prisma.InputJsonValue }, include });
    await this.audit.record(tx, {
      tenantId: u.tenantId, actor: userActor(u), action, entityType: 'transfer', entityId: before.id,
      metadata: { code: before.reservation.code, from: before.status, to: row.status, ...(event.note && { note: event.note }) }, ip,
    });
    await emitDomainEvent(tx, { tenantId: u.tenantId, propertyId: row.propertyId, type: 'transfer.updated', object: await this.addOns.partnerTransfer(tx, row) });
    return row;
  }

  private assertMove(t: Row, to: TransferStatusCode) {
    if (!canMove(t.status, to)) {
      const allowed = ALL.filter((s) => canMove(s, to));
      throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', `This transfer is ${t.status.toLowerCase().replace(/_/g, ' ')}; it cannot move to ${to.toLowerCase().replace(/_/g, ' ')}`, { status: t.status, allowed });
    }
  }

  update(u: AuthUser, id: string, dto: UpdateTransferDto, ip?: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const t = await this.load(tx, u.tenantId, id);
      if (!LIVE_TRANSFER.includes(t.status)) throw Err.invalidState(t.status, LIVE_TRANSFER, 'This transfer');
      if (dto.passengers !== undefined && dto.passengers > t.vehicleMaxPassengers) {
        throw issuesError([{ path: 'passengers', fieldKey: null, code: 'TOO_MANY_PASSENGERS', message: `A ${t.vehicleName} takes up to ${t.vehicleMaxPassengers} passengers`, meta: { max: t.vehicleMaxPassengers } }]);
      }
      const phone = dto.contactPhone ? normalisePhone(dto.contactPhone) : dto.contactPhone;
      if (dto.contactPhone && !phone) throw Err.validation('contactPhone', 'Enter a valid phone number');
      const row = await this.changed(tx, u, t, {
        ...(dto.scheduledAt !== undefined && { scheduledAt: new Date(dto.scheduledAt) }),
        ...(dto.passengers !== undefined && { passengers: dto.passengers }),
        ...(dto.luggage !== undefined && { luggage: dto.luggage }),
        ...(dto.contactPhone !== undefined && { contactPhone: phone ?? null }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.details !== undefined && { details: { ...((t.details ?? {}) as object), ...dto.details } as Prisma.InputJsonValue }),
      }, { status: null, note: `Updated: ${Object.keys(dto).join(', ')}` }, ip, 'transfer.updated');
      return this.view(row);
    });
  }

  confirm(u: AuthUser, id: string, ip?: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const t = await this.load(tx, u.tenantId, id);
      this.assertMove(t, 'CONFIRMED');
      return this.view(await this.changed(tx, u, t, { status: 'CONFIRMED' }, { status: 'CONFIRMED', note: null }, ip));
    });
  }

  async assign(u: AuthUser, id: string, dto: AssignDriverDto, ip?: string) {
    const phone = normalisePhone(dto.driverPhone);
    if (!phone) throw Err.validation('driverPhone', "Enter the driver's phone number, e.g. 0803 555 0142");
    const notify = dto.notifyGuest !== false;
    const { row, ids } = await this.db.tenant(u.tenantId, async (tx) => {
      const t = await this.load(tx, u.tenantId, id);
      if (t.status !== 'DRIVER_ASSIGNED') this.assertMove(t, 'DRIVER_ASSIGNED');
      const row = await this.changed(
        tx,
        u,
        t,
        { status: 'DRIVER_ASSIGNED', driverName: dto.driverName.trim(), driverPhone: phone, vehiclePlate: dto.vehiclePlate.trim().toUpperCase(), vehicleDescription: dto.vehicleDescription?.trim() || null, assignedAt: new Date(), ...(notify && { lastNotifiedAt: new Date() }) },
        { status: 'DRIVER_ASSIGNED', note: `${dto.driverName.trim()}, ${dto.vehiclePlate.trim().toUpperCase()}${t.driverName ? ' (re-assigned)' : ''}` },
        ip,
      );
      const ids = notify ? await this.queueGuestMessage(tx, row, 'TRANSFER_DRIVER_ASSIGNED', null) : [];
      return { row, ids };
    });
    await runAfter(() => this.notifications.dispatch(ids), this.logger);
    const notified = ids.length
      ? await this.db.tenant(u.tenantId, (tx) => tx.notificationLog.findMany({ where: { id: { in: ids } }, select: { channel: true, recipient: true, status: true } }))
      : [];
    return { ...this.view(row), notified: notified.map((n) => ({ channel: n.channel, to: n.recipient, status: n.status })) };
  }

  async setStatus(u: AuthUser, id: string, dto: TransferStatusDto, ip?: string) {
    const { row, ids } = await this.db.tenant(u.tenantId, async (tx) => {
      const t = await this.load(tx, u.tenantId, id);
      if (dto.status === 'DRIVER_ASSIGNED' && !t.driverName) throw Err.validation('status', 'Assign a driver with POST /transfers/:id/assign');
      this.assertMove(t, dto.status);
      if (dto.status === 'CANCELLED' && t.folioEntryId) {
        // A posted pickup that will not happen: the charge is voided.
        const r = await tx.reservation.findFirst({ where: { id: t.reservationId }, include: { folio: { select: { id: true, status: true } } } });
        if (r?.folio?.status === 'OPEN') await this.addOnsVoid(tx, u, r.folio.id, t);
      }
      const row = await this.changed(tx, u, t, { status: dto.status }, { status: dto.status, note: dto.note ?? null }, ip);
      const ids = dto.notifyGuest && (dto.status === 'EN_ROUTE' || dto.status === 'CANCELLED') ? await this.queueGuestMessage(tx, row, 'TRANSFER_UPDATE', dto.note ?? (dto.status === 'EN_ROUTE' ? 'Your driver is on the way.' : 'Your transfer has been cancelled.')) : [];
      if (ids.length) await tx.transfer.update({ where: { id }, data: { lastNotifiedAt: new Date() } });
      return { row, ids };
    });
    await runAfter(() => this.notifications.dispatch(ids), this.logger);
    return this.view(row);
  }

  /** A cancelled pickup that was already posted: its charge is voided. */
  private async addOnsVoid(tx: Tx, u: AuthUser, folioId: string, t: Row) {
    await this.ledger.voidChargeTx(tx, u.tenantId, folioId, t.folioEntryId!, { userId: u.userId, fullName: u.fullName }, `Transfer cancelled: ${t.pickupPointName}`);
  }

  async delay(u: AuthUser, id: string, dto: TransferDelayDto, ip?: string) {
    const { row, ids } = await this.db.tenant(u.tenantId, async (tx) => {
      const t = await this.load(tx, u.tenantId, id);
      if (!LIVE_TRANSFER.includes(t.status)) throw Err.invalidState(t.status, LIVE_TRANSFER, 'This transfer');
      const row = await this.changed(
        tx,
        u,
        t,
        { delayNote: dto.note.trim(), ...(dto.newScheduledAt && { scheduledAt: new Date(dto.newScheduledAt) }), ...(dto.notifyGuest && { lastNotifiedAt: new Date() }) },
        { status: null, note: `Delay: ${dto.note.trim()}` },
        ip,
        'transfer.delayed',
      );
      const ids = dto.notifyGuest ? await this.queueGuestMessage(tx, row, 'TRANSFER_UPDATE', dto.note.trim()) : [];
      return { row, ids };
    });
    await runAfter(() => this.notifications.dispatch(ids), this.logger);
    return this.view(row);
  }

  // ---------------------------------------------------------------------------
  // Guest messages
  // ---------------------------------------------------------------------------

  context(t: Row): TransferContext {
    return {
      label: directionLabel(t),
      direction: t.direction,
      pointName: t.pickupPointName,
      whenHuman: humanDateTime(t.scheduledAt),
      driverName: t.driverName,
      driverPhone: t.driverPhone,
      vehiclePlate: t.vehiclePlate,
      vehicleDescription: t.vehicleDescription ?? t.vehicleName,
      meetingNote: t.pickupPoint.notesForGuest,
      detailsSummary: detailsSummary(t.kind, (t.details ?? {}) as Record<string, unknown>, namesOf(t)),
      status: t.status,
    };
  }

  private async queueGuestMessage(tx: Tx, t: Row, template: 'TRANSFER_DRIVER_ASSIGNED' | 'TRANSFER_UPDATE', note: string | null): Promise<string[]> {
    const stayRow = await this.views.load(tx, t.tenantId, t.reservationId);
    const transfer = this.context(t);
    const msgs =
      template === 'TRANSFER_DRIVER_ASSIGNED'
        ? await this.notifier.guest(tx, stayRow, 'TRANSFER_DRIVER_ASSIGNED', { transfer })
        : await this.notifier.guest(tx, stayRow, 'TRANSFER_UPDATE', { transfer, note: note ?? '' });
    // The phone on the day, when the guest gave one for the pickup.
    const day = t.contactPhone && t.contactPhone !== (stayRow.contactPhone ?? stayRow.guest.phone) ? t.contactPhone : null;
    const adjusted = msgs.map((m) => (m.channel !== 'EMAIL' && day ? { ...m, to: day } : m));
    return this.notifications.queueTx(tx, adjusted.map((m) => ({ ...m, meta: { ...m.meta, transferId: t.id } })));
  }
}
