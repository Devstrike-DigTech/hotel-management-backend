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
import { PaystackClient } from './paystack.client.js';

export function toInvoiceView(i: Invoice) {
  return {
    id: i.id,
    reference: i.reference,
    amountKobo: i.amountKobo,
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

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly paystack: PaystackClient,
    private readonly config: AppConfigService,
  ) {}

  subscription(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const sub = await tx.subscription.findUnique({
        where: { tenantId: user.tenantId },
        include: { plan: { include: { features: true } } },
      });
      if (!sub) throw AppException.notFound('Subscription');
      const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
      const amount = priceFor(sub.plan, sub.interval);
      const dueAt =
        sub.status === 'TRIALING' ? sub.trialEndsAt : sub.currentPeriodEnd;
      const nextInvoice =
        amount !== null && dueAt && sub.status !== 'CANCELLED'
          ? {
              amountKobo: amount,
              dueAt: dueAt.toISOString(),
              planCode: sub.plan.code,
              interval: sub.interval,
            }
          : null;
      return {
        subscription: ent.subscription,
        plan: toPublicPlan(sub.plan),
        nextInvoice,
        paymentProvider: this.paystack.enabled ? 'paystack' : 'mock',
      };
    });
  }

  invoices(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
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
    const { invoice } = await this.db.tenant(user.tenantId, async (tx) => {
      const plan = await tx.plan.findUnique({ where: { code: dto.planCode } });
      if (!plan || !plan.isActive) throw AppException.notFound('Plan');
      const amount = priceFor(plan, dto.interval);
      if (amount === null) {
        throw AppException.badRequest(
          `${plan.name} is priced individually. Contact ${this.config.get('SUPPORT_EMAIL')} to upgrade.`,
        );
      }
      const sub = await tx.subscription.findUnique({
        where: { tenantId: user.tenantId },
      });
      if (!sub) throw AppException.notFound('Subscription');
      const invoice = await tx.invoice.create({
        data: {
          tenantId: user.tenantId,
          subscriptionId: sub.id,
          reference: newReference(),
          amountKobo: amount,
          planCode: plan.code,
          interval: dto.interval,
          provider: this.paystack.enabled ? 'paystack' : 'mock',
        },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'billing.checkout_started',
        entityType: 'invoice',
        entityId: invoice.id,
        metadata: {
          reference: invoice.reference,
          planCode: plan.code,
          interval: dto.interval,
          amountKobo: amount,
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
    await this.db.tenant(user.tenantId, (tx) =>
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
    return this.db.tenant(user.tenantId, async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { reference, tenantId: user.tenantId },
      });
      if (!invoice) throw AppException.notFound('Invoice');
      await this.markInvoicePaid(tx, invoice, userActor(user), ip);
      const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
      const paid = await tx.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      return { invoice: toInvoiceView(paid), subscription: ent.subscription };
    });
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
    await this.audit.record(tx, {
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
