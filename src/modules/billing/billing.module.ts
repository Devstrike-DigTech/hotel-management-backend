import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { DunningService } from './dunning.service.js';
import { PaystackWebhookService } from './paystack-webhook.service.js';

@Module({
  controllers: [BillingController],
  providers: [BillingService, PaystackWebhookService, DunningService],
  exports: [BillingService, DunningService],
})
export class BillingModule {}
