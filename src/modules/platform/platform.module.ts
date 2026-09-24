import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { PlatformAuthService } from './platform-auth.service.js';
import {
  PlatformAuthController,
  PlatformController,
  PlatformPermissionsController,
} from './platform.controller.js';
import { PlatformService } from './platform.service.js';

@Module({
  imports: [BillingModule],
  controllers: [PlatformAuthController, PlatformController, PlatformPermissionsController],
  providers: [PlatformService, PlatformAuthService],
})
export class PlatformModule {}
