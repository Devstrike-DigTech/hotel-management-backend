import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth-types.js';
import { AnyPermission, ClientIp, CurrentUser, RequirePermission } from '../../common/decorators/index.js';
import { lagosDate } from '../../common/time/lagos.js';
import { DbService } from '../../prisma/db.service.js';
import { RequireFeature } from '../entitlements/entitlements.decorators.js';
import { PricingService } from './pricing.service.js';
import { PromosService } from './promos.service.js';
import {
  DeskQuoteDto,
  PromoCheckDto,
  PromoCodeDto,
  PromoListDto,
  PutOverridesDto,
  PutRestrictionsDto,
  RangeDto,
  RatePlanDto,
  RateRuleDto,
  UpdatePromoCodeDto,
  UpdateRatePlanDto,
  UpdateRateRuleDto,
} from './rates.dto.js';
import { RatesService } from './rates.service.js';
import { AppException } from '../../common/errors/app-exception.js';

@ApiTags('Rates')
@ApiBearerAuth()
@RequireFeature('promotions')
@Controller()
export class RatesController {
  constructor(
    private readonly rates: RatesService,
    private readonly pricing: PricingService,
  ) {}

  @Get('rate-plans')
  @RequirePermission('rates.view')
  plans(@CurrentUser() user: AuthUser, @Query() q: RangeDto) {
    return this.rates.listPlans(user, q.active);
  }

  @Post('rate-plans')
  @RequirePermission('rates.manage')
  createPlan(@CurrentUser() user: AuthUser, @Body() dto: RatePlanDto, @ClientIp() ip?: string) {
    return this.rates.createPlan(user, dto, ip);
  }

  @Patch('rate-plans/:id')
  @RequirePermission('rates.manage')
  updatePlan(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRatePlanDto, @ClientIp() ip?: string) {
    return this.rates.updatePlan(user, id, dto, ip);
  }

  @Delete('rate-plans/:id')
  @RequirePermission('rates.manage')
  deletePlan(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.rates.deletePlan(user, id, ip);
  }

  @Get('rate-rules')
  @RequirePermission('rates.view')
  rules(@CurrentUser() user: AuthUser, @Query() q: RangeDto) {
    return this.rates.listRules(user, q);
  }

  @Post('rate-rules')
  @RequirePermission('rates.manage')
  createRule(@CurrentUser() user: AuthUser, @Body() dto: RateRuleDto, @ClientIp() ip?: string) {
    return this.rates.createRule(user, dto, ip);
  }

  @Patch('rate-rules/:id')
  @RequirePermission('rates.manage')
  updateRule(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRateRuleDto, @ClientIp() ip?: string) {
    return this.rates.updateRule(user, id, dto, ip);
  }

  @Delete('rate-rules/:id')
  @RequirePermission('rates.manage')
  deleteRule(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.rates.deleteRule(user, id, ip);
  }

  @Get('rate-overrides')
  @RequirePermission('rates.view')
  overrides(@CurrentUser() user: AuthUser, @Query() q: RangeDto) {
    return this.rates.listOverrides(user, q);
  }

  @Put('rate-overrides')
  @RequirePermission('rates.manage')
  @ApiOperation({ summary: 'Set (or clear with rateKobo null) single-date BAR prices' })
  putOverrides(@CurrentUser() user: AuthUser, @Body() dto: PutOverridesDto, @ClientIp() ip?: string) {
    return this.rates.putOverrides(user, dto, ip);
  }

  @Get('rate-restrictions')
  @RequirePermission('rates.view')
  restrictions(@CurrentUser() user: AuthUser, @Query() q: RangeDto) {
    return this.rates.listRestrictions(user, q);
  }

  @Put('rate-restrictions')
  @RequirePermission('rates.manage')
  putRestrictions(@CurrentUser() user: AuthUser, @Body() dto: PutRestrictionsDto, @ClientIp() ip?: string) {
    return this.rates.putRestrictions(user, dto, ip);
  }

  @Get('rates/calendar')
  @RequirePermission('rates.view')
  @ApiOperation({ summary: 'The Rate Almanac: resolved nightly prices, bands, restrictions and occupancy' })
  calendar(@CurrentUser() user: AuthUser, @Query() q: RangeDto) {
    return this.rates.calendar(user, q);
  }
}

/** The desk price preview works on every plan (Starter hotels see BAR only). */
@ApiTags('Rates')
@ApiBearerAuth()
@Controller('rates')
export class RatesQuoteController {
  constructor(private readonly pricing: PricingService) {}

  @Post('quote')
  @HttpCode(200)
  @AnyPermission('reservations.view', 'rates.view')
  @ApiOperation({ summary: 'Price a stay (rate plan, promo, corporate account) without booking it' })
  quote(@CurrentUser() user: AuthUser, @Body() dto: DeskQuoteDto) {
    return this.pricing.deskQuote(user, dto);
  }
}

@ApiTags('Rates')
@ApiBearerAuth()
@RequireFeature('promotions')
@Controller('promo-codes')
export class PromoCodesController {
  constructor(
    private readonly promos: PromosService,
    private readonly db: DbService,
  ) {}

  @Get()
  @RequirePermission('rates.view')
  list(@CurrentUser() user: AuthUser, @Query() q: PromoListDto) {
    return this.promos.list(user, q);
  }

  @Post('check')
  @HttpCode(200)
  @RequirePermission('rates.view')
  @ApiOperation({ summary: 'Test a promo code against a stay' })
  check(@CurrentUser() user: AuthUser, @Body() dto: PromoCheckDto) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rt = await tx.roomType.findFirst({ where: { id: dto.roomTypeId, tenantId: user.tenantId } });
      if (!rt) throw AppException.notFound('Room type');
      const c = await this.promos.check(tx, user.tenantId, {
        code: dto.code,
        roomTypeId: dto.roomTypeId,
        arrivalDate: dto.arrivalDate,
        departureDate: dto.departureDate,
        channel: dto.channel ?? 'FRONT_DESK',
        guestPhone: dto.guestPhone,
      });
      return { valid: !c.reason, reason: c.reason, message: c.message, checkedOn: lagosDate() };
    });
  }

  @Get(':id')
  @RequirePermission('rates.view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.promos.get(user, id);
  }

  @Post()
  @RequirePermission('promotions.manage')
  create(@CurrentUser() user: AuthUser, @Body() dto: PromoCodeDto, @ClientIp() ip?: string) {
    return this.promos.create(user, dto, ip);
  }

  @Patch(':id')
  @RequirePermission('promotions.manage')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePromoCodeDto, @ClientIp() ip?: string) {
    return this.promos.update(user, id, dto, ip);
  }

  @Delete(':id')
  @RequirePermission('promotions.manage')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip?: string) {
    return this.promos.remove(user, id, ip);
  }
}
