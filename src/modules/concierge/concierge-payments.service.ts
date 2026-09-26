import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { ConciergePayment, Prisma } from '../../generated/prisma/client.js';
import { AppException } from '../../common/errors/app-exception.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PaystackClient } from '../billing/paystack.client.js';
import { LedgerService, type Actor } from '../folios/ledger.service.js';
import type { TaxComponent } from '../folios/tax.logic.js';
import { DocumentsService } from '../invoices/documents.service.js';
import { NotificationService, type OutgoingMessage } from '../notifications/notification.service.js';
import { appError } from '../ops/ops.helpers.js';
import { ConciergeNotifier } from './concierge-notifier.service.js';
import { chargeOf, ConciergeService, requestInclude, timelineOf, type RequestRow, type TimelineEvent } from './concierge.service.js';
import { folioDescription } from './concierge.logic.js';

const PAYSTACK: Actor = { userId: null, fullName: 'Paystack' };
const CHANNELS = ['card', 'bank_transfer', 'ussd', 'bank'];

export interface ConciergePaymentInit {
  reference: string;
  authorizationUrl: string;
  amountKobo: number;
  provider: 'paystack' | 'mock';
}

export type After = () => Promise<void>;

interface ChargeInput {
  reference: string;
  amountKobo: number;
  paidAt: Date;
  channel: string | null;
  providerTransactionId: string | null;
  source: 'webhook' | 'verify' | 'dev';
}

/**
 * Online payment of concierge requests (M8): a Paystack transaction to the
 * property's subaccount (no platform commission), reference `CRQ_...`.
 * The webhook, the callback verification and the dev confirm share one
 * success path under a row lock: payment PAID, the charge and a CARD_ONLINE
 * payment posted to the stay's folio (or a walk-in folio closed at zero),
 * receipt, request confirmed, guest told.
 */
@Injectable()
export class ConciergePaymentsService {
  private readonly logger = new Logger(ConciergePaymentsService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: AppConfigService,
    private readonly paystack: PaystackClient,
    private readonly core: ConciergeService,
    private readonly notifier: ConciergeNotifier,
    private readonly ledger: LedgerService,
    private readonly docs: DocumentsService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
  ) {}

  static isConciergeReference(reference: string | null | undefined): boolean {
    return !!reference && reference.startsWith('CRQ_');
  }

  /** Online payment is possible: the setting is on and the property has a payout account. */
  async availableTx(tx: Tx, tenantId: string, propertyId: string): Promise<boolean> {
    const s = await this.core.settingsTx(tx, tenantId, propertyId);
    if (!s.payOnline) return false;
    const p = await tx.property.findFirst({ where: { id: propertyId, tenantId }, select: { payoutReady: true } });
    return !!p?.payoutReady;
  }

  /** Creates the payment row (inside the business transaction); initialise it after the commit. */
  async createTx(tx: Tx, r: RequestRow, email: string | null): Promise<ConciergePayment> {
    const amount = chargeOf(r)?.totalKobo ?? 0;
    if (amount <= 0) throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'There is nothing to pay for this request', { status: r.status, allowed: [] });
    if (!(await this.availableTx(tx, r.tenantId, r.propertyId))) throw appError(HttpStatus.CONFLICT, 'PAYMENT_UNAVAILABLE', 'Online payment is not available at this hotel. Choose to add it to your bill, or call the hotel.');
    const to = email ?? r.contactEmail ?? r.guest.email;
    if (!to) {
      throw appError(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'An email address is needed to pay online (for your receipt)', {
        fields: { email: ['An email address is needed to pay online (for your receipt)'] },
        issues: [{ path: 'email', fieldKey: 'email', code: 'REQUIRED', message: 'An email address is needed to pay online (for your receipt)' }],
      });
    }
    // Earlier unpaid attempts are superseded.
    await tx.conciergePayment.updateMany({ where: { requestId: r.id, status: 'INITIALIZED' }, data: { status: 'FAILED' } });
    const payout = await tx.payoutAccount.findUnique({ where: { propertyId: r.propertyId }, select: { subaccountCode: true } });
    const pay = await tx.conciergePayment.create({
      data: {
        tenantId: r.tenantId,
        propertyId: r.propertyId,
        requestId: r.id,
        reference: `CRQ_${randomBytes(10).toString('hex')}`,
        amountKobo: amount,
        email: to.toLowerCase(),
        quoteVersion: r.quoteVersion,
        subaccountCode: payout?.subaccountCode ?? null,
      },
    });
    await tx.conciergeRequest.update({ where: { id: r.id }, data: { paymentMethod: 'ONLINE', paymentStatus: 'PENDING', paymentReference: pay.reference } });
    return pay;
  }

  returnUrl(r: Pick<RequestRow, 'tenantId' | 'id' | 'quoteVersion' | 'quoteValidUntil' | 'reservation'> & { reservation: RequestRow['reservation'] }): string {
    const q = this.notifier.quoteLink(r);
    if (q) return q.url;
    return this.notifier.tripUrl(r.reservation ? { tenantId: r.tenantId, id: r.reservation.id, code: r.reservation.code, departureAt: r.reservation.departureAt } : null);
  }

  /** Creates the Paystack transaction (after the business transaction committed). */
  async initialize(tenantId: string, paymentId: string): Promise<ConciergePaymentInit> {
    const { pay, r, property } = await this.db.tenant(tenantId, async (tx) => {
      const pay = await tx.conciergePayment.findFirstOrThrow({ where: { id: paymentId, tenantId } });
      const r = await tx.conciergeRequest.findFirstOrThrow({ where: { id: pay.requestId, tenantId }, include: requestInclude });
      const property = await tx.property.findFirstOrThrow({ where: { id: r.propertyId, tenantId } });
      return { pay, r, property };
    });
    const back = this.returnUrl(r);
    let authorizationUrl: string;
    let accessCode: string | null = null;
    if (this.paystack.enabled) {
      const init = await this.paystack.initializeTransaction({
        email: pay.email,
        amountKobo: pay.amountKobo,
        reference: pay.reference,
        callbackUrl: `${back}${back.includes('?') ? '&' : '?'}reference=${encodeURIComponent(pay.reference)}`,
        metadata: {
          kind: 'concierge',
          tenantId,
          requestId: r.id,
          number: r.number,
          hotel: property.name,
          custom_fields: [
            { display_name: 'Request', variable_name: 'request_number', value: r.number },
            { display_name: 'Hotel', variable_name: 'hotel', value: property.name },
          ],
        },
        subaccount: pay.subaccountCode ?? undefined,
        transactionChargeKobo: 0,
        bearer: 'subaccount',
        channels: CHANNELS,
      });
      authorizationUrl = init.authorizationUrl;
      accessCode = init.accessCode || null;
    } else {
      if (this.config.isProduction) throw appError(HttpStatus.BAD_GATEWAY, 'PAYMENT_PROVIDER_ERROR', 'Online payment is not available right now');
      authorizationUrl = this.notifier.mockCheckoutUrl(pay.reference);
    }
    await this.db.tenant(tenantId, (tx) => tx.conciergePayment.update({ where: { id: paymentId }, data: { authorizationUrl, accessCode } }));
    return { reference: pay.reference, authorizationUrl, amountKobo: pay.amountKobo, provider: this.paystack.providerName };
  }

  // ---------------------------------------------------------------------------
  // Success path
  // ---------------------------------------------------------------------------

  /** The tenant of a payment reference (dedicated databases included). */
  async paymentTenant(reference: string): Promise<string | null> {
    const rows = await this.db.systemAll((tx, t) => tx.conciergePayment.findFirst({ where: { reference, ...t.tenants }, select: { tenantId: true } }));
    return rows.find((x) => x)?.tenantId ?? null;
  }

  /**
   * Applies a successful charge inside the caller's platform transaction.
   * Null for an unknown reference; otherwise the tenant and the work to run
   * after COMMIT (messages, refunds of late or short payments).
   */
  async applyChargeTx(tx: Tx, input: ChargeInput): Promise<{ tenantId: string; after: After } | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM concierge_payments WHERE reference = ${input.reference} FOR UPDATE`;
    if (!locked.length) return null;
    const pay = await tx.conciergePayment.findUniqueOrThrow({ where: { reference: input.reference } });
    if (pay.status !== 'INITIALIZED' && pay.status !== 'FAILED') return { tenantId: pay.tenantId, after: async () => {} };
    await tx.$queryRaw`SELECT id FROM concierge_requests WHERE id = ${pay.requestId}::uuid FOR UPDATE`;
    const r = await tx.conciergeRequest.findUniqueOrThrow({ where: { id: pay.requestId }, include: requestInclude });
    const now = new Date();
    const refund = async (why: string) => {
      await tx.conciergePayment.update({ where: { id: pay.id }, data: { status: 'REFUNDED', paidAt: input.paidAt, channel: input.channel, providerTransactionId: input.providerTransactionId, refundedAt: now } });
      const ev: TimelineEvent = { at: now.toISOString(), type: 'payment_refunded', status: null, note: why, by: 'Paystack', guestVisible: true };
      await tx.conciergeRequest.update({ where: { id: r.id }, data: { timeline: [...timelineOf(r), ev] as Prisma.InputJsonValue } });
      return { tenantId: pay.tenantId, after: async () => { await this.refundProvider(pay.reference, input.amountKobo, why); } };
    };
    if (input.amountKobo < pay.amountKobo) return refund('The amount paid did not match the price, so it was refunded in full.');
    if (['CANCELLED', 'DECLINED'].includes(r.status) || r.paymentReference !== pay.reference) return refund('This payment arrived after the request had changed, so it was refunded in full.');

    await tx.conciergePayment.update({ where: { id: pay.id }, data: { status: 'SUCCEEDED', paidAt: input.paidAt, channel: input.channel, providerTransactionId: input.providerTransactionId } });
    const settings = await this.core.settingsTx(tx, r.tenantId, r.propertyId);
    const description = folioDescription({ ...r, location: r.location }, { inRoom: settings.folioLabelInRoom, other: settings.folioLabelOther });
    const charge = chargeOf(r)!;
    const comps = (r.taxComponents as unknown as TaxComponent[]) ?? [];
    // The stay's folio when open, else a walk-in folio closed at zero.
    let folioId = r.reservation?.folio?.status === 'OPEN' ? r.reservation.folio.id : null;
    let walkIn = false;
    if (!folioId) {
      const f = await tx.folio.create({ data: { tenantId: r.tenantId, propertyId: r.propertyId, kind: 'WALK_IN', name: `Concierge ${r.number}`, guestId: r.guestId, notes: 'Concierge request paid online' } });
      folioId = f.id;
      walkIn = true;
    }
    const folio = await this.docs.loadFolio(tx, r.tenantId, folioId);
    const entry = await this.ledger.postExtra(tx, r.tenantId, folio, { description, enteredKobo: charge.amountKobo, comps }, PAYSTACK);
    const reloaded = await this.docs.loadFolio(tx, r.tenantId, folioId);
    const { receipt } = await this.ledger.postPayment(tx, r.tenantId, reloaded, { method: 'CARD_ONLINE', amountKobo: input.amountKobo, reference: pay.reference, note: `Concierge ${r.number}` }, PAYSTACK);
    if (walkIn) await tx.folio.update({ where: { id: folioId }, data: { status: 'CLOSED', closedAt: now } });
    const confirm = r.status === 'AWAITING_GUEST';
    const events: TimelineEvent[] = [{ at: now.toISOString(), type: 'payment_received', status: null, note: 'Paid online', by: 'Paystack', guestVisible: true }];
    if (confirm) events.push({ at: now.toISOString(), type: 'status', status: 'CONFIRMED', note: null, by: 'Paystack', guestVisible: true });
    const updated = await tx.conciergeRequest.update({
      where: { id: r.id },
      data: {
        paymentStatus: 'PAID',
        paidAt: input.paidAt,
        folioId,
        folioEntryId: entry.id,
        postedAt: now,
        folioDescription: description,
        ...(confirm && { status: 'CONFIRMED' }),
        firstResponseAt: r.firstResponseAt ?? now,
        timeline: [...timelineOf(r), ...events] as Prisma.InputJsonValue,
      },
      include: requestInclude,
    });
    await this.audit.record(tx, {
      tenantId: r.tenantId, actor: { kind: 'system', name: 'Paystack' }, action: 'concierge_request.paid', entityType: 'concierge_request', entityId: r.id, propertyId: r.propertyId,
      metadata: { number: r.number, amountKobo: input.amountKobo, reference: pay.reference, receiptNumber: receipt?.number ?? null, source: input.source },
    });
    const property = await tx.property.findFirstOrThrow({ where: { id: r.propertyId } });
    const msgs: OutgoingMessage[] = await this.notifier.guest(tx, updated, property, { template: 'CONCIERGE_CONFIRMED', url: this.returnUrl(updated) });
    const ids = await this.notifications.queueTx(tx, msgs);
    return { tenantId: r.tenantId, after: async () => { await this.notifications.dispatch(ids); } };
  }

  private async applyCharge(input: ChargeInput) {
    const tid = await this.paymentTenant(input.reference);
    const after: After[] = [];
    await this.db.systemFor(tid, async (tx) => {
      const res = await this.applyChargeTx(tx, input);
      if (res) after.push(res.after);
    });
    for (const fn of after) await fn().catch((e: Error) => this.logger.error(`Concierge payment follow-up failed: ${e.message}`));
  }

  async refundProvider(reference: string, amountKobo: number, note: string): Promise<void> {
    try {
      const res = await this.paystack.refund(reference, amountKobo, note);
      const tid = await this.paymentTenant(reference);
      await this.db.systemFor(tid, (tx) => tx.conciergePayment.update({ where: { reference }, data: { status: 'REFUNDED', refundedAt: new Date(), refundReference: res.id } }));
    } catch (e) {
      this.logger.error(`Concierge refund ${reference} failed: ${(e as Error).message}`);
    }
  }

  async onChargeFailedTx(tx: Tx, reference: string): Promise<string | null> {
    const pay = await tx.conciergePayment.findUnique({ where: { reference } });
    if (!pay) return null;
    await tx.conciergePayment.updateMany({ where: { id: pay.id, status: 'INITIALIZED' }, data: { status: 'FAILED' } });
    return pay.tenantId;
  }

  // ---------------------------------------------------------------------------
  // Verify, dev confirm, status
  // ---------------------------------------------------------------------------

  private async find(reference: string) {
    const tid = await this.paymentTenant(reference);
    if (!tid) throw AppException.notFound('Payment');
    const pay = await this.db.systemFor(tid, (tx) => tx.conciergePayment.findUnique({ where: { reference } }));
    if (!pay) throw AppException.notFound('Payment');
    return pay;
  }

  async verify(reference: string) {
    const pay = await this.find(reference);
    if ((pay.status === 'INITIALIZED' || pay.status === 'FAILED') && this.paystack.enabled) {
      const recent = pay.lastVerifiedAt && Date.now() - pay.lastVerifiedAt.getTime() < 5_000;
      if (!recent) {
        await this.db.systemFor(pay.tenantId, (tx) => tx.conciergePayment.update({ where: { id: pay.id }, data: { lastVerifiedAt: new Date() } }));
        try {
          const v = await this.paystack.verifyTransaction(reference);
          if (v.status === 'success') {
            await this.applyCharge({ reference, amountKobo: v.amountKobo, paidAt: v.paidAt ? new Date(v.paidAt) : new Date(), channel: v.channel, providerTransactionId: v.id, source: 'verify' });
          } else if (v.status === 'failed') {
            await this.db.systemFor(pay.tenantId, (tx) => tx.conciergePayment.updateMany({ where: { id: pay.id, status: 'INITIALIZED' }, data: { status: 'FAILED' } }));
          }
        } catch (e) {
          this.logger.warn(`Verify ${reference}: ${(e as Error).message}`);
        }
      }
    }
    return this.statusView(reference);
  }

  async devConfirm(reference: string, dto: { outcome: 'success' | 'failed'; channel?: string; amountKobo?: number }) {
    if (this.config.isProduction || this.paystack.enabled) throw AppException.notFound('Route');
    const pay = await this.find(reference);
    if (dto.outcome === 'failed') {
      await this.db.systemFor(pay.tenantId, (tx) => tx.conciergePayment.updateMany({ where: { id: pay.id, status: 'INITIALIZED' }, data: { status: 'FAILED' } }));
    } else {
      await this.applyCharge({ reference, amountKobo: dto.amountKobo ?? pay.amountKobo, paidAt: new Date(), channel: dto.channel ?? 'card', providerTransactionId: `mock_${randomBytes(6).toString('hex')}`, source: 'dev' });
    }
    return this.statusView(reference);
  }

  async statusView(reference: string) {
    const pay = await this.find(reference);
    const r = await this.db.systemFor(pay.tenantId, (tx) => tx.conciergeRequest.findUniqueOrThrow({ where: { id: pay.requestId }, include: requestInclude }));
    const state = pay.status === 'SUCCEEDED' ? 'SUCCESS' : pay.status === 'INITIALIZED' ? 'PENDING' : 'FAILED';
    const message =
      state === 'SUCCESS' ? `Paid. Request ${r.number} is confirmed.`
        : state === 'PENDING' ? 'We are waiting for the payment to come through.'
          : pay.status === 'REFUNDED' ? 'This payment was refunded in full.' : 'The payment did not go through. You can try again.';
    return { kind: 'CONCIERGE' as const, reference, state, message, amountKobo: pay.amountKobo, requestNumber: r.number, returnUrl: this.returnUrl(r) };
  }
}
