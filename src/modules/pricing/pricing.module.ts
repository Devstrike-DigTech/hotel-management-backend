import { Global, Module } from '@nestjs/common';
import { DynamicPricingService } from './dynamic-pricing.service.js';
import { PricingController } from './pricing.controller.js';

/** M5 dynamic pricing (feature `dynamic_pricing`). */
@Global()
@Module({
  controllers: [PricingController],
  providers: [DynamicPricingService],
  exports: [DynamicPricingService],
})
export class DynamicPricingModule {}
