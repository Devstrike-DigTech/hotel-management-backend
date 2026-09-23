import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { DigestService } from '../digest/digest.service.js';
import { NightAuditService } from '../night-audit/night-audit.service.js';
import { OpsJobsService } from '../ops/ops-jobs.service.js';
import { DUNNING_TZ, OPERATIONS_QUEUE, OPS_JOBS } from './jobs.constants.js';

@Processor(OPERATIONS_QUEUE)
export class OperationsProcessor extends WorkerHost {
  private readonly logger = new Logger(OperationsProcessor.name);

  constructor(
    private readonly nightAudit: NightAuditService,
    private readonly digest: DigestService,
    private readonly ops: OpsJobsService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case OPS_JOBS.nightAudit.name:
        return this.nightAudit.runAll();
      case OPS_JOBS.ownerDigest.name:
        return this.digest.runAll();
      case OPS_JOBS.guardSweep.name:
        return this.ops.guardSweepAll();
      case OPS_JOBS.idempotencyPurge.name:
        return this.ops.purgeIdempotencyKeys();
      default:
        this.logger.warn(`Unknown job ${job.name}`);
        return undefined;
    }
  }
}

/** Registers the repeatable operations jobs (idempotent upserts), all in Lagos time. */
@Injectable()
export class OperationsScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(OperationsScheduler.name);

  constructor(@InjectQueue(OPERATIONS_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const j of Object.values(OPS_JOBS)) {
      await this.queue.upsertJobScheduler(
        j.scheduler,
        { pattern: j.cron, tz: DUNNING_TZ },
        { name: j.name, opts: { removeOnComplete: 50, removeOnFail: 100, attempts: 2, backoff: { type: 'exponential', delay: 60_000 } } },
      );
    }
    this.logger.log('Scheduled night audit 02:00, owner digest 23:00, guard sweep hourly (Africa/Lagos)');
  }
}
