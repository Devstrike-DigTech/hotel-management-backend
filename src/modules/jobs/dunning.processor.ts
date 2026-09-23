import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { DunningService, type DunningReport } from '../billing/dunning.service.js';
import { BILLING_QUEUE, DUNNING_JOB } from './jobs.constants.js';

@Processor(BILLING_QUEUE)
export class BillingProcessor extends WorkerHost {
  private readonly logger = new Logger(BillingProcessor.name);

  constructor(private readonly dunning: DunningService) {
    super();
  }

  async process(job: Job): Promise<DunningReport | undefined> {
    if (job.name === DUNNING_JOB) {
      return this.dunning.run(new Date());
    }
    this.logger.warn(`Unknown job ${job.name}`);
    return undefined;
  }
}
