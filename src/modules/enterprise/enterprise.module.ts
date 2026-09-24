import { Global, Module } from '@nestjs/common';
import { RoomsModule } from '../rooms/rooms.module.js';
import { ExportsController, PlatformExportsController, PublicExportsController } from './exports/exports.controller.js';
import { ExportsService } from './exports/exports.service.js';
import { BrandingRegistry } from './white-label/branding.registry.js';
import { ApiKeysController, DevelopersController, PlatformApiUsageController } from './api-keys/api-keys.controller.js';
import { ApiKeysService } from './api-keys/api-keys.service.js';
import { PartnerGuard, PartnerInterceptor } from './partner/partner-auth.js';
import { PartnerController } from './partner/partner.controller.js';
import { PartnerDocsController } from './partner/partner-docs.controller.js';
import { WebhookDeliveriesController, WebhookEndpointsController } from './webhooks/webhooks.controller.js';
import { WebhooksService } from './webhooks/webhooks.service.js';

/**
 * M6 Enterprise tier: full data export, white-label, API keys and the
 * partner API, outbound webhooks and SSO. Global: notifications, documents
 * and the platform console read its services.
 */
@Global()
@Module({
  imports: [RoomsModule],
  controllers: [
    ExportsController,
    PublicExportsController,
    PlatformExportsController,
    ApiKeysController,
    DevelopersController,
    PlatformApiUsageController,
    WebhookEndpointsController,
    WebhookDeliveriesController,
    PartnerDocsController,
    PartnerController,
  ],
  providers: [BrandingRegistry, ExportsService, ApiKeysService, WebhooksService, PartnerGuard, PartnerInterceptor],
  exports: [BrandingRegistry, ExportsService, ApiKeysService, WebhooksService],
})
export class EnterpriseModule {}
