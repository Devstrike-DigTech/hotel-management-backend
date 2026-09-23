import { Global, Module } from '@nestjs/common';
import { PricingService } from './pricing.service.js';
import { PromosService } from './promos.service.js';
import { PromoCodesController, RatesController, RatesQuoteController } from './rates.controller.js';
import { RatesService } from './rates.service.js';

/** M4 rates, seasons, restrictions and promo codes (feature `promotions`). */
@Global()
@Module({
  controllers: [RatesController, RatesQuoteController, PromoCodesController],
  providers: [RatesService, PromosService, PricingService],
  exports: [RatesService, PromosService, PricingService],
})
export class RatesModule {}
