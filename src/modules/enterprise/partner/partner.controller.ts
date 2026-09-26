import { partnerRequest } from '../../concierge/requests.service.js';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { RoomStatus } from '../../../generated/prisma/enums.js';
import type { AuthUser } from '../../../common/auth-types.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { runInProperty, withProperties } from '../../../common/property-scope.js';
import { Public } from '../../../common/decorators/index.js';
import { addDays, dateRange, diffDays, isIsoDate, lagosDate, lagosDateTime, lagosStartOfDay } from '../../../common/time/lagos.js';
import { DbService, type Tx } from '../../../prisma/db.service.js';
import { LedgerService } from '../../folios/ledger.service.js';
import { HousekeepingService } from '../../housekeeping/housekeeping.service.js';
import { Err } from '../../ops/ops.helpers.js';
import { freeRoomsOverWindow, loadCapacity } from '../../rates/capacity.js';
import { resolveNights } from '../../rates/rates.logic.js';
import { RatesService } from '../../rates/rates.service.js';
import { ReportsService } from '../../reports/reports.service.js';
import { nightlyOf, reservationInclude, ReservationsService, type ResRow } from '../../reservations/reservations.service.js';
import { stayPartnerExtras } from '../../../common/stay-hooks.js';
import { AddOnsService } from '../../extras/addons.service.js';
import { publicPickupPoint } from '../../site/theme.service.js';
import { RoomsService } from '../../rooms/rooms.service.js';
import { decodeCursor, encodeCursor } from '../api-keys/api-keys.logic.js';
import { WebhooksService } from '../webhooks/webhooks.service.js';
import { PartnerGuard, PartnerInterceptor, PartnerScope, type PartnerContext, type PartnerRequest } from './partner-auth.js';
import { pDailyStats, pGuest, pProperty, pRateSource, pReservation, pRoom, pRoomType, pTask, type ReservationLike } from './partner.mappers.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_NIGHTS = 180;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export class PageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(200) cursor?: string;
}

export class PropertyFilterDto extends PageQueryDto {
  @IsOptional() @IsUUID() propertyId?: string;
}

export class RoomsQueryDto extends PropertyFilterDto {
  @IsOptional() @IsIn(Object.values(RoomStatus)) status?: RoomStatus;
  @IsOptional() @IsUUID() roomTypeId?: string;
}

export class RangeQueryDto {
  @IsUUID() propertyId!: string;
  @Matches(DATE) from!: string;
  @Matches(DATE) to!: string;
  @IsOptional() @IsUUID() roomTypeId?: string;
  @IsOptional() @IsString() @MaxLength(60) ratePlanId?: string;
}

export class ReservationsQueryDto extends PropertyFilterDto {
  @IsOptional() @IsIn(['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW']) status?: string;
  @IsOptional() @Matches(DATE) arrivalFrom?: string;
  @IsOptional() @Matches(DATE) arrivalTo?: string;
  @IsOptional() @IsISO8601() updatedSince?: string;
}

export class GuestsQueryDto extends PageQueryDto {
  @IsOptional() @IsISO8601() updatedSince?: string;
}

export class TasksQueryDto extends PropertyFilterDto {
  @IsOptional() @IsIn(['OPEN', 'IN_PROGRESS', 'DONE', 'ASSIGNED', 'INSPECTED', 'REJECTED', 'SKIPPED']) status?: string;
  @IsOptional() @Matches(DATE) date?: string;
}

export class TransfersQueryDto extends PropertyFilterDto {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsIn(['REQUESTED', 'CONFIRMED', 'DRIVER_ASSIGNED', 'EN_ROUTE', 'PICKED_UP', 'COMPLETED', 'NO_SHOW', 'CANCELLED']) status?: string;
}

export class ConciergeQueryDto extends PropertyFilterDto {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsIn(['NEW', 'QUOTED', 'AWAITING_GUEST', 'CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'CANCELLED']) status?: string;
}

export class DailyQueryDto {
  @IsUUID() propertyId!: string;
  @IsOptional() @Matches(DATE) date?: string;
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
}

export class RoomStatusDto {
  @IsIn(Object.values(RoomStatus)) status!: RoomStatus;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class PutOverrideDto {
  @IsUUID() propertyId!: string;
  @IsUUID() roomTypeId!: string;
  @IsOptional() @IsString() @MaxLength(60) ratePlanId?: string;
  @Matches(DATE) from!: string;
  @Matches(DATE) to!: string;
  @IsInt() @Min(0) @Max(10_000_000_000) rateKobo!: number;
}

export class DeleteOverridesQueryDto {
  @IsUUID() propertyId!: string;
  @IsUUID() roomTypeId!: string;
  @Matches(DATE) from!: string;
  @Matches(DATE) to!: string;
}

class PartnerGuestDto {
  @IsString() @Length(2, 120) fullName!: string;
  @IsString() @Length(7, 24) phone!: string;
  @IsOptional() @IsEmail() @MaxLength(160) email?: string;
}

export class CreatePartnerReservationDto {
  @IsUUID() propertyId!: string;
  @IsUUID() roomTypeId!: string;
  @Matches(DATE) arrivalDate!: string;
  @Matches(DATE) departureDate!: string;
  @IsInt() @Min(1) @Max(10) adults!: number;
  @IsOptional() @IsInt() @Min(0) @Max(10) children?: number;
  @IsOptional() @IsUUID() ratePlanId?: string;
  @ValidateNested() @Type(() => PartnerGuestDto) guest!: PartnerGuestDto;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsString() @MaxLength(120) externalRef?: string;
}

export class UpdatePartnerReservationDto {
  @IsOptional() @Matches(DATE) arrivalDate?: string;
  @IsOptional() @Matches(DATE) departureDate?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10) adults?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10) children?: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(120) externalRef?: string | null;
}

export class CancelPartnerReservationDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class CompleteTaskDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class PartnerWebhookDto {
  @IsOptional() @IsString() @MaxLength(2000) url?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) events?: string[];
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsArray() @IsUUID('all', { each: true }) propertyIds?: string[] | null;
  @IsOptional() @IsIn(['ACTIVE', 'DISABLED']) status?: 'ACTIVE' | 'DISABLED';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function limitOf(q: PageQueryDto): number {
  return q.limit ?? 50;
}

/** Keyset condition after a cursor, for any model ordered by (createdAt, id). */
function cursorWhere(cursor: string | undefined): Record<string, never> {
  if (!cursor) return {};
  const c = decodeCursor(cursor);
  if (!c) throw Err.validation('cursor', 'Invalid cursor');
  return { OR: [{ createdAt: { gt: c.createdAt } }, { createdAt: c.createdAt, id: { gt: c.id } }] } as unknown as Record<string, never>;
}

function page<T extends { createdAt: Date; id: string }, V>(rows: T[], limit: number, map: (r: T) => V) {
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { data: items.map(map), pagination: { nextCursor: more && last ? encodeCursor(last.createdAt, last.id) : null, limit } };
}

function checkRange(from: string, to: string, max: number) {
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw Err.validation('to', 'Give a valid range: from <= to (YYYY-MM-DD)');
  if (diffDays(from, to) + 1 > max) throw Err.validation('to', `At most ${max} nights at once`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The partner API (M6): a versioned resource API over the hotel data for
 * integrations. Authentication, scopes, rate limits, dry-run and the
 * `{ data }` envelope live in PartnerGuard / PartnerInterceptor.
 */
@ApiExcludeController()
@Public()
@UseGuards(PartnerGuard)
@UseInterceptors(PartnerInterceptor)
@Controller('api/partner/v1')
export class PartnerController {
  constructor(
    private readonly db: DbService,
    private readonly reservations: ReservationsService,
    private readonly addOns: AddOnsService,
    private readonly rooms: RoomsService,
    private readonly rates: RatesService,
    private readonly housekeeping: HousekeepingService,
    private readonly reports: ReportsService,
    private readonly ledger: LedgerService,
    private readonly webhooks: WebhooksService,
  ) {}

  private ctx(req: PartnerRequest): { p: PartnerContext; u: AuthUser } {
    return { p: req.partner!, u: req.user! };
  }

  /** 403 when the key may not see the property, 404 when it is not the tenant's. */
  private async assertProperty(p: PartnerContext, propertyId: string) {
    if (p.propertyIds.includes(propertyId)) return;
    const exists = await this.db.tenant(p.tenantId, (tx) =>
      this.db.withAllProperties(p.tenantId, () => tx.property.count({ where: { id: propertyId, tenantId: p.tenantId } })),
    );
    if (!exists) throw AppException.notFound('Property');
    throw new AppException(HttpStatus.FORBIDDEN, 'PROPERTY_ACCESS_DENIED', 'This API key may not access this property', { propertyId });
  }

  private scoped<T>(p: PartnerContext, propertyId: string | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const ids = propertyId ? [propertyId] : p.propertyIds;
    return withProperties(p.tenantId, ids, () => this.db.tenant(p.tenantId, fn));
  }

  private setDryRunMap(req: PartnerRequest, fn: (v: unknown) => unknown) {
    (req as PartnerRequest & { partnerDryRunMap?: (v: unknown) => unknown }).partnerDryRunMap = fn;
  }

  // ---- key --------------------------------------------------------------------

  @Get('me')
  me(@Req() req: PartnerRequest) {
    const { p } = this.ctx(req);
    return {
      keyId: p.keyId,
      name: p.name,
      environment: p.environment,
      scopes: p.scopes,
      propertyIds: p.restricted ? p.propertyIds : null,
      tenant: { id: p.tenantId, name: p.tenantName },
    };
  }

  // ---- properties & room types ---------------------------------------------------

  @Get('properties')
  async properties(@Req() req: PartnerRequest, @Query() q: PageQueryDto) {
    const { p } = this.ctx(req);
    const rows = await this.scoped(p, undefined, (tx) =>
      tx.property.findMany({ where: { tenantId: p.tenantId, id: { in: p.propertyIds }, ...cursorWhere(q.cursor) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limitOf(q) + 1 }),
    );
    return page(rows, limitOf(q), pProperty);
  }

  @Get('properties/:id')
  async property(@Req() req: PartnerRequest, @Param('id') id: string) {
    const { p } = this.ctx(req);
    if (!UUID.test(id)) throw AppException.notFound('Property');
    await this.assertProperty(p, id);
    const row = await this.scoped(p, id, (tx) => tx.property.findFirst({ where: { id, tenantId: p.tenantId } }));
    if (!row) throw AppException.notFound('Property');
    return pProperty(row);
  }

  @Get('room-types')
  async roomTypes(@Req() req: PartnerRequest, @Query() q: PropertyFilterDto) {
    const { p } = this.ctx(req);
    if (q.propertyId) await this.assertProperty(p, q.propertyId);
    const rows = await this.scoped(p, q.propertyId, async (tx) => {
      const types = await tx.roomType.findMany({ where: { tenantId: p.tenantId, ...cursorWhere(q.cursor) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limitOf(q) + 1 });
      const counts = await tx.room.groupBy({ by: ['roomTypeId'], where: { tenantId: p.tenantId, roomTypeId: { in: types.map((t) => t.id) } }, _count: { _all: true } });
      const byType = new Map(counts.map((c) => [c.roomTypeId, c._count._all]));
      return types.map((t) => Object.assign(t, { roomCount: byType.get(t.id) ?? 0 }));
    });
    return page(rows, limitOf(q), (t) => pRoomType(t, t.roomCount));
  }

  @Get('room-types/:id')
  async roomType(@Req() req: PartnerRequest, @Param('id') id: string) {
    const { p } = this.ctx(req);
    if (!UUID.test(id)) throw AppException.notFound('Room type');
    const t = await this.scoped(p, undefined, async (tx) => {
      const t = await tx.roomType.findFirst({ where: { id, tenantId: p.tenantId } });
      if (!t) throw AppException.notFound('Room type');
      return { t, n: await tx.room.count({ where: { tenantId: p.tenantId, roomTypeId: id } }) };
    });
    return pRoomType(t.t, t.n);
  }

  // ---- rooms ----------------------------------------------------------------------

  @Get('rooms')
  @PartnerScope('rooms:read')
  async roomList(@Req() req: PartnerRequest, @Query() q: RoomsQueryDto) {
    const { p } = this.ctx(req);
    if (q.propertyId) await this.assertProperty(p, q.propertyId);
    const rows = await this.scoped(p, q.propertyId, (tx) =>
      tx.room.findMany({
        where: { tenantId: p.tenantId, ...(q.status && { status: q.status }), ...(q.roomTypeId && { roomTypeId: q.roomTypeId }), ...cursorWhere(q.cursor) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limitOf(q) + 1,
      }),
    );
    return page(rows, limitOf(q), pRoom);
  }

  private async loadRoom(p: PartnerContext, id: string) {
    if (!UUID.test(id)) throw AppException.notFound('Room');
    const r = await this.scoped(p, undefined, (tx) => tx.room.findFirst({ where: { id, tenantId: p.tenantId } }));
    if (!r) throw AppException.notFound('Room');
    return r;
  }

  @Get('rooms/:id')
  @PartnerScope('rooms:read')
  async room(@Req() req: PartnerRequest, @Param('id') id: string) {
    return pRoom(await this.loadRoom(this.ctx(req).p, id));
  }

  @Patch('rooms/:id/status')
  @PartnerScope('rooms:write')
  async roomStatus(@Req() req: PartnerRequest, @Param('id') id: string, @Body() dto: RoomStatusDto) {
    const { p, u } = this.ctx(req);
    const room = await this.loadRoom(p, id);
    this.setDryRunMap(req, () => pRoom({ ...room, status: dto.status, updatedAt: new Date() }));
    await runInProperty(p.tenantId, room.propertyId, () => this.rooms.setStatus(u, id, { status: dto.status, note: dto.note }, req.ip));
    return pRoom(await this.loadRoom(p, id));
  }

  // ---- availability & rates -----------------------------------------------------------

  @Get('availability')
  @PartnerScope('availability:read')
  async availability(@Req() req: PartnerRequest, @Query() q: RangeQueryDto) {
    const { p } = this.ctx(req);
    checkRange(q.from, q.to, MAX_RANGE_NIGHTS);
    await this.assertProperty(p, q.propertyId);
    return this.scoped(p, q.propertyId, async (tx) => {
      const prop = await tx.property.findFirstOrThrow({ where: { id: q.propertyId } });
      const types = await tx.roomType.findMany({ where: { tenantId: p.tenantId, ...(q.roomTypeId && { id: q.roomTypeId }) }, orderBy: { createdAt: 'asc' } });
      const ids = types.map((t) => t.id);
      if (!ids.length) return [];
      const start = lagosDateTime(q.from, prop.checkInTime);
      const end = lagosDateTime(addDays(q.to, 1), prop.checkOutTime);
      const caps = await loadCapacity(tx, p.tenantId, ids, start, end);
      const out = [];
      for (const t of types) {
        const cap = caps.get(t.id)!;
        for (const date of dateRange(q.from, q.to)) {
          const s = lagosDateTime(date, prop.checkInTime);
          const e = lagosDateTime(addDays(date, 1), prop.checkOutTime);
          const booked = cap.stays.filter((x) => x.start < e && x.end > s).length;
          const blockedRooms = new Set([...cap.blocks.filter((b) => b.start < e && b.end > s).map((b) => b.roomId), ...cap.openEndedOutOfOrder]);
          const sellable = Math.max(0, cap.totalRooms - blockedRooms.size);
          out.push({ propertyId: q.propertyId, roomTypeId: t.id, date, available: freeRoomsOverWindow(cap, s, e), sellable, booked, blocked: blockedRooms.size });
        }
      }
      return out;
    });
  }

  @Get('rates')
  @PartnerScope('rates:read')
  async rateList(@Req() req: PartnerRequest, @Query() q: RangeQueryDto) {
    const { p } = this.ctx(req);
    checkRange(q.from, q.to, MAX_RANGE_NIGHTS);
    await this.assertProperty(p, q.propertyId);
    return this.scoped(p, q.propertyId, async (tx) => {
      const types = await tx.roomType.findMany({ where: { tenantId: p.tenantId, ...(q.roomTypeId && { id: q.roomTypeId }) }, orderBy: { createdAt: 'asc' } });
      const ctx = await this.rates.context(tx, p.tenantId, q.from, q.to, undefined, q.propertyId);
      const plans = q.ratePlanId ? [this.rates.planFrom(ctx, q.ratePlanId)] : ctx.plans.filter((x) => x.active !== false);
      const dates = dateRange(q.from, q.to);
      const out = [];
      for (const t of types) {
        for (const plan of plans) {
          const nights = resolveNights({ roomType: t, plan, dates, rules: ctx.rules, overrides: ctx.overrides });
          if (!nights) continue;
          for (const n of nights) {
            const r = ctx.restrictions.filter((x) => x.date === n.date && (x.roomTypeId === null || x.roomTypeId === t.id));
            const minNights = Math.max(plan.minNights ?? 0, ...r.map((x) => x.minNights ?? 0));
            out.push({
              propertyId: q.propertyId,
              roomTypeId: t.id,
              ratePlanId: plan.id ?? 'BAR',
              ratePlanName: plan.name,
              date: n.date,
              rateKobo: n.rateKobo,
              source: pRateSource(n.source),
              restrictions: {
                stopSell: r.some((x) => x.stopSell),
                closedToArrival: r.some((x) => x.closedToArrival),
                closedToDeparture: r.some((x) => x.closedToDeparture),
                minNights: minNights > 0 ? minNights : null,
              },
            });
          }
        }
      }
      return out;
    });
  }

  private async assertRoomType(p: PartnerContext, propertyId: string, roomTypeId: string) {
    await this.assertProperty(p, propertyId);
    const t = await this.scoped(p, propertyId, (tx) => tx.roomType.findFirst({ where: { id: roomTypeId, tenantId: p.tenantId, propertyId } }));
    if (!t) throw AppException.notFound('Room type');
  }

  @Put('rates/overrides')
  @PartnerScope('rates:write')
  async putOverrides(@Req() req: PartnerRequest, @Body() dto: PutOverrideDto) {
    const { p, u } = this.ctx(req);
    checkRange(dto.from, dto.to, 366);
    await this.assertRoomType(p, dto.propertyId, dto.roomTypeId);
    this.setDryRunMap(req, (v) => v);
    return runInProperty(p.tenantId, dto.propertyId, () =>
      this.rates.putOverrides(u, { roomTypeIds: [dto.roomTypeId], from: dto.from, to: dto.to, rateKobo: dto.rateKobo, note: `API key ${p.name}` }, req.ip),
    );
  }

  @Delete('rates/overrides')
  @PartnerScope('rates:write')
  async deleteOverrides(@Req() req: PartnerRequest, @Query() q: DeleteOverridesQueryDto) {
    const { p, u } = this.ctx(req);
    checkRange(q.from, q.to, 366);
    await this.assertRoomType(p, q.propertyId, q.roomTypeId);
    this.setDryRunMap(req, (v) => ({ deleted: (v as { updated: number }).updated }));
    const r = await runInProperty(p.tenantId, q.propertyId, () =>
      this.rates.putOverrides(u, { roomTypeIds: [q.roomTypeId], from: q.from, to: q.to, rateKobo: null as unknown as number }, req.ip),
    );
    return { deleted: r.updated };
  }

  // ---- reservations --------------------------------------------------------------------

  private async mapRows(p: PartnerContext, rows: ResRow[]) {
    // M7: booking-form answers (sensitive ones with guests:read), extras and pickups.
    const extra = rows.length
      ? await this.scoped(p, undefined, (tx) => stayPartnerExtras(tx, p.tenantId, rows.map((r) => r.id), { includeSensitive: p.scopes.includes('guests:read') }))
      : new Map<string, Record<string, unknown>>();
    return rows.map((r) => ({ ...pReservation(this.reservations.listItem(r, 0) as unknown as ReservationLike, nightlyOf(r)), ...extra.get(r.id) }));
  }

  @Get('reservations')
  @PartnerScope('reservations:read')
  async reservationList(@Req() req: PartnerRequest, @Query() q: ReservationsQueryDto) {
    const { p } = this.ctx(req);
    if (q.propertyId) await this.assertProperty(p, q.propertyId);
    const limit = limitOf(q);
    const rows = await this.scoped(p, q.propertyId, (tx) =>
      tx.reservation.findMany({
        where: {
          tenantId: p.tenantId,
          ...(q.status && { status: q.status as ResRow['status'] }),
          ...((q.arrivalFrom || q.arrivalTo) && {
            arrivalAt: { ...(q.arrivalFrom && { gte: lagosStartOfDay(q.arrivalFrom) }), ...(q.arrivalTo && { lt: lagosStartOfDay(addDays(q.arrivalTo, 1)) }) },
          }),
          ...(q.updatedSince && { updatedAt: { gte: new Date(q.updatedSince) } }),
          ...cursorWhere(q.cursor),
        },
        include: reservationInclude,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
      }),
    );
    const more = rows.length > limit;
    const items = more ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return { data: await this.mapRows(p, items), pagination: { nextCursor: more && last ? encodeCursor(last.createdAt, last.id) : null, limit } };
  }

  private async loadReservation(p: PartnerContext, idOrCode: string): Promise<ResRow> {
    const r = await this.scoped(p, undefined, (tx) =>
      tx.reservation.findFirst({ where: { tenantId: p.tenantId, ...(UUID.test(idOrCode) ? { id: idOrCode } : { code: idOrCode.toUpperCase() }) }, include: reservationInclude }),
    );
    if (!r) throw AppException.notFound('Reservation');
    return r;
  }

  @Get('reservations/:id')
  @PartnerScope('reservations:read')
  async reservation(@Req() req: PartnerRequest, @Param('id') id: string) {
    const r = await this.loadReservation(this.ctx(req).p, id);
    return (await this.mapRows(this.ctx(req).p, [r]))[0];
  }

  @Post('reservations')
  @PartnerScope('reservations:write')
  async createReservation(@Req() req: PartnerRequest, @Body() dto: CreatePartnerReservationDto) {
    const { p, u } = this.ctx(req);
    await this.assertRoomType(p, dto.propertyId, dto.roomTypeId);
    const toView = (v: unknown) => pReservation(v as ReservationLike);
    this.setDryRunMap(req, toView);
    const created = await runInProperty(p.tenantId, dto.propertyId, () =>
      this.reservations.create(
        { ...u, propertyId: dto.propertyId },
        {
          roomTypeId: dto.roomTypeId,
          arrivalDate: dto.arrivalDate,
          departureDate: dto.departureDate,
          adults: dto.adults,
          children: dto.children ?? 0,
          ratePlanId: dto.ratePlanId,
          guest: { fullName: dto.guest.fullName, phone: dto.guest.phone, email: dto.guest.email },
          notes: dto.notes,
          externalRef: dto.externalRef,
          stayType: 'NIGHTLY',
          status: 'CONFIRMED',
          source: 'API' as 'WALK_IN',
        },
        req.ip,
      ),
    );
    return toView(created);
  }

  @Patch('reservations/:id')
  @PartnerScope('reservations:write')
  async updateReservation(@Req() req: PartnerRequest, @Param('id') id: string, @Body() dto: UpdatePartnerReservationDto) {
    const { p, u } = this.ctx(req);
    const r = await this.loadReservation(p, id);
    this.setDryRunMap(req, (v) => pReservation(v as ReservationLike));
    const updated = await runInProperty(p.tenantId, r.propertyId, () => this.reservations.update({ ...u, propertyId: r.propertyId }, r.id, dto, req.ip));
    return pReservation(updated as unknown as ReservationLike);
  }

  @Post('reservations/:id/cancel')
  @PartnerScope('reservations:write')
  @HttpCode(200)
  async cancelReservation(@Req() req: PartnerRequest, @Param('id') id: string, @Body() dto: CancelPartnerReservationDto) {
    const { p, u } = this.ctx(req);
    const r = await this.loadReservation(p, id);
    this.setDryRunMap(req, (v) => pReservation(v as ReservationLike));
    await runInProperty(p.tenantId, r.propertyId, () =>
      this.reservations.cancel({ ...u, propertyId: r.propertyId }, r.id, { reason: dto.reason && dto.reason.length >= 3 ? dto.reason : `Cancelled through the API (${p.name})` }, req.ip),
    );
    return (await this.mapRows(p, [await this.loadReservation(p, r.id)]))[0];
  }

  @Get('reservations/:id/folio')
  @PartnerScope('folios:read')
  async folio(@Req() req: PartnerRequest, @Param('id') id: string) {
    const { p } = this.ctx(req);
    const r = await this.loadReservation(p, id);
    return this.scoped(p, r.propertyId, async (tx) => {
      const f = await tx.folio.findFirst({ where: { tenantId: p.tenantId, reservationId: r.id } });
      if (!f) throw AppException.notFound('Folio');
      const entries = await tx.folioEntry.findMany({ where: { folioId: f.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const voided = new Set(entries.filter((e) => e.type === 'VOID' && e.refEntryId).map((e) => e.refEntryId!));
      const balance = await this.ledger.balance(tx, f.id);
      const money = (e: (typeof entries)[number]) => Number(e.amountKobo);
      const charges = entries.filter((e) => !['PAYMENT', 'REFUND', 'VOID'].includes(e.type) && !voided.has(e.id)).reduce((a, e) => a + money(e), 0);
      return {
        reservationId: r.id,
        folioId: f.id,
        status: f.status,
        currency: 'NGN' as const,
        balanceKobo: balance,
        chargesKobo: charges,
        paymentsKobo: charges - balance,
        entries: entries.map((e) => ({
          id: e.id,
          type: e.type,
          description: e.description,
          amountKobo: money(e),
          paymentMethod: e.paymentMethod ?? null,
          createdAt: e.createdAt.toISOString(),
          voided: voided.has(e.id),
        })),
      };
    });
  }

  // ---- guests --------------------------------------------------------------------------

  @Get('guests')
  @PartnerScope('guests:read')
  async guests(@Req() req: PartnerRequest, @Query() q: GuestsQueryDto) {
    const { p } = this.ctx(req);
    const rows = await this.scoped(p, undefined, (tx) =>
      tx.guest.findMany({
        where: {
          tenantId: p.tenantId,
          anonymisedAt: null,
          ...(p.restricted && { reservations: { some: { propertyId: { in: p.propertyIds } } } }),
          ...(q.updatedSince && { updatedAt: { gte: new Date(q.updatedSince) } }),
          ...cursorWhere(q.cursor),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limitOf(q) + 1,
      }),
    );
    return page(rows, limitOf(q), pGuest);
  }

  @Get('guests/:id')
  @PartnerScope('guests:read')
  async guest(@Req() req: PartnerRequest, @Param('id') id: string) {
    const { p } = this.ctx(req);
    if (!UUID.test(id)) throw AppException.notFound('Guest');
    const g = await this.scoped(p, undefined, (tx) =>
      tx.guest.findFirst({ where: { id, tenantId: p.tenantId, anonymisedAt: null, ...(p.restricted && { reservations: { some: { propertyId: { in: p.propertyIds } } } }) } }),
    );
    if (!g) throw AppException.notFound('Guest');
    return pGuest(g);
  }

  // ---- housekeeping ------------------------------------------------------------------------

  // ---- M7: transfers, extras, pickup points ---------------------------------------------

  @Get('transfers')
  @PartnerScope('reservations:read')
  async transfersList(@Req() req: PartnerRequest, @Query() q: TransfersQueryDto) {
    const { p } = this.ctx(req);
    if (q.propertyId) await this.assertProperty(p, q.propertyId);
    const limit = limitOf(q);
    return this.scoped(p, q.propertyId, async (tx) => {
      const rows = await tx.transfer.findMany({
        where: {
          tenantId: p.tenantId,
          ...(q.status && { status: q.status as 'REQUESTED' }),
          ...((q.from || q.to) && { scheduledAt: { ...(q.from && { gte: lagosStartOfDay(q.from) }), ...(q.to && { lt: lagosStartOfDay(addDays(q.to, 1)) }) } }),
          ...cursorWhere(q.cursor),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
      });
      const more = rows.length > limit;
      const items = more ? rows.slice(0, limit) : rows;
      const data = [];
      for (const t of items) data.push(await this.addOns.partnerTransfer(tx, t));
      const last = items[items.length - 1];
      return { data, pagination: { nextCursor: more && last ? encodeCursor(last.createdAt, last.id) : null, limit } };
    });
  }

  @Get('extras')
  @PartnerScope('rates:read')
  async extrasList(@Req() req: PartnerRequest, @Query() q: PropertyFilterDto) {
    const { p } = this.ctx(req);
    if (q.propertyId) await this.assertProperty(p, q.propertyId);
    const rows = await this.scoped(p, q.propertyId, (tx) =>
      tx.extra.findMany({ where: { tenantId: p.tenantId, ...cursorWhere(q.cursor) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limitOf(q) + 1 }),
    );
    return page(rows, limitOf(q), (e) => ({
      id: e.id, propertyId: e.propertyId, name: e.name, description: e.description, category: e.category, kind: e.kind, pricing: e.pricing,
      priceKobo: e.priceKobo, maxUnits: e.maxUnits, taxable: e.taxable, channels: e.channels, dailyCap: e.dailyCap, leadTimeHours: e.leadTimeHours, active: e.active,
    }));
  }

  @Get('pickup-points')
  @PartnerScope('rates:read')
  async pickupPointsList(@Req() req: PartnerRequest, @Query() q: PropertyFilterDto) {
    const { p } = this.ctx(req);
    if (q.propertyId) await this.assertProperty(p, q.propertyId);
    const rows = await this.scoped(p, q.propertyId, (tx) =>
      tx.pickupPoint.findMany({ where: { tenantId: p.tenantId, ...cursorWhere(q.cursor) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limitOf(q) + 1 }),
    );
    return page(rows, limitOf(q), (x) => ({ propertyId: x.propertyId, active: x.active, ...publicPickupPoint(x) }));
  }

  // ---- M8: concierge (private requests are never included) -----------------------------------

  @Get('concierge-requests')
  @PartnerScope('reservations:read')
  async conciergeRequests(@Req() req: PartnerRequest, @Query() q: ConciergeQueryDto) {
    const { p } = this.ctx(req);
    if (q.propertyId) await this.assertProperty(p, q.propertyId);
    const rows = await this.scoped(p, q.propertyId, (tx) =>
      tx.conciergeRequest.findMany({
        where: {
          tenantId: p.tenantId,
          discreet: false,
          ...(q.status && { status: q.status as 'NEW' }),
          ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: lagosStartOfDay(q.from) }), ...(q.to && { lt: lagosStartOfDay(addDays(q.to, 1)) }) } }),
          ...cursorWhere(q.cursor),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limitOf(q) + 1,
      }),
    );
    return page(rows, limitOf(q), partnerRequest);
  }

  @Get('concierge-services')
  @PartnerScope('rates:read')
  async conciergeServices(@Req() req: PartnerRequest, @Query() q: PropertyFilterDto) {
    const { p } = this.ctx(req);
    if (q.propertyId) await this.assertProperty(p, q.propertyId);
    const rows = await this.scoped(p, q.propertyId, (tx) =>
      tx.conciergeService.findMany({ where: { tenantId: p.tenantId, reviewStatus: 'LIVE', active: true, ...cursorWhere(q.cursor) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limitOf(q) + 1 }),
    );
    return page(rows, limitOf(q), (x) => ({
      id: x.id, propertyId: x.propertyId, name: x.name, description: x.description, category: x.category, pricing: x.pricing, priceKobo: x.priceKobo,
      variants: Array.isArray(x.variants) ? x.variants : [], durationMinutes: x.durationMinutes, location: x.location, active: x.active,
    }));
  }

  @Get('housekeeping/tasks')
  @PartnerScope('housekeeping:read')
  async tasks(@Req() req: PartnerRequest, @Query() q: TasksQueryDto) {
    const { p } = this.ctx(req);
    if (q.propertyId) await this.assertProperty(p, q.propertyId);
    const rows = await this.scoped(p, q.propertyId, (tx) =>
      tx.housekeepingTask.findMany({
        where: {
          tenantId: p.tenantId,
          ...(q.status && { status: q.status as 'OPEN' }),
          ...(q.date && { businessDate: new Date(`${q.date}T00:00:00Z`) }),
          ...cursorWhere(q.cursor),
        },
        include: { room: { select: { number: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limitOf(q) + 1,
      }),
    );
    return page(rows, limitOf(q), pTask);
  }

  @Post('housekeeping/tasks/:id/complete')
  @PartnerScope('housekeeping:write')
  @HttpCode(200)
  async completeTask(@Req() req: PartnerRequest, @Param('id') id: string, @Body() dto: CompleteTaskDto) {
    const { p, u } = this.ctx(req);
    if (!UUID.test(id)) throw AppException.notFound('Housekeeping task');
    const load = () =>
      this.scoped(p, undefined, (tx) => tx.housekeepingTask.findFirst({ where: { id, tenantId: p.tenantId }, include: { room: { select: { number: true } } } }));
    const t = await load();
    if (!t) throw AppException.notFound('Housekeeping task');
    this.setDryRunMap(req, () => pTask({ ...t, status: 'DONE', completedAt: new Date() }));
    await runInProperty(p.tenantId, t.propertyId, () => this.housekeeping.update({ ...u, propertyId: t.propertyId }, id, { status: 'DONE', notes: dto.note }, req.ip));
    return pTask((await load())!);
  }

  // ---- reports ----------------------------------------------------------------------------

  @Get('reports/daily')
  @PartnerScope('reports:read')
  async daily(@Req() req: PartnerRequest, @Query() q: DailyQueryDto) {
    const { p } = this.ctx(req);
    await this.assertProperty(p, q.propertyId);
    const single = !q.from && !q.to;
    const from = q.from ?? q.date ?? addDays(lagosDate(), -1);
    const to = q.to ?? q.date ?? from;
    checkRange(from, to, 366);
    const flashes = await runInProperty(p.tenantId, q.propertyId, () => this.db.tenant(p.tenantId, (tx) => this.reports.flashes(tx, p.tenantId, from, to)));
    const out = flashes.map((f) => pDailyStats(f, q.propertyId));
    return single ? out[0] : out;
  }

  // ---- webhooks ----------------------------------------------------------------------------

  @Get('webhook-endpoints')
  @PartnerScope('webhooks:manage')
  webhookList(@Req() req: PartnerRequest) {
    return this.webhooks.list(this.ctx(req).u);
  }

  @Post('webhook-endpoints')
  @PartnerScope('webhooks:manage')
  webhookCreate(@Req() req: PartnerRequest, @Body() dto: PartnerWebhookDto) {
    if (!dto.url || !dto.events?.length) throw Err.validation('url', 'url and events are required');
    this.setDryRunMap(req, (v) => v);
    return this.webhooks.create(this.ctx(req).u, { url: dto.url, events: dto.events, description: dto.description, propertyIds: dto.propertyIds ?? null }, req.ip);
  }

  @Patch('webhook-endpoints/:id')
  @PartnerScope('webhooks:manage')
  webhookUpdate(@Req() req: PartnerRequest, @Param('id') id: string, @Body() dto: PartnerWebhookDto) {
    if (!UUID.test(id)) throw AppException.notFound('Webhook endpoint');
    this.setDryRunMap(req, (v) => v);
    return this.webhooks.update(this.ctx(req).u, id, dto, req.ip);
  }

  @Delete('webhook-endpoints/:id')
  @PartnerScope('webhooks:manage')
  async webhookDelete(@Req() req: PartnerRequest, @Param('id') id: string) {
    if (!UUID.test(id)) throw AppException.notFound('Webhook endpoint');
    this.setDryRunMap(req, () => ({ success: true }));
    await this.webhooks.remove(this.ctx(req).u, id, req.ip);
    return { success: true };
  }
}

