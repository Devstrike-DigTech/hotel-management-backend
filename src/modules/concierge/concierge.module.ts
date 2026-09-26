import { Global, Module } from '@nestjs/common';
import { CatalogueService } from './catalogue.service.js';
import { ConciergeController, ConciergeGatesController } from './concierge.controller.js';
import { ConciergeHooksService } from './concierge-hooks.service.js';
import { ConciergeNotifier } from './concierge-notifier.service.js';
import { ConciergePaymentsService } from './concierge-payments.service.js';
import { ConciergeService } from './concierge.service.js';
import { PlatformConciergeController } from './platform-concierge.controller.js';
import { PlatformConciergeService } from './platform-concierge.service.js';
import { PublicConciergeController } from './public-concierge.controller.js';
import { PublicConciergeService } from './public-concierge.service.js';
import { RequestsService } from './requests.service.js';

/**
 * M8: the concierge for lawful guest requests (catalogue, vendors, requests,
 * quotes, payments, discretion, SLA, retention) with its acceptable-use
 * policy, content screen and platform review. Global so the front desk, the
 * Paystack webhook and the public payment routes can reach its services.
 */
@Global()
@Module({
  controllers: [ConciergeGatesController, ConciergeController, PublicConciergeController, PlatformConciergeController],
  providers: [
    ConciergeService,
    CatalogueService,
    ConciergeNotifier,
    ConciergePaymentsService,
    RequestsService,
    PublicConciergeService,
    PlatformConciergeService,
    ConciergeHooksService,
  ],
  exports: [ConciergeService, CatalogueService, ConciergePaymentsService, RequestsService],
})
export class ConciergeModule {}
