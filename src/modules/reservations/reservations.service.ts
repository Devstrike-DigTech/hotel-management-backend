import { HttpStatus, Injectable } from '@nestjs/common';
import type { Guest, Prisma, Reservation, Room, RoomType } from '../../generated/prisma/client.js';
import type { ReservationStatus } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import {
  addDays,
  billableHours,
  diffDays,
  lagosDate,
  lagosDateTime,
  lagosStartOfDay,
  nightsBetween,
} from '../../common/time/lagos.js';
import { codePrefix, reservationCode } from '../../common/utils/codes.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { actorOf, LedgerService } from '../folios/ledger.service.js';
import { GuardService } from '../guard/guard.service.js';
import { GuestsService } from '../guests/guests.service.js';
import { HousekeepingService } from '../housekeeping/housekeeping.service.js';
import { DocumentsService } from '../invoices/documents.service.js';
import {
  appError,
  Err,
  isExclusionViolation,
  isManager,
  k,
  paginate,
  parseClientCreatedAt,
  primaryProperty,
  userNames,
} from '../ops/ops.helpers.js';
import { ACTIVE, AvailabilityService } from './availability.service.js';
import type {
  CancelDto,
  CheckInDto,
  CheckOutDto,
  CreateReservationDto,
  NoShowDto,
  PutRegistrationDto,
  ReservationQueryDto,
  UpdateReservationDto,
} from './reservations.dto.js';

const include = {
  guest: true,
  room: true,
  roomType: true,
  folio: { select: { id: true } },
} satisfies Prisma.ReservationInclude;

type ResRow = Prisma.ReservationGetPayload<{ include: typeof include }>;

const MAX_NIGHTS = 60;
const MIN_DAY_USE_MS = 2 * 3_600_000;
const MAX_DAY_USE_MS = 12 * 3_600_000;
const ALL_STATUSES: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW'];

function roomRef(r: Room | null) {
  return r ? { id: r.id, number: r.number, floor: r.floor, status: r.status } : null;
}

export function registrationComplete(r: Reservation, g: Guest): boolean {
  return missingRegistration(r, g).length === 0;
}

export function missingRegistration(
  r: Pick<Reservation, 'regArrivingFrom' | 'regGoingTo' | 'regPurpose'>,
  g: Pick<Guest, 'idType' | 'idNumberEnc'>,
): string[] {
  const missing: string[] = [];
  if (!r.regArrivingFrom) missing.push('registration.arrivingFrom');
  if (!r.regGoingTo) missing.push('registration.goingTo');
  if (!r.regPurpose) missing.push('registration.purpose');
  if (!g.idType) missing.push('guest.idType');
  if (!g.idNumberEnc) missing.push('guest.idNumber');
  return missing;
}

@Injectable()
export class ReservationsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly availability: AvailabilityService,
    private readonly ledger: LedgerService,
    private readonly guests: GuestsService,
    private readonly guard: GuardService,
    private readonly docs: DocumentsService,
    private readonly housekeeping: HousekeepingService,
  ) {}

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  listItem(r: ResRow, balance: number) {
    return {
      id: r.id,
      code: r.code,
      status: r.status,
      stayType: r.stayType,
      source: r.source,
      arrivalAt: r.arrivalAt.toISOString(),
      departureAt: r.departureAt.toISOString(),
      arrivalDate: lagosDate(r.arrivalAt),
      departureDate: lagosDate(r.departureAt),
      nights: r.stayType === 'NIGHTLY' ? nightsBetween(r.arrivalAt, r.departureAt) : null,
      hours: r.stayType === 'DAY_USE' ? billableHours(r.arrivalAt, r.departureAt) : null,
      adults: r.adults,
      children: r.children,
      rateKobo: k(r.rateKobo),
      guest: { id: r.guest.id, fullName: r.guest.fullName, phone: r.guest.phone, vip: r.guest.vip },
      roomType: { id: r.roomType.id, name: r.roomType.name },
      room: roomRef(r.room),
      folioId: r.folio?.id ?? '',
      balanceKobo: balance,
      registrationComplete: registrationComplete(r, r.guest),
      checkedInAt: r.checkedInAt?.toISOString() ?? null,
      checkedOutAt: r.checkedOutAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async listItems(tx: Tx, rows: ResRow[]) {
    const balances = await this.ledger.balances(tx, rows.map((r) => r.folio?.id).filter((x): x is string => !!x));
    return rows.map((r) => this.listItem(r, r.folio ? (balances.get(r.folio.id) ?? 0) : 0));
  }

  async detail(tx: Tx, tenantId: string, id: string) {
    const r = await this.load(tx, tenantId, id);
    const balance = r.folio ? await this.ledger.balance(tx, r.folio.id) : 0;
    const names = await userNames(tx, [r.createdById, r.registrationCompletedById]);
    const stats = await this.guests.stats(tx, [r.guestId]);
    const units = r.stayType === 'NIGHTLY' ? nightsBetween(r.arrivalAt, r.departureAt) : billableHours(r.arrivalAt, r.departureAt);
    const hasReg = r.regArrivingFrom || r.regGoingTo || r.regPurpose;
    return {
      ...this.listItem(r, balance),
      notes: r.notes,
      estimatedTotalKobo: k(r.rateKobo) * units,
      registration: hasReg
        ? {
            arrivingFrom: r.regArrivingFrom ?? '',
            goingTo: r.regGoingTo ?? '',
            purpose: r.regPurpose,
            vehiclePlate: r.regVehiclePlate,
            completedAt: r.registrationCompletedAt?.toISOString() ?? null,
            completedBy: r.registrationCompletedById
              ? { id: r.registrationCompletedById, fullName: names.get(r.registrationCompletedById) ?? 'Former staff member' }
              : null,
          }
        : null,
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
      cancelReason: r.cancelReason,
      noShowAt: r.noShowAt?.toISOString() ?? null,
      clientCreatedAt: r.clientCreatedAt?.toISOString() ?? null,
      createdBy: r.createdById ? { id: r.createdById, fullName: names.get(r.createdById) ?? 'Former staff member' } : null,
      guest: this.guests.toView(r.guest, stats.get(r.guestId)),
    };
  }

  async load(tx: Tx, tenantId: string, id: string): Promise<ResRow> {
    const r = await tx.reservation.findFirst({ where: { id, tenantId }, include });
    if (!r) throw AppException.notFound('Reservation');
    return r;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  list(user: AuthUser, q: ReservationQueryDto) {
    const pg = paginate(q.page, q.pageSize);
    const statuses = q.status?.split(',').filter((s): s is ReservationStatus => ALL_STATUSES.includes(s as ReservationStatus));
    return this.db.tenant(user.tenantId, async (tx) => {
      const digits = q.q?.replace(/\D/g, '') ?? '';
      const where: Prisma.ReservationWhereInput = {
        tenantId: user.tenantId,
        ...(statuses?.length && { status: { in: statuses } }),
        ...(q.from && { departureAt: { gt: lagosStartOfDay(q.from) } }),
        ...(q.to && { arrivalAt: { lt: lagosStartOfDay(addDays(q.to, 1)) } }),
        ...(q.roomId && { roomId: q.roomId }),
        ...(q.roomTypeId && { roomTypeId: q.roomTypeId }),
        ...(q.guestId && { guestId: q.guestId }),
        ...(q.stayType && { stayType: q.stayType }),
        ...(q.source && { source: q.source }),
        ...(q.q && {
          OR: [
            { code: { contains: q.q, mode: 'insensitive' } },
            { guest: { fullName: { contains: q.q, mode: 'insensitive' } } },
            ...(digits.length >= 4 ? [{ guest: { phone: { contains: digits.replace(/^0/, '') } } }] : []),
          ],
        }),
      };
      const rows = await tx.reservation.findMany({ where, include, orderBy: { arrivalAt: 'asc' }, skip: pg.skip, take: pg.take });
      const total = await tx.reservation.count({ where });
      return { items: await this.listItems(tx, rows), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  get(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, (tx) => this.detail(tx, user.tenantId, id));
  }

  guestWithStays(user: AuthUser, guestId: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const g = await this.guests.load(tx, user.tenantId, guestId);
      const stats = await this.guests.stats(tx, [guestId]);
      const rows = await tx.reservation.findMany({ where: { guestId }, include, orderBy: { arrivalAt: 'desc' }, take: 20 });
      return { ...this.guests.toView(g, stats.get(guestId)), stays: await this.listItems(tx, rows) };
    });
  }

  // ---------------------------------------------------------------------------
  // Create / update
  // ---------------------------------------------------------------------------

  private async window(
    tx: Tx,
    tenantId: string,
    stayType: 'NIGHTLY' | 'DAY_USE',
    input: { arrivalDate?: string; departureDate?: string; arrivalAt?: string; departureAt?: string },
    opts: { allowPastArrival?: boolean } = {},
  ) {
    const w = await this.availability.resolveWindow(tx, tenantId, { stayType, ...input });
    const now = new Date();
    if (w.departureAt <= w.arrivalAt) throw Err.validation('departureAt', 'Departure must be after arrival');
    if (stayType === 'NIGHTLY') {
      const nights = diffDays(lagosDate(w.arrivalAt), lagosDate(w.departureAt));
      if (nights < 1) throw Err.validation('departureDate', 'A nightly stay needs at least one night');
      if (nights > MAX_NIGHTS) throw Err.validation('departureDate', `A stay can be at most ${MAX_NIGHTS} nights`);
      if (!opts.allowPastArrival && lagosDate(w.arrivalAt) < addDays(lagosDate(now), -1)) {
        throw Err.validation('arrivalDate', 'Arrival cannot be in the past');
      }
    } else {
      const ms = w.departureAt.getTime() - w.arrivalAt.getTime();
      if (ms < MIN_DAY_USE_MS) throw Err.validation('departureAt', 'A day-use stay is at least 2 hours');
      if (ms > MAX_DAY_USE_MS) throw Err.validation('departureAt', 'A day-use stay is at most 12 hours; book a night instead');
      if (w.departureAt <= now) throw Err.validation('departureAt', 'The stay has already ended');
    }
    return w;
  }

  private async assertAvailable(tx: Tx, tenantId: string, w: Parameters<AvailabilityService['assertAvailable']>[2]) {
    await this.availability.assertAvailable(tx, tenantId, w);
  }

  private overlapError(roomTypeId: string, roomId: string | null) {
    return appError(HttpStatus.CONFLICT, 'ROOM_UNAVAILABLE', 'That room was just booked for an overlapping stay', {
      scope: 'ROOM',
      roomId,
      roomTypeId,
    });
  }

  /** Runs `fn` and maps a double-booking exclusion violation to ROOM_UNAVAILABLE. */
  private async guarded<T>(roomTypeId: string, roomId: string | null, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isExclusionViolation(e)) throw this.overlapError(roomTypeId, roomId);
      throw e;
    }
  }

  async create(user: AuthUser, dto: CreateReservationDto, ip?: string) {
    const stayType = dto.stayType ?? 'NIGHTLY';
    if (!dto.guestId && !dto.guest) throw Err.validation('guest', 'Give guestId or guest details');
    if (dto.rateKobo !== undefined && !isManager(user.role)) throw AppException.forbidden('Only a manager can set a custom rate');
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    return this.guarded(dto.roomTypeId, dto.roomId ?? null, () =>
      this.db.tenant(user.tenantId, async (tx) => {
        const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
        if (stayType === 'DAY_USE') await this.entitlements.assertFeature(ent, 'hourly_bookings');
        const roomType = await tx.roomType.findFirst({ where: { id: dto.roomTypeId, tenantId: user.tenantId } });
        if (!roomType) throw AppException.notFound('Room type');
        const rate = this.rateFor(roomType, stayType, dto.rateKobo);
        const w = await this.window(tx, user.tenantId, stayType, dto);
        let guest: Guest;
        if (dto.guestId) {
          guest = await this.guests.load(tx, user.tenantId, dto.guestId);
          if (guest.anonymisedAt) throw this.guests.anonymised();
        } else {
          guest = await this.guests.findOrCreateTx(tx, user.tenantId, dto.guest!);
        }
        await this.assertAvailable(tx, user.tenantId, { roomTypeId: roomType.id, roomId: dto.roomId, ...w });
        const code = await this.newCode(tx, user.tenantId);
        const r = await tx.reservation.create({
          data: {
            tenantId: user.tenantId,
            propertyId: roomType.propertyId,
            code,
            guestId: guest.id,
            roomTypeId: roomType.id,
            roomId: dto.roomId ?? null,
            stayType,
            arrivalAt: w.arrivalAt,
            departureAt: w.departureAt,
            adults: dto.adults ?? 1,
            children: dto.children ?? 0,
            source: dto.source ?? 'WALK_IN',
            status: dto.status ?? 'CONFIRMED',
            rateKobo: rate,
            notes: dto.notes ?? '',
            createdById: user.userId,
            clientCreatedAt,
          },
        });
        await tx.folio.create({
          data: { tenantId: user.tenantId, propertyId: roomType.propertyId, kind: 'RESERVATION', reservationId: r.id, guestId: guest.id, name: guest.fullName, createdById: user.userId },
        });
        await this.audit.record(tx, {
          tenantId: user.tenantId,
          actor: userActor(user),
          action: 'reservation.created',
          entityType: 'reservation',
          entityId: r.id,
          metadata: {
            code,
            guest: guest.fullName,
            stayType,
            arrivalAt: w.arrivalAt.toISOString(),
            departureAt: w.departureAt.toISOString(),
            rateKobo: rate,
            ...(clientCreatedAt && { clientCreatedAt: clientCreatedAt.toISOString() }),
          },
          ip,
        });
        return this.detail(tx, user.tenantId, r.id);
      }),
    );
  }

  private rateFor(rt: RoomType, stayType: 'NIGHTLY' | 'DAY_USE', override?: number): number {
    if (override !== undefined) return override;
    if (stayType === 'DAY_USE') {
      if (rt.hourlyPriceKobo === null) {
        throw appError(HttpStatus.BAD_REQUEST, 'NO_HOURLY_RATE', `${rt.name} has no hourly rate; set one on the room type first`, { roomTypeId: rt.id });
      }
      return rt.hourlyPriceKobo;
    }
    return rt.basePriceKobo;
  }

  private async newCode(tx: Tx, tenantId: string): Promise<string> {
    const property = await primaryProperty(tx, tenantId);
    const prefix = codePrefix(property.name);
    for (let i = 0; i < 8; i++) {
      const code = reservationCode(prefix, i < 5 ? 4 : 5);
      const clash = await tx.reservation.findFirst({ where: { tenantId, code }, select: { id: true } });
      if (!clash) return code;
    }
    throw new Error('Could not generate a unique reservation code');
  }

  async update(user: AuthUser, id: string, dto: UpdateReservationDto, ip?: string) {
    if (dto.rateKobo !== undefined && !isManager(user.role)) throw AppException.forbidden('Only a manager can set a custom rate');
    return this.db
      .tenant(user.tenantId, async (tx) => {
        const r = await this.load(tx, user.tenantId, id);
        const inHouse = r.status === 'CHECKED_IN';
        if (!['PENDING', 'CONFIRMED', 'CHECKED_IN'].includes(r.status)) {
          throw Err.invalidState(r.status, ['PENDING', 'CONFIRMED', 'CHECKED_IN'], 'This reservation');
        }
        if (inHouse && (dto.arrivalDate || dto.arrivalAt || dto.roomTypeId || dto.roomId !== undefined || dto.source || dto.rateKobo !== undefined)) {
          throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'For a guest in house you can only change the departure, guests and notes (use move-room to change rooms)', {
            status: r.status,
            allowed: ['PENDING', 'CONFIRMED'],
          });
        }
        const dateChange = dto.arrivalDate || dto.departureDate || dto.arrivalAt || dto.departureAt;
        let arrivalAt = r.arrivalAt;
        let departureAt = r.departureAt;
        if (dateChange) {
          const w = await this.window(
            tx,
            user.tenantId,
            r.stayType,
            r.stayType === 'NIGHTLY'
              ? { arrivalDate: dto.arrivalDate ?? lagosDate(r.arrivalAt), departureDate: dto.departureDate ?? lagosDate(r.departureAt) }
              : { arrivalAt: dto.arrivalAt ?? r.arrivalAt.toISOString(), departureAt: dto.departureAt ?? r.departureAt.toISOString() },
            { allowPastArrival: inHouse },
          );
          departureAt = w.departureAt;
          arrivalAt = inHouse ? r.arrivalAt : w.arrivalAt;
          if (inHouse && departureAt <= new Date()) throw Err.validation('departureDate', 'The new departure is already in the past');
        }
        const roomTypeId = dto.roomTypeId ?? r.roomTypeId;
        const roomId = dto.roomId === undefined ? (dto.roomTypeId && dto.roomTypeId !== r.roomTypeId ? null : r.roomId) : dto.roomId;
        const needsCheck = dateChange || roomTypeId !== r.roomTypeId || roomId !== r.roomId;
        if (roomTypeId !== r.roomTypeId) {
          const rt = await tx.roomType.findFirst({ where: { id: roomTypeId, tenantId: user.tenantId } });
          if (!rt) throw AppException.notFound('Room type');
        }
        if (needsCheck) {
          await this.assertAvailable(tx, user.tenantId, { roomTypeId, roomId, arrivalAt, departureAt, excludeReservationId: r.id });
        }
        await tx.reservation.update({
          where: { id },
          data: {
            arrivalAt,
            departureAt,
            roomTypeId,
            roomId,
            ...(dto.adults !== undefined && { adults: dto.adults }),
            ...(dto.children !== undefined && { children: dto.children }),
            ...(dto.source !== undefined && { source: dto.source }),
            ...(dto.notes !== undefined && { notes: dto.notes }),
            ...(dto.rateKobo !== undefined && { rateKobo: dto.rateKobo }),
          },
        });
        await this.audit.record(tx, {
          tenantId: user.tenantId,
          actor: userActor(user),
          action: 'reservation.updated',
          entityType: 'reservation',
          entityId: id,
          metadata: {
            code: r.code,
            changes: Object.keys(dto),
            before: { arrivalAt: r.arrivalAt.toISOString(), departureAt: r.departureAt.toISOString(), roomId: r.roomId },
            after: { arrivalAt: arrivalAt.toISOString(), departureAt: departureAt.toISOString(), roomId },
          },
          ip,
        });
        return this.detail(tx, user.tenantId, id);
      })
      .catch((e) => {
        if (isExclusionViolation(e)) throw this.overlapError(dto.roomTypeId ?? '', dto.roomId ?? null);
        throw e;
      });
  }

  confirm(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const r = await this.load(tx, user.tenantId, id);
      if (r.status !== 'PENDING') throw Err.invalidState(r.status, ['PENDING'], 'This reservation');
      await tx.reservation.update({ where: { id }, data: { status: 'CONFIRMED' } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'reservation.confirmed', entityType: 'reservation', entityId: id, metadata: { code: r.code }, ip });
      return this.detail(tx, user.tenantId, id);
    });
  }

  cancel(user: AuthUser, id: string, dto: CancelDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const r = await this.load(tx, user.tenantId, id);
      if (r.status !== 'PENDING' && r.status !== 'CONFIRMED') throw Err.invalidState(r.status, ['PENDING', 'CONFIRMED'], 'This reservation');
      await tx.reservation.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: dto.reason } });
      if (dto.feeKobo && r.folio) {
        const folio = await this.docs.loadFolio(tx, user.tenantId, r.folio.id);
        await this.ledger.postCharge(tx, user.tenantId, folio, { type: 'EXTRA', description: `Cancellation fee (${r.code})`, amountKobo: dto.feeKobo }, actorOf(user));
      }
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'reservation.cancelled',
        entityType: 'reservation',
        entityId: id,
        metadata: { code: r.code, reason: dto.reason, feeKobo: dto.feeKobo ?? 0 },
        ip,
      });
      return this.detail(tx, user.tenantId, id);
    });
  }

  noShow(user: AuthUser, id: string, dto: NoShowDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const r = await this.load(tx, user.tenantId, id);
      if (r.status !== 'PENDING' && r.status !== 'CONFIRMED') throw Err.invalidState(r.status, ['PENDING', 'CONFIRMED'], 'This reservation');
      if (lagosDate(r.arrivalAt) > lagosDate()) throw AppException.badRequest('A guest can only be marked no-show on or after the arrival date');
      await tx.reservation.update({ where: { id }, data: { status: 'NO_SHOW', noShowAt: new Date(), cancelReason: dto.reason ?? null } });
      if (dto.feeKobo && r.folio) {
        const folio = await this.docs.loadFolio(tx, user.tenantId, r.folio.id);
        await this.ledger.postCharge(tx, user.tenantId, folio, { type: 'EXTRA', description: `No-show fee (${r.code})`, amountKobo: dto.feeKobo }, actorOf(user));
      }
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'reservation.no_show',
        entityType: 'reservation',
        entityId: id,
        metadata: { code: r.code, reason: dto.reason ?? null, feeKobo: dto.feeKobo ?? 0 },
        ip,
      });
      return this.detail(tx, user.tenantId, id);
    });
  }

  // ---------------------------------------------------------------------------
  // Check-in
  // ---------------------------------------------------------------------------

  async checkIn(user: AuthUser, id: string, dto: CheckInDto, ip?: string) {
    if (dto.override && !isManager(user.role)) throw AppException.forbidden('Only a manager can override the clean-room rule');
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    let roomTypeForError = '';
    try {
      return await this.db.tenant(user.tenantId, async (tx) => {
        const r = await this.load(tx, user.tenantId, id);
        roomTypeForError = r.roomTypeId;
        if (r.status !== 'PENDING' && r.status !== 'CONFIRMED') throw Err.invalidState(r.status, ['PENDING', 'CONFIRMED'], 'This reservation');
        const now = new Date();
        const today = lagosDate(now);
        const arrivalDate = lagosDate(r.arrivalAt);
        const departureDate = lagosDate(r.departureAt);
        const dateOk = r.stayType === 'DAY_USE' ? today === arrivalDate : today >= arrivalDate && today < departureDate;
        if (!dateOk) {
          throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', `This stay is for ${arrivalDate}; it cannot be checked in today`, {
            status: r.status,
            allowed: ['PENDING', 'CONFIRMED'],
          });
        }
        if (r.stayType === 'DAY_USE' && r.departureAt <= now) throw AppException.badRequest('The booked day-use time has already ended');

        // Guest details from the register card.
        let guest = r.guest;
        if (guest.anonymisedAt) throw this.guests.anonymised();
        if (dto.guest) guest = await this.guests.updateTx(tx, user.tenantId, guest, dto.guest);
        const reg = {
          regArrivingFrom: dto.registration?.arrivingFrom ?? r.regArrivingFrom,
          regGoingTo: dto.registration?.goingTo ?? r.regGoingTo,
          regPurpose: dto.registration?.purpose ?? r.regPurpose,
          regVehiclePlate: dto.registration?.vehiclePlate ?? r.regVehiclePlate,
        };
        const missing = missingRegistration(reg, guest);
        if (missing.length && !dto.registerLater) {
          throw appError(HttpStatus.BAD_REQUEST, 'REGISTRATION_INCOMPLETE', 'Complete the guest register before check-in, or choose to register later', { missing });
        }

        // Room.
        const roomId = dto.roomId ?? r.roomId;
        if (!roomId) throw Err.validation('roomId', 'Assign a room to check in');
        const room = await tx.room.findFirst({ where: { id: roomId, tenantId: user.tenantId } });
        if (!room) throw AppException.notFound('Room');
        if (room.roomTypeId !== r.roomTypeId) throw AppException.badRequest('The room is not of the booked room type; change the booking first');
        if (room.status === 'OCCUPIED' || room.status === 'OUT_OF_ORDER') {
          throw appError(HttpStatus.CONFLICT, 'ROOM_UNAVAILABLE', `Room ${room.number} is ${room.status === 'OCCUPIED' ? 'occupied' : 'out of order'}`, {
            scope: 'ROOM',
            roomId: room.id,
            roomTypeId: r.roomTypeId,
          });
        }
        let overridden = false;
        if (room.status === 'VACANT_DIRTY') {
          if (!dto.override) {
            throw appError(HttpStatus.CONFLICT, 'ROOM_NOT_CLEAN', `Room ${room.number} has not been cleaned yet`, { roomId: room.id, status: room.status });
          }
          overridden = true;
        }
        const arrivalAt = now < r.arrivalAt ? now : r.arrivalAt;
        if (roomId !== r.roomId || arrivalAt.getTime() !== r.arrivalAt.getTime()) {
          await this.assertAvailable(tx, user.tenantId, {
            roomTypeId: r.roomTypeId,
            roomId,
            arrivalAt,
            departureAt: r.departureAt,
            excludeReservationId: r.id,
          });
        }
        await tx.reservation.update({
          where: { id },
          data: {
            ...reg,
            roomId,
            arrivalAt,
            status: 'CHECKED_IN',
            checkedInAt: now,
            checkedInById: user.userId,
            ...(missing.length === 0 && { registrationCompletedAt: now, registrationCompletedById: user.userId }),
          },
        });
        await tx.room.update({ where: { id: roomId }, data: { status: 'OCCUPIED' } });

        // First night (or the whole day-use block).
        const folio = await this.docs.loadFolio(tx, user.tenantId, r.folio!.id);
        if (folio.name !== guest.fullName) await tx.folio.update({ where: { id: folio.id }, data: { name: guest.fullName, guestId: guest.id } });
        const rate = k(r.rateKobo);
        if (r.stayType === 'NIGHTLY') {
          await this.ledger.postCharge(
            tx,
            user.tenantId,
            folio,
            { type: 'ROOM', description: `Room ${room.number}, night of ${arrivalDate}`, amountKobo: rate, businessDate: arrivalDate, clientCreatedAt },
            actorOf(user),
          );
        } else {
          const hours = billableHours(arrivalAt, r.departureAt);
          await this.ledger.postCharge(
            tx,
            user.tenantId,
            folio,
            { type: 'DAY_USE', description: `Day use, room ${room.number}, ${hours} h`, amountKobo: rate * hours, businessDate: today, clientCreatedAt },
            actorOf(user),
          );
        }
        if (dto.deposit) {
          if (!['CASH', 'TRANSFER', 'POS'].includes(dto.deposit.method) && !isManager(user.role)) {
            throw AppException.forbidden('Only a manager can record that payment method');
          }
          const fresh = await this.docs.loadFolio(tx, user.tenantId, folio.id);
          await this.ledger.postPayment(
            tx,
            user.tenantId,
            fresh,
            { method: dto.deposit.method, amountKobo: dto.deposit.amountKobo, reference: dto.deposit.reference, note: 'Deposit at check-in', clientCreatedAt },
            actorOf(user),
          );
        }
        if (overridden) {
          const features = await this.guard.features(tx, user.tenantId);
          await this.guard.raise(tx, user.tenantId, features, {
            rule: 'DIRTY_OVERRIDE_CHECKIN',
            title: `${r.code} checked in to dirty room ${room.number}`,
            detail: `${user.fullName} overrode the clean-room rule. Reason: ${dto.override!.reason}`,
            dedupeKey: `DIRTY_OVERRIDE_CHECKIN:${r.id}`,
            reservationId: r.id,
            roomId: room.id,
            userId: user.userId,
            userName: user.fullName,
            evidence: { roomStatus: room.status, reason: dto.override!.reason },
          });
        }
        await this.audit.record(tx, {
          tenantId: user.tenantId,
          actor: userActor(user),
          action: 'reservation.checked_in',
          entityType: 'reservation',
          entityId: id,
          metadata: {
            code: r.code,
            room: room.number,
            registrationComplete: missing.length === 0,
            ...(overridden && { override: dto.override!.reason, roomStatus: room.status }),
            ...(dto.deposit && { depositKobo: dto.deposit.amountKobo, depositMethod: dto.deposit.method }),
            ...(clientCreatedAt && { clientCreatedAt: clientCreatedAt.toISOString() }),
          },
          ip,
        });
        return this.detail(tx, user.tenantId, id);
      });
    } catch (e) {
      if (isExclusionViolation(e)) throw this.overlapError(roomTypeForError, dto.roomId ?? null);
      throw e;
    }
  }

  putRegistration(user: AuthUser, id: string, dto: PutRegistrationDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const r = await this.load(tx, user.tenantId, id);
      if (!['PENDING', 'CONFIRMED', 'CHECKED_IN'].includes(r.status)) {
        throw Err.invalidState(r.status, ['PENDING', 'CONFIRMED', 'CHECKED_IN'], 'This reservation');
      }
      let guest = r.guest;
      if (dto.guest) guest = await this.guests.updateTx(tx, user.tenantId, guest, dto.guest);
      const reg = { regArrivingFrom: dto.arrivingFrom, regGoingTo: dto.goingTo, regPurpose: dto.purpose, regVehiclePlate: dto.vehiclePlate ?? r.regVehiclePlate };
      const complete = missingRegistration(reg, guest).length === 0;
      await tx.reservation.update({
        where: { id },
        data: {
          ...reg,
          ...(complete && !r.registrationCompletedAt && r.status === 'CHECKED_IN' && { registrationCompletedAt: new Date(), registrationCompletedById: user.userId }),
        },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'reservation.registration_updated',
        entityType: 'reservation',
        entityId: id,
        metadata: { code: r.code, complete },
        ip,
      });
      return this.detail(tx, user.tenantId, id);
    });
  }

  // ---------------------------------------------------------------------------
  // Check-out
  // ---------------------------------------------------------------------------

  checkOut(user: AuthUser, id: string, dto: CheckOutDto, ip?: string) {
    if (dto.override && !isManager(user.role)) throw AppException.forbidden('Only a manager can check a guest out with a balance');
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    return this.db.tenant(user.tenantId, async (tx) => {
      const r = await this.load(tx, user.tenantId, id);
      if (r.status !== 'CHECKED_IN') throw Err.invalidState(r.status, ['CHECKED_IN'], 'This reservation');
      const folio = await this.docs.loadFolio(tx, user.tenantId, r.folio!.id);
      const balance = await this.ledger.balance(tx, folio.id);
      const features = await this.guard.features(tx, user.tenantId);
      if (balance < 0 || (balance > 0 && !dto.override)) {
        throw appError(
          HttpStatus.CONFLICT,
          'BALANCE_OUTSTANDING',
          balance > 0 ? 'The guest still owes money on this folio' : 'The guest is in credit; record a refund first',
          { balanceKobo: balance },
        );
      }
      if (balance > 0) {
        await this.ledger.postPayment(
          tx,
          user.tenantId,
          folio,
          { method: 'CITY_LEDGER', amountKobo: balance, note: dto.override!.reason, receipt: false, clientCreatedAt },
          actorOf(user),
        );
        await this.guard.raise(tx, user.tenantId, features, {
          rule: 'CHECKOUT_WITH_BALANCE',
          title: `${r.code} checked out owing ₦${(balance / 100).toLocaleString('en-NG')}`,
          detail: `${user.fullName} checked ${r.guest.fullName} out with an unpaid balance moved to the city ledger. Reason: ${dto.override!.reason}`,
          dedupeKey: `CHECKOUT_WITH_BALANCE:${r.id}`,
          amountKobo: balance,
          reservationId: r.id,
          roomId: r.roomId,
          userId: user.userId,
          userName: user.fullName,
          evidence: { balanceKobo: balance, reason: dto.override!.reason },
        });
      }
      const now = new Date();
      const departureAt = now < r.departureAt ? new Date(Math.max(now.getTime(), r.arrivalAt.getTime() + 1000)) : r.departureAt;
      await tx.reservation.update({
        where: { id },
        data: { status: 'CHECKED_OUT', checkedOutAt: now, checkedOutById: user.userId, departureAt },
      });
      if (r.roomId) {
        await tx.room.update({ where: { id: r.roomId }, data: { status: 'VACANT_DIRTY' } });
        await this.housekeeping.createTask(tx, user.tenantId, features, { roomId: r.roomId, reason: 'CHECKOUT', reservationId: r.id });
      }
      await tx.folio.update({ where: { id: folio.id }, data: { status: 'CLOSED', closedAt: now } });
      const invoice = await this.docs.issueInvoice(tx, user.tenantId, folio.id, 'FINAL', { id: user.userId, fullName: user.fullName });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'reservation.checked_out',
        entityType: 'reservation',
        entityId: id,
        metadata: {
          code: r.code,
          room: r.room?.number ?? null,
          invoiceNumber: invoice.number,
          early: now < r.departureAt,
          ...(balance > 0 && { cityLedgerKobo: balance, override: dto.override!.reason }),
          ...(clientCreatedAt && { clientCreatedAt: clientCreatedAt.toISOString() }),
        },
        ip,
      });
      return { reservation: await this.detail(tx, user.tenantId, id), invoice };
    });
  }

  // ---------------------------------------------------------------------------
  // Room move and day-use conversion
  // ---------------------------------------------------------------------------

  async moveRoom(user: AuthUser, id: string, roomId: string, reason: string | undefined, ip?: string) {
    try {
      return await this.db.tenant(user.tenantId, async (tx) => {
        const r = await this.load(tx, user.tenantId, id);
        if (r.status !== 'CHECKED_IN') throw Err.invalidState(r.status, ['CHECKED_IN'], 'This reservation');
        if (roomId === r.roomId) throw AppException.badRequest('The guest is already in that room');
        const room = await tx.room.findFirst({ where: { id: roomId, tenantId: user.tenantId } });
        if (!room) throw AppException.notFound('Room');
        if (room.status === 'OCCUPIED' || room.status === 'OUT_OF_ORDER') {
          throw appError(HttpStatus.CONFLICT, 'ROOM_UNAVAILABLE', `Room ${room.number} is not available`, { scope: 'ROOM', roomId, roomTypeId: room.roomTypeId });
        }
        if (room.status === 'VACANT_DIRTY') {
          throw appError(HttpStatus.CONFLICT, 'ROOM_NOT_CLEAN', `Room ${room.number} has not been cleaned yet`, { roomId, status: room.status });
        }
        await this.assertAvailable(tx, user.tenantId, {
          roomTypeId: room.roomTypeId,
          roomId,
          arrivalAt: r.arrivalAt,
          departureAt: r.departureAt,
          excludeReservationId: r.id,
        });
        await tx.reservation.update({ where: { id }, data: { roomId, roomTypeId: room.roomTypeId } });
        const features = await this.guard.features(tx, user.tenantId);
        if (r.roomId) {
          await tx.room.update({ where: { id: r.roomId }, data: { status: 'VACANT_DIRTY' } });
          await this.housekeeping.createTask(tx, user.tenantId, features, { roomId: r.roomId, reason: 'ROOM_MOVE', reservationId: r.id });
        }
        await tx.room.update({ where: { id: roomId }, data: { status: 'OCCUPIED' } });
        await this.audit.record(tx, {
          tenantId: user.tenantId,
          actor: userActor(user),
          action: 'reservation.room_moved',
          entityType: 'reservation',
          entityId: id,
          metadata: { code: r.code, from: r.room?.number ?? null, to: room.number, reason: reason ?? null },
          ip,
        });
        return this.detail(tx, user.tenantId, id);
      });
    } catch (e) {
      if (isExclusionViolation(e)) throw this.overlapError('', roomId);
      throw e;
    }
  }

  async convertToNightly(user: AuthUser, id: string, departureDate: string | undefined, ip?: string) {
    try {
      return await this.db.tenant(user.tenantId, async (tx) => {
        const r = await this.load(tx, user.tenantId, id);
        if (r.status !== 'CHECKED_IN' || r.stayType !== 'DAY_USE') {
          throw Err.invalidState(r.status, ['CHECKED_IN'], 'Only a checked-in day-use stay');
        }
        const property = await primaryProperty(tx, user.tenantId);
        const today = lagosDate();
        const dep = departureDate ?? addDays(today, 1);
        if (dep <= today) throw Err.validation('departureDate', 'Departure must be after today');
        if (diffDays(today, dep) > MAX_NIGHTS) throw Err.validation('departureDate', `At most ${MAX_NIGHTS} nights`);
        const departureAt = lagosDateTime(dep, property.checkOutTime);
        await this.assertAvailable(tx, user.tenantId, {
          roomTypeId: r.roomTypeId,
          roomId: r.roomId,
          arrivalAt: r.arrivalAt,
          departureAt,
          excludeReservationId: r.id,
        });
        const rate = r.roomType.basePriceKobo;
        await tx.reservation.update({ where: { id }, data: { stayType: 'NIGHTLY', departureAt, rateKobo: rate } });
        const folio = await this.docs.loadFolio(tx, user.tenantId, r.folio!.id);
        await this.ledger.postCharge(
          tx,
          user.tenantId,
          folio,
          { type: 'ROOM', description: `Room ${r.room?.number ?? ''}, night of ${today} (converted from day use)`, amountKobo: rate, businessDate: today },
          actorOf(user),
        );
        await this.audit.record(tx, {
          tenantId: user.tenantId,
          actor: userActor(user),
          action: 'reservation.converted_to_nightly',
          entityType: 'reservation',
          entityId: id,
          metadata: { code: r.code, departureDate: dep, rateKobo: rate },
          ip,
        });
        return this.detail(tx, user.tenantId, id);
      });
    } catch (e) {
      if (isExclusionViolation(e)) throw this.overlapError('', null);
      throw e;
    }
  }

  /** Statuses that hold inventory (for other modules). */
  static readonly ACTIVE = ACTIVE;
}
