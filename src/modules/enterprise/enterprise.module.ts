import { Global, Module } from '@nestjs/common';
import { RoomsModule } from '../rooms/rooms.module.js';
import { ExportsController, PlatformExportsController, PublicExportsController } from './exports/exports.controller.js';
import { ExportsService } from './exports/exports.service.js';
import { BrandingRegistry } from './white-label/branding.registry.js';
import { PlatformSmsSendersController, PublicBrandAssetsController, PublicStaffPortalController, WhiteLabelController } from './white-label/white-label.controller.js';
import { WhiteLabelService } from './white-label/white-label.service.js';
import { MockOidcController, SsoAuthController, SsoConfigController } from './sso/sso.controller.js';
import { MockOidcService } from './sso/mock-oidc.service.js';
import { SsoService } from './sso/sso.service.js';
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
    WhiteLabelController,
    PublicStaffPortalController,
    PublicBrandAssetsController,
    PlatformSmsSendersController,
    SsoConfigController,
    SsoAuthController,
    MockOidcController,
  ],
  providers: [BrandingRegistry, WhiteLabelService, SsoService, MockOidcService, ExportsService, ApiKeysService, WebhooksService, PartnerGuard, PartnerInterceptor],
  exports: [BrandingRegistry, WhiteLabelService, SsoService, ExportsService, ApiKeysService, WebhooksService],
})
export class EnterpriseModule {}
