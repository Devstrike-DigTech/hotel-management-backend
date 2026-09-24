import { Injectable } from '@nestjs/common';
import type { Coupon } from '../../../generated/prisma/client.js';
import type { PlatformPrincipal } from '../../../common/auth-types.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { DbService } from '../../../prisma/db.service.js';
import { appError, Err } from '../../ops/ops.helpers.js';

export interface CouponInput {
  code: string;
  name: string;
  percentOff?: number | null;
  amountOffKobo?: number | null;
  durationMonths?: number | null;
  planCodes?: string[];
  intervals?: ('MONTHLY' | 'YEARLY')[];
  maxRedemptions?: number | null;
  validFrom?: string | null;
  validUntil?: string | null;
}

export function couponView(c: Coupon) {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    percentOff: c.percentOff,
    amountOffKobo: c.amountOffKobo,
    durationMonths: c.durationMonths,
    planCodes: c.planCodes,
    intervals: c.intervals as ('MONTHLY' | 'YEARLY')[],
    maxRedemptions: c.maxRedemptions,
    redemptions: c.redemptions,
    validFrom: c.validFrom?.toISOString() ?? null,
    validUntil: c.validUntil?.toISOString() ?? null,
    active: c.active,
    createdAt: c.createdAt.toISOString(),
    createdBy: c.createdById ? { id: c.createdById, fullName: c.createdByName ?? '', email: '' } : null,
  };
}

/** Subscription coupons (M6): e.g. "first 3 months 50% off" for chosen plans. */
@Injectable()
export class CouponsService {
  constructor(private readonly db: DbService) {}

  async list(active?: boolean) {
    const rows = await this.db.system((tx) => tx.coupon.findMany({ where: active === undefined ? {} : { active }, orderBy: { createdAt: 'desc' } }));
    return rows.map(couponView);
  }

  async create(p: PlatformPrincipal, dto: CouponInput) {
    const code = dto.code.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw Err.validation('code', 'Use 3 to 32 letters, digits, - or _');
    if ((dto.percentOff ?? null) === null === ((dto.amountOffKobo ?? null) === null)) throw Err.validation('percentOff', 'Give either percentOff or amountOffKobo');
    if (dto.validFrom && dto.validUntil && new Date(dto.validUntil) <= new Date(dto.validFrom)) throw Err.validation('validUntil', 'validUntil must be after validFrom');
    if (dto.planCodes?.length) {
      const known = await this.db.system((tx) => tx.plan.findMany({ where: { code: { in: dto.planCodes } }, select: { code: true } }));
      const missing = dto.planCodes.filter((c) => !known.some((k) => k.code === c));
      if (missing.length) throw Err.validation('planCodes', `Unknown plan: ${missing.join(', ')}`);
    }
    try {
      const c = await this.db.system((tx) =>
        tx.coupon.create({
          data: {
            code, name: dto.name.trim(), percentOff: dto.percentOff ?? null, amountOffKobo: dto.amountOffKobo ?? null,
            durationMonths: dto.durationMonths ?? null, planCodes: dto.planCodes ?? [], intervals: dto.intervals ?? [],
            maxRedemptions: dto.maxRedemptions ?? null, validFrom: dto.validFrom ? new Date(dto.validFrom) : null,
            validUntil: dto.validUntil ? new Date(dto.validUntil) : null, createdById: p.platformUserId, createdByName: p.fullName,
          },
        }),
      );
      return couponView(c);
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw appError(409, 'CONFLICT', `The coupon code ${code} is taken`);
      throw e;
    }
  }

  async update(id: string, dto: { name?: string; active?: boolean; validUntil?: string | null; maxRedemptions?: number | null }) {
    const c = await this.db.system((tx) => tx.coupon.findUnique({ where: { id } }));
    if (!c) throw AppException.notFound('Coupon');
    const updated = await this.db.system((tx) =>
      tx.coupon.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name.trim() }),
          ...(dto.active !== undefined && { active: dto.active }),
          ...(dto.validUntil !== undefined && { validUntil: dto.validUntil ? new Date(dto.validUntil) : null }),
          ...(dto.maxRedemptions !== undefined && { maxRedemptions: dto.maxRedemptions }),
        },
      }),
    );
    return couponView(updated);
  }

  async redemptions(id: string) {
    return this.db.system(async (tx) => {
      const rows = await tx.couponRedemption.findMany({ where: { couponId: id }, orderBy: { appliedAt: 'desc' } });
      const tenants = await tx.tenant.findMany({ where: { id: { in: rows.map((r) => r.tenantId) } }, select: { id: true, name: true, slug: true } });
      const byId = new Map(tenants.map((t) => [t.id, t]));
      return rows.map((r) => ({ tenant: byId.get(r.tenantId) ?? { id: r.tenantId, name: '', slug: '' }, appliedAt: r.appliedAt.toISOString(), monthsRemaining: r.monthsRemaining, active: r.active }));
    });
  }

  /** Applies a coupon to a tenant's subscription from the console (replaces the active one). */
  async apply(tenantId: string, code: string) {
    const c = await this.db.system((tx) => tx.coupon.findUnique({ where: { code: code.trim().toUpperCase() } }));
    if (!c) throw AppException.notFound('Coupon');
    if (!c.active || (c.validUntil && c.validUntil <= new Date())) throw Err.validation('code', 'This coupon is not active');
    if (c.maxRedemptions !== null && c.redemptions >= c.maxRedemptions) throw Err.validation('code', 'This coupon has been used up');
    await this.db.system(async (tx) => {
      await tx.couponRedemption.updateMany({ where: { tenantId, active: true }, data: { active: false, endedAt: new Date() } });
      await tx.couponRedemption.create({ data: { tenantId, couponId: c.id, monthsRemaining: c.durationMonths } });
      await tx.coupon.update({ where: { id: c.id }, data: { redemptions: { increment: 1 } } });
    });
  }

  async remove(tenantId: string) {
    await this.db.system((tx) => tx.couponRedemption.updateMany({ where: { tenantId, active: true }, data: { active: false, endedAt: new Date() } }));
  }
}
