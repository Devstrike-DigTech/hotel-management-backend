import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AppConfigService } from '../config/app-config.service.js';
import { DigestController } from './digest/digest.controller.js';
import { DIGEST_PROVIDER, LogDigestProvider, WhatsAppDigestProvider } from './digest/digest.providers.js';
import { DigestService } from './digest/digest.service.js';
import { FoliosController, TaxSettingsController } from './folios/folios.controller.js';
import { LedgerService } from './folios/ledger.service.js';
import { TaxSettingsService } from './folios/tax-settings.service.js';
import { FrontDeskController } from './front-desk/front-desk.controller.js';
import { FrontDeskService } from './front-desk/front-desk.service.js';
import { GuardController } from './guard/guard.controller.js';
import { GuardService } from './guard/guard.service.js';
import { FilesController, GuestRegisterController, GuestsController } from './guests/guests.controller.js';
import { GuestsService } from './guests/guests.service.js';
import { HousekeepingController } from './housekeeping/housekeeping.controller.js';
import { HousekeepingService } from './housekeeping/housekeeping.service.js';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor.js';
import { DocumentsService } from './invoices/documents.service.js';
import { InvoicesController, PublicDocumentsController } from './invoices/invoices.controller.js';
import { NightAuditController } from './night-audit/night-audit.controller.js';
import { NightAuditService } from './night-audit/night-audit.service.js';
import { ApprovalPinController } from './ops/approval-pin.controller.js';
import { OpsJobsService } from './ops/ops-jobs.service.js';
import { ReportsController } from './reports/reports.controller.js';
import { ReportsService } from './reports/reports.service.js';
import { AvailabilityController, ReservationsController } from './reservations/reservations.controller.js';
import { AvailabilityService } from './reservations/availability.service.js';
import { ReservationsService } from './reservations/reservations.service.js';
import { ShiftsController } from './shifts/shifts.controller.js';
import { ShiftsService } from './shifts/shifts.service.js';
import { objectStorageProvider } from './storage/storage.provider.js';

/**
 * M2 core hotel operations: reservations, guests, front desk, folios and
 * taxes, invoices and receipts, cashier shifts, Revenue Guard, owner digest,
 * night audit and reports. Global so M1 modules (rooms, dashboard) can use
 * the guard and front-desk services.
 */
@Global()
@Module({
  controllers: [
    ReservationsController,
    AvailabilityController,
    GuestsController,
    GuestRegisterController,
    FilesController,
    FoliosController,
    TaxSettingsController,
    InvoicesController,
    PublicDocumentsController,
    ShiftsController,
    GuardController,
    DigestController,
    NightAuditController,
    ReportsController,
    FrontDeskController,
    HousekeepingController,
    ApprovalPinController,
  ],
  providers: [
    objectStorageProvider,
    { provide: 'APP_NAME', inject: [AppConfigService], useFactory: (c: AppConfigService) => c.get('APP_NAME') },
    {
      provide: DIGEST_PROVIDER,
      inject: [AppConfigService],
      useFactory: (c: AppConfigService) => {
        const token = c.get('WHATSAPP_TOKEN');
        const phoneId = c.get('WHATSAPP_PHONE_ID');
        return token && phoneId ? new WhatsAppDigestProvider(token, phoneId, c.get('WHATSAPP_API_BASE_URL')) : new LogDigestProvider();
      },
    },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    TaxSettingsService,
    GuardService,
    DocumentsService,
    LedgerService,
    ShiftsService,
    GuestsService,
    HousekeepingService,
    AvailabilityService,
    ReservationsService,
    ReportsService,
    NightAuditService,
    DigestService,
    FrontDeskService,
    OpsJobsService,
  ],
  exports: [
    GuardService,
    FrontDeskService,
    NightAuditService,
    DigestService,
    OpsJobsService,
    LedgerService,
    ReservationsService,
    DocumentsService,
    AvailabilityService,
    GuestsService,
    TaxSettingsService,
  ],
})
export class OperationsModule {}
