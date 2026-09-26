import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/index.js';
import { RateLimit } from '../infra/rate-limit.js';
import {
  AcceptQuoteDto,
  DeclineQuoteDto,
  GuestCancelDto,
  GuestCreateRequestDto,
  GuestRateDto,
  PublicCatalogueQueryDto,
  PublicPriceDto,
  SlotsQueryDto,
} from './concierge.dto.js';
import { ConciergePaymentsService } from './concierge-payments.service.js';
import { PublicConciergeService } from './public-concierge.service.js';

const MINUTE = 60;
const HOUR = 3600;

/** Guest-facing concierge (M8): catalogue, trip page, quote links, payments. */
@ApiTags('Public concierge')
@Public()
@Controller('public')
export class PublicConciergeController {
  constructor(
    private readonly svc: PublicConciergeService,
    private readonly payments: ConciergePaymentsService,
  ) {}

  @Get('concierge/categories')
  categories() {
    return this.svc.categories();
  }

  @Get('hotels/:slug/concierge')
  @RateLimit({ name: 'concierge', limit: 120, windowSec: MINUTE })
  @ApiOperation({ summary: 'The hotel concierge catalogue (lawful services only)' })
  catalogue(@Param('slug') slug: string, @Query() q: PublicCatalogueQueryDto) {
    return this.svc.hotelCatalogue(slug, q);
  }

  @Get('hotels/:slug/concierge/services/:id')
  @RateLimit({ name: 'concierge', limit: 120, windowSec: MINUTE })
  service(@Param('slug') slug: string, @Param('id') id: string) {
    return this.svc.hotelService(slug, id);
  }

  @Get('hotels/:slug/concierge/services/:id/slots')
  @RateLimit({ name: 'concierge', limit: 120, windowSec: MINUTE })
  slots(@Param('slug') slug: string, @Param('id') id: string, @Query() q: SlotsQueryDto) {
    return this.svc.slots(slug, id, q.date, q.variantId);
  }

  @Post('hotels/:slug/concierge/price')
  @HttpCode(200)
  @RateLimit({ name: 'concierge', limit: 120, windowSec: MINUTE })
  price(@Param('slug') slug: string, @Body() dto: PublicPriceDto) {
    return this.svc.price(slug, dto);
  }

  // --- Trip page (manage-booking token) --------------------------------------------

  @Get('trips/:code/concierge')
  trip(@Param('code') code: string, @Query('t') t?: string) {
    return this.svc.trip(code, t);
  }

  @Post('trips/:code/concierge/requests')
  @RateLimit({ name: 'concierge-request', limit: 30, windowSec: HOUR })
  create(@Param('code') code: string, @Body() dto: GuestCreateRequestDto, @Query('t') t?: string) {
    return this.svc.create(code, t, dto);
  }

  @Get('trips/:code/concierge/requests/:id')
  get(@Param('code') code: string, @Param('id') id: string, @Query('t') t?: string) {
    return this.svc.getRequest(code, t, id);
  }

  @Post('trips/:code/concierge/requests/:id/cancel')
  @HttpCode(200)
  @RateLimit({ name: 'concierge-request', limit: 30, windowSec: HOUR })
  cancel(@Param('code') code: string, @Param('id') id: string, @Body() dto: GuestCancelDto, @Query('t') t?: string) {
    return this.svc.cancel(code, t, id, dto.reason);
  }

  @Post('trips/:code/concierge/requests/:id/rating')
  @HttpCode(200)
  @RateLimit({ name: 'concierge-request', limit: 30, windowSec: HOUR })
  rate(@Param('code') code: string, @Param('id') id: string, @Body() dto: GuestRateDto, @Query('t') t?: string) {
    return this.svc.rate(code, t, id, dto);
  }

  // --- Quote links -----------------------------------------------------------------------

  @Get('concierge/quotes/:token')
  quote(@Param('token') token: string) {
    return this.svc.quote(token);
  }

  @Post('concierge/quotes/:token/accept')
  @HttpCode(200)
  @RateLimit({ name: 'concierge-quote', limit: 20, windowSec: 10 * MINUTE })
  accept(@Param('token') token: string, @Body() dto: AcceptQuoteDto) {
    return this.svc.accept(token, dto);
  }

  @Post('concierge/quotes/:token/decline')
  @HttpCode(200)
  @RateLimit({ name: 'concierge-quote', limit: 20, windowSec: 10 * MINUTE })
  decline(@Param('token') token: string, @Body() dto: DeclineQuoteDto) {
    return this.svc.decline(token, dto.reason);
  }

  @Get('concierge/payments/:reference/verify')
  @RateLimit({ name: 'verify', limit: 60, windowSec: MINUTE })
  verify(@Param('reference') reference: string) {
    return this.payments.verify(reference);
  }
}
