import { Injectable } from '@nestjs/common';
import type { Prisma, Property } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { DbService } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { toImages } from '../public/hotel.mapper.js';
import { primaryProperty } from './property.helpers.js';
import type { UpdatePropertyDto } from './property.dto.js';

export function toPropertyView(p: Property) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    tagline: p.tagline,
    description: p.description,
    address: p.address,
    city: p.city,
    state: p.state,
    area: p.area,
    phone: p.phone,
    email: p.email,
    checkInTime: p.checkInTime,
    checkOutTime: p.checkOutTime,
    coverImageUrl: p.coverImageUrl,
    images: toImages(p.images),
    amenities: p.amenities,
    policies: p.policies,
    accentColor: p.accentColor,
    logoUrl: p.logoUrl,
    listedOnMarketplace: p.listedOnMarketplace,
  };
}

@Injectable()
export class PropertyService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  get(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) =>
      toPropertyView(await primaryProperty(tx, user.tenantId)),
    );
  }

  async update(user: AuthUser, dto: UpdatePropertyDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      if (dto.accentColor !== undefined || dto.logoUrl !== undefined) {
        const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
        await this.entitlements.assertFeature(ent, 'booking_site_branding');
      }
      const current = await primaryProperty(tx, user.tenantId);
      const { images, ...rest } = dto;
      const data: Prisma.PropertyUpdateInput = {
        ...rest,
        ...(images !== undefined && {
          images: images as unknown as Prisma.InputJsonValue,
        }),
      };
      const updated = await tx.property.update({
        where: { id: current.id },
        data,
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'property.updated',
        entityType: 'property',
        entityId: current.id,
        metadata: { changes: Object.keys(dto) },
        ip,
      });
      return toPropertyView(updated);
    });
  }
}
