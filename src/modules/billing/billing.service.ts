import { ControlMirrorService } from '../dedicated-db/control-mirror.service.js';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Invoice } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import {
  AuditService,
  userActor,
  type AuditActor,
} from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { toPublicPlan } from '../plans/plan.mapper.js';
import type { CheckoutDto } from './billing.dto.js';
import { addInterval, priceFor } from './billing.periods.js';
import { couponDiscount, couponProblem, monthsAfter } from './coupons.logic.js';
import { PaystackClient } from './paystack.client.js';

export function toInvoiceView(i: Invoice) {
  return {
    id: i.id,
    reference: i.reference,
    amountKobo: i.amountKobo,
    discountKobo: i.discountKobo,
    couponCode: i.couponCode,
    status: i.status,
    planCode: i.planCode,
    interval: i.interval,
    paidAt: i.paidAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
  };
}

export function newReference(): string {
  return `INV-${randomBytes(6).toString('hex').toUpperCase()}`;
}

export function redemptionView(r: { couponId: string; monthsRemaining: number | null; appliedAt: Date; coupon: { code: string; name: string; percentOff: number | null; amountOffKobo: number | null } }) {
  return {
    couponId: r.couponId,
    code: r.coupon.code,
    name: r.coupon.name,
    percentOff: r.coupon.percentOff,
    amountOffKobo: r.coupon.amountOffKobo,
    monthsRemaining: r.monthsRemaining,
    appliedAt: r.appliedAt.toISOString(),
  };
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly paystack: PaystackClient,
    private readonly config: AppConfigService,
    private readonly mirror: ControlMirrorService,
  ) {}

  /**
   * M6: subscriptions, invoices and coupons are control-plane rows: they stay
   * in the shared database even when the tenant has a dedicated one.
   */
  subscription(user: AuthUser) {
    return this.db.control(user.tenantId, async (tx) => {
      const sub = await tx.subscription.findUnique({
        where: { tenantId: user.tenantId },
        include: { plan: { include: { features: true } } },
      });
      if (!sub) throw AppException.notFound('Subscription');
      const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
      const amount = sub.customPriceKobo ?? priceFor(sub.plan, sub.interval);
      const redemption = await this.activeRedemption(user.tenantId);
      const discount = redemption && amount !== null && redemption.monthsRemaining !== 0 ? couponDiscount(redemption.coupon, amount) : 0;
      const dueAt =
        sub.status === 'TRIALING' ? sub.trialEndsAt : sub.currentPeriodEnd;
      const nextInvoice =
        amount !== null && dueAt && sub.status !== 'CANCELLED'
          ? {
              amountKobo: amount - discount,
              discountKobo: discount,
              dueAt: dueAt.toISOString(),
              planCode: sub.plan.code,
              interval: sub.interval,
            }
          : null;
      return {
        subscription: ent.subscription,
        plan: toPublicPlan(sub.plan),
        nextInvoice,
        coupon: redemption ? redemptionView(redemption) : null,
        paymentProvider: this.paystack.enabled ? 'paystack' : 'mock',
      };
    });
  }

  /** Coupons are platform data (hotel_app cannot read them): platform connection, filtered to the tenant. */
  private activeRedemption(tenantId: string) {
    return this.db.system((tx) => tx.couponRedemption.findFirst({ where: { tenantId, active: true }, include: { coupon: true } }));
  }

  /** GET /billing/coupons/check: what a coupon would take off this plan's price. */
  async checkCoupon(user: AuthUser, q: { code: string; planCode: string; interval: 'MONTHLY' | 'YEARLY' }) {
    const coupon = await this.db.system((tx) => tx.coupon.findUnique({ where: { code: q.code } }));
    const plan = await this.db.control(user.tenantId, (tx) => tx.plan.findUnique({ where: { code: q.planCode } }));
    if (!plan || !plan.isActive) throw AppException.notFound('Plan');
    const amount = priceFor(plan, q.interval) ?? 0;
    if (!coupon) return { valid: false, reason: 'Unknown coupon code', coupon: null, amountKobo: amount, discountKobo: 0 };
    const problem = couponProblem(coupon, q.planCode, q.interval);
    const discount = problem ? 0 : couponDiscount(coupon, amount);
    return {
      valid: !problem,
      reason: problem,
      coupon: { code: coupon.code, name: coupon.name, percentOff: coupon.percentOff, amountOffKobo: coupon.amountOffKobo, durationMonths: coupon.durationMonths },
      amountKobo: amount - discount,
      discountKobo: discount,
    };
  }

  invoices(user: AuthUser) {
    return this.db.control(user.tenantId, async (tx) => {
      const rows = await tx.invoice.findMany({
        where: { tenantId: user.tenantId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return rows.map(toInvoiceView);
    });
  }

  /**
   * Creates a PENDING invoice and returns where to send the user to pay.
   * With PAYSTACK_SECRET_KEY: a Paystack hosted checkout URL.
   * Without it (non-production only): a mock checkout page on the admin app,
   * completed via POST /billing/dev/confirm.
   */
  async checkout(user: AuthUser, dto: CheckoutDto, ip?: string) {
    if (!this.paystack.enabled && this.config.isProduction) {
      throw new AppException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.PAYMENT_PROVIDER_ERROR,
        'Online payments are not configured',
      );
    }
    const coupon = dto.couponCode ? await this.db.system((tx) => tx.coupon.findUnique({ where: { code: dto.couponCode } })) : null;
    if (dto.couponCode && !coupon) throw AppException.badRequest('Unknown coupon code', { couponCode: dto.couponCode });
    const existing = await this.activeRedemption(user.tenantId);
    const { invoice } = await this.db.control(user.tenantId, async (tx) => {
      const plan = await tx.plan.findUnique({ where: { code: dto.planCode } });
      if (!plan || !plan.isActive) throw AppException.notFound('Plan');
      const sub = await tx.subscription.findUnique({
        where: { tenantId: user.tenantId },
      });
      if (!sub) throw AppException.notFound('Subscription');
      // M6: an Enterprise contract price applies to the tenant's own plan.
      const custom = sub.customPriceKobo !== null && sub.planId === plan.id && sub.interval === dto.interval ? sub.customPriceKobo : null;
      const amount = custom ?? priceFor(plan, dto.interval);
      if (amount === null) {
        throw AppException.badRequest(
          `${plan.name} is priced individually. Contact ${this.config.get('SUPPORT_EMAIL')} to upgrade.`,
        );
      }
      // A new coupon, or the months left on the one already applied.
      let discount = 0;
      let couponCode: string | null = null;
      if (coupon) {
        const problem = couponProblem(coupon, plan.code, dto.interval);
        if (problem) throw AppException.badRequest(problem, { couponCode: coupon.code });
        if (existing && existing.couponId !== coupon.id) throw AppException.badRequest('Another coupon is already applied to this subscription', { couponCode: coupon.code });
        discount = couponDiscount(coupon, amount);
        couponCode = coupon.code;
      } else {
        if (existing && existing.monthsRemaining !== 0 && !couponProblem({ ...existing.coupon, active: true, validUntil: null, maxRedemptions: null }, plan.code, dto.interval)) {
          discount = couponDiscount(existing.coupon, amount);
          couponCode = existing.coupon.code;
        }
      }
      const invoice = await tx.invoice.create({
        data: {
          tenantId: user.tenantId,
          subscriptionId: sub.id,
          reference: newReference(),
          amountKobo: amount - discount,
          discountKobo: discount,
          couponCode,
          planCode: plan.code,
          interval: dto.interval,
          provider: this.paystack.enabled ? 'paystack' : 'mock',
        },
      });
      await this.audit.recordControl(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'billing.checkout_started',
        entityType: 'invoice',
        entityId: invoice.id,
        metadata: {
          reference: invoice.reference,
          planCode: plan.code,
          interval: dto.interval,
          amountKobo: amount - discount,
          ...(couponCode && { couponCode, discountKobo: discount }),
        },
        ip,
      });
      return { invoice };
    });

    let authorizationUrl: string;
    if (this.paystack.enabled) {
      const res = await this.paystack.initializeTransaction({
        email: user.email,
        amountKobo: invoice.amountKobo,
        reference: invoice.reference,
        callbackUrl: `${this.config.get('ADMIN_URL')}/billing/callback`,
        metadata: {
          tenantId: user.tenantId,
          invoiceId: invoice.id,
          planCode: invoice.planCode,
          interval: invoice.interval,
        },
      });
      authorizationUrl = res.authorizationUrl;
    } else {
      authorizationUrl = `${this.config.get('ADMIN_URL')}/billing/mock-checkout?reference=${encodeURIComponent(invoice.reference)}`;
    }
    await this.db.control(user.tenantId, (tx) =>
      tx.invoice.update({
        where: { id: invoice.id },
        data: { authorizationUrl },
      }),
    );
    return { authorizationUrl, reference: invoice.reference };
  }

  /** Dev-only: completes a mock checkout as if Paystack had confirmed it. */
  async devConfirm(user: AuthUser, reference: string, ip?: string) {
    if (this.config.isProduction) throw AppException.notFound('Route');
    // Dev only: the platform connection, like the webhook it stands in for.
    const out = await this.db.system(async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { reference, tenantId: user.tenantId },
      });
      if (!invoice) throw AppException.notFound('Invoice');
      await this.markInvoicePaid(tx, invoice, userActor(user), ip);
      const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
      const paid = await tx.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      return { invoice: toInvoiceView(paid), subscription: ent.subscription };
    });
    await this.mirror.sync(user.tenantId);
    return out;
  }

  /**
   * Marks an invoice paid and activates/extends the subscription on the
   * invoice's plan. Idempotent: an already-paid invoice is a no-op. Works in
   * a tenant transaction (dev confirm) or a system transaction (webhook).
   */
  async markInvoicePaid(
    tx: Tx,
    invoice: Invoice,
    actor: AuditActor | null,
    ip?: string,
    paidAt: Date = new Date(),
  ): Promise<boolean> {
    if (invoice.status === 'PAID') return false;
    const plan = await tx.plan.findUnique({ where: { code: invoice.planCode } });
    if (!plan) throw new Error(`Invoice ${invoice.reference} has unknown plan`);
    const sub = await tx.subscription.findUniqueOrThrow({
      where: { id: invoice.subscriptionId },
    });

    // Renewing early extends from the current period end; otherwise from now.
    const extendFrom =
      sub.status === 'ACTIVE' &&
      sub.currentPeriodEnd &&
      sub.currentPeriodEnd.getTime() > paidAt.getTime() &&
      sub.planId === plan.id &&
      sub.interval === invoice.interval
        ? sub.currentPeriodEnd
        : paidAt;
    const periodEnd = addInterval(extendFrom, invoice.interval);

    await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: 'PAID', paidAt },
    });
    // M6: the coupon on this invoice starts (or continues) its redemption.
    if (invoice.couponCode) {
      const coupon = await tx.coupon.findUnique({ where: { code: invoice.couponCode } });
      if (coupon) {
        const existing = await tx.couponRedemption.findFirst({ where: { tenantId: invoice.tenantId, active: true } });
        if (!existing) {
          const left = monthsAfter(coupon.durationMonths, invoice.interval);
          await tx.couponRedemption.create({ data: { tenantId: invoice.tenantId, couponId: coupon.id, monthsRemaining: left, active: left !== 0 } });
          await tx.coupon.update({ where: { id: coupon.id }, data: { redemptions: { increment: 1 } } });
        } else if (existing.couponId === coupon.id) {
          const left = monthsAfter(existing.monthsRemaining, invoice.interval);
          await tx.couponRedemption.update({ where: { id: existing.id }, data: { monthsRemaining: left, ...(left === 0 && { active: false, endedAt: paidAt }) } });
        }
      }
    }
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        planId: plan.id,
        status: 'ACTIVE',
        interval: invoice.interval,
        currentPeriodStart: extendFrom,
        currentPeriodEnd: periodEnd,
        pastDueAt: null,
        readOnlyAt: null,
        suspendedAt: null,
        cancelledAt: null,
      },
    });
    await this.audit.recordControl(tx, {
      tenantId: invoice.tenantId,
      actor,
      action: 'subscription.activated',
      entityType: 'subscription',
      entityId: sub.id,
      metadata: {
        reference: invoice.reference,
        amountKobo: invoice.amountKobo,
        planCode: plan.code,
        interval: invoice.interval,
        previousStatus: sub.status,
        currentPeriodEnd: periodEnd.toISOString(),
      },
      ip,
    });
    this.logger.log(
      `Invoice ${invoice.reference} paid; tenant ${invoice.tenantId} active on ${plan.code} until ${periodEnd.toISOString()}`,
    );
    return true;
  }
}
