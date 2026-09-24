import { Global, Module } from '@nestjs/common';
import { BookingFormController } from '../booking-form/booking-form.controller.js';
import { BookingFormService } from '../booking-form/booking-form.service.js';
import { FILE_SCANNER, FormUploadsService, NoopFileScanner } from '../booking-form/form-uploads.service.js';
import { AddOnsService } from '../extras/addons.service.js';
import { ExtrasController, ReservationAddOnsController, TransfersController } from '../extras/extras.controller.js';
import { ExtrasService } from '../extras/extras.service.js';
import { M7HooksService } from '../extras/m7-hooks.service.js';
import { TransfersService } from '../extras/transfers.service.js';
import { SetupController } from '../setup/setup.controller.js';
import { SetupService } from '../setup/setup.service.js';
import { PreviewTokens } from './preview-tokens.js';
import { PublicSiteController } from './public-site.controller.js';
import { PublicSiteAssetsController, SiteController } from './site.controller.js';
import { SiteAssetsService } from './site-assets.service.js';
import { ThemeService } from './theme.service.js';

/**
 * M7: Brand Studio (themes, templates, assets, preview tokens), the
 * configurable booking form, paid extras, pickup points and transfers, and
 * the setup wizard. Global so the booking flow, the reservation views, the
 * dashboard and the partner API can use its services.
 */
@Global()
@Module({
  controllers: [
    SiteController,
    PublicSiteAssetsController,
    PublicSiteController,
    BookingFormController,
    ExtrasController,
    TransfersController,
    ReservationAddOnsController,
    SetupController,
  ],
  providers: [
    PreviewTokens,
    SiteAssetsService,
    ThemeService,
    { provide: FILE_SCANNER, useClass: NoopFileScanner },
    FormUploadsService,
    BookingFormService,
    ExtrasService,
    AddOnsService,
    TransfersService,
    SetupService,
    M7HooksService,
  ],
  exports: [PreviewTokens, SiteAssetsService, ThemeService, FormUploadsService, BookingFormService, ExtrasService, AddOnsService, TransfersService, SetupService],
})
export class SiteModule {}
