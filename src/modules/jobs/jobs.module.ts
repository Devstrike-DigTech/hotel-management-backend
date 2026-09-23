import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfigService } from '../../config/app-config.service.js';
import { BillingModule } from '../billing/billing.module.js';
import { BillingProcessor } from './dunning.processor.js';
import { DunningScheduler } from './dunning.scheduler.js';
import { BILLING_QUEUE, redisConnection } from './jobs.constants.js';

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
    BillingModule,
  ],
  providers: [BillingProcessor, DunningScheduler],
})
export class JobsModule {}
