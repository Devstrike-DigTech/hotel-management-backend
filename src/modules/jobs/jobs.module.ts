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
import { ProJobsService } from './pro-jobs.service.js';

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
    BillingModule,
  ],
  providers: [ProJobsService, BillingProcessor, DunningScheduler, OperationsProcessor, OperationsScheduler, GuestProcessor, GuestScheduler],
})
export class JobsModule {}
