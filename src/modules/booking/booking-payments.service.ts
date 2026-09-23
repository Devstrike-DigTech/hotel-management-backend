import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PromosService } from '../rates/promos.service.js';
import { randomBytes } from 'node:crypto';
import type { BookingPayment, OrphanReason } from '../../generated/prisma/client.js';
import { AppException } from '../../common/errors/app-exception.js';
import { humanDateTime, lagosDate } from '../../common/time/lagos.js';
import { maskPhone } from '../../common/utils/phone.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PaystackClient } from '../billing/paystack.client.js';
import { LedgerService, type Actor } from '../folios/ledger.service.js';
import { GuardService } from '../guard/guard.service.js';
import { DocumentsService } from '../invoices/documents.service.js';
import { NotificationService, type OutgoingMessage } from '../notifications/notification.service.js';
import { renderTemplate } from '../notifications/templates/templates.js';
import { appError, k } from '../ops/ops.helpers.js';
import { AvailabilityService } from '../reservations/availability.service.js';
import { HOLD_EXPIRED_REASON } from './booking.logic.js';
import { BookingNotifier } from './booking-notifier.service.js';
import { BookingViewService, stayInclude, type StayRow } from './booking-view.service.js';
import { CommissionService } from './commission.service.js';
import { GuestJobsService } from './guest-jobs.service.js';
import { RefundsService } from './refunds.service.js';

export const ONLINE_ACTOR: Actor = { userId: null, fullName: 'Online payment' };
const PAYSTACK_AUDIT = { kind: 'system' as const, name: 'Paystack' };
const CHANNELS = ['card', 'bank_transfer', 'ussd', 'bank'];

export interface ChargeInput {
  reference: string;
  amountKobo: number;
  currency: string;
  paidAt: Date;
  channel: string | null;
  providerTransactionId: string | null;
  source: 'webhook' | 'verify' | 'dev';
}

/** Work to do after the transaction commits (notifications, refunds, jobs). */
export type After = () => Promise<void>;

export interface PaymentInit {
  reference: string;
  authorizationUrl: string;
  accessCode: string | null;
  amountKobo: number;
  provider: 'paystack' | 'mock';
  holdExpiresAt: string;
}

const ORPHAN_TEXT: Record<OrphanReason, string> = {
  LATE_NO_INVENTORY: 'The payment arrived after the 20-minute hold ended and the room had been sold.',
  AMOUNT_MISMATCH: 'The amount received did not match the booking total.',
  BOOKING_CANCELLED: 'The booking had already been cancelled when the payment arrived.',
  DUPLICATE_PAYMENT: 'The booking had already been paid by an earlier payment.',
};

/**
 * Online payments for bookings. The success path is shared by the Paystack
 * webhook (source of truth), the callback verification and the dev mock
 * confirm, and runs under row locks on the payment and the reservation, so
 * whichever arrives first applies it and the others are no-ops.
 */
@Injectable()
export class BookingPaymentsService {
  private readonly logger = new Logger(BookingPaymentsService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: AppConfigService,
    private readonly paystack: PaystackClient,
    private readonly ledger: LedgerService,
    private readonly docs: DocumentsService,
    private readonly availability: AvailabilityService,
    private readonly commission: CommissionService,
    private readonly guard: GuardService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly notifier: BookingNotifier,
    private readonly views: BookingViewService,
    private readonly refunds: RefundsService,
    private readonly jobs: GuestJobsService,
    private readonly promos: PromosService,
  ) {}

  static newReference(): string {
    return `BKG_${randomBytes(10).toString('hex')}`;
  }

  mockCheckoutUrl(reference: string): string {
    return `${this.config.get('WEB_URL')}/pay/mock?reference=${encodeURIComponent(reference)}`;
  }

  /** Creates the Paystack transaction for a payment row (after the booking committed). */
  async initialize(tenantId: string, paymentId: string): Promise<PaymentInit> {
    const { pay, r } = await this.db.tenant(tenantId, async (tx) => {
      const pay = await tx.bookingPayment.findFirstOrThrow({ where: { id: paymentId, tenantId } });
      const r = await tx.reservation.findFirstOrThrow({ where: { id: pay.reservationId, tenantId }, include: { property: true } });
      return { pay, r };
    });
    let authorizationUrl: string;
    let accessCode: string | null = null;
    if (this.paystack.enabled) {
      const init = await this.paystack.initializeTransaction({
        email: pay.email,
        amountKobo: k(pay.amountKobo),
        reference: pay.reference,
        callbackUrl: pay.callbackUrl,
        metadata: {
          kind: 'booking',
          reservationId: r.id,
          tenantId,
          holdId: r.id,
          code: r.code,
          hotel: r.property.name,
          custom_fields: [
            { display_name: 'Booking', variable_name: 'booking_code', value: r.code },
            { display_name: 'Hotel', variable_name: 'hotel', value: r.property.name },
          ],
        },
        subaccount: pay.subaccountCode ?? undefined,
        transactionChargeKobo: k(pay.commissionKobo),
        bearer: 'subaccount',
        channels: CHANNELS,
      });
      authorizationUrl = init.authorizationUrl;
      accessCode = init.accessCode || null;
    } else {
      if (this.config.isProduction) throw appError(HttpStatus.BAD_GATEWAY, 'PAYMENT_PROVIDER_ERROR', 'Online payment is not available right now');
      authorizationUrl = this.mockCheckoutUrl(pay.reference);
    }
    await this.db.tenant(tenantId, (tx) => tx.bookingPayment.update({ where: { id: paymentId }, data: { authorizationUrl, accessCode } }));
    return {
      reference: pay.reference,
      authorizationUrl,
      accessCode,
      amountKobo: k(pay.amountKobo),
      provider: this.paystack.providerName,
      holdExpiresAt: (r.holdExpiresAt ?? new Date()).toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Success path
  // ---------------------------------------------------------------------------

  /**
   * Applies a successful charge inside the caller's platform transaction.
   * Returns null for an unknown reference, else the tenant and the follow-up
   * work to run after COMMIT.
   */
  async applyChargeTx(tx: Tx, input: ChargeInput): Promise<{ tenantId: string; after: After } | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM booking_payments WHERE reference = ${input.reference} FOR UPDATE`;
    if (!locked.length) return null;
    const pay = await tx.bookingPayment.findUniqueOrThrow({ where: { reference: input.reference } });
    if (pay.status !== 'INITIALIZED' && pay.status !== 'FAILED') {
      return { tenantId: pay.tenantId, after: async () => {} };
    }
    await tx.$queryRaw`SELECT id FROM reservations WHERE id = ${pay.reservationId}::uuid FOR UPDATE`;
    const r = await tx.reservation.findFirstOrThrow({ where: { id: pay.reservationId, tenantId: pay.tenantId }, include: stayInclude });
    const paid = { amountKobo: input.amountKobo, paidAt: input.paidAt, channel: input.channel, providerTransactionId: input.providerTransactionId };

    if (input.currency.toUpperCase() !== 'NGN' || input.amountKobo < k(pay.amountKobo)) {
      return this.orphanTx(tx, pay, r, paid, 'AMOUNT_MISMATCH');
    }
    if (r.bookingPayments.some((p) => p.id !== pay.id && ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status))) {
      return this.orphanTx(tx, pay, r, paid, 'DUPLICATE_PAYMENT');
    }
    if (r.status === 'PENDING') return this.confirmTx(tx, pay, r, paid, input.source);
    if (r.status === 'CANCELLED' && r.cancelReason === HOLD_EXPIRED_REASON) {
      // Late payment: revive the booking if the room type still has space.
      const stillAhead = lagosDate(r.arrivalAt) >= lagosDate() && r.departureAt > new Date();
      if (stillAhead) {
        try {
          await this.availability.assertAvailable(tx, r.tenantId, { roomTypeId: r.roomTypeId, roomId: r.roomId, arrivalAt: r.arrivalAt, departureAt: r.departureAt, excludeReservationId: r.id });
          await this.audit.record(tx, {
            tenantId: r.tenantId,
            actor: PAYSTACK_AUDIT,
            action: 'reservation.hold_revived',
            entityType: 'reservation',
            entityId: r.id,
            metadata: { code: r.code, reference: pay.reference },
          });
          return this.confirmTx(tx, pay, r, paid, input.source);
        } catch (e) {
          if (!(e instanceof AppException)) throw e;
        }
      }
      return this.orphanTx(tx, pay, r, paid, 'LATE_NO_INVENTORY');
    }
    return this.orphanTx(tx, pay, r, paid, 'BOOKING_CANCELLED');
  }

  private async confirmTx(
    tx: Tx,
    pay: BookingPayment,
    r: StayRow,
    paid: { amountKobo: number; paidAt: Date; channel: string | null; providerTransactionId: string | null },
    source: ChargeInput['source'],
  ): Promise<{ tenantId: string; after: After }> {
    const tenantId = r.tenantId;
    await tx.reservation.update({
      where: { id: r.id },
      data: { status: 'CONFIRMED', guaranteeType: 'PREPAID', holdExpiresAt: null, cancelledAt: null, cancelReason: null, cancelledBy: null },
    });
    await this.promos.confirm(tx, tenantId, r.id);
    const folio = await this.docs.loadFolio(tx, tenantId, r.folio!.id);
    const { entry, receipt } = await this.ledger.postPayment(
      tx,
      tenantId,
      folio,
      { method: 'CARD_ONLINE', amountKobo: paid.amountKobo, reference: pay.reference, note: `Online payment (${channelText(paid.channel)})` },
      ONLINE_ACTOR,
    );
    await tx.bookingPayment.update({
      where: { id: pay.id },
      data: {
        status: 'SUCCEEDED',
        paidAmountKobo: paid.amountKobo,
        paidAt: paid.paidAt,
        channel: paid.channel,
        providerTransactionId: paid.providerTransactionId,
        folioEntryId: entry.id,
      },
    });
    await this.commission.collect(tx, {
      tenantId,
      reservationId: r.id,
      paymentId: pay.id,
      amountKobo: k(pay.commissionKobo),
      baseKobo: paid.amountKobo,
      bps: pay.commissionBps,
      channel: r.source,
    });
    await this.audit.record(tx, {
      tenantId,
      actor: PAYSTACK_AUDIT,
      action: 'reservation.paid_online',
      entityType: 'reservation',
      entityId: r.id,
      metadata: { code: r.code, reference: pay.reference, amountKobo: paid.amountKobo, commissionKobo: k(pay.commissionKobo), channel: paid.channel, source, receiptNumber: receipt?.number ?? null },
    });
    const fresh = await tx.reservation.findFirstOrThrow({ where: { id: r.id }, include: stayInclude });
    const stay = await this.notifier.stayContext(tx, fresh);
    const msgs: OutgoingMessage[] = [
      ...(await this.notifier.guest(tx, fresh, 'BOOKING_CONFIRMED', {}, { stay, dedupe: true })),
      ...(receipt
        ? await this.notifier.guest(
            tx,
            fresh,
            'PAYMENT_RECEIPT',
            { receiptNumber: receipt.number, amountKobo: paid.amountKobo, amountInWords: receipt.amountInWords, channel: paid.channel, reference: pay.reference, paidAtHuman: humanDateTime(paid.paidAt) },
            { stay, dedupe: true },
          )
        : []),
      ...(await this.notifier.hotel(tx, fresh, {
        template: 'HOTEL_NEW_BOOKING',
        stay,
        channelLabel: fresh.source === 'BOOKING_SITE' ? 'Booking site' : 'Marketplace',
        adminUrl: this.notifier.adminUrl(fresh.id),
        commissionKobo: k(pay.commissionKobo),
        guestPhone: fresh.contactPhone ?? fresh.guest.phone ?? '',
        guestEmail: fresh.contactEmail ?? fresh.guest.email,
      })),
    ];
    const ids = await this.notifications.queueTx(tx, msgs);
    return {
      tenantId,
      after: async () => {
        await this.notifications.dispatch(ids);
        await this.jobs.cancelHoldExpiry(r.id);
        await this.jobs.schedulePreArrival(tenantId, r.id, r.arrivalAt);
      },
    };
  }

  private async orphanTx(
    tx: Tx,
    pay: BookingPayment,
    r: StayRow,
    paid: { amountKobo: number; paidAt: Date; channel: string | null; providerTransactionId: string | null },
    reason: OrphanReason,
  ): Promise<{ tenantId: string; after: After }> {
    const tenantId = r.tenantId;
    this.logger.warn(`Orphaned payment ${pay.reference} (${reason}) for ${r.code}`);
    await tx.bookingPayment.update({
      where: { id: pay.id },
      data: { status: 'ORPHANED', orphanReason: reason, paidAmountKobo: paid.amountKobo, paidAt: paid.paidAt, channel: paid.channel, providerTransactionId: paid.providerTransactionId },
    });
    const folio = r.folio ? await this.docs.loadFolio(tx, tenantId, r.folio.id) : null;
    if (folio && folio.status === 'OPEN') {
      // The money came in and goes straight back out: both lines are kept for the audit trail.
      const { entry } = await this.ledger.postPayment(
        tx,
        tenantId,
        folio,
        { method: 'CARD_ONLINE', amountKobo: paid.amountKobo, reference: pay.reference, note: 'Online payment that could not be applied', receipt: false },
        ONLINE_ACTOR,
      );
      await tx.bookingPayment.update({ where: { id: pay.id }, data: { folioEntryId: entry.id } });
      await this.ledger.postOnlineRefund(tx, tenantId, folio, { amountKobo: paid.amountKobo, reference: pay.reference, reason: ORPHAN_TEXT[reason] }, ONLINE_ACTOR);
    }
    if (k(pay.commissionKobo) > 0) {
      await this.commission.collect(tx, { tenantId, reservationId: r.id, paymentId: pay.id, amountKobo: k(pay.commissionKobo), baseKobo: paid.amountKobo, bps: pay.commissionBps, channel: r.source });
      await tx.commissionEntry.create({
        data: { tenantId, propertyId: r.propertyId, reservationId: r.id, paymentId: pay.id, kind: 'REVERSED', accrual: false, amountKobo: k(pay.commissionKobo), baseKobo: paid.amountKobo, commissionBps: pay.commissionBps, channel: r.source, note: 'Orphaned payment refunded in full' },
      });
    }
    const refund = await tx.bookingRefund.create({
      data: { tenantId, paymentId: pay.id, reservationId: r.id, amountKobo: paid.amountKobo, reason: 'PAYMENT_ORPHANED', status: 'PENDING', requestedBy: 'System' },
    });
    const features = await this.guard.features(tx, tenantId);
    await this.guard.raise(tx, tenantId, features, {
      rule: 'PAYMENT_ORPHANED',
      title: `Online payment for ${r.code} could not be applied`,
      detail: `${ORPHAN_TEXT[reason]} ${naira(paid.amountKobo)} (reference ${pay.reference}) is being refunded to ${r.guest.fullName} in full.`,
      dedupeKey: `PAYMENT_ORPHANED:${pay.id}`,
      amountKobo: paid.amountKobo,
      reservationId: r.id,
      evidence: { reference: pay.reference, reason, amountKobo: paid.amountKobo, expectedKobo: k(pay.amountKobo) },
      suggestion: 'No action needed unless the refund fails; the platform team is alerted too.',
    });
    await this.audit.record(tx, {
      tenantId,
      actor: PAYSTACK_AUDIT,
      action: 'payment.orphaned',
      entityType: 'reservation',
      entityId: r.id,
      metadata: { code: r.code, reference: pay.reference, reason, amountKobo: paid.amountKobo },
    });
    const stay = await this.notifier.stayContext(tx, r);
    const guestMsgs = await this.notifier.guest(tx, r, 'PAYMENT_ORPHANED_REFUND', { amountKobo: paid.amountKobo, reason: ORPHAN_TEXT[reason] }, { stay });
    const alert = renderTemplate(this.notifier.brand(r), {
      template: 'ORPHANED_PAYMENT_ALERT',
      hotelName: r.property.name,
      code: r.code,
      reference: pay.reference,
      amountKobo: paid.amountKobo,
      reason: ORPHAN_TEXT[reason],
      guestName: r.guest.fullName,
      guestPhone: maskPhone(r.contactPhone ?? r.guest.phone ?? ''),
      refundStatus: 'PENDING',
    });
    const hotelTo = await this.notifier.hotelRecipients(tx, r);
    const platformTo = this.config.get('PLATFORM_ALERT_EMAIL') ?? this.config.get('SUPPORT_EMAIL');
    const alerts: OutgoingMessage[] = [
      ...hotelTo.map((to) => ({ tenantId, reservationId: r.id, template: 'ORPHANED_PAYMENT_ALERT' as const, channel: 'EMAIL' as const, audience: 'HOTEL' as const, to, subject: alert.subject, text: alert.text, html: alert.html })),
      { tenantId: null, reservationId: r.id, template: 'ORPHANED_PAYMENT_ALERT', channel: 'EMAIL', audience: 'PLATFORM', to: platformTo, subject: alert.subject, text: alert.text, html: alert.html },
    ];
    const ids = await this.notifications.queueTx(tx, [...guestMsgs, ...alerts]);
    return {
      tenantId,
      after: async () => {
        await this.refunds.process(refund.id);
        await this.notifications.dispatch(ids);
      },
    };
  }

  /** Runs `applyChargeTx` in its own platform transaction, then the follow-up work. */
  async applyCharge(input: ChargeInput): Promise<boolean> {
    const res = await this.db.system((tx) => this.applyChargeTx(tx, input));
    if (!res) return false;
    await runAfter(res.after, this.logger);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Guest-facing: verify, retry, dev confirm
  // ---------------------------------------------------------------------------

  private async findPayment(reference: string) {
    const pay = await this.db.system((tx) => tx.bookingPayment.findUnique({ where: { reference } }));
    if (!pay) throw AppException.notFound('Payment');
    return pay;
  }

  async verify(reference: string) {
    const pay = await this.findPayment(reference);
    if ((pay.status === 'INITIALIZED' || pay.status === 'FAILED') && this.paystack.enabled) {
      const recent = pay.lastVerifiedAt && Date.now() - pay.lastVerifiedAt.getTime() < 5_000;
      if (!recent) {
        await this.db.system((tx) => tx.bookingPayment.update({ where: { id: pay.id }, data: { lastVerifiedAt: new Date() } }));
        try {
          const v = await this.paystack.verifyTransaction(reference);
          if (v.status === 'success') {
            await this.applyCharge({
              reference,
              amountKobo: v.amountKobo,
              currency: v.currency,
              paidAt: v.paidAt ? new Date(v.paidAt) : new Date(),
              channel: v.channel,
              providerTransactionId: v.id,
              source: 'verify',
            });
          } else if (v.status === 'failed' && pay.status === 'INITIALIZED') {
            await this.db.system((tx) => tx.bookingPayment.updateMany({ where: { id: pay.id, status: 'INITIALIZED' }, data: { status: 'FAILED' } }));
          }
        } catch (e) {
          this.logger.warn(`Verify ${reference}: ${(e as Error).message}`);
        }
      }
    }
    return this.statusView(reference);
  }

  async statusView(reference: string) {
    return this.db.system(async (tx) => {
      const pay = await tx.bookingPayment.findUnique({ where: { reference }, include: { refunds: { orderBy: { createdAt: 'desc' } } } });
      if (!pay) throw AppException.notFound('Payment');
      const r = await this.views.load(tx, pay.tenantId, pay.reservationId);
      const booking = await this.views.view(tx, r);
      const refund = pay.refunds[0] ?? null;
      let state: 'PENDING' | 'SUCCESS' | 'FAILED' | 'EXPIRED' | 'ORPHANED' | 'REFUNDED';
      let message: string;
      switch (pay.status) {
        case 'SUCCEEDED':
          state = 'SUCCESS';
          message = `Payment received. Your room at ${r.property.name} is confirmed.`;
          break;
        case 'PARTIALLY_REFUNDED':
        case 'REFUNDED':
          state = 'REFUNDED';
          message = 'This booking was cancelled and the payment refunded.';
          break;
        case 'ORPHANED':
          state = refund?.status === 'PROCESSED' ? 'REFUNDED' : 'ORPHANED';
          message = 'Your payment arrived after the room was released, so we are refunding it in full.';
          break;
        case 'FAILED':
          state = booking.displayStatus === 'AWAITING_PAYMENT' ? 'FAILED' : 'EXPIRED';
          message = state === 'FAILED' ? 'The payment did not go through. You can try again while your room is held.' : 'Your hold expired before payment was completed. Nothing was charged.';
          break;
        default:
          state = booking.displayStatus === 'AWAITING_PAYMENT' ? 'PENDING' : booking.displayStatus === 'CANCELLED' ? 'FAILED' : 'EXPIRED';
          message =
            state === 'PENDING'
              ? 'Waiting for confirmation from the payment provider.'
              : state === 'EXPIRED'
                ? 'Your hold expired before payment was completed. Nothing was charged.'
                : 'This booking was cancelled.';
      }
      const token = this.views.manageToken(r);
      return {
        reference: pay.reference,
        state,
        paymentStatus: pay.status,
        amountKobo: k(pay.amountKobo),
        paidAt: pay.paidAt?.toISOString() ?? null,
        channel: pay.channel,
        message,
        callbackUrl: pay.callbackUrl,
        booking,
        manageToken: token,
        manageUrl: this.views.tokens.manageUrl(r.code, token),
        refund: refund ? { amountKobo: k(refund.amountKobo), status: refund.status } : null,
      };
    });
  }

  /** A fresh payment attempt for a booking still on hold. */
  async retry(reference: string): Promise<PaymentInit> {
    const pay = await this.findPayment(reference);
    const created = await this.db.tenant(pay.tenantId, async (tx) => {
      const r = await tx.reservation.findFirstOrThrow({ where: { id: pay.reservationId, tenantId: pay.tenantId }, include: { bookingPayments: true } });
      if (r.bookingPayments.some((p) => ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status))) {
        throw appError(HttpStatus.CONFLICT, 'PAYMENT_ALREADY_COMPLETED', 'This booking is already paid.');
      }
      if (r.status !== 'PENDING' || !r.holdExpiresAt || r.holdExpiresAt <= new Date()) {
        throw appError(HttpStatus.CONFLICT, 'HOLD_EXPIRED', 'The room is no longer held for you. Please check availability again.', {
          expiredAt: r.holdExpiresAt?.toISOString() ?? null,
        });
      }
      return tx.bookingPayment.create({
        data: {
          tenantId: pay.tenantId,
          propertyId: r.propertyId,
          reservationId: r.id,
          reference: BookingPaymentsService.newReference(),
          provider: this.paystack.providerName,
          amountKobo: pay.amountKobo,
          commissionKobo: pay.commissionKobo,
          commissionBps: pay.commissionBps,
          subaccountCode: pay.subaccountCode,
          callbackUrl: pay.callbackUrl,
          email: pay.email,
        },
      });
    });
    return this.initialize(pay.tenantId, created.id);
  }

  /** Development only (mock provider): simulate the guest paying on the mock checkout page. */
  async devConfirm(reference: string, dto: { outcome: 'success' | 'failed'; channel?: string; amountKobo?: number }) {
    if (this.config.isProduction || this.paystack.enabled) throw AppException.notFound('Route');
    const pay = await this.findPayment(reference);
    if (dto.outcome === 'failed') {
      await this.db.system((tx) => tx.bookingPayment.updateMany({ where: { id: pay.id, status: 'INITIALIZED' }, data: { status: 'FAILED' } }));
    } else {
      await this.applyCharge({
        reference,
        amountKobo: dto.amountKobo ?? k(pay.amountKobo),
        currency: 'NGN',
        paidAt: new Date(),
        channel: dto.channel ?? 'card',
        providerTransactionId: `mock_${randomBytes(6).toString('hex')}`,
        source: 'dev',
      });
    }
    return this.statusView(reference);
  }

  /** Webhook `charge.failed`: the attempt failed (the hold keeps running). */
  async onChargeFailedTx(tx: Tx, reference: string): Promise<string | null> {
    const pay = await tx.bookingPayment.findUnique({ where: { reference } });
    if (!pay) return null;
    await tx.bookingPayment.updateMany({ where: { id: pay.id, status: 'INITIALIZED' }, data: { status: 'FAILED' } });
    return pay.tenantId;
  }
}

export async function runAfter(after: After, logger: Logger): Promise<void> {
  try {
    await after();
  } catch (e) {
    logger.error(`Follow-up work failed: ${(e as Error).message}`);
  }
}

function channelText(channel: string | null): string {
  switch (channel) {
    case 'bank_transfer':
      return 'bank transfer';
    case 'ussd':
      return 'USSD';
    case 'bank':
      return 'bank account';
    default:
      return 'card';
  }
}

function naira(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString('en-NG')}`;
}
