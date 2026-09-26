import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfigService } from '../../config/app-config.service.js';
import { BillingModule } from '../billing/billing.module.js';
import { BillingProcessor } from './dunning.processor.js';
import { DunningScheduler } from './dunning.scheduler.js';
import { GuestProcessor, GuestScheduler } from './guest.processor.js';
import { BILLING_QUEUE, GUEST_QUEUE, OPERATIONS_QUEUE, redisConnection } from './jobs.constants.js';
import { OperationsProcessor, OperationsScheduler } from './operations.processor.js';
import { PlatformProcessor, PlatformScheduler } from './platform.processor.js';
import { PLATFORM_QUEUE } from '../platform/console/system-health.service.js';
import { ProJobsService } from './pro-jobs.service.js';

/**
 * PROCESS_ROLE splits one deployment into an HTTP process and a job process
 * (same image, same env):
 *   all    (default) HTTP API + BullMQ processors in one process (development)
 *   api    HTTP API; enqueues jobs and registers the schedules, runs no processors
 *   worker runs the BullMQ processors (it still answers /api/v1/health on PORT)
 * Schedulers are idempotent upserts, so both roles register them.
 */
export function processRole(): 'all' | 'api' | 'worker' {
  const v = (process.env.PROCESS_ROLE ?? 'all').trim().toLowerCase() || 'all';
  if (v === 'all' || v === 'api' || v === 'worker') return v;
  throw new Error(`PROCESS_ROLE must be all, api or worker (got "${v}")`);
}

/** Every @Processor (BullMQ Worker). Add new processors here, not to `providers` directly. */
const PROCESSORS = [BillingProcessor, OperationsProcessor, GuestProcessor, PlatformProcessor];

/**
 * BullMQ wiring. Imported only when JOBS_ENABLED is true (see AppModule), so
 * tests and one-off scripts do not start workers or schedule jobs.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        // BullMQ 6 under native ESM needs a constructed client; it duplicates
        // it for blocking worker connections.
        connection: new Redis(redisConnection(config.get('REDIS_URL'))),
        prefix: 'hotel',
      }),
    }),
    BullModule.registerQueue({ name: BILLING_QUEUE }),
    BullModule.registerQueue({ name: OPERATIONS_QUEUE }),
    BullModule.registerQueue({ name: GUEST_QUEUE }),
    BullModule.registerQueue({ name: PLATFORM_QUEUE }),
    BillingModule,
  ],
  providers: [ProJobsService, DunningScheduler, OperationsScheduler, GuestScheduler, PlatformScheduler, ...(processRole() === 'api' ? [] : PROCESSORS)],
})
export class JobsModule {}
