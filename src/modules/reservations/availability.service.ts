import { HttpStatus, Injectable } from '@nestjs/common';
import type { ReservationStatus } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { addDays, dateRange, diffDays, isIsoDate, lagosDate, lagosDateTime, lagosStartOfDay, nightWindow } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { LedgerService } from '../folios/ledger.service.js';
import { advisoryLock, appError, Err, k, primaryProperty } from '../ops/ops.helpers.js';
import { dailyAvailability, isFree, maxConcurrent } from './availability.logic.js';

export const ACTIVE: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'CHECKED_IN'];
const MAX_RANGE_DAYS = 92;

export interface Window {
  roomTypeId: string;
  roomId?: string | null;
  arrivalAt: Date;
  departureAt: Date;
  excludeReservationId?: string | null;
}

const collator = new Intl.Collator('en', { numeric: true });

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Validates that a stay fits. Serialised per (tenant, room type) with an
   * advisory lock so two unassigned bookings cannot both take the last room;
   * assigned rooms are additionally protected by the exclusion constraint.
   */
  async assertAvailable(tx: Tx, tenantId: string, w: Window): Promise<void> {
    await advisoryLock(tx, `room-type:${tenantId}:${w.roomTypeId}`);
    const rooms = await tx.room.findMany({ where: { tenantId, roomTypeId: w.roomTypeId } });
    const sellable = rooms.filter((r) => r.status !== 'OUT_OF_ORDER');
    const exclude = w.excludeReservationId ? { id: { not: w.excludeReservationId } } : {};
    if (w.roomId) {
      const room = rooms.find((r) => r.id === w.roomId);
      if (!room) throw AppException.badRequest('The room does not belong to the selected room type');
      if (room.status === 'OUT_OF_ORDER') {
        throw appError(HttpStatus.CONFLICT, 'ROOM_UNAVAILABLE', `Room ${room.number} is out of order`, {
          scope: 'ROOM',
          roomId: room.id,
          roomTypeId: w.roomTypeId,
        });
      }
      const clashes = await tx.reservation.findMany({
        where: {
          tenantId,
          roomId: w.roomId,
          status: { in: ACTIVE },
          arrivalAt: { lt: w.departureAt },
          departureAt: { gt: w.arrivalAt },
          ...exclude,
        },
        select: { id: true, code: true },
      });
      if (clashes.length) {
        throw appError(HttpStatus.CONFLICT, 'ROOM_UNAVAILABLE', `Room ${room.number} is already booked for part of these dates`, {
          scope: 'ROOM',
          roomId: room.id,
          roomTypeId: w.roomTypeId,
          conflicts: clashes.map((c) => ({ reservationId: c.id, code: c.code })),
        });
      }
    }
    const stays = await tx.reservation.findMany({
      where: {
        tenantId,
        roomTypeId: w.roomTypeId,
        status: { in: ACTIVE },
        arrivalAt: { lt: w.departureAt },
        departureAt: { gt: w.arrivalAt },
        ...exclude,
      },
      select: { arrivalAt: true, departureAt: true },
    });
    const peak = maxConcurrent(stays.map((s) => ({ start: s.arrivalAt, end: s.departureAt })), w.arrivalAt, w.departureAt);
    if (peak + 1 > sellable.length) {
      throw appError(HttpStatus.CONFLICT, 'ROOM_UNAVAILABLE', 'No room of this type is free for these dates', {
        scope: 'ROOM_TYPE',
        roomTypeId: w.roomTypeId,
      });
    }
  }

  private checkRange(from: string, to: string) {
    if (!isIsoDate(from) || !isIsoDate(to)) throw Err.validation('from', 'from and to must be YYYY-MM-DD');
    if (to < from) throw Err.validation('to', '"to" must not be before "from"');
    if (diffDays(from, to) + 1 > MAX_RANGE_DAYS) throw Err.validation('to', `The range can be at most ${MAX_RANGE_DAYS} days`);
  }

  grid(user: AuthUser, from: string, to: string, roomTypeId?: string) {
    this.checkRange(from, to);
    return this.db.tenant(user.tenantId, async (tx) => {
      const property = await primaryProperty(tx, user.tenantId);
      const types = await tx.roomType.findMany({
        where: { tenantId: user.tenantId, ...(roomTypeId && { id: roomTypeId }) },
        orderBy: [{ sortOrder: 'asc' }, { basePriceKobo: 'asc' }],
        include: { rooms: { select: { status: true } } },
      });
      const nights = dateRange(from, to).map((d) => ({ date: d, ...nightWindow(d, property.checkInTime, property.checkOutTime) }));
      const windowStart = nights[0].start;
      const windowEnd = nights[nights.length - 1].end;
      const stays = await tx.reservation.findMany({
        where: {
          tenantId: user.tenantId,
          status: { in: ACTIVE },
          arrivalAt: { lt: windowEnd },
          departureAt: { gt: windowStart },
          ...(roomTypeId && { roomTypeId }),
        },
        select: { roomTypeId: true, arrivalAt: true, departureAt: true },
      });
      return {
        from,
        to,
        roomTypes: types.map((t) => {
          const ooo = t.rooms.filter((r) => r.status === 'OUT_OF_ORDER').length;
          return {
            roomType: { id: t.id, name: t.name, basePriceKobo: t.basePriceKobo, hourlyPriceKobo: t.hourlyPriceKobo },
            totalRooms: t.rooms.length,
            days: dailyAvailability(
              nights,
              t.rooms.length,
              ooo,
              stays.filter((s) => s.roomTypeId === t.id).map((s) => ({ start: s.arrivalAt, end: s.departureAt })),
            ),
          };
        }),
      };
    });
  }

  /** Resolves a stay window from query/body input and the property times. */
  async resolveWindow(
    tx: Tx,
    tenantId: string,
    input: { stayType?: string; arrivalDate?: string; departureDate?: string; arrivalAt?: string; departureAt?: string },
  ): Promise<{ arrivalAt: Date; departureAt: Date }> {
    const property = await primaryProperty(tx, tenantId);
    if ((input.stayType ?? 'NIGHTLY') === 'DAY_USE') {
      if (!input.arrivalAt || !input.departureAt) throw Err.validation('arrivalAt', 'arrivalAt and departureAt are required for day use');
      const a = new Date(input.arrivalAt);
      const d = new Date(input.departureAt);
      if (Number.isNaN(a.getTime()) || Number.isNaN(d.getTime())) throw Err.validation('arrivalAt', 'Invalid timestamps');
      return { arrivalAt: a, departureAt: d };
    }
    if (!input.arrivalDate || !input.departureDate || !isIsoDate(input.arrivalDate) || !isIsoDate(input.departureDate)) {
      throw Err.validation('arrivalDate', 'arrivalDate and departureDate (YYYY-MM-DD) are required');
    }
    return {
      arrivalAt: lagosDateTime(input.arrivalDate, property.checkInTime),
      departureAt: lagosDateTime(input.departureDate, property.checkOutTime),
    };
  }

  /**
   * Room picker for a window.
   *
   * - `free`: no active stay (pending, confirmed or checked in) overlaps the
   *   window. With `forCheckIn`, the window starts now (check-in moves the
   *   arrival to now), so a room whose guest is still checked in is never free
   *   for a check-in, even if that guest departs later today.
   * - `checkInReady`: free, clean (VACANT_CLEAN or RESERVED) and nobody is
   *   checked in to it right now. Only these rooms pass check-in.
   * - `occupiedUntil`: departure of the guest currently checked in, if any.
   * - `reason`: why `checkInReady` is false (first that applies): OUT_OF_ORDER,
   *   OCCUPIED (a guest is checked in now), BOOKED (another stay overlaps the
   *   window), DIRTY; null when the room is ready.
   */
  roomsFor(
    user: AuthUser,
    q: {
      roomTypeId: string;
      stayType?: string;
      arrivalDate?: string;
      departureDate?: string;
      arrivalAt?: string;
      departureAt?: string;
      excludeReservationId?: string;
      forCheckIn?: string;
    },
  ) {
    const forCheckIn = q.forCheckIn === 'true';
    return this.db.tenant(user.tenantId, async (tx) => {
      const w = await this.resolveWindow(tx, user.tenantId, q);
      const now = new Date();
      const arrivalAt = forCheckIn && now < w.arrivalAt ? now : w.arrivalAt;
      const departureAt = w.departureAt;
      if (departureAt <= arrivalAt) throw Err.validation('departureAt', 'Departure must be after arrival');
      const rooms = await tx.room.findMany({ where: { tenantId: user.tenantId, roomTypeId: q.roomTypeId } });
      const exclude = q.excludeReservationId ? { id: { not: q.excludeReservationId } } : {};
      const stays = await tx.reservation.findMany({
        where: {
          tenantId: user.tenantId,
          roomTypeId: q.roomTypeId,
          status: { in: ACTIVE },
          arrivalAt: { lt: departureAt },
          departureAt: { gt: arrivalAt },
          ...exclude,
        },
        select: { roomId: true, arrivalAt: true, departureAt: true },
      });
      const inHouse = await tx.reservation.findMany({
        where: { tenantId: user.tenantId, roomId: { in: rooms.map((r) => r.id) }, status: 'CHECKED_IN', ...exclude },
        select: { roomId: true, departureAt: true },
      });
      const occupant = new Map(inHouse.map((r) => [r.roomId, r.departureAt]));
      const sellable = rooms.filter((r) => r.status !== 'OUT_OF_ORDER').length;
      const peak = maxConcurrent(stays.map((s) => ({ start: s.arrivalAt, end: s.departureAt })), arrivalAt, departureAt);
      rooms.sort((a, b) => a.floor - b.floor || collator.compare(a.number, b.number));
      return {
        roomTypeId: q.roomTypeId,
        forCheckIn,
        available: Math.max(0, sellable - peak),
        rooms: rooms.map((r) => {
          const booked = !isFree(
            stays.filter((s) => s.roomId === r.id).map((s) => ({ start: s.arrivalAt, end: s.departureAt })),
            arrivalAt,
            departureAt,
          );
          const occupiedUntil = occupant.get(r.id) ?? null;
          const clean = r.status === 'VACANT_CLEAN' || r.status === 'RESERVED';
          const free = r.status !== 'OUT_OF_ORDER' && !booked && !(forCheckIn && occupiedUntil);
          const reason =
            r.status === 'OUT_OF_ORDER'
              ? 'OUT_OF_ORDER'
              : occupiedUntil
                ? 'OCCUPIED'
                : booked
                  ? 'BOOKED'
                  : !clean
                    ? 'DIRTY'
                    : null;
          return {
            id: r.id,
            number: r.number,
            floor: r.floor,
            status: r.status,
            free,
            clean,
            checkInReady: free && clean && !occupiedUntil,
            occupiedUntil: occupiedUntil?.toISOString() ?? null,
            reason,
          };
        }),
      };
    });
  }

  tapeChart(user: AuthUser, from: string, to: string) {
    this.checkRange(from, to);
    return this.db.tenant(user.tenantId, async (tx) => {
      const property = await primaryProperty(tx, user.tenantId);
      const rooms = await tx.room.findMany({ where: { tenantId: user.tenantId }, include: { roomType: true } });
      rooms.sort((a, b) => a.floor - b.floor || collator.compare(a.number, b.number));
      const types = await tx.roomType.findMany({
        where: { tenantId: user.tenantId },
        orderBy: [{ sortOrder: 'asc' }, { basePriceKobo: 'asc' }],
        include: { _count: { select: { rooms: true } } },
      });
      const start = lagosStartOfDay(from);
      const end = lagosStartOfDay(addDays(to, 1));
      const rows = await tx.reservation.findMany({
        where: {
          tenantId: user.tenantId,
          status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] },
          arrivalAt: { lt: end },
          departureAt: { gt: start },
        },
        include: { guest: true, folio: { select: { id: true } } },
        orderBy: { arrivalAt: 'asc' },
      });
      const balances = await this.ledger.balances(tx, rows.map((r) => r.folio?.id).filter((x): x is string => !!x));
      const stays = rows.map((r) => ({
        reservationId: r.id,
        code: r.code,
        roomId: r.roomId,
        roomTypeId: r.roomTypeId,
        status: r.status,
        stayType: r.stayType,
        arrivalAt: r.arrivalAt.toISOString(),
        departureAt: r.departureAt.toISOString(),
        guestName: r.guest.fullName,
        vip: r.guest.vip,
        adults: r.adults,
        children: r.children,
        source: r.source,
        balanceKobo: r.folio ? (balances.get(r.folio.id) ?? 0) : 0,
        paymentMode: r.paymentMode,
        holdExpiresAt: r.status === 'PENDING' && r.paymentMode === 'ONLINE' ? (r.holdExpiresAt?.toISOString() ?? null) : null,
      }));
      return {
        from,
        to,
        today: lagosDate(),
        checkInTime: property.checkInTime,
        checkOutTime: property.checkOutTime,
        rooms: rooms.map((r) => ({
          id: r.id,
          number: r.number,
          floor: r.floor,
          status: r.status,
          roomType: { id: r.roomType.id, name: r.roomType.name },
        })),
        roomTypes: types.map((t) => ({ id: t.id, name: t.name, roomCount: t._count.rooms })),
        stays: stays.filter((s) => s.roomId),
        unassigned: stays.filter((s) => !s.roomId && ACTIVE.includes(s.status)),
      };
    });
  }

  /** kobo helper re-exported for callers that only import this service. */
  static k = k;
}
