import { HttpStatus, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Extra, PickupPoint, Prisma } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { Err, isUniqueViolation, primaryProperty } from '../ops/ops.helpers.js';
import type { ExtraDto, PickupPointDto, TransportCompanyDto, UpdateExtraDto, UpdatePickupPointDto, VehicleOptionDto } from './extras.dto.js';
import type { ExtraAvailability, ExtraLike, PickupPointLike, VehicleOption } from './extras.logic.js';

export function extraLike(e: Extra): ExtraLike {
  return {
    id: e.id,
    name: e.name,
    category: e.category,
    kind: e.kind,
    pricing: e.pricing,
    priceKobo: e.priceKobo,
    maxUnits: e.maxUnits,
    taxable: e.taxable,
    channels: e.channels,
    availability: (e.availability ?? {}) as ExtraAvailability,
    dailyCap: e.dailyCap,
    leadTimeHours: e.leadTimeHours,
    active: e.active,
  };
}

export function pointLike(p: PickupPoint): PickupPointLike {
  return {
    id: p.id,
    name: p.name,
    shortName: p.shortName,
    kind: p.kind,
    city: p.city,
    priceKobo: p.priceKobo,
    dropOffPriceKobo: p.dropOffPriceKobo,
    vehicleOptions: Array.isArray(p.vehicleOptions) ? (p.vehicleOptions as unknown as VehicleOption[]) : [],
    leadTimeHours: p.leadTimeHours,
    operatingHours: (p.operatingHours as { open: string; close: string } | null) ?? null,
    taxable: p.taxable,
    active: p.active,
  };
}

function availabilityOf(a: ExtraDto['availability']): ExtraAvailability {
  return {
    validFrom: a?.validFrom ?? null,
    validTo: a?.validTo ?? null,
    daysOfWeek: a?.daysOfWeek?.length ? [...new Set(a.daysOfWeek)].sort((x, y) => x - y) : null,
    minNights: a?.minNights ?? null,
    earlyFrom: a?.earlyFrom ?? null,
    lateUntil: a?.lateUntil ?? null,
  };
}

/** Stable ids for vehicle options: kept on edits, generated for new ones. */
export function vehicleOptionsOf(list: VehicleOptionDto[] | undefined, previous: VehicleOption[] = []): VehicleOption[] {
  if (!list) return previous;
  const used = new Set<string>();
  return list.map((v) => {
    let id = v.id && /^[a-z0-9-]{1,40}$/.test(v.id) && !used.has(v.id) ? v.id : '';
    if (!id) {
      const base = v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'vehicle';
      id = used.has(base) || previous.some((p) => p.id === base && p.name !== v.name) ? `${base}-${randomBytes(2).toString('hex')}` : base;
    }
    used.add(id);
    return { id, name: v.name.trim(), maxPassengers: v.maxPassengers, priceKobo: v.priceKobo ?? null };
  });
}

/**
 * Extras, pickup points and transport companies (M7, feature `paid_extras`;
 * permission `extras.manage`). All rows belong to the current property,
 * except transport companies a hotel group adds (group-wide).
 */
@Injectable()
export class ExtrasService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  extraView(e: Extra, soldLast30Days = 0) {
    return {
      id: e.id,
      propertyId: e.propertyId,
      name: e.name,
      description: e.description,
      imageUrl: e.imageUrl,
      category: e.category,
      kind: e.kind,
      pricing: e.pricing,
      priceKobo: e.priceKobo,
      maxUnits: e.maxUnits,
      taxable: e.taxable,
      channels: e.channels,
      availability: availabilityOf(e.availability as ExtraDto['availability']),
      dailyCap: e.dailyCap,
      leadTimeHours: e.leadTimeHours,
      active: e.active,
      sortOrder: e.sortOrder,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
      soldLast30Days,
    };
  }

  pointView(p: PickupPoint) {
    return {
      id: p.id,
      propertyId: p.propertyId,
      name: p.name,
      shortName: p.shortName,
      kind: p.kind,
      city: p.city,
      address: p.address,
      priceKobo: p.priceKobo,
      dropOffPriceKobo: p.dropOffPriceKobo,
      vehicleOptions: pointLike(p).vehicleOptions,
      leadTimeHours: p.leadTimeHours,
      operatingHours: pointLike(p).operatingHours,
      notesForGuest: p.notesForGuest,
      taxable: p.taxable,
      active: p.active,
      sortOrder: p.sortOrder,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  private checkExtra(pricing: string, maxUnits: number | null | undefined, a: ExtraAvailability) {
    if (pricing === 'PER_UNIT' && !maxUnits) throw Err.validation('maxUnits', 'Per-unit extras need a maximum number of units (1 to 50)');
    if (a.validFrom && a.validTo && a.validTo < a.validFrom) throw Err.validation('availability.validTo', 'The end date is before the start date');
  }

  // ---------------------------------------------------------------------------
  // Extras
  // ---------------------------------------------------------------------------

  listExtras(u: AuthUser, active?: boolean) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const rows = await tx.extra.findMany({ where: { tenantId: u.tenantId, ...(active !== undefined && { active }) }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
      const since = new Date(Date.now() - 30 * 86_400_000);
      const sold = await tx.reservationExtra.groupBy({ by: ['extraId'], where: { tenantId: u.tenantId, status: 'ACTIVE', createdAt: { gte: since }, extraId: { in: rows.map((r) => r.id) } }, _sum: { quantity: true } });
      const by = new Map(sold.map((s) => [s.extraId, s._sum.quantity ?? 0]));
      return rows.map((r) => this.extraView(r, by.get(r.id) ?? 0));
    });
  }

  async createExtra(u: AuthUser, dto: ExtraDto, ip?: string) {
    const availability = availabilityOf(dto.availability);
    this.checkExtra(dto.pricing, dto.maxUnits, availability);
    try {
      return await this.db.tenant(u.tenantId, async (tx) => {
        const p = await primaryProperty(tx, u.tenantId);
        const e = await tx.extra.create({
          data: {
            tenantId: u.tenantId,
            propertyId: p.id,
            name: dto.name.trim(),
            description: dto.description ?? '',
            imageUrl: dto.imageUrl ?? null,
            category: dto.category,
            kind: dto.kind ?? 'STANDARD',
            pricing: dto.pricing,
            priceKobo: dto.priceKobo,
            maxUnits: dto.pricing === 'PER_UNIT' ? (dto.maxUnits ?? null) : null,
            taxable: dto.taxable ?? true,
            channels: dto.channels ?? ['MARKETPLACE', 'BOOKING_SITE', 'FRONT_DESK'],
            availability: availability as unknown as Prisma.InputJsonValue,
            dailyCap: dto.dailyCap ?? null,
            leadTimeHours: dto.leadTimeHours ?? 0,
            active: dto.active ?? true,
            sortOrder: dto.sortOrder ?? 0,
          },
        });
        await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'extra.created', entityType: 'extra', entityId: e.id, metadata: { name: e.name, priceKobo: e.priceKobo, pricing: e.pricing }, ip });
        return this.extraView(e);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw AppException.conflict('An extra with this name already exists');
      throw e;
    }
  }

  async updateExtra(u: AuthUser, id: string, dto: UpdateExtraDto, ip?: string) {
    try {
      return await this.db.tenant(u.tenantId, async (tx) => {
        const cur = await tx.extra.findFirst({ where: { id, tenantId: u.tenantId } });
        if (!cur) throw AppException.notFound('Extra');
        const pricing = dto.pricing ?? cur.pricing;
        const maxUnits = dto.maxUnits !== undefined ? dto.maxUnits : cur.maxUnits;
        const availability = dto.availability ? availabilityOf(dto.availability) : (cur.availability as ExtraAvailability);
        this.checkExtra(pricing, maxUnits, availability);
        const e = await tx.extra.update({
          where: { id },
          data: {
            ...(dto.name !== undefined && { name: dto.name.trim() }),
            ...(dto.description !== undefined && { description: dto.description }),
            ...(dto.imageUrl !== undefined && { imageUrl: dto.imageUrl }),
            ...(dto.category !== undefined && { category: dto.category }),
            ...(dto.kind !== undefined && { kind: dto.kind }),
            pricing,
            maxUnits: pricing === 'PER_UNIT' ? maxUnits : null,
            ...(dto.priceKobo !== undefined && { priceKobo: dto.priceKobo }),
            ...(dto.taxable !== undefined && { taxable: dto.taxable }),
            ...(dto.channels !== undefined && { channels: dto.channels }),
            availability: availability as unknown as Prisma.InputJsonValue,
            ...(dto.dailyCap !== undefined && { dailyCap: dto.dailyCap }),
            ...(dto.leadTimeHours !== undefined && { leadTimeHours: dto.leadTimeHours }),
            ...(dto.active !== undefined && { active: dto.active }),
            ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
          },
        });
        await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'extra.updated', entityType: 'extra', entityId: id, metadata: { changes: Object.keys(dto) }, ip });
        return this.extraView(e);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw AppException.conflict('An extra with this name already exists');
      throw e;
    }
  }

  removeExtra(u: AuthUser, id: string, ip?: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const cur = await tx.extra.findFirst({ where: { id, tenantId: u.tenantId } });
      if (!cur) throw AppException.notFound('Extra');
      const refs = await tx.reservationExtra.count({ where: { extraId: id } });
      if (refs) throw new AppException(HttpStatus.CONFLICT, 'EXTRA_IN_USE', 'Bookings include this extra. Switch it off instead (active: false).', { references: refs });
      await tx.extra.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'extra.deleted', entityType: 'extra', entityId: id, metadata: { name: cur.name }, ip });
      return { success: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Pickup points
  // ---------------------------------------------------------------------------

  listPoints(u: AuthUser, active?: boolean) {
    return this.db.tenant(u.tenantId, async (tx) =>
      (await tx.pickupPoint.findMany({ where: { tenantId: u.tenantId, ...(active !== undefined && { active }) }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })).map((p) => this.pointView(p)),
    );
  }

  async createPoint(u: AuthUser, dto: PickupPointDto, ip?: string) {
    try {
      return await this.db.tenant(u.tenantId, async (tx) => {
        const prop = await primaryProperty(tx, u.tenantId);
        const p = await tx.pickupPoint.create({
          data: {
            tenantId: u.tenantId,
            propertyId: prop.id,
            name: dto.name.trim(),
            shortName: dto.shortName ?? null,
            kind: dto.kind,
            city: dto.city.trim(),
            address: dto.address ?? null,
            priceKobo: dto.priceKobo,
            dropOffPriceKobo: dto.dropOffPriceKobo ?? null,
            vehicleOptions: vehicleOptionsOf(dto.vehicleOptions) as unknown as Prisma.InputJsonValue,
            leadTimeHours: dto.leadTimeHours ?? 6,
            operatingHours: (dto.operatingHours ?? null) as unknown as Prisma.InputJsonValue,
            notesForGuest: dto.notesForGuest ?? null,
            taxable: dto.taxable ?? true,
            active: dto.active ?? true,
            sortOrder: dto.sortOrder ?? 0,
          },
        });
        await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'pickup_point.created', entityType: 'pickup_point', entityId: p.id, metadata: { name: p.name, kind: p.kind, priceKobo: p.priceKobo }, ip });
        return this.pointView(p);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw AppException.conflict('A pickup point with this name already exists');
      throw e;
    }
  }

  async updatePoint(u: AuthUser, id: string, dto: UpdatePickupPointDto, ip?: string) {
    try {
      return await this.db.tenant(u.tenantId, async (tx) => {
        const cur = await tx.pickupPoint.findFirst({ where: { id, tenantId: u.tenantId } });
        if (!cur) throw AppException.notFound('Pickup point');
        const p = await tx.pickupPoint.update({
          where: { id },
          data: {
            ...(dto.name !== undefined && { name: dto.name.trim() }),
            ...(dto.shortName !== undefined && { shortName: dto.shortName }),
            ...(dto.kind !== undefined && { kind: dto.kind }),
            ...(dto.city !== undefined && { city: dto.city.trim() }),
            ...(dto.address !== undefined && { address: dto.address }),
            ...(dto.priceKobo !== undefined && { priceKobo: dto.priceKobo }),
            ...(dto.dropOffPriceKobo !== undefined && { dropOffPriceKobo: dto.dropOffPriceKobo }),
            ...(dto.vehicleOptions !== undefined && { vehicleOptions: vehicleOptionsOf(dto.vehicleOptions, pointLike(cur).vehicleOptions) as unknown as Prisma.InputJsonValue }),
            ...(dto.leadTimeHours !== undefined && { leadTimeHours: dto.leadTimeHours }),
            ...(dto.operatingHours !== undefined && { operatingHours: (dto.operatingHours ?? null) as unknown as Prisma.InputJsonValue }),
            ...(dto.notesForGuest !== undefined && { notesForGuest: dto.notesForGuest }),
            ...(dto.taxable !== undefined && { taxable: dto.taxable }),
            ...(dto.active !== undefined && { active: dto.active }),
            ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
          },
        });
        await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'pickup_point.updated', entityType: 'pickup_point', entityId: id, metadata: { changes: Object.keys(dto) }, ip });
        return this.pointView(p);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw AppException.conflict('A pickup point with this name already exists');
      throw e;
    }
  }

  removePoint(u: AuthUser, id: string, ip?: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const cur = await tx.pickupPoint.findFirst({ where: { id, tenantId: u.tenantId } });
      if (!cur) throw AppException.notFound('Pickup point');
      const refs = await tx.transfer.count({ where: { pickupPointId: id } });
      if (refs) throw new AppException(HttpStatus.CONFLICT, 'EXTRA_IN_USE', 'Transfers use this pickup point. Switch it off instead (active: false).', { references: refs });
      await tx.pickupPoint.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'pickup_point.deleted', entityType: 'pickup_point', entityId: id, metadata: { name: cur.name }, ip });
      return { success: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Transport companies and train routes
  // ---------------------------------------------------------------------------

  /** The platform catalogue (shared database, whatever database serves the tenant). */
  async platformCompanies() {
    return (await this.db.prisma.transportCompany.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })).map((c) => ({ id: c.id, name: c.name, shortName: c.shortName, source: 'PLATFORM' as const }));
  }

  async trainRoutes() {
    return (await this.db.prisma.trainRoute.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })).map((r) => ({ id: r.id, name: r.name, operator: r.operator, stations: r.stations, services: r.services }));
  }

  async companiesTx(tx: Tx, tenantId: string) {
    const local = await tx.localTransportCompany.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
    return [...(await this.platformCompanies()), ...local.map((c) => ({ id: c.id, name: c.name, shortName: c.shortName, source: 'HOTEL' as const }))];
  }

  companies(u: AuthUser) {
    return this.db.tenant(u.tenantId, (tx) => this.companiesTx(tx, u.tenantId));
  }

  async addCompany(u: AuthUser, dto: TransportCompanyDto, ip?: string) {
    const name = dto.name.trim();
    if ((await this.platformCompanies()).some((c) => c.name.toLowerCase() === name.toLowerCase())) throw AppException.conflict('This company is already on the list');
    try {
      return await this.db.tenant(u.tenantId, async (tx) => {
        const c = await tx.localTransportCompany.create({ data: { tenantId: u.tenantId, name, shortName: dto.shortName ?? null } });
        await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'transport_company.created', entityType: 'transport_company', entityId: c.id, propertyId: null, metadata: { name }, ip });
        return { id: c.id, name: c.name, shortName: c.shortName, source: 'HOTEL' as const };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw AppException.conflict('This company is already on the list');
      throw e;
    }
  }

  removeCompany(u: AuthUser, id: string, ip?: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const c = await tx.localTransportCompany.findFirst({ where: { id, tenantId: u.tenantId } });
      if (!c) throw AppException.notFound('Transport company');
      await tx.localTransportCompany.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'transport_company.deleted', entityType: 'transport_company', entityId: id, propertyId: null, metadata: { name: c.name }, ip });
      return { success: true };
    });
  }
}
