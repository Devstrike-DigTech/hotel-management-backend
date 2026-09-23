import { Injectable } from '@nestjs/common';
import type { Prisma, RoomType } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { DbService } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { primaryProperty } from '../property/property.helpers.js';
import { toImages } from '../public/hotel.mapper.js';
import type { CreateRoomTypeDto, UpdateRoomTypeDto } from './room-types.dto.js';

export function toRoomTypeView(rt: RoomType, roomCount: number) {
  return {
    id: rt.id,
    name: rt.name,
    description: rt.description,
    basePriceKobo: rt.basePriceKobo,
    hourlyPriceKobo: rt.hourlyPriceKobo,
    capacity: rt.capacity,
    bedType: rt.bedType,
    sizeSqm: rt.sizeSqm,
    amenities: rt.amenities,
    images: toImages(rt.images),
    roomCount,
  };
}

@Injectable()
export class RoomTypesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  list(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.roomType.findMany({
        where: { tenantId: user.tenantId },
        include: { _count: { select: { rooms: true } } },
        orderBy: [{ sortOrder: 'asc' }, { basePriceKobo: 'asc' }],
      });
      return rows.map((r) => toRoomTypeView(r, r._count.rooms));
    });
  }

  private async assertHourlyAllowed(
    user: AuthUser,
    hourly: number | null | undefined,
  ) {
    if (hourly === undefined || hourly === null) return;
    const ent = await this.entitlements.getEntitlements(user.tenantId);
    await this.entitlements.assertFeature(ent, 'hourly_bookings');
  }

  async create(user: AuthUser, dto: CreateRoomTypeDto, ip?: string) {
    await this.assertHourlyAllowed(user, dto.hourlyPriceKobo);
    return this.db.tenant(user.tenantId, async (tx) => {
      const property = await primaryProperty(tx, user.tenantId);
      const count = await tx.roomType.count({ where: { tenantId: user.tenantId } });
      const rt = await tx.roomType.create({
        data: {
          tenantId: user.tenantId,
          propertyId: property.id,
          name: dto.name,
          description: dto.description ?? '',
          basePriceKobo: dto.basePriceKobo,
          hourlyPriceKobo: dto.hourlyPriceKobo ?? null,
          capacity: dto.capacity,
          bedType: dto.bedType,
          sizeSqm: dto.sizeSqm,
          amenities: dto.amenities ?? [],
          images: (dto.images ?? []) as unknown as Prisma.InputJsonValue,
          sortOrder: count,
        },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'room_type.created',
        entityType: 'room_type',
        entityId: rt.id,
        metadata: { name: rt.name, basePriceKobo: rt.basePriceKobo },
        ip,
      });
      return toRoomTypeView(rt, 0);
    });
  }

  async update(user: AuthUser, id: string, dto: UpdateRoomTypeDto, ip?: string) {
    await this.assertHourlyAllowed(user, dto.hourlyPriceKobo);
    return this.db.tenant(user.tenantId, async (tx) => {
      const existing = await tx.roomType.findFirst({
        where: { id, tenantId: user.tenantId },
      });
      if (!existing) throw AppException.notFound('Room type');
      const data: Prisma.RoomTypeUpdateInput = {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.basePriceKobo !== undefined && { basePriceKobo: dto.basePriceKobo }),
        ...(dto.hourlyPriceKobo !== undefined && {
          hourlyPriceKobo: dto.hourlyPriceKobo,
        }),
        ...(dto.capacity !== undefined && { capacity: dto.capacity }),
        ...(dto.bedType !== undefined && { bedType: dto.bedType }),
        ...(dto.sizeSqm !== undefined && { sizeSqm: dto.sizeSqm }),
        ...(dto.amenities !== undefined && { amenities: dto.amenities }),
        ...(dto.images !== undefined && {
          images: dto.images as unknown as Prisma.InputJsonValue,
        }),
      };
      const rt = await tx.roomType.update({
        where: { id },
        data,
        include: { _count: { select: { rooms: true } } },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'room_type.updated',
        entityType: 'room_type',
        entityId: id,
        metadata: { changes: Object.keys(data) },
        ip,
      });
      return toRoomTypeView(rt, rt._count.rooms);
    });
  }

  async remove(user: AuthUser, id: string, ip?: string) {
    await this.db.tenant(user.tenantId, async (tx) => {
      const existing = await tx.roomType.findFirst({
        where: { id, tenantId: user.tenantId },
        include: { _count: { select: { rooms: true } } },
      });
      if (!existing) throw AppException.notFound('Room type');
      if (existing._count.rooms > 0) {
        throw AppException.conflict(
          'Move or delete the rooms of this type before deleting it',
          { roomCount: existing._count.rooms },
        );
      }
      await tx.roomType.delete({ where: { id } });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'room_type.deleted',
        entityType: 'room_type',
        entityId: id,
        metadata: { name: existing.name },
        ip,
      });
    });
    return { success: true };
  }
}
