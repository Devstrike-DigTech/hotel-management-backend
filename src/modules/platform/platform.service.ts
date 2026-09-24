import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Prisma, Subscription } from '../../generated/prisma/client.js';
import {
  SubscriptionStatus,
  type BillingInterval,
} from '../../generated/prisma/enums.js';
import type { PlatformPrincipal } from '../../common/auth-types.js';
import { sha256Hex } from '../../common/crypto/secret-box.js';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { humanDate, lagosDate } from '../../common/time/lagos.js';
import { randomSuffix, slugify } from '../../common/utils/slug.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import {
  AuditService,
  platformActor,
  toAuditItem,
} from '../audit/audit.service.js';
import { AuthService, isUniqueViolation } from '../auth/auth.service.js';
import { redemptionView, toInvoiceView } from '../billing/billing.service.js';
import { PlatformMarketplaceService } from '../booking/platform-marketplace.service.js';
import { ControlMirrorService } from '../dedicated-db/control-mirror.service.js';
import { ListingsService } from '../dedicated-db/listings.service.js';
import { ProvisioningService } from '../dedicated-db/provisioning.service.js';
import { LIMIT_CODES, UNLIMITED } from '../entitlements/entitlements.constants.js';
import { normaliseLimits } from '../entitlements/entitlements.logic.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { renderTemplate } from '../notifications/templates/templates.js';
import { toPublicPlan } from '../plans/plan.mapper.js';
import { CouponsService } from './console/coupons.service.js';
import { ImpersonationService } from './console/impersonation.service.js';
import { OffboardingService } from './console/offboarding.service.js';
import { SystemHealthService } from './console/system-health.service.js';
import { PlatformAuditService } from './security/platform-audit.service.js';
import type {
  CreateTenantDto,
  SetFeatureOverrideDto,
  TenantListQueryDto,
  UpdatePlanDto,
  UpdateTenantSubscriptionDto,
} from './platform.dto.js';

const DAY = 24 * 60 * 60 * 1000;
const LAGOS_OFFSET_MS = 60 * 60 * 1000; // Africa/Lagos is UTC+1, no DST
const SETUP_DAYS = 7;
/** Statuses that pay (MRR). */
const PAYING: SubscriptionStatus[] = ['ACTIVE', 'PAST_DUE'];

type PlanPrices = { code: string; priceMonthlyKobo: number | null; priceYearlyKobo: number | null };
type ControlTenant = Prisma.TenantGetPayload<{ include: { subscription: { include: { plan: true } } } }>;

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
  /** M6 */
  lifecycle: 'ACTIVE' | 'OFFBOARDING' | 'DELETED';
  mrrKobo: number;
  dbMode: 'SHARED' | 'DEDICATED';
  offboarding: boolean;
  properties: number;
}

/**
 * Monthly-equivalent recurring revenue of one subscription, in kobo. An
 * Enterprise custom price (per billing interval) wins over the plan price.
 */
export function monthlyRevenueKobo(
  plan: { priceMonthlyKobo: number | null; priceYearlyKobo: number | null },
  interval: BillingInterval,
  customPriceKobo: number | null = null,
): number {
  if (customPriceKobo !== null) {
    return interval === 'YEARLY' ? Math.round(customPriceKobo / 12) : customPriceKobo;
  }
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

/** When a subscription left the paying set (cancelled, suspended), if it did. */
export function churnedAt(s: Pick<Subscription, 'status' | 'cancelledAt' | 'suspendedAt'>): Date | null {
  if (s.status === 'CANCELLED') return s.cancelledAt;
  if (s.status === 'SUSPENDED') return s.suspendedAt;
  return null;
}

function subscriptionMrr(s: { status: SubscriptionStatus; interval: BillingInterval; customPriceKobo: number | null; plan: PlanPrices }): number {
  return PAYING.includes(s.status) ? monthlyRevenueKobo(s.plan, s.interval, s.customPriceKobo) : 0;
}

/**
 * Platform console reads and writes (tenants, plans, subscriptions). Control
 * plane rows (tenants, subscriptions, invoices, overrides) live in the shared
 * database and are read with `system`; operational rows (properties, staff,
 * rooms, the tenant audit trail) with `systemFor` / `systemAll`, so tenants
 * with a dedicated database (M6) show the same as everyone else. Tenant-facing
 * code never calls into this service.
 */
@Injectable()
export class PlatformService {
  private readonly logger = new Logger(PlatformService.name);
  /** Per-tenant room / staff / property counts across databases (30 s). */
  private countsCache: { at: number; value: Map<string, { rooms: number; staff: number; properties: number }> } | null = null;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly marketplace: PlatformMarketplaceService,
    private readonly config: AppConfigService,
    private readonly auth: AuthService,
    private readonly notifications: NotificationService,
    private readonly mirror: ControlMirrorService,
    private readonly listings: ListingsService,
    private readonly provisioning: ProvisioningService,
    private readonly health: SystemHealthService,
    private readonly offboarding: OffboardingService,
    private readonly coupons: CouponsService,
    private readonly impersonation: ImpersonationService,
    private readonly platformAudit: PlatformAuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  private async counts(fresh = false) {
    if (!fresh && this.countsCache && Date.now() - this.countsCache.at < 30_000) return this.countsCache.value;
    const parts = await this.db.systemAll(async (tx, t) => {
      const rooms = await tx.room.groupBy({ by: ['tenantId'], where: t.tenants, _count: { _all: true } });
      const staff = await tx.user.groupBy({ by: ['tenantId'], where: { ...t.tenants, isActive: true }, _count: { _all: true } });
      const props = await tx.property.groupBy({ by: ['tenantId'], where: t.tenants, _count: { _all: true } });
      return { rooms, staff, props };
    });
    const out = new Map<string, { rooms: number; staff: number; properties: number }>();
    const get = (id: string) => {
      let v = out.get(id);
      if (!v) out.set(id, (v = { rooms: 0, staff: 0, properties: 0 }));
      return v;
    };
    for (const p of parts) {
      for (const r of p.rooms) get(r.tenantId).rooms += r._count._all;
      for (const r of p.staff) get(r.tenantId).staff += r._count._all;
      for (const r of p.props) get(r.tenantId).properties += r._count._all;
    }
    this.countsCache = { at: Date.now(), value: out };
    return out;
  }

  private row(t: ControlTenant, counts: Map<string, { rooms: number; staff: number; properties: number }>): TenantRow {
    const c = counts.get(t.id) ?? { rooms: 0, staff: 0, properties: 0 };
    const s = t.subscription;
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      city: t.city,
      planCode: s?.plan.code ?? null,
      status: s?.status ?? null,
      rooms: c.rooms,
      staff: c.staff,
      createdAt: t.createdAt.toISOString(),
      trialEndsAt: s?.trialEndsAt?.toISOString() ?? null,
      lifecycle: t.lifecycle as TenantRow['lifecycle'],
      mrrKobo: s ? subscriptionMrr(s) : 0,
      dbMode: this.db.router.isDedicated(t.id) ? 'DEDICATED' : 'SHARED',
      offboarding: t.lifecycle === 'OFFBOARDING',
      properties: c.properties,
    };
  }

  async metrics(now: Date = new Date()) {
    const counts = await this.counts();
    const base = await this.db.system(async (tx) => {
      const tenants = await tx.tenant.findMany({
        where: { lifecycle: { not: 'DELETED' } },
        include: { subscription: { include: { plan: true } } },
      });
      const plans = await tx.plan.findMany({ orderBy: { sortOrder: 'asc' } });
      return { tenants, plans };
    });
    const { tenants, plans } = base;

    let mrrKobo = 0;
    for (const t of tenants) if (t.subscription) mrrKobo += subscriptionMrr(t.subscription);

    const tenantsByPlan: Record<string, number> = Object.fromEntries(plans.map((p) => [p.code, 0]));
    const tenantsByStatus = Object.fromEntries(
      Object.values(SubscriptionStatus).map((s) => [s, 0]),
    ) as Record<SubscriptionStatus, number>;
    for (const t of tenants) {
      if (!t.subscription) continue;
      tenantsByPlan[t.subscription.plan.code] = (tenantsByPlan[t.subscription.plan.code] ?? 0) + 1;
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
      .sort((a, b) => a.subscription!.trialEndsAt!.getTime() - b.subscription!.trialEndsAt!.getTime())
      .map((t) => this.row(t, counts));

    const newTenants30d = tenants.filter((t) => t.createdAt.getTime() >= now.getTime() - 30 * DAY).length;

    const weeks: string[] = [];
    for (let i = 11; i >= 0; i--) weeks.push(weekStart(new Date(now.getTime() - i * 7 * DAY)));
    const byWeek = new Map(weeks.map((w) => [w, 0]));
    for (const t of tenants) {
      const w = weekStart(t.createdAt);
      if (byWeek.has(w)) byWeek.set(w, byWeek.get(w)! + 1);
    }

    return {
      mrrKobo,
      arrKobo: mrrKobo * 12,
      tenantsTotal: tenants.length,
      tenantsByPlan,
      tenantsByStatus,
      trialsEndingSoon,
      newTenants30d,
      signupsByWeek: weeks.map((week) => ({ week, count: byWeek.get(week)! })),
      marketplace: await this.marketplace.metricsBlock(now),
    };
  }

  /** Console home: metrics + churn + system health (M6). */
  async overview(now: Date = new Date()) {
    const m = await this.metrics(now);
    const since = new Date(now.getTime() - 30 * DAY);
    const { subs, offboarded } = await this.db.system(async (tx) => ({
      subs: await tx.subscription.findMany({ include: { plan: true, tenant: { select: { createdAt: true, lifecycle: true } } } }),
      offboarded: await tx.tenantOffboarding.findMany({
        where: { status: { notIn: ['CANCELLED'] } },
        select: { tenantId: true, requestedAt: true },
      }),
    }));
    const offAt = new Map(offboarded.map((o) => [o.tenantId, o.requestedAt]));
    const churnDate = (s: (typeof subs)[number]) => offAt.get(s.tenantId) ?? churnedAt(s);

    let churned30d = 0;
    let mrrLost30dKobo = 0;
    for (const s of subs) {
      const at = churnDate(s);
      if (at && at >= since && at <= now) {
        churned30d++;
        mrrLost30dKobo += monthlyRevenueKobo(s.plan, s.interval, s.customPriceKobo);
      }
    }
    // Paying 30 days ago: still paying and older than 30 days, plus those that churned since.
    const payingThen =
      subs.filter((s) => PAYING.includes(s.status) && s.tenant.createdAt < since && s.tenant.lifecycle === 'ACTIVE').length + churned30d;
    const churnRatePct = payingThen ? Math.round((churned30d / payingThen) * 1000) / 10 : 0;

    const months: string[] = [];
    const today = lagosDate(now);
    let y = Number(today.slice(0, 4));
    let mo = Number(today.slice(5, 7));
    for (let i = 0; i < 6; i++) {
      months.unshift(`${y}-${String(mo).padStart(2, '0')}`);
      mo--;
      if (mo === 0) {
        mo = 12;
        y--;
      }
    }
    const byMonth = new Map(months.map((k) => [k, 0]));
    for (const s of subs) {
      const at = churnDate(s);
      if (!at) continue;
      const key = lagosDate(at).slice(0, 7);
      if (byMonth.has(key)) byMonth.set(key, byMonth.get(key)! + 1);
    }

    const health = await this.health.summary().catch((e: Error) => {
      this.logger.warn(`Health summary failed: ${e.message}`);
      return { status: 'degraded' as const, failedJobs: 0, webhookFailures24h: 0, notificationFailures24h: 0, channelSyncErrors24h: 0, overdueCrons: 0, dedicatedDbsUnhealthy: 0 };
    });

    return {
      mrrKobo: m.mrrKobo,
      arrKobo: m.arrKobo,
      gmv30dKobo: m.marketplace.gmv30dKobo,
      commission30d: { collectedKobo: m.marketplace.commission30dKobo, receivableKobo: m.marketplace.receivableKobo },
      tenantsTotal: m.tenantsTotal,
      tenantsByPlan: m.tenantsByPlan,
      tenantsByStatus: m.tenantsByStatus,
      signupsByWeek: m.signupsByWeek,
      newTenants30d: m.newTenants30d,
      churn: {
        churned30d,
        churnRatePct,
        mrrLost30dKobo,
        byMonth: months.map((month) => ({ month, churned: byMonth.get(month)! })),
      },
      trialsEndingSoon: m.trialsEndingSoon,
      health,
    };
  }

  async tenants(q: TenantListQueryDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const and: Prisma.TenantWhereInput[] = [];
    if (q.q) {
      const contains = { contains: q.q, mode: 'insensitive' as const };
      and.push({ OR: [{ name: contains }, { slug: contains }, { city: contains }] });
    }
    if (q.plan) and.push({ subscription: { is: { plan: { code: q.plan } } } });
    if (q.status) and.push({ subscription: { is: { status: q.status } } });
    if (q.city) and.push({ city: { equals: q.city, mode: 'insensitive' } });
    if (q.dbMode) {
      const ids = this.db.router.activeDedicated().map((r) => r.tenantId);
      and.push(q.dbMode === 'DEDICATED' ? { id: { in: ids } } : { id: { notIn: ids } });
    }
    const where: Prisma.TenantWhereInput = and.length ? { AND: and } : {};
    const [rows, counts] = await Promise.all([
      this.db.system((tx) => tx.tenant.findMany({ where, include: { subscription: { include: { plan: true } } } })),
      this.counts(),
    ]);
    const items = rows.map((t) => this.row(t, counts));
    const sort = q.sort ?? 'created';
    items.sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name)
        : sort === 'mrr' ? b.mrrKobo - a.mrrKobo || a.name.localeCompare(b.name)
          : b.createdAt.localeCompare(a.createdAt),
    );
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
  }

  async tenant(id: string) {
    const control = await this.db.system(async (tx) => {
      const t = await tx.tenant.findUnique({
        where: { id },
        include: { subscription: { include: { plan: true } }, featureOverrides: { orderBy: { featureCode: 'asc' } } },
      });
      if (!t) throw AppException.notFound('Tenant');
      const invoices = await tx.invoice.findMany({ where: { tenantId: id }, orderBy: { createdAt: 'desc' }, take: 10 });
      const redemption = await tx.couponRedemption.findFirst({ where: { tenantId: id, active: true }, include: { coupon: true } });
      const ent = t.subscription ? await this.entitlements.getEntitlements(id, tx) : null;
      const wl = await tx.whiteLabelSetting.findUnique({ where: { tenantId: id } });
      const emailDomain = await tx.emailDomain.findUnique({ where: { tenantId: id } });
      const sms = await tx.smsSenderRequest.findFirst({ where: { tenantId: id, current: true }, orderBy: { requestedAt: 'desc' } });
      const staffPortal = await tx.staffPortalDomain.findUnique({ where: { tenantId: id } });
      const sso = await tx.ssoConfig.findUnique({ where: { tenantId: id } });
      const keys = await tx.apiKey.findMany({ where: { tenantId: id }, select: { revokedAt: true, lastUsedAt: true, expiresAt: true } });
      const usage = await tx.apiUsageDaily.aggregate({
        where: { tenantId: id, date: { gte: new Date(`${lagosDate(new Date(Date.now() - 29 * DAY))}T00:00:00Z`) } },
        _sum: { requests: true, errors: true },
      });
      const support = await tx.supportRequest.findMany({
        where: { tenantId: id, status: { in: ['NEW', 'OPEN', 'WAITING_ON_HOTEL'] } },
        select: { firstResponseDue: true, firstRespondedAt: true },
      });
      return { t, invoices, redemption, ent, wl, emailDomain, sms, staffPortal, sso, keys, usage, support };
    });
    const { t, ent } = control;

    const data = await this.db.systemFor(id, async (tx) => {
      const properties = await tx.property.findMany({ where: { tenantId: id }, orderBy: { createdAt: 'asc' } });
      const staff = await tx.user.findMany({ where: { tenantId: id }, orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }] });
      const activity = await tx.auditLog.findMany({ where: { tenantId: id }, orderBy: { createdAt: 'desc' }, take: 10 });
      const payouts = await tx.payoutAccount.findMany({ where: { tenantId: id } });
      const domains = await tx.customDomain.findMany({ where: { tenantId: id } });
      const usage = await this.entitlements.getUsage(id, tx);
      return { properties, staff, activity, payouts, domains, usage };
    });

    const owner = data.staff.find((u) => u.role === 'OWNER') ?? null;
    const s = t.subscription;
    const counts = new Map([[id, { rooms: data.usage.rooms, staff: data.usage.staff, properties: data.usage.properties }]]);
    const payoutByProperty = new Map(data.payouts.map((p) => [p.propertyId, p]));
    const now = new Date();
    const activeKeys = control.keys.filter((k) => !k.revokedAt && (!k.expiresAt || k.expiresAt > now));
    const lastUsed = control.keys.reduce<Date | null>((a, k) => (k.lastUsedAt && (!a || k.lastUsedAt > a) ? k.lastUsedAt : a), null);
    const wlFeature = ent?.features.includes('white_label') ?? false;

    return {
      ...this.row(t, counts),
      state: t.state,
      owner: owner ? { id: owner.id, fullName: owner.fullName, email: owner.email, phone: owner.phone } : null,
      properties: data.properties.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        city: p.city,
        area: p.area,
        listedOnMarketplace: p.listedOnMarketplace,
      })),
      propertyCount: data.properties.length,
      subscription: s
        ? {
            planCode: s.plan.code,
            planName: ent?.subscription.planName ?? s.plan.name,
            status: s.status,
            interval: s.interval,
            trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
            currentPeriodStart: s.currentPeriodStart?.toISOString() ?? null,
            currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
            pastDueAt: s.pastDueAt?.toISOString() ?? null,
            readOnlyAt: s.readOnlyAt?.toISOString() ?? null,
            suspendedAt: s.suspendedAt?.toISOString() ?? null,
            cancelledAt: s.cancelledAt?.toISOString() ?? null,
            customPriceKobo: s.customPriceKobo,
            contractStartAt: s.contractStartAt?.toISOString() ?? null,
            contractEndAt: s.contractEndAt?.toISOString() ?? null,
            contractNotes: s.contractNotes,
            coupon: control.redemption ? redemptionView(control.redemption) : null,
          }
        : null,
      entitlements: { features: ent?.features ?? [], limits: ent?.limits ?? {}, usage: data.usage },
      usage: data.usage,
      featureOverrides: t.featureOverrides.map((o) => ({
        featureCode: o.featureCode,
        enabled: o.enabled,
        note: o.note,
        updatedAt: o.updatedAt.toISOString(),
      })),
      staff: data.staff.map((u) => ({
        id: u.id,
        fullName: u.fullName,
        email: u.email,
        role: u.role as string,
        isActive: u.isActive,
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      })),
      payout: {
        ready: data.properties.length > 0 && data.properties.every((p) => payoutByProperty.has(p.id)),
        properties: data.properties.map((p) => {
          const a = payoutByProperty.get(p.id);
          return { propertyId: p.id, name: p.name, payoutReady: !!a, bankName: a?.bankName ?? null, accountLast4: a?.accountNumberLast4 ?? null };
        }),
      },
      domains: [
        ...data.domains.map((d) => ({ propertyId: d.propertyId, domain: d.domain, status: d.status as 'PENDING' | 'VERIFIED' | 'FAILED', kind: 'BOOKING_SITE' as const })),
        ...(control.staffPortal
          ? [{ propertyId: data.properties[0]?.id ?? '', domain: control.staffPortal.domain, status: control.staffPortal.status as 'PENDING' | 'VERIFIED' | 'FAILED', kind: 'STAFF_PORTAL' as const }]
          : []),
      ],
      whiteLabel: {
        enabled: !!control.wl?.enabled && wlFeature,
        emailDomain: control.emailDomain?.domain ?? null,
        emailDomainStatus: control.emailDomain?.status ?? null,
        smsSenderId: control.sms?.senderId ?? null,
        smsSenderStatus: control.sms?.status ?? null,
      },
      sso: { enabled: !!control.sso?.enabled, provider: control.sso?.provider ?? null, enforced: !!control.sso?.enabled && !!control.sso.enforced },
      dedicatedDb: await this.provisioning.databaseView(id),
      apiUsage: {
        keys: activeKeys.length,
        requests30d: control.usage._sum.requests ?? 0,
        errors30d: control.usage._sum.errors ?? 0,
        lastUsedAt: lastUsed?.toISOString() ?? null,
      },
      support: {
        open: control.support.length,
        overdue: control.support.filter((r) => !r.firstRespondedAt && r.firstResponseDue < now).length,
      },
      offboarding: await this.offboarding.forTenant(id),
      impersonations: (await this.impersonation.list({ tenantId: id, page: 1, pageSize: 5 })).items,
      invoices: control.invoices.map(toInvoiceView),
      recentActivity: data.activity.map((r) => toAuditItem(r)),
    };
  }

  // ---------------------------------------------------------------------------
  // Enterprise onboarding (M6)
  // ---------------------------------------------------------------------------

  private adminUrl(): string {
    return this.config.get('ADMIN_URL').replace(/\/$/, '');
  }

  private async slugTaken(slug: string): Promise<boolean> {
    const hits = await this.db.systemAll((tx) =>
      Promise.all([tx.tenant.count({ where: { slug } }), tx.property.count({ where: { slug } })]),
    );
    return hits.some(([a, b]) => a + b > 0);
  }

  async createTenant(p: PlatformPrincipal, dto: CreateTenantDto, ip?: string) {
    const planCode = dto.planCode ?? 'enterprise';
    const moneyFields = dto.customPriceKobo !== undefined && dto.customPriceKobo !== null;
    if (moneyFields) this.requireBillingManage(p);
    const email = dto.owner.email.trim().toLowerCase();
    if (await this.auth.findUserByEmail(email)) {
      throw new AppException(HttpStatus.CONFLICT, ErrorCode.EMAIL_TAKEN, 'An account with this email already exists');
    }
    const plan = await this.db.system((tx) => tx.plan.findUnique({ where: { code: planCode } }));
    if (!plan) throw AppException.notFound('Plan');
    const status = dto.status ?? 'ACTIVE';
    if (status === 'TRIALING' && (!dto.trialEndsAt || new Date(dto.trialEndsAt) <= new Date())) {
      throw new AppException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR, 'trialEndsAt must be in the future', {
        fields: { trialEndsAt: ['trialEndsAt must be in the future'] },
      });
    }
    let slug = dto.slug ?? slugify(dto.name);
    if (dto.slug) {
      if (await this.slugTaken(slug)) throw AppException.conflict('This hotel address is already taken');
    } else {
      for (let i = 0; i < 6 && (await this.slugTaken(slug)); i++) slug = `${slugify(dto.name)}-${randomSuffix()}`;
    }
    const tenantId = randomUUID();
    const interval = dto.interval ?? 'MONTHLY';
    const now = new Date();
    const periodEnd = new Date(now.getTime() + (interval === 'YEARLY' ? 365 : 30) * DAY);
    const propertyName = dto.propertyName ?? dto.name;
    let ownerId: string;
    try {
      ownerId = await this.db.tenant(tenantId, async (tx) => {
        await tx.tenant.create({ data: { id: tenantId, name: dto.name, slug, city: dto.city, state: dto.state } });
        const property = await tx.property.create({
          data: { tenantId, name: propertyName, slug, city: dto.city, state: dto.state, phone: dto.owner.phone, email },
        });
        await tx.ratePlan.create({
          data: {
            tenantId, propertyId: property.id, code: 'BAR', name: 'Best Available Rate',
            description: "Flexible rate at the day's best price.", kind: 'BAR', isBar: true, pricing: 'DERIVED',
          },
        });
        const user = await tx.user.create({
          data: { tenantId, email, fullName: dto.owner.fullName, phone: dto.owner.phone, role: 'OWNER', passwordHash: '!setup' },
        });
        await tx.subscription.create({
          data: {
            tenantId, planId: plan.id, status, interval,
            trialEndsAt: status === 'TRIALING' ? new Date(dto.trialEndsAt!) : null,
            currentPeriodStart: status === 'ACTIVE' ? now : null,
            currentPeriodEnd: status === 'ACTIVE' ? periodEnd : null,
            customPriceKobo: dto.customPriceKobo ?? null,
            contractStartAt: dto.contractStartAt ? new Date(dto.contractStartAt) : null,
            contractEndAt: dto.contractEndAt ? new Date(dto.contractEndAt) : null,
            contractNotes: dto.contractNotes ?? null,
          },
        });
        await this.audit.record(tx, {
          tenantId,
          actor: platformActor(p),
          action: 'tenant.created_by_platform',
          entityType: 'tenant',
          entityId: tenantId,
          propertyId: null,
          metadata: { plan: planCode, status, interval, customPriceKobo: dto.customPriceKobo ?? null, propertyId: property.id },
          ip,
        });
        return user.id;
      });
    } catch (e) {
      if (isUniqueViolation(e, 'email')) throw new AppException(HttpStatus.CONFLICT, ErrorCode.EMAIL_TAKEN, 'An account with this email already exists');
      if (isUniqueViolation(e, 'slug')) throw AppException.conflict('This hotel address is already taken');
      throw e;
    }
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(now.getTime() + SETUP_DAYS * DAY);
    await this.db.system((tx) =>
      tx.ownerSetupToken.create({
        data: { tenantId, userId: ownerId, email, fullName: dto.owner.fullName, tokenHash: sha256Hex(`owner-setup:${token}`), expiresAt },
      }),
    );
    const ownerSetupUrl = `${this.adminUrl()}/setup-password?token=${token}`;
    const rendered = renderTemplate(
      { appName: this.config.get('APP_NAME'), appDomain: this.config.get('APP_DOMAIN'), supportEmail: this.config.get('SUPPORT_EMAIL') },
      { template: 'OWNER_SETUP', fullName: dto.owner.fullName, hotelName: dto.name, url: ownerSetupUrl, expiresHuman: humanDate(lagosDate(expiresAt)) },
    );
    await this.notifications
      .send([{ tenantId, template: 'OWNER_SETUP', channel: 'EMAIL', audience: 'HOTEL', to: email, subject: rendered.subject, text: rendered.text, html: rendered.html }])
      .catch((e: Error) => this.logger.warn(`Owner set-up email failed: ${e.message}`));
    await this.platformAudit.record({ actor: p, action: 'tenant.created', targetType: 'tenant', targetId: tenantId, tenantId, ip, metadata: { name: dto.name, slug, plan: planCode } });
    this.countsCache = null;
    this.listings.schedule(tenantId, 0);
    return { tenant: await this.tenant(tenantId), ownerSetupUrl };
  }

  // ---------------------------------------------------------------------------
  // Subscription actions
  // ---------------------------------------------------------------------------

  private requireBillingManage(p: PlatformPrincipal) {
    if (p.permissions && !p.permissions.has('billing.manage')) {
      throw new AppException(HttpStatus.FORBIDDEN, 'PLATFORM_FORBIDDEN', 'Changing prices needs the billing.manage permission', { permission: 'billing.manage' });
    }
  }

  /** After a control-plane change: dedicated mirror, public listing, caches. */
  private async afterControlChange(tenantId: string) {
    await this.mirror.sync(tenantId);
    this.listings.schedule(tenantId, 0);
  }

  async updateSubscription(actor: PlatformPrincipal, id: string, dto: UpdateTenantSubscriptionDto, ip?: string) {
    const money = ['customPriceKobo', 'contractStartAt', 'contractEndAt', 'contractNotes', 'interval'] as const;
    if (money.some((k) => dto[k] !== undefined)) this.requireBillingManage(actor);
    await this.db.system(async (tx) => {
      const sub = await tx.subscription.findUnique({ where: { tenantId: id }, include: { plan: true } });
      if (!sub) throw AppException.notFound('Subscription');
      const data: Prisma.SubscriptionUncheckedUpdateInput = {};
      if (dto.planCode !== undefined) {
        const plan = await tx.plan.findUnique({ where: { code: dto.planCode } });
        if (!plan) throw AppException.notFound('Plan');
        data.planId = plan.id;
      }
      if (dto.trialEndsAt !== undefined) data.trialEndsAt = dto.trialEndsAt ? new Date(dto.trialEndsAt) : null;
      if (dto.interval !== undefined) data.interval = dto.interval;
      if (dto.customPriceKobo !== undefined) data.customPriceKobo = dto.customPriceKobo;
      if (dto.contractStartAt !== undefined) data.contractStartAt = dto.contractStartAt ? new Date(dto.contractStartAt) : null;
      if (dto.contractEndAt !== undefined) data.contractEndAt = dto.contractEndAt ? new Date(dto.contractEndAt) : null;
      if (dto.contractNotes !== undefined) data.contractNotes = dto.contractNotes;
      if (dto.status !== undefined && dto.status !== sub.status) Object.assign(data, statusChange(sub, dto.status));
      await tx.subscription.update({ where: { id: sub.id }, data });
      await this.audit.recordControl(tx, {
        tenantId: id,
        actor: platformActor(actor),
        action: 'platform.subscription_updated',
        entityType: 'subscription',
        entityId: sub.id,
        propertyId: null,
        metadata: { from: { planCode: sub.plan.code, status: sub.status }, to: dto as Record<string, unknown> },
        ip,
      });
    });
    await this.afterControlChange(id);
    return this.tenant(id);
  }

  async extendTrial(p: PlatformPrincipal, id: string, days: number, reason: string, ip?: string) {
    await this.db.system(async (tx) => {
      const sub = await tx.subscription.findUnique({ where: { tenantId: id } });
      if (!sub) throw AppException.notFound('Subscription');
      if (!['TRIALING', 'PAST_DUE', 'READ_ONLY'].includes(sub.status) && sub.trialEndsAt === null) {
        throw new AppException(HttpStatus.CONFLICT, 'INVALID_STATE', 'Only a trial can be extended', { status: sub.status });
      }
      const from = sub.trialEndsAt && sub.trialEndsAt > new Date() ? sub.trialEndsAt : new Date();
      const trialEndsAt = new Date(from.getTime() + days * DAY);
      await tx.subscription.update({
        where: { id: sub.id },
        data: { trialEndsAt, ...(sub.status !== 'TRIALING' && sub.status !== 'ACTIVE' ? statusChange(sub, 'TRIALING') : {}) },
      });
      await this.audit.recordControl(tx, {
        tenantId: id, actor: platformActor(p), action: 'platform.trial_extended', entityType: 'subscription', entityId: sub.id,
        propertyId: null, metadata: { days, reason, trialEndsAt: trialEndsAt.toISOString() }, ip,
      });
    });
    await this.afterControlChange(id);
    return this.tenant(id);
  }

  async suspend(p: PlatformPrincipal, id: string, reason: string, ip?: string) {
    await this.db.system(async (tx) => {
      const sub = await tx.subscription.findUnique({ where: { tenantId: id } });
      if (!sub) throw AppException.notFound('Subscription');
      if (sub.status === 'SUSPENDED') throw new AppException(HttpStatus.CONFLICT, 'INVALID_STATE', 'This hotel is already suspended', { status: sub.status });
      await tx.subscription.update({ where: { id: sub.id }, data: statusChange(sub, 'SUSPENDED') });
      await this.audit.recordControl(tx, {
        tenantId: id, actor: platformActor(p), action: 'platform.tenant_suspended', entityType: 'subscription', entityId: sub.id,
        propertyId: null, metadata: { reason, previousStatus: sub.status }, ip,
      });
    });
    await this.platformAudit.record({ actor: p, action: 'tenant.suspended', targetType: 'tenant', targetId: id, tenantId: id, ip, metadata: { reason } });
    await this.afterControlChange(id);
    return this.tenant(id);
  }

  async reinstate(p: PlatformPrincipal, id: string, reason: string, ip?: string) {
    await this.db.system(async (tx) => {
      const t = await tx.tenant.findUnique({ where: { id }, include: { subscription: true } });
      if (!t?.subscription) throw AppException.notFound('Subscription');
      if (t.lifecycle !== 'ACTIVE') throw new AppException(HttpStatus.CONFLICT, 'INVALID_STATE', 'Cancel the offboarding first', { lifecycle: t.lifecycle });
      const sub = t.subscription;
      if (!['SUSPENDED', 'CANCELLED', 'READ_ONLY', 'PAST_DUE'].includes(sub.status)) {
        throw new AppException(HttpStatus.CONFLICT, 'INVALID_STATE', 'This hotel is not suspended', { status: sub.status });
      }
      const next: SubscriptionStatus = sub.trialEndsAt && sub.trialEndsAt > new Date() && !sub.currentPeriodEnd ? 'TRIALING' : 'ACTIVE';
      await tx.subscription.update({ where: { id: sub.id }, data: statusChange(sub, next) });
      await this.audit.recordControl(tx, {
        tenantId: id, actor: platformActor(p), action: 'platform.tenant_reinstated', entityType: 'subscription', entityId: sub.id,
        propertyId: null, metadata: { reason, previousStatus: sub.status, status: next }, ip,
      });
    });
    await this.platformAudit.record({ actor: p, action: 'tenant.reinstated', targetType: 'tenant', targetId: id, tenantId: id, ip, metadata: { reason } });
    await this.afterControlChange(id);
    return this.tenant(id);
  }

  async applyCoupon(p: PlatformPrincipal, id: string, code: string, ip?: string) {
    await this.tenantExists(id);
    await this.coupons.apply(id, code);
    await this.db.system((tx) =>
      this.audit.recordControl(tx, {
        tenantId: id, actor: platformActor(p), action: 'platform.coupon_applied', entityType: 'subscription', entityId: id,
        propertyId: null, metadata: { code: code.toUpperCase() }, ip,
      }),
    );
    return this.tenant(id);
  }

  async removeCoupon(p: PlatformPrincipal, id: string, ip?: string) {
    await this.tenantExists(id);
    await this.coupons.remove(id);
    await this.db.system((tx) =>
      this.audit.recordControl(tx, {
        tenantId: id, actor: platformActor(p), action: 'platform.coupon_removed', entityType: 'subscription', entityId: id, propertyId: null, ip,
      }),
    );
    return this.tenant(id);
  }

  private async tenantExists(id: string) {
    const t = await this.db.system((tx) => tx.tenant.findUnique({ where: { id }, select: { id: true } }));
    if (!t) throw AppException.notFound('Tenant');
  }

  setFeatureOverride(actor: PlatformPrincipal, id: string, dto: SetFeatureOverrideDto, ip?: string) {
    return this.db
      .system(async (tx) => {
        const tenant = await tx.tenant.findUnique({ where: { id }, select: { id: true } });
        if (!tenant) throw AppException.notFound('Tenant');
        await tx.tenantFeatureOverride.upsert({
          where: { tenantId_featureCode: { tenantId: id, featureCode: dto.featureCode } },
          create: { tenantId: id, featureCode: dto.featureCode, enabled: dto.enabled, note: dto.note ?? null },
          update: { enabled: dto.enabled, note: dto.note ?? null },
        });
        await this.audit.recordControl(tx, {
          tenantId: id, actor: platformActor(actor), action: 'platform.feature_override_set', entityType: 'tenant', entityId: id,
          propertyId: null, metadata: { featureCode: dto.featureCode, enabled: dto.enabled }, ip,
        });
      })
      .then(() => this.afterControlChange(id))
      .then(() => this.tenant(id));
  }

  removeFeatureOverride(actor: PlatformPrincipal, id: string, featureCode: string, ip?: string) {
    return this.db
      .system(async (tx) => {
        const res = await tx.tenantFeatureOverride.deleteMany({ where: { tenantId: id, featureCode } });
        if (res.count === 0) throw AppException.notFound('Feature override');
        await this.audit.recordControl(tx, {
          tenantId: id, actor: platformActor(actor), action: 'platform.feature_override_removed', entityType: 'tenant', entityId: id,
          propertyId: null, metadata: { featureCode }, ip,
        });
      })
      .then(() => this.afterControlChange(id))
      .then(() => this.tenant(id));
  }

  // ---------------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------------

  plans() {
    return this.db.system(async (tx) => {
      const plans = await tx.plan.findMany({
        include: { features: true, _count: { select: { subscriptions: true } } },
        orderBy: { sortOrder: 'asc' },
      });
      return plans.map((p) => ({ ...toPublicPlan(p), id: p.id, isActive: p.isActive, tenantCount: p._count.subscriptions }));
    });
  }

  async updatePlan(actor: PlatformPrincipal, code: string, dto: UpdatePlanDto, ip?: string) {
    if (dto.limits) {
      for (const [k, v] of Object.entries(dto.limits)) {
        if (!(LIMIT_CODES as readonly string[]).includes(k)) {
          throw AppException.badRequest(`Unknown limit "${k}"`, { allowed: LIMIT_CODES });
        }
        if (!Number.isInteger(v) || v < UNLIMITED) {
          throw AppException.badRequest(`Limit "${k}" must be an integer >= -1 (-1 = unlimited)`);
        }
      }
    }
    const result = await this.db.system(async (tx) => {
      const plan = await tx.plan.findUnique({ where: { code } });
      if (!plan) throw AppException.notFound('Plan');
      const { features, limits, ...scalar } = dto;
      const updated = await tx.plan.update({
        where: { id: plan.id },
        data: { ...scalar, ...(limits && { limits: { ...normaliseLimits(plan.limits), ...limits } }) },
      });
      if (features) {
        await tx.planFeature.deleteMany({ where: { planId: plan.id } });
        await tx.planFeature.createMany({
          data: [...new Set(features)].map((featureCode) => ({ planId: plan.id, featureCode })),
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
      return { ...toPublicPlan(full), id: full.id, isActive: full.isActive, tenantCount: full._count.subscriptions };
    });
    // The plan catalogue is mirrored into every dedicated database.
    await this.mirror.syncAll().catch((e: Error) => this.logger.warn(`Plan mirror sync failed: ${e.message}`));
    return result;
  }
}

/** Field changes for a manual status change (timestamps of the state machine). */
export function statusChange(
  sub: Pick<Subscription, 'currentPeriodEnd'>,
  status: SubscriptionStatus,
  now = new Date(),
): Prisma.SubscriptionUncheckedUpdateInput {
  const data: Prisma.SubscriptionUncheckedUpdateInput = { status };
  switch (status) {
    case 'ACTIVE':
    case 'TRIALING':
      Object.assign(data, { pastDueAt: null, readOnlyAt: null, suspendedAt: null, cancelledAt: null });
      if (status === 'ACTIVE' && (!sub.currentPeriodEnd || sub.currentPeriodEnd.getTime() < now.getTime())) {
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
  return data;
}
