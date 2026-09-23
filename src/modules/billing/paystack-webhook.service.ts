import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma, Subscription } from '../../generated/prisma/client.js';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { isUniqueViolation } from '../auth/auth.service.js';
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
    subscription_code?: string;
    customer?: { customer_code?: string; email?: string };
    subscription?: { subscription_code?: string };
    metadata?: { tenantId?: string } | string | null;
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

    try {
      return await this.db.system(async (tx) => {
        const ledger = await tx.paymentEvent.create({
          data: {
            provider: 'paystack',
            eventKey: key,
            eventType: type,
            payload: event as unknown as Prisma.InputJsonValue,
          },
        });
        const tenantId = await this.dispatch(tx, type, event);
        await tx.paymentEvent.update({
          where: { id: ledger.id },
          data: { processedAt: new Date(), tenantId },
        });
        return { received: true as const, handled: tenantId !== null };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'event_key') || isUniqueViolation(err, 'eventKey')) {
        this.logger.log(`Duplicate Paystack event ${key} ignored`);
        return { received: true, duplicate: true };
      }
      throw err;
    }
  }

  /** Applies the event; returns the affected tenant id (or null if ignored). */
  private async dispatch(
    tx: Tx,
    type: string,
    event: PaystackEvent,
  ): Promise<string | null> {
    const d = event.data ?? {};
    switch (type) {
      case 'charge.success':
        return this.onChargeSuccess(tx, d);
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
      await this.audit.record(tx, {
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
    await this.audit.record(tx, {
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
      await this.audit.record(tx, {
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
      await this.audit.record(tx, {
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
