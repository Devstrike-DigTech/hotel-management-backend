import { Global, Module } from '@nestjs/common';
import { LoyaltyController, LoyaltyGuestController } from './loyalty.controller.js';
import { LoyaltyService } from './loyalty.service.js';

/** M5 loyalty (feature `loyalty`, tenant-wide). */
@Global()
@Module({
  controllers: [LoyaltyController, LoyaltyGuestController],
  providers: [LoyaltyService],
  exports: [LoyaltyService],
})
export class LoyaltyModule {}
