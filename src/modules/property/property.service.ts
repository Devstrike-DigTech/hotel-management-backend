import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma, Property } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { propertyAccessDenied } from '../../common/guards/permission.guard.js';
import { slugify } from '../../common/utils/slug.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { toImages } from '../public/hotel.mapper.js';
import { appError, isUniqueViolation } from '../ops/ops.helpers.js';
import { primaryProperty } from './property.helpers.js';
import type { CreatePropertyDto, UpdatePropertyM5Dto } from './property.dto.js';

export interface GroupInfo {
  slug: string;
  name: string;
  propertyCount: number;
}

export function toPropertyView(p: Property, extra?: { isPrimary: boolean; group: GroupInfo }) {
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
    // M5
    invoicePrefix: p.invoicePrefix,
    ...(extra && { isPrimary: extra.isPrimary, group: extra.group }),
  };
}

export type PropertySummary = ReturnType<typeof toPropertySummary>;

export function toPropertySummary(p: Property, o: { isPrimary: boolean; roomCount: number }) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    city: p.city,
    state: p.state,
    area: p.area,
    isPrimary: o.isPrimary,
    invoicePrefix: p.invoicePrefix,
    coverImageUrl: p.coverImageUrl,
    roomCount: o.roomCount,
    listedOnMarketplace: p.listedOnMarketplace,
    customDomain: p.customDomainVerifiedAt ? p.customDomain : null,
    createdAt: p.createdAt.toISOString(),
  };
}

/** Initials of a hotel name for its invoice prefix: "Palmwine House Ikoyi" -> "PHI". */
export function defaultPrefix(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w !== 'THE' && w !== 'AND' && w !== 'OF');
  let pre = words.map((w) => w[0]).join('').slice(0, 4);
  if (pre.length < 2) pre = (words[0] ?? 'HTL').slice(0, 3).padEnd(2, 'X');
  return pre;
}

@Injectable()
export class PropertyService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Every property of the tenant, oldest first, with room counts. */
  private async all(tx: Tx, tenantId: string) {
    const rows = await tx.property.findMany({ where: { tenantId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const counts = await this.db.withAllProperties(tenantId, () =>
      tx.room.groupBy({ by: ['propertyId'], where: { tenantId }, _count: { _all: true } }),
    );
    const byId = new Map(counts.map((c) => [c.propertyId, c._count._all]));
    return rows.map((p, i) => ({ row: p, summary: toPropertySummary(p, { isPrimary: i === 0, roomCount: byId.get(p.id) ?? 0 }) }));
  }

  async group(tx: Tx, tenantId: string): Promise<GroupInfo> {
    const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true, name: true } });
    const propertyCount = await tx.property.count({ where: { tenantId } });
    return { slug: t.slug, name: t.name, propertyCount };
  }

  private async view(tx: Tx, tenantId: string, p: Property) {
    const first = await tx.property.findFirst({ where: { tenantId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } });
    return toPropertyView(p, { isPrimary: first?.id === p.id, group: await this.group(tx, tenantId) });
  }

  /** Summaries for `/me` and `/properties`: the properties this user may access. */
  async summaries(tx: Tx, user: AuthUser): Promise<PropertySummary[]> {
    const all = await this.all(tx, user.tenantId);
    const allowed = new Set(user.propertyIds ?? all.map((x) => x.row.id));
    return all.filter((x) => allowed.has(x.row.id)).map((x) => x.summary);
  }

  get(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => this.view(tx, user.tenantId, await primaryProperty(tx, user.tenantId)));
  }

  list(user: AuthUser) {
    return this.db.tenant(user.tenantId, (tx) => this.summaries(tx, user));
  }

  private assertAccess(user: AuthUser, propertyId: string) {
    if (user.propertyIds && !user.propertyIds.includes(propertyId)) throw propertyAccessDenied(propertyId);
  }

  getById(user: AuthUser, id: string) {
    this.assertAccess(user, id);
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await tx.property.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!p) throw AppException.notFound('Property');
      return this.view(tx, user.tenantId, p);
    });
  }

  async update(user: AuthUser, dto: UpdatePropertyM5Dto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => this.applyUpdate(tx, user, await primaryProperty(tx, user.tenantId), dto, ip));
  }

  updateById(user: AuthUser, id: string, dto: UpdatePropertyM5Dto, ip?: string) {
    this.assertAccess(user, id);
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await tx.property.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!p) throw AppException.notFound('Property');
      return this.applyUpdate(tx, user, p, dto, ip);
    });
  }

  private async applyUpdate(tx: Tx, user: AuthUser, current: Property, dto: UpdatePropertyM5Dto, ip?: string) {
    if (dto.accentColor !== undefined || dto.logoUrl !== undefined) {
      const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
      await this.entitlements.assertFeature(ent, 'booking_site_branding');
    }
    const { images, ...rest } = dto;
    if (dto.invoicePrefix !== undefined) await this.assertPrefixFree(tx, user.tenantId, dto.invoicePrefix, current.id);
    if (dto.slug !== undefined && dto.slug !== current.slug) await this.assertSlugFree(tx, dto.slug);
    const data: Prisma.PropertyUpdateInput = {
      ...rest,
      ...(images !== undefined && { images: images as unknown as Prisma.InputJsonValue }),
    };
    try {
      const updated = await tx.property.update({ where: { id: current.id }, data });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'property.updated',
        entityType: 'property',
        entityId: current.id,
        metadata: { changes: Object.keys(dto) },
        ip,
      });
      return this.view(tx, user.tenantId, updated);
    } catch (e) {
      if (isUniqueViolation(e) && dto.slug) throw appError(HttpStatus.CONFLICT, 'SLUG_TAKEN', `The address ${dto.slug} is taken`, { slug: dto.slug });
      throw e;
    }
  }

  private async assertPrefixFree(tx: Tx, tenantId: string, prefix: string, exceptId?: string) {
    const clash = await tx.property.findFirst({ where: { tenantId, invoicePrefix: prefix, ...(exceptId && { id: { not: exceptId } }) }, select: { id: true } });
    if (clash) throw appError(HttpStatus.CONFLICT, 'PROPERTY_PREFIX_TAKEN', `Another property of the group already uses ${prefix}`, { invoicePrefix: prefix });
  }

  /** Slugs are global (marketplace URLs, subdomains); other tenants' slugs are visible in the public context. */
  private async assertSlugFree(tx: Tx, slug: string) {
    const clash = await this.db.public((ptx) => ptx.property.findFirst({ where: { slug }, select: { id: true } }));
    const own = await tx.property.findFirst({ where: { slug }, select: { id: true } });
    if (clash || own) throw appError(HttpStatus.CONFLICT, 'SLUG_TAKEN', `The address ${slug} is taken`, { slug });
  }

  async create(user: AuthUser, dto: CreatePropertyDto, ip?: string) {
    const slug = dto.slug ?? slugify(dto.name);
    if (!slug) throw appError(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Give the property a name', { fields: { name: ['name is required'] } });
    try {
      return await this.db.tenant(user.tenantId, async (tx) => {
        // Re-check the limit inside the transaction (two concurrent creates).
        const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
        await this.entitlements.assertWithinLimit(ent, 'max_properties', 1, tx);
        await this.assertSlugFree(tx, slug);
        let prefix = dto.invoicePrefix;
        if (prefix) {
          await this.assertPrefixFree(tx, user.tenantId, prefix);
        } else {
          const taken = new Set((await tx.property.findMany({ where: { tenantId: user.tenantId }, select: { invoicePrefix: true } })).map((x) => x.invoicePrefix));
          const base = defaultPrefix(dto.name);
          prefix = base;
          for (let i = 2; taken.has(prefix); i++) prefix = `${base.slice(0, 5)}${i}`;
        }
        const source = dto.copyFromPropertyId
          ? await tx.property.findFirst({ where: { id: dto.copyFromPropertyId, tenantId: user.tenantId } })
          : null;
        if (dto.copyFromPropertyId && !source) throw AppException.notFound('Property to copy from');
        if (source) this.assertAccess(user, source.id);
        const p = await tx.property.create({
          data: {
            tenantId: user.tenantId,
            name: dto.name,
            slug,
            city: dto.city,
            state: dto.state,
            area: dto.area ?? '',
            address: dto.address ?? '',
            phone: dto.phone ?? '',
            email: dto.email ?? '',
            tagline: dto.tagline ?? '',
            description: dto.description ?? '',
            checkInTime: dto.checkInTime ?? source?.checkInTime ?? '14:00',
            checkOutTime: dto.checkOutTime ?? source?.checkOutTime ?? '12:00',
            invoicePrefix: prefix,
            ...(source && {
              onlineBookingEnabled: source.onlineBookingEnabled,
              allowPayAtHotel: source.allowPayAtHotel,
              requireCardForPayAtHotel: source.requireCardForPayAtHotel,
              freeCancellationHours: source.freeCancellationHours,
              lateCancellationFeePct: source.lateCancellationFeePct,
              noShowFeePct: source.noShowFeePct,
              requireInspection: source.requireInspection,
              stayoverEnabled: source.stayoverEnabled,
              amenities: source.amenities,
              policies: source.policies,
            }),
          },
        });
        await this.db.withAllProperties(user.tenantId, () => this.initialise(tx, user.tenantId, p.id, source?.id ?? null));
        await this.audit.record(tx, {
          tenantId: user.tenantId,
          actor: userActor(user),
          action: 'property.created',
          entityType: 'property',
          entityId: p.id,
          metadata: { name: p.name, slug: p.slug, invoicePrefix: prefix, copiedFrom: source?.name ?? null },
          ip,
        });
        // The creator can use it at once even with a property list.
        if (user.allProperties === false) {
          await tx.userPropertyAccess.create({ data: { tenantId: user.tenantId, userId: user.userId, propertyId: p.id } });
        }
        return this.view(tx, user.tenantId, p);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw appError(HttpStatus.CONFLICT, 'SLUG_TAKEN', `The address ${slug} is taken`, { slug });
      throw e;
    }
  }

  /** Default settings rows for a new property (copied from `sourceId` where given). */
  private async initialise(tx: Tx, tenantId: string, propertyId: string, sourceId: string | null) {
    const tax = sourceId ? await tx.taxSetting.findUnique({ where: { propertyId: sourceId } }) : null;
    await tx.taxSetting.create({
      data: {
        tenantId,
        propertyId,
        ...(tax && {
          vatEnabled: tax.vatEnabled, vatRateBps: tax.vatRateBps, vatInclusive: tax.vatInclusive,
          consumptionEnabled: tax.consumptionEnabled, consumptionRateBps: tax.consumptionRateBps,
          consumptionInclusive: tax.consumptionInclusive, consumptionLabel: tax.consumptionLabel,
          serviceChargeEnabled: tax.serviceChargeEnabled, serviceChargeRateBps: tax.serviceChargeRateBps,
          serviceChargeInclusive: tax.serviceChargeInclusive, discountApprovalThresholdBps: tax.discountApprovalThresholdBps,
        }),
      },
    });
    await tx.ratePlan.create({
      data: { tenantId, propertyId, code: 'BAR', name: 'Best available rate', kind: 'BAR', isBar: true, description: 'The standard price of each room type.' },
    });
    const digest = sourceId ? await tx.digestSetting.findUnique({ where: { propertyId: sourceId } }) : null;
    await tx.digestSetting.create({ data: { tenantId, propertyId, enabled: digest?.enabled ?? true, recipients: digest?.recipients ?? [] } });
    if (sourceId) {
      const notif = await tx.notificationSetting.findUnique({ where: { propertyId: sourceId } });
      if (notif) {
        await tx.notificationSetting.create({
          data: { tenantId, propertyId, guardAlerts: notif.guardAlerts as Prisma.InputJsonValue, quietHours: notif.quietHours as Prisma.InputJsonValue },
        });
      }
      const lists = await tx.housekeepingChecklist.findMany({ where: { tenantId, propertyId: sourceId, roomTypeId: null } });
      for (const c of lists) {
        await tx.housekeepingChecklist.create({ data: { tenantId, propertyId, roomTypeId: null, taskType: c.taskType, items: c.items as Prisma.InputJsonValue } });
      }
    }
  }

  /** PUT /me/current-property: the default used without X-Property-Id. */
  setCurrent(user: AuthUser, propertyId: string) {
    const id = propertyId.toLowerCase();
    this.assertAccess(user, id);
    return this.db.tenant(user.tenantId, async (tx) => {
      const all = await this.all(tx, user.tenantId);
      const hit = all.find((x) => x.row.id === id);
      if (!hit) throw propertyAccessDenied(propertyId);
      await tx.user.update({ where: { id: user.userId }, data: { defaultPropertyId: id } });
      return { currentProperty: hit.summary };
    });
  }
}
