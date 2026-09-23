import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  BILLING_QUEUE,
  DUNNING_CRON,
  DUNNING_JOB,
  DUNNING_SCHEDULER_ID,
  DUNNING_TZ,
} from './jobs.constants.js';

/** Registers the repeatable daily dunning job (idempotent upsert). */
@Injectable()
export class DunningScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(DunningScheduler.name);

  constructor(@InjectQueue(BILLING_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      DUNNING_SCHEDULER_ID,
      { pattern: DUNNING_CRON, tz: DUNNING_TZ },
      {
        name: DUNNING_JOB,
        opts: { removeOnComplete: 30, removeOnFail: 100, attempts: 3, backoff: { type: 'exponential', delay: 60_000 } },
      },
    );
    this.logger.log(`Dunning scheduled: "${DUNNING_CRON}" ${DUNNING_TZ}`);
  }
}
