import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception.js';
import { runStayHooksTx } from '../../common/stay-hooks.js';
import type { Tx } from '../../prisma/db.service.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { LedgerService, type Actor } from '../folios/ledger.service.js';
import { DocumentsService } from '../invoices/documents.service.js';
import { JobsBridge } from '../infra/jobs-bridge.js';
import { NotificationService, type OutgoingMessage } from '../notifications/notification.service.js';
import { appError, Err, k } from '../ops/ops.helpers.js';
import { cancellationOutcome, displayStatus, type CancellationOutcome } from './booking.logic.js';
import { BookingNotifier } from './booking-notifier.service.js';
import type { After } from './booking-payments.service.js';
import { paidOnline, refundedOnline, stayInclude, stayPolicy, type StayRow } from './booking-view.service.js';
import { PromosService } from '../rates/promos.service.js';
import { CommissionService } from './commission.service.js';
import { RefundsService } from './refunds.service.js';

export interface CancelRequest {
  by: 'GUEST' | 'HOTEL';
  reason: string | null;
  actor: AuditActor;
  ledgerActor: Actor;
  ip?: string;
}

/**
 * Cancelling online bookings, by the guest (policy fee applies) or by the
 * hotel (always a full refund). Runs inside the caller's tenant transaction:
 * status, folio (fee charge + refund line), refund row, commission reversal,
 * audit and notifications commit together; the Paystack refund call happens
 * after COMMIT through the returned `after`.
 */
@Injectable()
export class CancellationService {
  private readonly logger = new Logger(CancellationService.name);

  constructor(
    private readonly ledger: LedgerService,
    private readonly docs: DocumentsService,
    private readonly commission: CommissionService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly notifier: BookingNotifier,
    private readonly refunds: RefundsService,
    private readonly jobs: JobsBridge,
    private readonly promos: PromosService,
  ) {}

  preview(r: StayRow, now = new Date()): CancellationOutcome & { canCancel: boolean; reason: string | null } {
    const paid = Math.max(0, paidOnline(r) - refundedOnline(r));
    const firstNight = r.quote && typeof r.quote === 'object' ? Number((r.quote as { firstNightTotalKobo?: number }).firstNightTotalKobo ?? 0) : k(r.rateKobo);
    const outcome = cancellationOutcome({ now, arrivalAt: r.arrivalAt, policy: stayPolicy(r), paidKobo: paid, firstNightTotalKobo: firstNight, paymentMode: r.paymentMode });
    const status = displayStatus(r, now);
    let reason: string | null = null;
    if (r.status === 'CHECKED_IN') reason = 'You have already checked in. Please speak to the front desk.';
    else if (r.status === 'CHECKED_OUT') reason = 'This stay is complete.';
    else if (r.status === 'CANCELLED' || status === 'EXPIRED') reason = 'This booking is already cancelled.';
    else if (r.status === 'NO_SHOW') reason = 'This booking was marked as a no-show.';
    else if (r.arrivalAt <= now) reason = 'Check-in time has passed. Please contact the hotel.';
    // An unpaid hold is free to cancel.
    if (status === 'AWAITING_PAYMENT') return { ...outcome, feeKobo: 0, refundKobo: 0, free: true, canCancel: reason === null, reason };
    return { ...outcome, canCancel: reason === null, reason };
  }

  async cancelTx(tx: Tx, tenantId: string, reservationId: string, req: CancelRequest, now = new Date()): Promise<{ outcome: CancellationOutcome; after: After }> {
    await tx.$queryRaw`SELECT id FROM reservations WHERE id = ${reservationId}::uuid FOR UPDATE`;
    const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId }, include: stayInclude });
    if (!r) throw AppException.notFound('Booking');
    const pv = this.preview(r, now);
    if (req.by === 'GUEST' && !pv.canCancel) {
      throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', pv.reason ?? 'This booking cannot be cancelled', { status: r.status, allowed: ['PENDING', 'CONFIRMED'] });
    }
    if (req.by === 'HOTEL' && r.status !== 'PENDING' && r.status !== 'CONFIRMED') {
      throw Err.invalidState(r.status, ['PENDING', 'CONFIRMED'], 'This reservation');
    }
    // The hotel always refunds in full.
    const outcome: CancellationOutcome = req.by === 'HOTEL' ? { ...pv, feeKobo: 0, refundKobo: pv.paidKobo } : pv;
    await tx.reservation.update({
      where: { id: r.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: now,
        cancelReason: req.reason ?? (req.by === 'GUEST' ? 'Cancelled by the guest' : 'Cancelled by the hotel'),
        cancelledBy: req.by,
        cancellationFeeKobo: outcome.feeKobo,
        holdExpiresAt: null,
      },
    });
    await this.promos.release(tx, tenantId, r.id);
    await runStayHooksTx('releasedTx', tx, tenantId, r.id, { why: 'Booking cancelled' });
    const refundIds: string[] = [];
    if (outcome.paidKobo > 0 && r.folio) {
      const folio = await this.docs.loadFolio(tx, tenantId, r.folio.id);
      if (folio.status === 'OPEN') {
        if (outcome.feeKobo > 0) {
          await this.ledger.postCharge(tx, tenantId, folio, { type: 'EXTRA', description: `Cancellation fee (${r.code})`, amountKobo: outcome.feeKobo, taxable: false }, req.ledgerActor);
        }
        const payment = r.bookingPayments.find((p) => ['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(p.status));
        if (outcome.refundKobo > 0 && payment) {
          await this.ledger.postOnlineRefund(tx, tenantId, folio, { amountKobo: outcome.refundKobo, reference: payment.reference, reason: req.by === 'GUEST' ? 'Guest cancellation' : 'Cancelled by the hotel' }, req.ledgerActor);
          const refund = await tx.bookingRefund.create({
            data: {
              tenantId,
              paymentId: payment.id,
              reservationId: r.id,
              amountKobo: outcome.refundKobo,
              reason: req.by === 'GUEST' ? 'GUEST_CANCELLED' : 'HOTEL_CANCELLED',
              status: 'PENDING',
              requestedBy: req.ledgerActor.fullName,
            },
          });
          refundIds.push(refund.id);
          await this.commission.reverseForRefund(tx, {
            tenantId,
            reservationId: r.id,
            paymentId: payment.id,
            refundKobo: outcome.refundKobo,
            paidKobo: outcome.paidKobo,
            channel: r.source,
            bps: payment.commissionBps,
            note: req.by === 'GUEST' ? 'Guest cancellation refund' : 'Hotel cancellation (full refund)',
          });
        }
      }
    }
    await this.commission.reverseAccrued(tx, tenantId, r.id, req.by === 'GUEST' ? 'Cancelled by the guest' : 'Cancelled by the hotel');
    await this.audit.record(tx, {
      tenantId,
      actor: req.actor,
      action: req.by === 'GUEST' ? 'reservation.cancelled_by_guest' : 'reservation.cancelled',
      entityType: 'reservation',
      entityId: r.id,
      metadata: { code: r.code, reason: req.reason, feeKobo: outcome.feeKobo, refundKobo: outcome.refundKobo, paidKobo: outcome.paidKobo, online: true },
      ip: req.ip,
    });
    const fresh = await tx.reservation.findFirstOrThrow({ where: { id: r.id }, include: stayInclude });
    const msgs: OutgoingMessage[] = [];
    const wasHold = displayStatus(r, now) === 'AWAITING_PAYMENT';
    if (!wasHold) {
      const stay = await this.notifier.stayContext(tx, fresh);
      stay.paidKobo = outcome.paidKobo;
      msgs.push(...(await this.notifier.guest(tx, fresh, 'BOOKING_CANCELLED', { cancelledBy: req.by, feeKobo: outcome.feeKobo, refundKobo: outcome.refundKobo, reason: req.reason }, { stay, dedupe: true })));
      if (req.by === 'GUEST') {
        msgs.push(...(await this.notifier.hotel(tx, fresh, { template: 'HOTEL_BOOKING_CANCELLED', stay, adminUrl: this.notifier.adminUrl(r.id), feeKobo: outcome.feeKobo, refundKobo: outcome.refundKobo, reason: req.reason })));
      }
    }
    const ids = await this.notifications.queueTx(tx, msgs);
    return {
      outcome,
      after: async () => {
        for (const id of refundIds) await this.refunds.process(id);
        await this.notifications.dispatch(ids);
        await this.jobs.remove(`pre-arrival-${r.id}`);
        await this.jobs.remove(`hold-${r.id}`);
      },
    };
  }
}
