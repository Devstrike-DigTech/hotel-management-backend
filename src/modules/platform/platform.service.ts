import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  SubscriptionStatus,
  type BillingInterval,
} from '../../generated/prisma/enums.js';
import type { PlatformPrincipal } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import {
  AuditService,
  platformActor,
  toAuditItem,
} from '../audit/audit.service.js';
import { toInvoiceView } from '../billing/billing.service.js';
import { LIMIT_CODES, UNLIMITED } from '../entitlements/entitlements.constants.js';
import { normaliseLimits } from '../entitlements/entitlements.logic.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { toPublicPlan } from '../plans/plan.mapper.js';
import type {
  SetFeatureOverrideDto,
  TenantListQueryDto,
  UpdatePlanDto,
  UpdateTenantSubscriptionDto,
} from './platform.dto.js';

const DAY = 24 * 60 * 60 * 1000;
const LAGOS_OFFSET_MS = 60 * 60 * 1000; // Africa/Lagos is UTC+1, no DST

const tenantRowInclude = {
  subscription: { include: { plan: { select: { code: true } } } },
  _count: {
    select: { rooms: true, users: { where: { isActive: true } } },
  },
} satisfies Prisma.TenantInclude;

type TenantRowSource = Prisma.TenantGetPayload<{ include: typeof tenantRowInclude }>;

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  city: string;
  planCode: string | null;
  status: SubscriptionStatus | null;
  rooms: number;
  staff: number;
  createdAt: string;
  trialEndsAt: string | null;
}

function toTenantRow(t: TenantRowSource): TenantRow {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    city: t.city,
    planCode: t.subscription?.plan.code ?? null,
    status: t.subscription?.status ?? null,
    rooms: t._count.rooms,
    staff: t._count.users,
    createdAt: t.createdAt.toISOString(),
    trialEndsAt: t.subscription?.trialEndsAt?.toISOString() ?? null,
  };
}

/** Monthly-equivalent recurring revenue of one subscription, in kobo. */
export function monthlyRevenueKobo(
  plan: { priceMonthlyKobo: number | null; priceYearlyKobo: number | null },
  interval: BillingInterval,
): number {
  if (interval === 'YEARLY') {
    return plan.priceYearlyKobo !== null ? Math.round(plan.priceYearlyKobo / 12) : 0;
  }
  return plan.priceMonthlyKobo ?? 0;
}

/** Monday (Lagos time) of the week containing `d`, as YYYY-MM-DD. */
export function weekStart(d: Date): string {
  const local = new Date(d.getTime() + LAGOS_OFFSET_MS);
  const dow = (local.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow),
  );
  return monday.toISOString().slice(0, 10);
}

/**
 * Platform console reads and writes. Every method here uses the `system` RLS
 * context on purpose: the console is the one place that must see across
 * tenants. Tenant-facing code never calls into this service.
 */
@Injectable()
export class PlatformService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  metrics(now: Date = new Date()) {
    return this.db.system(async (tx) => {
      const tenants = await tx.tenant.findMany({ include: tenantRowInclude });
      const plans = await tx.plan.findMany({ orderBy: { sortOrder: 'asc' } });
      const subs = await tx.subscription.findMany({ include: { plan: true } });

      let mrrKobo = 0;
      for (const s of subs) {
        if (s.status === 'ACTIVE' || s.status === 'PAST_DUE') {
          mrrKobo += monthlyRevenueKobo(s.plan, s.interval);
        }
      }

      const tenantsByPlan: Record<string, number> = Object.fromEntries(
        plans.map((p) => [p.code, 0]),
      );
      const tenantsByStatus: Record<string, number> = Object.fromEntries(
        Object.values(SubscriptionStatus).map((s) => [s, 0]),
      );
      for (const t of tenants) {
        if (!t.subscription) continue;
        tenantsByPlan[t.subscription.plan.code] =
          (tenantsByPlan[t.subscription.plan.code] ?? 0) + 1;
        tenantsByStatus[t.subscription.status]++;
      }

      const soon = now.getTime() + 7 * DAY;
      const trialsEndingSoon = tenants
        .filter(
          (t) =>
            t.subscription?.status === 'TRIALING' &&
            t.subscription.trialEndsAt &&
            t.subscription.trialEndsAt.getTime() <= soon,
        )
        .sort(
          (a, b) =>
            a.subscription!.trialEndsAt!.getTime() -
            b.subscription!.trialEndsAt!.getTime(),
        )
        .map(toTenantRow);

      const newTenants30d = tenants.filter(
        (t) => t.createdAt.getTime() >= now.getTime() - 30 * DAY,
      ).length;

      // Last 12 weeks, oldest first, including empty weeks.
      const weeks: string[] = [];
      for (let i = 11; i >= 0; i--) {
        weeks.push(weekStart(new Date(now.getTime() - i * 7 * DAY)));
      }
      const counts = new Map(weeks.map((w) => [w, 0]));
      for (const t of tenants) {
        const w = weekStart(t.createdAt);
        if (counts.has(w)) counts.set(w, counts.get(w)! + 1);
      }

      return {
        mrrKobo,
        arrKobo: mrrKobo * 12,
        tenantsTotal: tenants.length,
        tenantsByPlan,
        tenantsByStatus,
        trialsEndingSoon,
        newTenants30d,
        signupsByWeek: weeks.map((week) => ({ week, count: counts.get(week)! })),
      };
    });
  }

  tenants(q: TenantListQueryDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const and: Prisma.TenantWhereInput[] = [];
    if (q.q) {
      const contains = { contains: q.q, mode: 'insensitive' as const };
      and.push({ OR: [{ name: contains }, { slug: contains }, { city: contains }] });
    }
    if (q.plan) and.push({ subscription: { is: { plan: { code: q.plan } } } });
    if (q.status) and.push({ subscription: { is: { status: q.status } } });
    const where: Prisma.TenantWhereInput = and.length ? { AND: and } : {};

    return this.db.system(async (tx) => {
      const rows = await tx.tenant.findMany({
        where,
        include: tenantRowInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
      const total = await tx.tenant.count({ where });
      return { items: rows.map(toTenantRow), total, page, pageSize };
    });
  }

  tenant(id: string) {
    return this.db.system((tx) => this.tenantDetail(tx, id));
  }

  private async tenantDetail(tx: Tx, id: string) {
    const t = await tx.tenant.findUnique({
      where: { id },
      include: {
        ...tenantRowInclude,
        properties: { orderBy: { createdAt: 'asc' } },
        featureOverrides: { orderBy: { featureCode: 'asc' } },
      },
    });
    if (!t) throw AppException.notFound('Tenant');
    const owner = await tx.user.findFirst({
      where: { tenantId: id, role: 'OWNER' },
      orderBy: { createdAt: 'asc' },
    });
    const invoices = await tx.invoice.findMany({
      where: { tenantId: id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    const activity = await tx.auditLog.findMany({
      where: { tenantId: id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    const ent = t.subscription
      ? await this.entitlements.getEntitlements(id, tx)
      : null;
    const usage = await this.entitlements.getUsage(id, tx);
    const s = t.subscription;

    return {
      ...toTenantRow(t),
      state: t.state,
      owner: owner
        ? {
            id: owner.id,
            fullName: owner.fullName,
            email: owner.email,
            phone: owner.phone,
          }
        : null,
      properties: t.properties.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        city: p.city,
        area: p.area,
        listedOnMarketplace: p.listedOnMarketplace,
      })),
      subscription: s
        ? {
            planCode: s.plan.code,
            planName: ent?.subscription.planName ?? s.plan.code,
            status: s.status,
            interval: s.interval,
            trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
            currentPeriodStart: s.currentPeriodStart?.toISOString() ?? null,
            currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
            pastDueAt: s.pastDueAt?.toISOString() ?? null,
            readOnlyAt: s.readOnlyAt?.toISOString() ?? null,
            suspendedAt: s.suspendedAt?.toISOString() ?? null,
            cancelledAt: s.cancelledAt?.toISOString() ?? null,
          }
        : null,
      entitlements: {
        features: ent?.features ?? [],
        limits: ent?.limits ?? {},
        usage,
      },
      featureOverrides: t.featureOverrides.map((o) => ({
        featureCode: o.featureCode,
        enabled: o.enabled,
        note: o.note,
        updatedAt: o.updatedAt.toISOString(),
      })),
      invoices: invoices.map(toInvoiceView),
      recentActivity: activity.map(toAuditItem),
    };
  }

  updateSubscription(
    actor: PlatformPrincipal,
    id: string,
    dto: UpdateTenantSubscriptionDto,
    ip?: string,
  ) {
    return this.db.system(async (tx) => {
      const sub = await tx.subscription.findUnique({
        where: { tenantId: id },
        include: { plan: true },
      });
      if (!sub) throw AppException.notFound('Subscription');
      const data: Prisma.SubscriptionUncheckedUpdateInput = {};
      if (dto.planCode !== undefined) {
        const plan = await tx.plan.findUnique({ where: { code: dto.planCode } });
        if (!plan) throw AppException.notFound('Plan');
        data.planId = plan.id;
      }
      if (dto.trialEndsAt !== undefined) {
        data.trialEndsAt = dto.trialEndsAt ? new Date(dto.trialEndsAt) : null;
      }
      if (dto.status !== undefined && dto.status !== sub.status) {
        const now = new Date();
        data.status = dto.status;
        switch (dto.status) {
          case 'ACTIVE':
          case 'TRIALING':
            Object.assign(data, {
              pastDueAt: null,
              readOnlyAt: null,
              suspendedAt: null,
              cancelledAt: null,
            });
            if (
              dto.status === 'ACTIVE' &&
              (!sub.currentPeriodEnd || sub.currentPeriodEnd.getTime() < now.getTime())
            ) {
              // Comped/manual activation: give a fresh 30-day period.
              data.currentPeriodStart = now;
              data.currentPeriodEnd = new Date(now.getTime() + 30 * DAY);
            }
            break;
          case 'PAST_DUE':
            data.pastDueAt = now;
            break;
          case 'READ_ONLY':
            data.readOnlyAt = now;
            break;
          case 'SUSPENDED':
            data.suspendedAt = now;
            break;
          case 'CANCELLED':
            data.cancelledAt = now;
            break;
        }
      }
      await tx.subscription.update({ where: { id: sub.id }, data });
      await this.audit.record(tx, {
        tenantId: id,
        actor: platformActor(actor),
        action: 'platform.subscription_updated',
        entityType: 'subscription',
        entityId: sub.id,
        metadata: {
          from: { planCode: sub.plan.code, status: sub.status },
          to: dto as Record<string, unknown>,
        },
        ip,
      });
      return this.tenantDetail(tx, id);
    });
  }

  setFeatureOverride(
    actor: PlatformPrincipal,
    id: string,
    dto: SetFeatureOverrideDto,
    ip?: string,
  ) {
    return this.db.system(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id }, select: { id: true } });
      if (!tenant) throw AppException.notFound('Tenant');
      await tx.tenantFeatureOverride.upsert({
        where: { tenantId_featureCode: { tenantId: id, featureCode: dto.featureCode } },
        create: {
          tenantId: id,
          featureCode: dto.featureCode,
          enabled: dto.enabled,
          note: dto.note ?? null,
        },
        update: { enabled: dto.enabled, note: dto.note ?? null },
      });
      await this.audit.record(tx, {
        tenantId: id,
        actor: platformActor(actor),
        action: 'platform.feature_override_set',
        entityType: 'tenant',
        entityId: id,
        metadata: { featureCode: dto.featureCode, enabled: dto.enabled },
        ip,
      });
      return this.tenantDetail(tx, id);
    });
  }

  removeFeatureOverride(
    actor: PlatformPrincipal,
    id: string,
    featureCode: string,
    ip?: string,
  ) {
    return this.db.system(async (tx) => {
      const res = await tx.tenantFeatureOverride.deleteMany({
        where: { tenantId: id, featureCode },
      });
      if (res.count === 0) throw AppException.notFound('Feature override');
      await this.audit.record(tx, {
        tenantId: id,
        actor: platformActor(actor),
        action: 'platform.feature_override_removed',
        entityType: 'tenant',
        entityId: id,
        metadata: { featureCode },
        ip,
      });
      return this.tenantDetail(tx, id);
    });
  }

  plans() {
    return this.db.system(async (tx) => {
      const plans = await tx.plan.findMany({
        include: { features: true, _count: { select: { subscriptions: true } } },
        orderBy: { sortOrder: 'asc' },
      });
      return plans.map((p) => ({
        ...toPublicPlan(p),
        id: p.id,
        isActive: p.isActive,
        tenantCount: p._count.subscriptions,
      }));
    });
  }

  updatePlan(actor: PlatformPrincipal, code: string, dto: UpdatePlanDto, ip?: string) {
    if (dto.limits) {
      for (const [k, v] of Object.entries(dto.limits)) {
        if (!(LIMIT_CODES as readonly string[]).includes(k)) {
          throw AppException.badRequest(`Unknown limit "${k}"`, {
            allowed: LIMIT_CODES,
          });
        }
        if (!Number.isInteger(v) || v < UNLIMITED) {
          throw AppException.badRequest(
            `Limit "${k}" must be an integer >= -1 (-1 = unlimited)`,
          );
        }
      }
    }
    return this.db.system(async (tx) => {
      const plan = await tx.plan.findUnique({ where: { code } });
      if (!plan) throw AppException.notFound('Plan');
      const { features, limits, ...scalar } = dto;
      const updated = await tx.plan.update({
        where: { id: plan.id },
        data: {
          ...scalar,
          ...(limits && {
            limits: { ...normaliseLimits(plan.limits), ...limits },
          }),
        },
      });
      if (features) {
        await tx.planFeature.deleteMany({ where: { planId: plan.id } });
        await tx.planFeature.createMany({
          data: [...new Set(features)].map((featureCode) => ({
            planId: plan.id,
            featureCode,
          })),
        });
      }
      await this.audit.record(tx, {
        tenantId: null,
        actor: platformActor(actor),
        action: 'platform.plan_updated',
        entityType: 'plan',
        entityId: updated.id,
        metadata: { code, changes: Object.keys(dto) },
        ip,
      });
      const full = await tx.plan.findUniqueOrThrow({
        where: { id: plan.id },
        include: { features: true, _count: { select: { subscriptions: true } } },
      });
      return {
        ...toPublicPlan(full),
        id: full.id,
        isActive: full.isActive,
        tenantCount: full._count.subscriptions,
      };
    });
  }
}
