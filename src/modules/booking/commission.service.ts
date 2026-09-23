import { Injectable } from '@nestjs/common';
import type { ReservationSource } from '../../generated/prisma/enums.js';
import type { Tx } from '../../prisma/db.service.js';
import { k } from '../ops/ops.helpers.js';
import { commissionReversal } from './booking.logic.js';

export interface CommissionTotals {
  collectedKobo: number;
  accruedKobo: number;
  reversedKobo: number;
  /** Reversals of collected commission. */
  reversedCollectedKobo: number;
  /** Reversals of accrued (receivable) commission. */
  reversedAccruedKobo: number;
  netKobo: number;
}

/**
 * The commission ledger (append-only for the API). COLLECTED = taken by the
 * Paystack split at payment time; ACCRUED = pay-at-hotel marketplace booking,
 * receivable from the hotel; REVERSED = refunds / cancellations / no-shows,
 * with `accrual` telling which side it reduces. All calls run inside the
 * caller's transaction.
 */
@Injectable()
export class CommissionService {
  async totals(tx: Tx, reservationId: string): Promise<CommissionTotals> {
    const rows = await tx.commissionEntry.findMany({ where: { reservationId } });
    const sum = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((a, r) => a + k(r.amountKobo), 0);
    const collected = sum((r) => r.kind === 'COLLECTED');
    const accrued = sum((r) => r.kind === 'ACCRUED');
    const revC = sum((r) => r.kind === 'REVERSED' && !r.accrual);
    const revA = sum((r) => r.kind === 'REVERSED' && r.accrual);
    return {
      collectedKobo: collected,
      accruedKobo: accrued,
      reversedKobo: revC + revA,
      reversedCollectedKobo: revC,
      reversedAccruedKobo: revA,
      netKobo: collected + accrued - revC - revA,
    };
  }

  private async propertyOf(tx: Tx, reservationId: string): Promise<string> {
    return (await tx.reservation.findUniqueOrThrow({ where: { id: reservationId }, select: { propertyId: true } })).propertyId;
  }

  async accrue(tx: Tx, e: { tenantId: string; reservationId: string; amountKobo: number; baseKobo: number; bps: number; channel: ReservationSource }) {
    if (e.amountKobo <= 0) return;
    await tx.commissionEntry.create({
      data: {
        tenantId: e.tenantId,
        propertyId: await this.propertyOf(tx, e.reservationId),
        reservationId: e.reservationId,
        kind: 'ACCRUED',
        amountKobo: e.amountKobo,
        baseKobo: e.baseKobo,
        commissionBps: e.bps,
        channel: e.channel,
        note: 'Pay-at-hotel marketplace booking (receivable)',
      },
    });
  }

  async collect(tx: Tx, e: { tenantId: string; reservationId: string; paymentId: string; amountKobo: number; baseKobo: number; bps: number; channel: ReservationSource }) {
    if (e.amountKobo <= 0) return;
    await tx.commissionEntry.create({
      data: {
        tenantId: e.tenantId,
        propertyId: await this.propertyOf(tx, e.reservationId),
        reservationId: e.reservationId,
        paymentId: e.paymentId,
        kind: 'COLLECTED',
        amountKobo: e.amountKobo,
        baseKobo: e.baseKobo,
        commissionBps: e.bps,
        channel: e.channel,
        note: 'Split at payment (Paystack transaction charge)',
      },
    });
  }

  /**
   * Reverses collected commission in proportion to a refund
   * (commission x refund / paid). Returns the amount reversed.
   */
  async reverseForRefund(
    tx: Tx,
    e: { tenantId: string; reservationId: string; paymentId: string | null; refundKobo: number; paidKobo: number; channel: ReservationSource; bps: number; note: string },
  ): Promise<number> {
    const t = await this.totals(tx, e.reservationId);
    const amount = commissionReversal(t.collectedKobo, t.reversedCollectedKobo, e.refundKobo, e.paidKobo);
    if (amount <= 0) return 0;
    await tx.commissionEntry.create({
      data: {
        tenantId: e.tenantId,
        propertyId: await this.propertyOf(tx, e.reservationId),
        reservationId: e.reservationId,
        paymentId: e.paymentId,
        kind: 'REVERSED',
        accrual: false,
        amountKobo: amount,
        baseKobo: e.refundKobo,
        commissionBps: e.bps,
        channel: e.channel,
        note: e.note,
      },
    });
    return amount;
  }

  /** Reverses whatever accrued (pay-at-hotel) commission is left on a booking. */
  async reverseAccrued(tx: Tx, tenantId: string, reservationId: string, note: string): Promise<number> {
    const t = await this.totals(tx, reservationId);
    const left = t.accruedKobo - t.reversedAccruedKobo;
    if (left <= 0) return 0;
    const first = await tx.commissionEntry.findFirst({ where: { reservationId, kind: 'ACCRUED' } });
    await tx.commissionEntry.create({
      data: {
        tenantId,
        propertyId: await this.propertyOf(tx, reservationId),
        reservationId,
        kind: 'REVERSED',
        accrual: true,
        amountKobo: left,
        baseKobo: first ? first.baseKobo : 0,
        commissionBps: first?.commissionBps ?? 0,
        channel: first?.channel ?? 'MARKETPLACE',
        note,
      },
    });
    return left;
  }

  async reverseAccruedMany(tx: Tx, tenantId: string, reservationIds: string[], note: string): Promise<number> {
    if (!reservationIds.length) return 0;
    const withAccrual = await tx.commissionEntry.findMany({
      where: { tenantId, reservationId: { in: reservationIds }, kind: 'ACCRUED' },
      select: { reservationId: true },
      distinct: ['reservationId'],
    });
    let total = 0;
    for (const r of withAccrual) total += await this.reverseAccrued(tx, tenantId, r.reservationId, note);
    return total;
  }
}
