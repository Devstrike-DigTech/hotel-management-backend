import { ControlMirrorService } from '../dedicated-db/control-mirror.service.js';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma, Subscription } from '../../generated/prisma/client.js';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { isUniqueViolation } from '../auth/auth.service.js';
import { BookingPaymentsService, runAfter, type After } from '../booking/booking-payments.service.js';
import { RefundsService } from '../booking/refunds.service.js';
import { ConciergePaymentsService } from '../concierge/concierge-payments.service.js';
import { BillingService } from './billing.service.js';
import { PaystackClient } from './paystack.client.js';

const PAYSTACK_ACTOR: AuditActor = { kind: 'system', name: 'Paystack' };

interface PaystackEvent {
  event?: string;
  data?: {
    id?: number | string;
    reference?: string;
    amount?: number;
    currency?: string;
    status?: string;
    paid_at?: string | null;
    channel?: string | null;
    subscription_code?: string;
    customer?: { customer_code?: string; email?: string };
    subscription?: { subscription_code?: string };
    metadata?: { tenantId?: string; kind?: string } | string | null;
    transaction_reference?: string;
    transaction?: { reference?: string };
  };
}

export interface WebhookResult {
  received: true;
  duplicate?: boolean;
  handled?: boolean;
}

/**
 * Paystack webhook processing.
 *
 * 1. The signature over the exact raw body is verified before anything else.
 * 2. An idempotency key is derived from the event and inserted into
 *    payment_events (unique). A replay hits the unique constraint and is
 *    acknowledged with 200 without being processed again.
 * 3. The ledger insert and the state change happen in ONE system transaction:
 *    if processing fails, the ledger row rolls back too and Paystack's retry
 *    will be processed normally.
 */
@Injectable()
export class PaystackWebhookService {
  private readonly logger = new Logger(PaystackWebhookService.name);

  constructor(
    private readonly db: DbService,
    private readonly paystack: PaystackClient,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
    private readonly bookings: BookingPaymentsService,
    private readonly refunds: RefundsService,
    private readonly mirror: ControlMirrorService,
    private readonly concierge: ConciergePaymentsService,
  ) {}

  async handle(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<WebhookResult> {
    if (!this.paystack.verifySignature(rawBody, signature)) {
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.INVALID_SIGNATURE,
        'Invalid webhook signature',
      );
    }
    let event: PaystackEvent;
    try {
      event = JSON.parse(rawBody!.toString('utf8')) as PaystackEvent;
    } catch {
      throw AppException.badRequest('Webhook body is not valid JSON');
    }
    const type = event.event ?? 'unknown';
    const key = eventKey(event, rawBody!);

    const after: After[] = [];
    // M6: booking payments and refunds of a tenant with a dedicated database
    // are processed there, ledger entry included (so replays stay idempotent).
    const routeTenant = await this.routeTenant(type, event);
    try {
      const result = await this.db.systemFor(routeTenant, async (tx) => {
        const ledger = await tx.paymentEvent.create({
          data: {
            provider: 'paystack',
            eventKey: key,
            eventType: type,
            payload: event as unknown as Prisma.InputJsonValue,
          },
        });
        const tenantId = await this.dispatch(tx, type, event, after);
        await tx.paymentEvent.update({
          where: { id: ledger.id },
          data: { processedAt: new Date(), tenantId },
        });
        // M6: subscription changes reach the tenant's dedicated-database mirror.
        if (tenantId && !routeTenant) after.push(async () => { await this.mirror.sync(tenantId); });
        return { received: true as const, handled: tenantId !== null };
      });
      // Notifications, refunds and jobs run only after the state change committed.
      for (const fn of after) await runAfter(fn, this.logger);
      return result;
    } catch (err) {
      if (isUniqueViolation(err, 'event_key') || isUniqueViolation(err, 'eventKey')) {
        this.logger.log(`Duplicate Paystack event ${key} ignored`);
        return { received: true, duplicate: true };
      }
      throw err;
    }
  }

  /** The dedicated-database tenant a booking or refund event belongs to (null = shared database). */
  private async routeTenant(type: string, event: PaystackEvent): Promise<string | null> {
    if (!this.db.router.activeDedicated().length) return null;
    const d = event.data ?? {};
    const meta = typeof d.metadata === 'object' && d.metadata ? d.metadata : null;
    let reference: string | null = null;
    if (type.startsWith('charge.')) {
      // M8: concierge payments live in the tenant's database too.
      if (meta?.kind === 'concierge' || ConciergePaymentsService.isConciergeReference(d.reference)) {
        const hinted = typeof meta?.tenantId === 'string' ? meta.tenantId : null;
        if (hinted && this.db.router.isDedicated(hinted)) return hinted;
        const tid = d.reference ? await this.concierge.paymentTenant(d.reference) : null;
        return tid && this.db.router.isDedicated(tid) ? tid : null;
      }
      const isBooking = meta?.kind === 'booking' || (d.reference ?? '').startsWith('BKG_');
      if (!isBooking) return null;
      const hinted = typeof meta?.tenantId === 'string' ? meta.tenantId : null;
      if (hinted && this.db.router.isDedicated(hinted)) return hinted;
      reference = d.reference ?? null;
    } else if (type.startsWith('refund.')) {
      const r = d as Record<string, unknown>;
      const nested = r.transaction as { reference?: string } | undefined;
      reference = (r.transaction_reference as string | undefined) ?? nested?.reference ?? (r.reference as string | undefined) ?? null;
    }
    if (!reference) return null;
    const tenantId = await this.bookings.paymentTenant(reference);
    return tenantId && this.db.router.isDedicated(tenantId) ? tenantId : null;
  }

  /** Applies the event; returns the affected tenant id (or null if ignored). */
  private async dispatch(
    tx: Tx,
    type: string,
    event: PaystackEvent,
    after: After[],
  ): Promise<string | null> {
    const d = event.data ?? {};
    const meta = typeof d.metadata === 'object' && d.metadata ? d.metadata : null;
    const isBooking = meta?.kind === 'booking' || (d.reference ?? '').startsWith('BKG_');
    const isConcierge = meta?.kind === 'concierge' || ConciergePaymentsService.isConciergeReference(d.reference);
    switch (type) {
      case 'charge.success':
        if (isConcierge) {
          const res = await this.concierge.applyChargeTx(tx, {
            reference: d.reference ?? '',
            amountKobo: Number(d.amount ?? 0),
            paidAt: d.paid_at ? new Date(d.paid_at) : new Date(),
            channel: d.channel ?? null,
            providerTransactionId: d.id !== undefined ? String(d.id) : null,
            source: 'webhook',
          });
          if (!res) return null;
          after.push(res.after);
          return res.tenantId;
        }
        if (isBooking) {
          const res = await this.bookings.applyChargeTx(tx, {
            reference: d.reference ?? '',
            amountKobo: Number(d.amount ?? 0),
            currency: d.currency ?? 'NGN',
            paidAt: d.paid_at ? new Date(d.paid_at) : new Date(),
            channel: d.channel ?? null,
            providerTransactionId: d.id !== undefined ? String(d.id) : null,
            source: 'webhook',
          });
          if (!res) return null;
          after.push(res.after);
          return res.tenantId;
        }
        return this.onChargeSuccess(tx, d);
      case 'charge.failed':
        if (isConcierge && d.reference) return this.concierge.onChargeFailedTx(tx, d.reference);
        return isBooking && d.reference ? this.bookings.onChargeFailedTx(tx, d.reference) : null;
      case 'refund.processed':
      case 'refund.pending':
      case 'refund.processing':
      case 'refund.failed':
        return this.refunds.onRefundEventTx(tx, type === 'refund.processing' ? 'refund.pending' : type, d as Record<string, unknown>);
      case 'subscription.create':
        return this.onSubscriptionCreate(tx, d);
      case 'subscription.disable':
        return this.onSubscriptionDisable(tx, d);
      case 'invoice.payment_failed':
        return this.onPaymentFailed(tx, d);
      default:
        this.logger.debug(`Unhandled Paystack event ${type}`);
        return null;
    }
  }

  private async onChargeSuccess(
    tx: Tx,
    d: NonNullable<PaystackEvent['data']>,
  ): Promise<string | null> {
    if (!d.reference) return null;
    const invoice = await tx.invoice.findUnique({
      where: { reference: d.reference },
    });
    if (!invoice) {
      this.logger.warn(`charge.success for unknown reference ${d.reference}`);
      return null;
    }
    if (
      typeof d.amount !== 'number' ||
      d.amount < invoice.amountKobo ||
      (d.currency && d.currency !== invoice.currency)
    ) {
      this.logger.error(
        `charge.success amount/currency mismatch for ${d.reference}: got ${d.amount} ${d.currency}, expected ${invoice.amountKobo} ${invoice.currency}`,
      );
      await this.audit.recordControl(tx, {
        tenantId: invoice.tenantId,
        actor: PAYSTACK_ACTOR,
        action: 'billing.payment_mismatch',
        entityType: 'invoice',
        entityId: invoice.id,
        metadata: { amount: d.amount, currency: d.currency },
      });
      return invoice.tenantId;
    }
    await this.billing.markInvoicePaid(tx, invoice, PAYSTACK_ACTOR);
    const customerCode = d.customer?.customer_code;
    if (customerCode) {
      await tx.subscription.update({
        where: { id: invoice.subscriptionId },
        data: { paystackCustomerCode: customerCode },
      });
    }
    return invoice.tenantId;
  }

  private async findSubscription(
    tx: Tx,
    d: NonNullable<PaystackEvent['data']>,
  ): Promise<Subscription | null> {
    const subCode = d.subscription_code ?? d.subscription?.subscription_code;
    if (subCode) {
      const s = await tx.subscription.findFirst({
        where: { paystackSubscriptionCode: subCode },
      });
      if (s) return s;
    }
    const customerCode = d.customer?.customer_code;
    if (customerCode) {
      const s = await tx.subscription.findFirst({
        where: { paystackCustomerCode: customerCode },
      });
      if (s) return s;
    }
    const meta = typeof d.metadata === 'object' ? d.metadata : null;
    if (meta?.tenantId) {
      return tx.subscription.findUnique({ where: { tenantId: meta.tenantId } });
    }
    return null;
  }

  private async onSubscriptionCreate(
    tx: Tx,
    d: NonNullable<PaystackEvent['data']>,
  ): Promise<string | null> {
    const sub = await this.findSubscription(tx, d);
    if (!sub) return null;
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        paystackSubscriptionCode: d.subscription_code ?? sub.paystackSubscriptionCode,
        paystackCustomerCode: d.customer?.customer_code ?? sub.paystackCustomerCode,
      },
    });
    await this.audit.recordControl(tx, {
      tenantId: sub.tenantId,
      actor: PAYSTACK_ACTOR,
      action: 'subscription.provider_linked',
      entityType: 'subscription',
      entityId: sub.id,
      metadata: { subscriptionCode: d.subscription_code },
    });
    return sub.tenantId;
  }

  private async onSubscriptionDisable(
    tx: Tx,
    d: NonNullable<PaystackEvent['data']>,
  ): Promise<string | null> {
    const sub = await this.findSubscription(tx, d);
    if (!sub) return null;
    if (sub.status !== 'SUSPENDED' && sub.status !== 'CANCELLED') {
      await tx.subscription.update({
        where: { id: sub.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await this.audit.recordControl(tx, {
        tenantId: sub.tenantId,
        actor: PAYSTACK_ACTOR,
        action: 'subscription.cancelled',
        entityType: 'subscription',
        entityId: sub.id,
        metadata: { previousStatus: sub.status },
      });
    }
    return sub.tenantId;
  }

  private async onPaymentFailed(
    tx: Tx,
    d: NonNullable<PaystackEvent['data']>,
  ): Promise<string | null> {
    const sub = await this.findSubscription(tx, d);
    if (!sub) return null;
    if (sub.status === 'ACTIVE') {
      await tx.subscription.update({
        where: { id: sub.id },
        data: { status: 'PAST_DUE', pastDueAt: new Date() },
      });
      await this.audit.recordControl(tx, {
        tenantId: sub.tenantId,
        actor: PAYSTACK_ACTOR,
        action: 'subscription.past_due',
        entityType: 'subscription',
        entityId: sub.id,
        metadata: { reason: 'invoice.payment_failed' },
      });
    }
    return sub.tenantId;
  }
}

/**
 * Paystack does not send a top-level event id, so the key combines the event
 * type with the most specific id in the payload, falling back to a hash of
 * the body (identical retries hash identically).
 */
export function eventKey(event: PaystackEvent, rawBody: Buffer): string {
  const d = event.data ?? {};
  const id =
    d.id ??
    d.reference ??
    d.subscription_code ??
    createHash('sha256').update(rawBody).digest('hex');
  return `paystack:${event.event ?? 'unknown'}:${id}`;
}
