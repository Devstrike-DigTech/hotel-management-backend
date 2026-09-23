import { HttpStatus, Injectable } from '@nestjs/common';
import type { PromoCode, RoomType } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { diffDays, isIsoDate, lagosDateTime } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { priceNights, type PriceBreakdown } from '../booking/booking.logic.js';
import { componentsFrom, type TaxComponent } from '../folios/tax.logic.js';
import { TaxSettingsService } from '../folios/tax-settings.service.js';
import { appError, Err, primaryProperty } from '../ops/ops.helpers.js';
import { freeRoomsOverWindow, loadCapacity } from './capacity.js';
import { PromosService } from './promos.service.js';
import {
  planUnavailable,
  promoDiscounts,
  resolveNights,
  restrictionHits,
  stayDates,
  type NightlyRate,
  type PlanLike,
  type PromoInvalidReason,
  type RateChannel,
  type RestrictionHit,
} from './rates.logic.js';
import { planLabel, RatesService, type RateContext } from './rates.service.js';

export interface StayPricing {
  plan: PlanLike;
  nights: NightlyRate[];
  promo: PromoCode | null;
  promoError: { code: string; reason: PromoInvalidReason; message: string } | null;
  warnings: RestrictionHit[];
  components: TaxComponent[];
  breakdown: PriceBreakdown;
  ctx: RateContext;
}

export interface StayPricingInput {
  roomType: Pick<RoomType, 'id' | 'name' | 'basePriceKobo' | 'propertyId'>;
  arrivalDate: string;
  departureDate: string;
  ratePlanId?: string | null;
  promoCode?: string | null;
  channel: RateChannel;
  guestPhone?: string | null;
  guestId?: string | null;
  excludeReservationId?: string | null;
  /** Manual prices (MANAGER): one per night, or a single price for every night. */
  manual?: { rateKobo?: number; nightly?: { date: string; rateKobo: number }[] };
  /** Online channels: restrictions are enforced (STAY_RESTRICTED); at the desk they are warnings. */
  enforceRestrictions: boolean;
  /** Throw PROMO_INVALID (bookings) instead of reporting promoError (previews). */
  promoStrict: boolean;
  /** Lock the promo row (bookings) so the last use cannot be sold twice. */
  lockPromo?: boolean;
  /** Skip the plan's channel / length checks (re-pricing an existing stay). */
  skipPlanChecks?: boolean;
}

export function ratePlanRef(plan: PlanLike) {
  return {
    id: plan.id ?? '',
    code: plan.code,
    name: plan.name,
    kind: plan.kind,
    includesBreakfast: plan.includesBreakfast,
    refundable: !plan.cancelPolicy?.nonRefundable,
  };
}

/**
 * Prices a nightly stay end to end: rate plan (resolveNightlyRates), promo
 * discount per night, restrictions and the tax breakdown exactly as the
 * folio will post it. Used by desk reservations, the admin quote, public
 * availability / quotes / bookings.
 */
@Injectable()
export class PricingService {
  constructor(
    private readonly db: DbService,
    private readonly rates: RatesService,
    private readonly promos: PromosService,
    private readonly taxes: TaxSettingsService,
  ) {}

  planError(plan: PlanLike, reason: string) {
    const messages: Record<string, string> = {
      INACTIVE: `${plan.name} is not available`,
      CHANNEL: `${plan.name} cannot be booked here`,
      MIN_NIGHTS: `${plan.name} needs at least ${plan.minNights} nights`,
      MAX_NIGHTS: `${plan.name} is for stays of at most ${plan.maxNights} nights`,
      ROOM_TYPE: `${plan.name} is not sold for this room type`,
    };
    return appError(HttpStatus.BAD_REQUEST, 'RATE_PLAN_UNAVAILABLE', messages[reason] ?? `${plan.name} is not available`, {
      ratePlanId: plan.id,
      reason,
      ...(plan.minNights && { minNights: plan.minNights }),
      ...(plan.maxNights && { maxNights: plan.maxNights }),
    });
  }

  restrictionError(hit: RestrictionHit) {
    return appError(HttpStatus.CONFLICT, 'STAY_RESTRICTED', hit.message, { reason: hit.reason, date: hit.date, ...(hit.minNights && { minNights: hit.minNights }) });
  }

  async price(tx: Tx, tenantId: string, input: StayPricingInput, preloaded?: { ctx?: RateContext; components?: TaxComponent[] }): Promise<StayPricing> {
    const nightsCount = diffDays(input.arrivalDate, input.departureDate);
    if (nightsCount < 1) throw Err.validation('departureDate', 'A nightly stay needs at least one night');
    const ctx = preloaded?.ctx ?? (await this.rates.context(tx, tenantId, input.arrivalDate, input.departureDate));
    const plan = this.rates.planFrom(ctx, input.ratePlanId);
    if (!input.skipPlanChecks) {
      const why = planUnavailable(plan, input.roomType.id, nightsCount, input.channel);
      if (why) throw this.planError(plan, why);
    }
    const dates = stayDates(input.arrivalDate, input.departureDate);
    let nights: NightlyRate[] | null;
    if (input.manual?.nightly) {
      const map = new Map(input.manual.nightly.map((n) => [n.date, n.rateKobo]));
      if (dates.some((d) => !map.has(d)) || map.size !== dates.length) throw Err.validation('nightlyRates', 'Give exactly one price for each night of the stay');
      nights = dates.map((d) => ({ date: d, rateKobo: map.get(d)!, baseRateKobo: map.get(d)!, source: 'MANUAL' as const, ruleId: null, ruleName: null, discountKobo: 0 }));
    } else if (input.manual?.rateKobo !== undefined) {
      const r = input.manual.rateKobo;
      nights = dates.map((d) => ({ date: d, rateKobo: r, baseRateKobo: r, source: 'MANUAL' as const, ruleId: null, ruleName: null, discountKobo: 0 }));
    } else {
      nights = resolveNights({ roomType: input.roomType, plan, dates, rules: ctx.rules, overrides: ctx.overrides });
      if (!nights) throw this.planError(plan, 'ROOM_TYPE');
    }
    const warnings = ctx.promotions ? restrictionHits(ctx.restrictions, input.roomType.id, input.arrivalDate, input.departureDate) : [];
    if (input.enforceRestrictions && warnings.length) throw this.restrictionError(warnings[0]);

    const components = preloaded?.components ?? componentsFrom(await this.taxes.forProperty(tx, tenantId, input.roomType.propertyId));
    let promo: PromoCode | null = null;
    let promoError: StayPricing['promoError'] = null;
    if (input.promoCode?.trim()) {
      const code = this.promos.normalise(input.promoCode);
      const check = ctx.promotions
        ? await this.promos.check(tx, tenantId, {
            code,
            roomTypeId: input.roomType.id,
            arrivalDate: input.arrivalDate,
            departureDate: input.departureDate,
            channel: input.channel,
            guestPhone: input.guestPhone,
            guestId: input.guestId,
            excludeReservationId: input.excludeReservationId,
            lock: input.lockPromo,
          })
        : { promo: null, reason: 'NOT_FOUND' as const, message: `${code} is not a valid promo code` };
      if (!check.reason && check.promo) {
        const discounts = promoDiscounts(check.promo, nights, components);
        if (discounts.every((d) => d <= 0)) {
          check.reason = 'NO_DISCOUNT';
          check.message = `${code} gives no discount on this stay`;
        } else {
          nights = nights.map((n, i) => ({ ...n, discountKobo: discounts[i] }));
          promo = check.promo;
        }
      }
      if (check.reason) {
        if (input.promoStrict) throw this.promos.toError(check, code);
        promoError = { code, reason: check.reason, message: check.message ?? 'Invalid promo code' };
      }
    }
    const breakdown = priceNights({
      roomTypeName: input.roomType.name,
      components,
      nights: nights.map((n) => ({ date: n.date, rateKobo: n.rateKobo, discountKobo: n.discountKobo, ruleName: n.ruleName })),
      ratePlan: ratePlanRef(plan),
      promo: promo ? { code: promo.code, description: promo.description, type: promo.type } : null,
    });
    return { plan, nights, promo, promoError, warnings, components, breakdown, ctx };
  }

  /** Admin price preview for the new-reservation drawer (POST /rates/quote). */
  deskQuote(
    user: AuthUser,
    dto: {
      roomTypeId: string;
      arrivalDate: string;
      departureDate: string;
      ratePlanId?: string;
      promoCode?: string;
      corporateAccountId?: string;
      adults?: number;
      children?: number;
      channel?: RateChannel;
      guestPhone?: string;
      excludeReservationId?: string;
    },
  ) {
    if (!isIsoDate(dto.arrivalDate) || !isIsoDate(dto.departureDate)) throw Err.validation('arrivalDate', 'arrivalDate and departureDate must be YYYY-MM-DD');
    return this.db.tenant(user.tenantId, async (tx) => {
      const rt = await tx.roomType.findFirst({ where: { id: dto.roomTypeId, tenantId: user.tenantId } });
      if (!rt) throw AppException.notFound('Room type');
      const channel = dto.channel ?? 'FRONT_DESK';
      let account: { id: string; name: string; ratePlanId: string | null } | null = null;
      if (dto.corporateAccountId) {
        account = await tx.corporateAccount.findFirst({ where: { id: dto.corporateAccountId, tenantId: user.tenantId }, select: { id: true, name: true, ratePlanId: true } });
        if (!account) throw AppException.notFound('Corporate account');
      }
      const ratePlanId = dto.ratePlanId ?? account?.ratePlanId ?? null;
      const ctx = await this.rates.context(tx, user.tenantId, dto.arrivalDate, dto.departureDate);
      const components = componentsFrom(await this.taxes.forProperty(tx, user.tenantId, rt.propertyId));
      const priced = await this.price(
        tx,
        user.tenantId,
        {
          roomType: rt,
          arrivalDate: dto.arrivalDate,
          departureDate: dto.departureDate,
          ratePlanId,
          promoCode: dto.promoCode,
          channel,
          guestPhone: dto.guestPhone,
          excludeReservationId: dto.excludeReservationId,
          enforceRestrictions: channel !== 'FRONT_DESK',
          promoStrict: false,
        },
        { ctx, components },
      );
      const nights = diffDays(dto.arrivalDate, dto.departureDate);
      const eligiblePlans = [];
      for (const p of ctx.plans) {
        const why = planUnavailable(p, rt.id, nights, channel);
        let total: number | null = null;
        if (!why) {
          const n = resolveNights({ roomType: rt, plan: p, dates: stayDates(dto.arrivalDate, dto.departureDate), rules: ctx.rules, overrides: ctx.overrides });
          total = n ? priceNights({ roomTypeName: rt.name, components, nights: n }).totalKobo : null;
        }
        eligiblePlans.push({ id: p.id ?? '', code: p.code, name: p.name, kind: p.kind, label: planLabel(p), available: !why && total !== null, reason: why, totalKobo: total });
      }
      const property = await primaryProperty(tx, user.tenantId);
      const a = lagosDateTime(dto.arrivalDate, property.checkInTime);
      const d = lagosDateTime(dto.departureDate, property.checkOutTime);
      const cap = (await loadCapacity(tx, user.tenantId, [rt.id], a, d, { excludeReservationId: dto.excludeReservationId })).get(rt.id)!;
      return {
        roomType: { id: rt.id, name: rt.name },
        ratePlan: ratePlanRef(priced.plan),
        nights: priced.nights,
        roomTotalKobo: priced.nights.reduce((s, n) => s + n.rateKobo, 0),
        breakdown: priced.breakdown,
        promo: priced.promo ? { code: priced.promo.code, description: priced.promo.description, type: priced.promo.type, discountKobo: priced.breakdown.discountKobo } : null,
        promoError: priced.promoError,
        eligiblePlans,
        warnings: priced.warnings,
        available: freeRoomsOverWindow(cap, a, d),
        corporateAccount: account,
      };
    });
  }
}
