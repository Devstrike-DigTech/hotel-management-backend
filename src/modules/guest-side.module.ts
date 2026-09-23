import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PaystackClient } from './billing/paystack.client.js';
import { BookingNotifier } from './booking/booking-notifier.service.js';
import { BookingPaymentsService } from './booking/booking-payments.service.js';
import { BookingTokens } from './booking/booking-tokens.service.js';
import { BookingViewService } from './booking/booking-view.service.js';
import { CancellationService } from './booking/cancellation.service.js';
import { CommissionService } from './booking/commission.service.js';
import { GuestJobsService } from './booking/guest-jobs.service.js';
import { HoldsService } from './booking/holds.service.js';
import { HotelBookingController } from './booking/hotel-booking.controller.js';
import { HotelBookingService } from './booking/hotel-booking.service.js';
import { PlatformMarketplaceController } from './booking/platform-marketplace.controller.js';
import { PlatformMarketplaceService } from './booking/platform-marketplace.service.js';
import { DevController, PublicBookingController } from './booking/public-booking.controller.js';
import { PublicBookingService } from './booking/public-booking.service.js';
import { RefundsService } from './booking/refunds.service.js';
import { TripsService } from './booking/trips.service.js';
import { GuestAuthController, GuestController } from './guest-auth/guest-auth.controller.js';
import { GuestAuthService } from './guest-auth/guest-auth.service.js';
import { JobsBridge } from './infra/jobs-bridge.js';
import { RateLimitGuard, RateLimitService } from './infra/rate-limit.js';
import { RedisService } from './infra/redis.service.js';
import { DevOutboxService } from './notifications/dev-outbox.service.js';
import { NotificationService } from './notifications/notification.service.js';
import { HotelReviewsController, PlatformReviewsController, PublicReviewsController } from './reviews/reviews.controller.js';
import { ReviewsService } from './reviews/reviews.service.js';

/**
 * M3, the guest side: online booking with Paystack split payments, holds,
 * commission ledger, guest accounts, trips, cancellations and refunds,
 * notifications, reviews, payouts and the marketplace console. Global so M1
 * and M2 modules (public search, reservations, billing webhook, jobs) can use
 * its services.
 */
@Global()
@Module({
  controllers: [
    PublicBookingController,
    DevController,
    GuestAuthController,
    GuestController,
    PublicReviewsController,
    HotelReviewsController,
    PlatformReviewsController,
    HotelBookingController,
    PlatformMarketplaceController,
  ],
  providers: [
    RedisService,
    RateLimitService,
    { provide: APP_GUARD, useClass: RateLimitGuard },
    JobsBridge,
    PaystackClient,
    DevOutboxService,
    NotificationService,
    BookingTokens,
    BookingViewService,
    BookingNotifier,
    CommissionService,
    RefundsService,
    GuestJobsService,
    BookingPaymentsService,
    HoldsService,
    CancellationService,
    PublicBookingService,
    TripsService,
    HotelBookingService,
    PlatformMarketplaceService,
    GuestAuthService,
    ReviewsService,
  ],
  exports: [
    RedisService,
    RateLimitService,
    JobsBridge,
    PaystackClient,
    NotificationService,
    BookingTokens,
    BookingViewService,
    CommissionService,
    RefundsService,
    GuestJobsService,
    BookingPaymentsService,
    HoldsService,
    CancellationService,
    PublicBookingService,
    HotelBookingService,
    PlatformMarketplaceService,
    ReviewsService,
  ],
})
export class GuestSideModule {}
