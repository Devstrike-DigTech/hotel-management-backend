import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  BillingInterval,
  SubscriptionStatus,
} from '../../generated/prisma/enums.js';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import {
  LIMIT_USAGE_KEY,
  type LimitCode,
  type Usage,
} from './entitlements.constants.js';
import {
  computeFeatures,
  exceedsLimit,
  isWriteBlocked,
  normaliseLimits,
  requiredPlanFor,
  upgradePlanFor,
  type PlanLike,
} from './entitlements.logic.js';

export interface SubscriptionSummary {
  planCode: string;
  planName: string;
  status: SubscriptionStatus;
  interval: BillingInterval;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
}

export interface TenantEntitlements {
  tenantId: string;
  subscription: SubscriptionSummary;
  features: string[];
  limits: Record<string, number>;
  writeBlocked: boolean;
}

/**
 * Computes what a tenant may do: its plan's features and limits, adjusted by
 * per-tenant overrides, plus the subscription state that decides whether
 * writes are allowed.
 */
@Injectable()
export class EntitlementsService {
  constructor(private readonly db: DbService) {}

  /** Entitlements for a tenant. Pass `tx` to reuse an open tenant transaction. */
  async getEntitlements(tenantId: string, tx?: Tx): Promise<TenantEntitlements> {
    const run = async (t: Tx): Promise<TenantEntitlements> => {
      const sub = await t.subscription.findUnique({
        where: { tenantId },
        include: { plan: { include: { features: true } } },
      });
      if (!sub) {
        throw new AppException(
          HttpStatus.PAYMENT_REQUIRED,
          ErrorCode.SUBSCRIPTION_READ_ONLY,
          'This hotel has no subscription',
        );
      }
      const overrides = await t.tenantFeatureOverride.findMany({
        where: { tenantId },
        select: { featureCode: true, enabled: true },
      });
      return {
        tenantId,
        subscription: {
          planCode: sub.plan.code,
          planName: sub.plan.name,
          status: sub.status,
          interval: sub.interval,
          trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
          currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
        },
        features: computeFeatures(
          sub.plan.features.map((f) => f.featureCode),
          overrides,
        ),
        limits: normaliseLimits(sub.plan.limits),
        writeBlocked: isWriteBlocked(sub.status, sub.currentPeriodEnd),
      };
    };
    return tx ? run(tx) : this.db.tenant(tenantId, run);
  }

  async getUsage(tenantId: string, tx?: Tx): Promise<Usage> {
    const run = async (t: Tx): Promise<Usage> => {
      // Sequential on purpose: queries in one transaction share a connection.
      const rooms = await t.room.count({ where: { tenantId } });
      const staff = await t.user.count({ where: { tenantId, isActive: true } });
      const properties = await t.property.count({ where: { tenantId } });
      return { rooms, staff, properties };
    };
    return tx ? run(tx) : this.db.tenant(tenantId, run);
  }

  /** All plans as plain objects (the catalogue is readable in any context). */
  async listPlans(tx?: Tx): Promise<PlanLike[]> {
    const client = tx ?? this.db.prisma;
    const plans = await client.plan.findMany({
      include: { features: true },
      orderBy: { sortOrder: 'asc' },
    });
    return plans.map((p) => ({
      code: p.code,
      sortOrder: p.sortOrder,
      isActive: p.isActive,
      limits: normaliseLimits(p.limits),
      features: p.features.map((f) => f.featureCode),
    }));
  }

  /** Throws FEATURE_LOCKED unless the entitlements include `feature`. */
  async assertFeature(ent: TenantEntitlements, feature: string): Promise<void> {
    if (ent.features.includes(feature)) return;
    const plans = await this.listPlans();
    throw new AppException(
      HttpStatus.FORBIDDEN,
      ErrorCode.FEATURE_LOCKED,
      `Your plan does not include this feature (${feature})`,
      { feature, requiredPlan: requiredPlanFor(feature, plans) ?? 'enterprise' },
    );
  }

  /**
   * Throws LIMIT_REACHED if adding `adding` units would exceed the limit.
   * Pass `tx` when counting inside the transaction that will do the insert.
   */
  async assertWithinLimit(
    ent: TenantEntitlements,
    limit: LimitCode,
    adding = 1,
    tx?: Tx,
  ): Promise<void> {
    const max = ent.limits[limit];
    const usage = await this.getUsage(ent.tenantId, tx);
    const current = usage[LIMIT_USAGE_KEY[limit]];
    if (!exceedsLimit(max, current, adding)) return;
    const plans = await this.listPlans();
    throw new AppException(
      HttpStatus.FORBIDDEN,
      ErrorCode.LIMIT_REACHED,
      `Your plan allows ${max} (${limit}); you have ${current}`,
      {
        limit,
        max,
        current,
        upgradePlan: upgradePlanFor(
          limit,
          current + adding,
          ent.subscription.planCode,
          plans,
        ),
      },
    );
  }

  assertWritable(ent: TenantEntitlements): void {
    if (!ent.writeBlocked) return;
    throw new AppException(
      HttpStatus.PAYMENT_REQUIRED,
      ErrorCode.SUBSCRIPTION_READ_ONLY,
      ent.subscription.status === 'SUSPENDED'
        ? 'This account is suspended. Settle your subscription to continue.'
        : 'Your subscription is read-only. Renew to make changes.',
      { status: ent.subscription.status },
    );
  }
}
