import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { HotelAnnouncementsController, PlatformAnnouncementsController } from './announcements.controller.js';
import { AnnouncementsService } from './announcements.service.js';
import {
  PlatformAuditController,
  PlatformCouponsController,
  PlatformOffboardingController,
  PlatformSystemController,
} from './console.controller.js';
import { CouponsService } from './coupons.service.js';
import { HotelImpersonationController, ImpersonationExchangeController, PlatformImpersonationController } from './impersonation.controller.js';
import { ImpersonationInterceptor } from './impersonation.interceptor.js';
import { ImpersonationService } from './impersonation.service.js';
import { OffboardingService } from './offboarding.service.js';
import { PlatformJobsService } from './platform-jobs.service.js';
import { PlatformUsersService } from './platform-users.service.js';
import { HotelSupportController, PlatformSupportController, SupportFilesController } from './support.controller.js';
import { SupportService } from './support.service.js';
import { JobRunsService, SystemHealthService } from './system-health.service.js';

/**
 * M6 platform console: support desk, announcements, impersonation, coupons,
 * console users, offboarding, system health and named jobs. Global so the
 * jobs module and the tenant console (PlatformModule) can use its services.
 */
@Global()
@Module({
  controllers: [
    PlatformAnnouncementsController,
    HotelAnnouncementsController,
    HotelSupportController,
    SupportFilesController,
    PlatformSupportController,
    PlatformImpersonationController,
    ImpersonationExchangeController,
    HotelImpersonationController,
    PlatformOffboardingController,
    PlatformAuditController,
    PlatformCouponsController,
    PlatformSystemController,
  ],
  providers: [
    SupportService,
    AnnouncementsService,
    ImpersonationService,
    CouponsService,
    PlatformUsersService,
    SystemHealthService,
    JobRunsService,
    OffboardingService,
    PlatformJobsService,
    { provide: APP_INTERCEPTOR, useClass: ImpersonationInterceptor },
  ],
  exports: [
    SupportService,
    AnnouncementsService,
    ImpersonationService,
    CouponsService,
    PlatformUsersService,
    SystemHealthService,
    JobRunsService,
    OffboardingService,
    PlatformJobsService,
  ],
})
export class PlatformConsoleModule {}
