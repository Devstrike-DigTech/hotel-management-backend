import { HttpStatus, Injectable } from '@nestjs/common';
import { can, forbidden } from '../../common/permissions/can.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { GuardService } from '../guard/guard.service.js';
import { lagosDate } from '../../common/time/lagos.js';
import { parseClientCreatedAt } from '../ops/ops.helpers.js';
import type {
  BulkCreateRoomsDto,
  CreateRoomDto,
  RoomQueryDto,
  UpdateRoomDto,
  UpdateRoomStatusDto,
} from './rooms.dto.js';

export const MAX_BULK_ROOMS = 100;

const roomInclude = {
  roomType: { select: { id: true, name: true } },
} satisfies Prisma.RoomInclude;

type RoomRow = Prisma.RoomGetPayload<{ include: typeof roomInclude }>;

export function toRoomView(r: RoomRow) {
  return {
    id: r.id,
    number: r.number,
    floor: r.floor,
    status: r.status,
    notes: r.notes,
    roomType: { id: r.roomType.id, name: r.roomType.name },
    updatedAt: r.updatedAt.toISOString(),
  };
}

const collator = new Intl.Collator('en', { numeric: true });

@Injectable()
export class RoomsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly guard: GuardService,
  ) {}

  list(user: AuthUser, q: RoomQueryDto) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.room.findMany({
        where: {
          tenantId: user.tenantId,
          ...(q.status && { status: q.status }),
          ...(q.floor !== undefined && { floor: q.floor }),
          ...(q.roomTypeId && { roomTypeId: q.roomTypeId }),
        },
        include: roomInclude,
      });
      rows.sort(
        (a, b) => a.floor - b.floor || collator.compare(a.number, b.number),
      );
      return rows.map(toRoomView);
    });
  }

  private async assertRoomType(tx: Tx, tenantId: string, roomTypeId: string) {
    const rt = await tx.roomType.findFirst({
      where: { id: roomTypeId, tenantId },
      select: { id: true, propertyId: true },
    });
    if (!rt) throw AppException.notFound('Room type');
    return rt;
  }

  private async assertNumberFree(
    tx: Tx,
    propertyId: string,
    numbers: string[],
    exceptId?: string,
  ) {
    const clash = await tx.room.findMany({
      where: {
        propertyId,
        number: { in: numbers },
        ...(exceptId && { id: { not: exceptId } }),
      },
      select: { number: true },
    });
    if (clash.length) {
      throw AppException.conflict(
        clash.length === 1
          ? `Room ${clash[0].number} already exists`
          : `${clash.length} of these room numbers already exist`,
        { numbers: clash.map((c) => c.number) },
      );
    }
  }

  async create(user: AuthUser, dto: CreateRoomDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
      await this.entitlements.assertWithinLimit(ent, 'max_rooms', 1, tx);
      const rt = await this.assertRoomType(tx, user.tenantId, dto.roomTypeId);
      await this.assertNumberFree(tx, rt.propertyId, [dto.number]);
      const room = await tx.room.create({
        data: {
          tenantId: user.tenantId,
          propertyId: rt.propertyId,
          roomTypeId: rt.id,
          number: dto.number,
          floor: dto.floor,
          status: dto.status ?? 'VACANT_CLEAN',
          notes: dto.notes ?? null,
        },
        include: roomInclude,
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'room.created',
        entityType: 'room',
        entityId: room.id,
        metadata: { number: room.number, floor: room.floor },
        ip,
      });
      return toRoomView(room);
    });
  }

  async bulkCreate(user: AuthUser, dto: BulkCreateRoomsDto, ip?: string) {
    if (dto.to < dto.from) {
      throw AppException.badRequest('"to" must be greater than or equal to "from"');
    }
    const count = dto.to - dto.from + 1;
    if (count > MAX_BULK_ROOMS) {
      throw AppException.badRequest(
        `You can add at most ${MAX_BULK_ROOMS} rooms at a time`,
      );
    }
    const numbers = Array.from(
      { length: count },
      (_, i) => `${dto.prefix ?? ''}${dto.from + i}`,
    );

    return this.db.tenant(user.tenantId, async (tx) => {
      const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
      await this.entitlements.assertWithinLimit(ent, 'max_rooms', count, tx);
      const rt = await this.assertRoomType(tx, user.tenantId, dto.roomTypeId);
      await this.assertNumberFree(tx, rt.propertyId, numbers);
      await tx.room.createMany({
        data: numbers.map((number) => ({
          tenantId: user.tenantId,
          propertyId: rt.propertyId,
          roomTypeId: rt.id,
          number,
          floor: dto.floor,
        })),
      });
      const rooms = await tx.room.findMany({
        where: { propertyId: rt.propertyId, number: { in: numbers } },
        include: roomInclude,
      });
      rooms.sort((a, b) => collator.compare(a.number, b.number));
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'room.bulk_created',
        entityType: 'room',
        entityId: null,
        metadata: {
          count,
          floor: dto.floor,
          from: numbers[0],
          to: numbers[numbers.length - 1],
          roomTypeId: rt.id,
        },
        ip,
      });
      return rooms.map(toRoomView);
    });
  }

  async update(user: AuthUser, id: string, dto: UpdateRoomDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const existing = await tx.room.findFirst({
        where: { id, tenantId: user.tenantId },
      });
      if (!existing) throw AppException.notFound('Room');
      let propertyId = existing.propertyId;
      if (dto.roomTypeId && dto.roomTypeId !== existing.roomTypeId) {
        propertyId = (await this.assertRoomType(tx, user.tenantId, dto.roomTypeId))
          .propertyId;
      }
      if (dto.number && dto.number !== existing.number) {
        await this.assertNumberFree(tx, propertyId, [dto.number], id);
      }
      const data: Prisma.RoomUncheckedUpdateInput = {
        ...(dto.number !== undefined && { number: dto.number }),
        ...(dto.floor !== undefined && { floor: dto.floor }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.roomTypeId !== undefined && {
          roomTypeId: dto.roomTypeId,
          propertyId,
        }),
      };
      const room = await tx.room.update({
        where: { id },
        data,
        include: roomInclude,
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'room.updated',
        entityType: 'room',
        entityId: id,
        metadata: { number: room.number, changes: Object.keys(data) },
        ip,
      });
      return toRoomView(room);
    });
  }

  async setStatus(
    user: AuthUser,
    id: string,
    dto: UpdateRoomStatusDto,
    ip?: string,
  ) {
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    return this.db.tenant(user.tenantId, async (tx) => {
      const existing = await tx.room.findFirst({
        where: { id, tenantId: user.tenantId },
      });
      if (!existing) throw AppException.notFound('Room');
      if (!can(user, 'rooms.status')) {
        // Housekeeping staff (housekeeping.work) may only turn a dirty room clean.
        if (!(existing.status === 'VACANT_DIRTY' && dto.status === 'VACANT_CLEAN')) {
          throw forbidden('rooms.status', 'Housekeeping can only mark a dirty room as clean');
        }
        const property = await tx.property.findFirst({ where: { id: existing.propertyId }, select: { requireInspection: true } });
        if (property?.requireInspection && !can(user, 'housekeeping.inspect')) {
          throw new AppException(HttpStatus.CONFLICT, 'INSPECTION_REQUIRED', 'A supervisor must inspect the room before it is marked clean', { roomId: existing.id });
        }
      }
      const room = await tx.room.update({
        where: { id },
        data: {
          status: dto.status,
          ...(dto.note !== undefined && { notes: dto.note || null }),
        },
        include: roomInclude,
      });
      await this.revenueGuard(tx, user, existing.status, room.status, room.id, room.number);
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'room.status_changed',
        entityType: 'room',
        entityId: id,
        metadata: {
          number: room.number,
          from: existing.status,
          to: dto.status,
          ...(dto.note && { note: dto.note }),
          ...(clientCreatedAt && { clientCreatedAt: clientCreatedAt.toISOString() }),
        },
        ip,
      });
      return toRoomView(room);
    });
  }

  /**
   * Manual status changes that bypass the front desk: OCCUPIED -> VACANT_DIRTY
   * with no check-out (ROOM_STATUS_FLIP) and OCCUPIED with nobody checked in
   * (OCCUPIED_WITHOUT_STAY).
   */
  private async revenueGuard(
    tx: Tx,
    user: AuthUser,
    from: string,
    to: string,
    roomId: string,
    number: string,
  ) {
    if (from === to || (to !== 'OCCUPIED' && !(from === 'OCCUPIED' && to === 'VACANT_DIRTY'))) return;
    const inHouse = await tx.reservation.count({
      where: { tenantId: user.tenantId, roomId, status: 'CHECKED_IN' },
    });
    if (inHouse) return;
    const features = await this.guard.features(tx, user.tenantId);
    const today = lagosDate();
    if (to === 'OCCUPIED') {
      await this.guard.raise(tx, user.tenantId, features, {
        rule: 'OCCUPIED_WITHOUT_STAY',
        title: `Room ${number} set to occupied with no guest checked in`,
        detail: `${user.fullName} marked the room occupied by hand. No checked-in stay covers it.`,
        dedupeKey: `OCCUPIED_WITHOUT_STAY:${roomId}:${today}`,
        roomId,
        userId: user.userId,
        userName: user.fullName,
        evidence: { roomNumber: number, from, to },
      });
      return;
    }
    const since = new Date(Date.now() - 2 * 3_600_000);
    const checkedOut = await tx.reservation.count({
      where: { tenantId: user.tenantId, roomId, checkedOutAt: { gte: since } },
    });
    if (checkedOut) return;
    await this.guard.raise(tx, user.tenantId, features, {
      rule: 'ROOM_STATUS_FLIP',
      title: `Room ${number} flipped from occupied to dirty without a check-out`,
      detail: `${user.fullName} changed the status by hand. A stay may have been sold and not recorded.`,
      dedupeKey: `ROOM_STATUS_FLIP:${roomId}:${today}`,
      roomId,
      userId: user.userId,
      userName: user.fullName,
      evidence: { roomNumber: number, from, to },
    });
  }

  async remove(user: AuthUser, id: string, ip?: string) {
    await this.db.tenant(user.tenantId, async (tx) => {
      const existing = await tx.room.findFirst({
        where: { id, tenantId: user.tenantId },
      });
      if (!existing) throw AppException.notFound('Room');
      await tx.room.delete({ where: { id } });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'room.deleted',
        entityType: 'room',
        entityId: id,
        metadata: { number: existing.number, floor: existing.floor },
        ip,
      });
    });
    return { success: true };
  }
}
