import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../prisma/db.service.js';
import { JobsBridge } from '../infra/jobs-bridge.js';
import { NotificationService } from '../notifications/notification.service.js';
import { BookingNotifier } from './booking-notifier.service.js';
import { BookingViewService, stayInclude } from './booking-view.service.js';

export const GUEST_JOBS = {
  holdExpire: 'hold-expire',
  preArrival: 'pre-arrival',
  reviewRequest: 'review-request',
  holdSweep: { name: 'hold-sweep', scheduler: 'hold-sweep-minutely', cron: '* * * * *' },
  guestSweep: { name: 'guest-notifications-sweep', scheduler: 'guest-notifications-hourly', cron: '20 * * * *' },
} as const;

const PRE_ARRIVAL_LEAD_MS = 24 * 3_600_000;
const REVIEW_DELAY_MS = 4 * 3_600_000;
/** Review requests are only sent for check-outs this recent (catch-up window of the sweep). */
const REVIEW_CATCH_UP_MS = 72 * 3_600_000;

/**
 * Time-based guest messages: pre-arrival (24 h before arrival) and review
 * requests (4 h after check-out). Each is a BullMQ delayed job queued at the
 * triggering moment, backed by an hourly sweep that catches anything missed
 * (restarts, jobs disabled). A dedupe key per stay makes a double send
 * impossible.
 */
@Injectable()
export class GuestJobsService {
  private readonly logger = new Logger(GuestJobsService.name);

  constructor(
    private readonly db: DbService,
    private readonly jobs: JobsBridge,
    private readonly notifications: NotificationService,
    private readonly notifier: BookingNotifier,
    private readonly views: BookingViewService,
  ) {}

  async scheduleHoldExpiry(tenantId: string, reservationId: string, at: Date): Promise<void> {
    await this.jobs.enqueue(GUEST_JOBS.holdExpire, { tenantId, reservationId }, { delay: Math.max(0, at.getTime() - Date.now() + 2_000), jobId: `hold-${reservationId}`, attempts: 3, backoff: { type: 'fixed', delay: 15_000 } });
  }

  async cancelHoldExpiry(reservationId: string): Promise<void> {
    await this.jobs.remove(`hold-${reservationId}`);
  }

  async schedulePreArrival(tenantId: string, reservationId: string, arrivalAt: Date): Promise<void> {
    const due = arrivalAt.getTime() - PRE_ARRIVAL_LEAD_MS;
    // Inside the 24 h window already: the next sweep sends it.
    if (due <= Date.now()) return;
    await this.jobs.enqueue(GUEST_JOBS.preArrival, { tenantId, reservationId }, { delay: due - Date.now(), jobId: `pre-arrival-${reservationId}`, attempts: 3, backoff: { type: 'exponential', delay: 60_000 } });
  }

  async scheduleReviewRequest(tenantId: string, reservationId: string, checkedOutAt: Date): Promise<void> {
    const due = checkedOutAt.getTime() + REVIEW_DELAY_MS;
    await this.jobs.enqueue(GUEST_JOBS.reviewRequest, { tenantId, reservationId }, { delay: Math.max(0, due - Date.now()), jobId: `review-${reservationId}`, attempts: 3, backoff: { type: 'exponential', delay: 60_000 } });
  }

  /** Sends the pre-arrival message if the stay is still on and it has not been sent. */
  async sendPreArrival(tenantId: string, reservationId: string, now = new Date()): Promise<boolean> {
    const ids = await this.db.tenant(tenantId, async (tx) => {
      const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId }, include: stayInclude });
      if (!r || r.status !== 'CONFIRMED' || !r.paymentMode) return [];
      if (r.arrivalAt <= now || r.arrivalAt.getTime() - now.getTime() > PRE_ARRIVAL_LEAD_MS + 5 * 60_000) return [];
      const msgs = await this.notifier.guest(tx, r, 'PRE_ARRIVAL', { message: r.property.preArrivalMessage }, { dedupe: true });
      return this.notifications.queueTx(tx, msgs);
    });
    await this.notifications.dispatch(ids);
    return ids.length > 0;
  }

  async sendReviewRequest(tenantId: string, reservationId: string, now = new Date()): Promise<boolean> {
    const ids = await this.db.tenant(tenantId, async (tx) => {
      const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId }, include: stayInclude });
      if (!r || r.status !== 'CHECKED_OUT' || !r.checkedOutAt || r.review || r.guest.anonymisedAt) return [];
      if (now.getTime() - r.checkedOutAt.getTime() < REVIEW_DELAY_MS - 60_000) return [];
      const { token, deadline } = this.views.tokens.signReview(tenantId, r.id, r.checkedOutAt);
      if (deadline <= now) return [];
      const msgs = await this.notifier.reviewRequest(tx, r, this.views.tokens.reviewUrl(token), deadline);
      return this.notifications.queueTx(tx, msgs);
    });
    await this.notifications.dispatch(ids);
    return ids.length > 0;
  }

  /** Hourly catch-up across hotels (platform role enumerates, each send runs in its tenant). */
  async sweep(now = new Date()): Promise<{ preArrival: number; reviewRequests: number }> {
    const { arriving, departed } = await this.db.system(async (tx) => {
      const arriving = await tx.reservation.findMany({
        where: {
          status: 'CONFIRMED',
          paymentMode: { not: null },
          arrivalAt: { gt: now, lte: new Date(now.getTime() + PRE_ARRIVAL_LEAD_MS) },
          notificationLogs: { none: { template: 'PRE_ARRIVAL' } },
        },
        select: { id: true, tenantId: true },
        take: 500,
      });
      const departed = await tx.reservation.findMany({
        where: {
          status: 'CHECKED_OUT',
          checkedOutAt: { gte: new Date(now.getTime() - REVIEW_CATCH_UP_MS), lte: new Date(now.getTime() - REVIEW_DELAY_MS) },
          review: { is: null },
          notificationLogs: { none: { template: 'REVIEW_REQUEST' } },
        },
        select: { id: true, tenantId: true },
        take: 500,
      });
      return { arriving, departed };
    });
    let preArrival = 0;
    let reviewRequests = 0;
    for (const r of arriving) {
      try {
        if (await this.sendPreArrival(r.tenantId, r.id, now)) preArrival++;
      } catch (e) {
        this.logger.error(`Pre-arrival ${r.id}: ${(e as Error).message}`);
      }
    }
    for (const r of departed) {
      try {
        if (await this.sendReviewRequest(r.tenantId, r.id, now)) reviewRequests++;
      } catch (e) {
        this.logger.error(`Review request ${r.id}: ${(e as Error).message}`);
      }
    }
    return { preArrival, reviewRequests };
  }
}
