import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { GuestPrincipal } from '../../common/auth-types.js';
import { ClientIp, MaybeGuest, OptionalGuest, Public } from '../../common/decorators/index.js';
import { AppException } from '../../common/errors/app-exception.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { PaystackClient } from '../billing/paystack.client.js';
import { RateLimit } from '../infra/rate-limit.js';
import { DevOutboxService } from '../notifications/dev-outbox.service.js';
import { HOLD_MINUTES, MAX_ADVANCE_DAYS, MAX_ONLINE_NIGHTS, QUOTE_TTL_MINUTES } from './booking.logic.js';
import { AvailabilityQueryDto,
  PriceCalendarQueryDto, CreateBookingDto, DevConfirmDto, OutboxQueryDto, QuoteDto, TripCancelDto } from './booking.dto.js';
import { BookingPaymentsService } from './booking-payments.service.js';
import { ConciergePaymentsService } from '../concierge/concierge-payments.service.js';
import { PublicBookingService } from './public-booking.service.js';
import { TripsService } from './trips.service.js';

const MINUTE = 60;
const HOUR = 3600;

@ApiTags('Public booking')
@Public()
@Controller('public')
export class PublicBookingController {
  constructor(
    private readonly booking: PublicBookingService,
    private readonly payments: BookingPaymentsService,
    private readonly trips: TripsService,
    private readonly config: AppConfigService,
    private readonly paystack: PaystackClient,
    private readonly concierge: ConciergePaymentsService,
  ) {}

  @Get('booking-config')
  bookingConfig() {
    return {
      holdMinutes: HOLD_MINUTES,
      quoteTtlMinutes: QUOTE_TTL_MINUTES,
      paymentProvider: this.paystack.providerName,
      otpChannels: ['SMS', 'WHATSAPP'],
      devMode: !this.config.isProduction,
      maxNights: MAX_ONLINE_NIGHTS,
      maxAdvanceDays: MAX_ADVANCE_DAYS,
    };
  }

  @Get('hotels/:slug/availability')
  @RateLimit({ name: 'availability', limit: 120, windowSec: MINUTE })
  @ApiOperation({ summary: 'Room types with availability and quoted totals for dates (or a day-use slot)' })
  availability(@Param('slug') slug: string, @Query() q: AvailabilityQueryDto) {
    return this.booking.hotelAvailability(slug, q);
  }

  @Get('hotels/:slug/price-calendar')
  @RateLimit({ name: 'availability', limit: 120, windowSec: MINUTE })
  @ApiOperation({ summary: 'Cheapest nightly price per day for the date picker, with closed-to-arrival days and min-stay hints' })
  priceCalendar(@Param('slug') slug: string, @Query() q: PriceCalendarQueryDto) {
    return this.booking.priceCalendar(slug, q);
  }

  @Post('quotes')
  @HttpCode(200)
  @OptionalGuest()
  @RateLimit({ name: 'quote', limit: 30, windowSec: MINUTE })
  @ApiOperation({ summary: 'Authoritative price + quoteToken (15 minutes)' })
  quote(@Body() dto: QuoteDto, @MaybeGuest() guest: GuestPrincipal | undefined) {
    return this.booking.quote(dto, guest);
  }

  @Post('bookings')
  @OptionalGuest()
  @RateLimit({ name: 'booking', limit: 10, windowSec: MINUTE })
  @ApiOperation({ summary: 'Create a booking: online payment (20-minute hold) or pay at the hotel' })
  async create(@Body() dto: CreateBookingDto, @MaybeGuest() guest: GuestPrincipal | undefined, @Res({ passthrough: true }) res: Response, @ClientIp() ip?: string) {
    const out = await this.booking.create(dto, guest, ip);
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return out.body;
  }

  @Get('payments/:reference/verify')
  @RateLimit({ name: 'verify', limit: 60, windowSec: MINUTE })
  @ApiOperation({ summary: 'Payment status after the Paystack redirect (verifies with Paystack when still pending)' })
  verify(@Param('reference') reference: string) {
    // M8: concierge payments (CRQ_...) answer ConciergePaymentStatus.
    if (ConciergePaymentsService.isConciergeReference(reference)) return this.concierge.verify(reference);
    return this.payments.verify(reference);
  }

  @Post('payments/:reference/retry')
  @HttpCode(200)
  @RateLimit({ name: 'pay-retry', limit: 10, windowSec: 10 * MINUTE })
  retry(@Param('reference') reference: string) {
    return this.payments.retry(reference);
  }

  // --- Manage booking (trip token) -----------------------------------------

  @Get('trips/:code')
  trip(@Param('code') code: string, @Query('t') t?: string) {
    return this.trips.view(code, t);
  }

  @Get('trips/:code/cancel-preview')
  preview(@Param('code') code: string, @Query('t') t?: string) {
    return this.trips.preview(code, t);
  }

  @Post('trips/:code/cancel')
  @HttpCode(200)
  @RateLimit({ name: 'trip-cancel', limit: 10, windowSec: HOUR })
  cancel(@Param('code') code: string, @Body() dto: TripCancelDto, @Query('t') t?: string, @ClientIp() ip?: string) {
    return this.trips.cancel(code, t, dto.reason, ip);
  }

  @Get('trips/:code/calendar.ics')
  @Header('Content-Type', 'text/calendar; charset=utf-8')
  async calendar(@Param('code') code: string, @Res({ passthrough: true }) res: Response, @Query('t') t?: string) {
    const ics = await this.trips.calendar(code, t);
    res.setHeader('Content-Disposition', `attachment; filename="${ics.filename}"`);
    return ics.body;
  }

  @Get('trips/:code/documents/:kind/:id')
  document(@Param('code') code: string, @Param('kind') kind: string, @Param('id') id: string, @Query('t') t?: string) {
    if (kind !== 'invoice' && kind !== 'receipt') throw AppException.notFound('Document');
    return this.trips.document(code, t, kind, id);
  }

  @Post('trips/:code/invoice')
  proforma(@Param('code') code: string, @Query('t') t?: string) {
    return this.trips.proforma(code, t);
  }
}

/** Development helpers; every route answers 404 in production. */
@ApiTags('Development')
@Public()
@Controller('public/dev')
export class DevController {
  constructor(
    private readonly outbox: DevOutboxService,
    private readonly payments: BookingPaymentsService,
    private readonly concierge: ConciergePaymentsService,
  ) {}

  private assertDev() {
    if (!this.outbox.available) throw AppException.notFound('Route');
  }

  @Get('outbox')
  @ApiOperation({ summary: 'Last 50 messages that would have been sent (dev only)' })
  async list(@Query() q: OutboxQueryDto) {
    this.assertDev();
    return { items: await this.outbox.list(q.limit ?? 50, q.to) };
  }

  @Delete('outbox')
  async clear() {
    this.assertDev();
    await this.outbox.clear();
    return { success: true };
  }

  @Post('payments/:reference/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mock checkout: complete or fail a payment (dev only, mock provider)' })
  confirm(@Param('reference') reference: string, @Body() dto: DevConfirmDto) {
    this.assertDev();
    if (ConciergePaymentsService.isConciergeReference(reference)) return this.concierge.devConfirm(reference, dto);
    return this.payments.devConfirm(reference, dto);
  }
}
