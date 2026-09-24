import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { PROVISION_JOB, ProvisioningService } from '../dedicated-db/provisioning.service.js';
import { PlatformJobsService } from '../platform/console/platform-jobs.service.js';
import { PLATFORM_JOBS, PLATFORM_QUEUE } from '../platform/console/system-health.service.js';
import { DUNNING_TZ } from './jobs.constants.js';

/** M6 platform jobs: webhook delivery, announcement emails, offboarding, dedicated-DB purge, listings, API usage. */
@Processor(PLATFORM_QUEUE, { concurrency: 2 })
export class PlatformProcessor extends WorkerHost {
  constructor(
    private readonly jobs: PlatformJobsService,
    private readonly provisioning: ProvisioningService,
  ) {
    super();
  }

  process(job: Job): Promise<unknown> {
    // Durable dedicated-database runs (resumed from their checkpoint if a worker died).
    if (job.name === PROVISION_JOB) return this.provisioning.execute((job.data as { id: string }).id);
    return this.jobs.runScheduled(job.name);
  }
}

@Injectable()
export class PlatformScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlatformScheduler.name);

  constructor(@InjectQueue(PLATFORM_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const j of Object.values(PLATFORM_JOBS)) {
      await this.queue.upsertJobScheduler(
        j.scheduler,
        { pattern: j.cron, tz: DUNNING_TZ },
        { name: j.name, opts: { removeOnComplete: 20, removeOnFail: 100 } },
      );
    }
    this.logger.log('Platform queue ready: webhooks and announcement emails every minute, offboarding 04:30, dedicated-DB purge hourly, listings every 15 min, API usage flush every 5 min (Africa/Lagos)');
  }
}
