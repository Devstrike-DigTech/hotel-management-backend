import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { DunningService } from './dunning.service.js';
import { PaystackWebhookService } from './paystack-webhook.service.js';
import { PaystackClient } from './paystack.client.js';

@Module({
  controllers: [BillingController],
  providers: [BillingService, PaystackClient, PaystackWebhookService, DunningService],
  exports: [BillingService, DunningService],
})
export class BillingModule {}
