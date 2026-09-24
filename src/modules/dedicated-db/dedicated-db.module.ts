import { Global, Module } from '@nestjs/common';
import { ControlMirrorService } from './control-mirror.service.js';
import { HotelDedicatedDbController, PlatformDedicatedDbController } from './dedicated-db.controller.js';
import { ListingsService } from './listings.service.js';
import { ProvisioningService } from './provisioning.service.js';

/** M6: dedicated tenant databases, the control-plane mirror and the public listing projection. */
@Global()
@Module({
  controllers: [PlatformDedicatedDbController, HotelDedicatedDbController],
  providers: [ControlMirrorService, ListingsService, ProvisioningService],
  exports: [ControlMirrorService, ListingsService, ProvisioningService],
})
export class DedicatedDbModule {}
