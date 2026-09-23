import { Injectable, Logger } from '@nestjs/common';
import type { BookingPaymentStatus } from '../../generated/prisma/enums.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { PaystackClient } from '../billing/paystack.client.js';
import { k } from '../ops/ops.helpers.js';

/**
 * Sends refunds to Paystack after the business transaction that decided them
 * has committed, and tracks their outcome (webhook `refund.*` events finish
 * the job). A failure never undoes the cancellation: the refund row becomes
 * FAILED and the platform console can retry it.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly db: DbService,
    private readonly paystack: PaystackClient,
  ) {}

  async process(refundId: string): Promise<void> {
    const x = await this.db.system((tx) => tx.bookingRefund.findUnique({ where: { id: refundId }, include: { payment: true } }));
    if (!x || x.status === 'PROCESSED') return;
    if (x.status === 'PENDING' && x.providerRefundId) return; // already accepted by Paystack; waiting for refund.processed
    try {
      const res = await this.paystack.refund(x.payment.reference, k(x.amountKobo), `Refund for ${x.reason.toLowerCase().replace(/_/g, ' ')}`);
      const status = res.status === 'processed' ? 'PROCESSED' : res.status === 'failed' ? 'FAILED' : 'PENDING';
      await this.db.system(async (tx) => {
        await tx.bookingRefund.update({
          where: { id: refundId },
          data: {
            status,
            providerRefundId: res.id || null,
            attempts: { increment: 1 },
            error: status === 'FAILED' ? 'The payment provider declined the refund' : null,
            ...(status === 'PROCESSED' && { processedAt: new Date() }),
          },
        });
        if (status === 'PROCESSED') await this.syncPaymentStatus(tx, x.paymentId);
      });
    } catch (e) {
      const message = (e as Error).message.slice(0, 300);
      this.logger.error(`Refund ${refundId} failed: ${message}`);
      await this.db.system((tx) => tx.bookingRefund.update({ where: { id: refundId }, data: { status: 'FAILED', attempts: { increment: 1 }, error: message } }));
    }
  }

  /** Re-sends a FAILED refund (platform console). */
  async retry(refundId: string): Promise<void> {
    await this.db.system((tx) => tx.bookingRefund.update({ where: { id: refundId }, data: { status: 'PENDING', providerRefundId: null, error: null } }));
    await this.process(refundId);
  }

  /** SUCCEEDED -> PARTIALLY_REFUNDED / REFUNDED from the processed refunds. Orphaned payments keep their status. */
  async syncPaymentStatus(tx: Tx, paymentId: string): Promise<void> {
    const p = await tx.bookingPayment.findUnique({ where: { id: paymentId }, include: { refunds: true } });
    if (!p || !['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status)) return;
    const done = p.refunds.filter((r) => r.status === 'PROCESSED').reduce((a, r) => a + k(r.amountKobo), 0);
    const paid = k(p.paidAmountKobo ?? p.amountKobo);
    const status: BookingPaymentStatus = done <= 0 ? 'SUCCEEDED' : done >= paid ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    if (status !== p.status) await tx.bookingPayment.update({ where: { id: paymentId }, data: { status } });
  }

  /** Paystack `refund.processed` / `refund.pending` / `refund.failed`. Returns the tenant id or null. */
  async onRefundEventTx(tx: Tx, type: string, d: Record<string, unknown>): Promise<string | null> {
    const providerId = typeof d.id === 'string' || typeof d.id === 'number' ? String(d.id) : null;
    const nested = d.transaction as { reference?: string } | undefined;
    const reference = (d.transaction_reference as string | undefined) ?? nested?.reference ?? (d.reference as string | undefined) ?? null;
    let refund = providerId ? await tx.bookingRefund.findFirst({ where: { providerRefundId: providerId } }) : null;
    if (!refund && reference) {
      refund = await tx.bookingRefund.findFirst({
        where: { payment: { reference }, status: { in: ['PENDING', 'FAILED'] } },
        orderBy: { createdAt: 'asc' },
      });
    }
    if (!refund) return null;
    const status = type === 'refund.processed' ? 'PROCESSED' : type === 'refund.failed' ? 'FAILED' : 'PENDING';
    await tx.bookingRefund.update({
      where: { id: refund.id },
      data: {
        status,
        providerRefundId: providerId ?? refund.providerRefundId,
        ...(status === 'PROCESSED' && { processedAt: new Date(), error: null }),
        ...(status === 'FAILED' && { error: (typeof d.reason === 'string' ? d.reason : typeof d.message === 'string' ? d.message : 'Refund failed at the payment provider').slice(0, 300) }),
      },
    });
    if (status === 'PROCESSED') await this.syncPaymentStatus(tx, refund.paymentId);
    return refund.tenantId;
  }
}
