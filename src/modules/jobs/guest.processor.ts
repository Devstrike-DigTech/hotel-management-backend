import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { GUEST_JOBS, GuestJobsService } from '../booking/guest-jobs.service.js';
import { HoldsService } from '../booking/holds.service.js';
import { JobsBridge } from '../infra/jobs-bridge.js';
import { NOTIFY_ATTEMPTS, NOTIFY_JOB, NotificationService } from '../notifications/notification.service.js';
import { DUNNING_TZ, GUEST_QUEUE } from './jobs.constants.js';

/** Guest-side jobs: notification delivery (with retries), hold expiry, pre-arrival and review messages. */
@Processor(GUEST_QUEUE, { concurrency: 5 })
export class GuestProcessor extends WorkerHost {
  private readonly logger = new Logger(GuestProcessor.name);

  constructor(
    private readonly notifications: NotificationService,
    private readonly holds: HoldsService,
    private readonly guestJobs: GuestJobsService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    const d = job.data as { id?: string; tenantId?: string; reservationId?: string; fromName?: string | null; meta?: Record<string, unknown> };
    switch (job.name) {
      case NOTIFY_JOB: {
        const attempts = job.opts.attempts ?? NOTIFY_ATTEMPTS;
        await this.notifications.deliver(d.id!, { final: job.attemptsMade + 1 >= attempts, fromName: d.fromName ?? null, meta: d.meta ?? {} });
        return { delivered: d.id };
      }
      case GUEST_JOBS.holdExpire:
        return { expired: await this.holds.expire(d.tenantId!, d.reservationId!) };
      case GUEST_JOBS.preArrival:
        return { sent: await this.guestJobs.sendPreArrival(d.tenantId!, d.reservationId!) };
      case GUEST_JOBS.reviewRequest:
        return { sent: await this.guestJobs.sendReviewRequest(d.tenantId!, d.reservationId!) };
      case GUEST_JOBS.holdSweep.name:
        return this.holds.sweep();
      case GUEST_JOBS.guestSweep.name:
        return this.guestJobs.sweep();
      default:
        this.logger.warn(`Unknown job ${job.name}`);
        return undefined;
    }
  }
}

/** Hands the queue to request-path services and registers the sweeps. */
@Injectable()
export class GuestScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(GuestScheduler.name);

  constructor(
    @InjectQueue(GUEST_QUEUE) private readonly queue: Queue,
    private readonly bridge: JobsBridge,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.bridge.setQueue(this.queue);
    for (const j of [GUEST_JOBS.holdSweep, GUEST_JOBS.guestSweep]) {
      await this.queue.upsertJobScheduler(j.scheduler, { pattern: j.cron, tz: DUNNING_TZ }, { name: j.name, opts: { removeOnComplete: 20, removeOnFail: 50 } });
    }
    this.logger.log('Guest queue ready: hold sweep every minute, guest notifications hourly');
  }
}
