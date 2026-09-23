import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../prisma/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PaystackClient } from '../billing/paystack.client.js';
import { NotificationService } from '../notifications/notification.service.js';
import { HOLD_EXPIRED_REASON } from './booking.logic.js';
import { PromosService } from '../rates/promos.service.js';
import { BookingNotifier } from './booking-notifier.service.js';
import { BookingPaymentsService } from './booking-payments.service.js';
import { stayInclude } from './booking-view.service.js';

/**
 * Releases unpaid online holds. A delayed BullMQ job fires at each hold's
 * expiry; a one-minute sweep catches the rest. Before releasing, open payment
 * attempts are verified with Paystack in case the webhook is late.
 */
@Injectable()
export class HoldsService {
  private readonly logger = new Logger(HoldsService.name);

  constructor(
    private readonly db: DbService,
    private readonly paystack: PaystackClient,
    private readonly payments: BookingPaymentsService,
    private readonly notifications: NotificationService,
    private readonly notifier: BookingNotifier,
    private readonly audit: AuditService,
    private readonly promos: PromosService,
  ) {}

  /** Returns true when the hold was released. */
  async expire(tenantId: string, reservationId: string, now = new Date()): Promise<boolean> {
    if (this.paystack.enabled) {
      const open = await this.db.tenant(tenantId, (tx) =>
        tx.bookingPayment.findMany({ where: { tenantId, reservationId, status: 'INITIALIZED' }, select: { reference: true } }),
      );
      for (const p of open) {
        try {
          await this.payments.verify(p.reference);
        } catch (e) {
          this.logger.warn(`Pre-expiry verify ${p.reference}: ${(e as Error).message}`);
        }
      }
    }
    const ids = await this.db.tenant(tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM reservations WHERE id = ${reservationId}::uuid FOR UPDATE`;
      const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId }, include: stayInclude });
      if (!r || r.status !== 'PENDING' || r.paymentMode !== 'ONLINE' || !r.holdExpiresAt || r.holdExpiresAt > now) return null;
      await tx.reservation.update({
        where: { id: r.id },
        data: { status: 'CANCELLED', cancelledAt: now, cancelReason: HOLD_EXPIRED_REASON, cancelledBy: 'SYSTEM' },
      });
      await this.promos.release(tx, tenantId, r.id);
      await this.audit.record(tx, {
        tenantId,
        actor: { kind: 'system', name: 'Online booking' },
        action: 'reservation.hold_expired',
        entityType: 'reservation',
        entityId: r.id,
        metadata: { code: r.code, holdExpiresAt: r.holdExpiresAt.toISOString() },
      });
      const fresh = await tx.reservation.findFirstOrThrow({ where: { id: r.id }, include: stayInclude });
      const msgs = await this.notifier.guest(tx, fresh, 'HOLD_EXPIRED', { hotelUrl: this.notifier.hotelUrl(r.property.slug) }, { dedupe: true });
      return this.notifications.queueTx(tx, msgs);
    });
    if (ids === null) return false;
    await this.notifications.dispatch(ids);
    return true;
  }

  async sweep(now = new Date()): Promise<{ expired: number }> {
    const due = await this.db.system((tx) =>
      tx.reservation.findMany({
        where: { status: 'PENDING', paymentMode: 'ONLINE', holdExpiresAt: { lte: now } },
        select: { id: true, tenantId: true },
        take: 500,
      }),
    );
    let expired = 0;
    for (const r of due) {
      try {
        if (await this.expire(r.tenantId, r.id, now)) expired++;
      } catch (e) {
        this.logger.error(`Hold expiry ${r.id}: ${(e as Error).message}`);
      }
    }
    return { expired };
  }
}
