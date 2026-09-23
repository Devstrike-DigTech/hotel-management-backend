import { runInProperty } from '../../common/property-scope.js';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Prisma, Property, RoomType } from '../../generated/prisma/client.js';
import type { GuestPrincipal } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { addDays, diffDays, lagosDate, lagosDateTime } from '../../common/time/lagos.js';
import { codePrefix, reservationCode } from '../../common/utils/codes.js';
import { normalisePhone } from '../../common/utils/phone.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PaystackClient } from '../billing/paystack.client.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { componentsFrom, type TaxComponent } from '../folios/tax.logic.js';
import { TaxSettingsService } from '../folios/tax-settings.service.js';
import { GuestsService } from '../guests/guests.service.js';
import { RateLimitService } from '../infra/rate-limit.js';
import { NotificationService } from '../notifications/notification.service.js';
import { appError, Err, isExclusionViolation, k } from '../ops/ops.helpers.js';
import { toImages, toRoomTypePublic } from '../public/hotel.mapper.js';
import { AvailabilityService } from '../reservations/availability.service.js';
import { dateRange, dbDate } from '../../common/time/lagos.js';
import { freeRoomsOverWindow, loadCapacity } from '../rates/capacity.js';
import { PricingService, type StayPricing } from '../rates/pricing.service.js';
import { PromosService } from '../rates/promos.service.js';
import { LoyaltyService, type QuoteLoyalty } from '../loyalty/loyalty.service.js';
import { planUnavailable, resolveNights, restrictionHits, restrictionOn, stayDates, type NightlyRate, type PlanLike } from '../rates/rates.logic.js';
import { planLabel, planTerms, RatesService, type RateContext } from '../rates/rates.service.js';
import {
  checkStayDates,
  effectivePolicy,
  priceNights,
  type PolicyInput,
  commissionFor,
  effectiveCommissionBps,
  freeCancellationUntil,
  HOLD_MINUTES,
  mapUrl,
  policyView,
  priceStay,
  QUOTE_TTL_MINUTES,
  type BookingChannel,
  type PriceBreakdown,
} from './booking.logic.js';
import type { AvailabilityQueryDto, CreateBookingDto, PriceCalendarQueryDto, QuoteDto } from './booking.dto.js';
import { BookingNotifier } from './booking-notifier.service.js';
import { BookingPaymentsService, runAfter, type PaymentInit } from './booking-payments.service.js';
import { BookingTokens } from './booking-tokens.service.js';
import { BookingViewService, stayInclude } from './booking-view.service.js';
import { CommissionService } from './commission.service.js';
import { GuestJobsService } from './guest-jobs.service.js';

export interface StayWindow {
  stayType: 'NIGHTLY' | 'DAY_USE';
  arrivalAt: Date;
  departureAt: Date;
  checkIn: string | null;
  checkOut: string | null;
  date: string | null;
  startTime: string | null;
  hours: number | null;
  nights: number | null;
  /** First night / day-use date. */
  day: string;
  units: number;
}

/** Tax settings are created with these defaults on first use (VAT 7.5% exclusive). */
const DEFAULT_TAX: TaxComponent[] = [{ code: 'VAT', label: 'VAT', rateBps: 750, inclusive: false }];

type HotelRow = Property & { roomTypes: (RoomType & { rooms: { status: string }[] })[] };

const hotelInclude = {
  roomTypes: { orderBy: [{ sortOrder: 'asc' }, { basePriceKobo: 'asc' }], include: { rooms: { select: { status: true } } } },
} satisfies Prisma.PropertyInclude;

/**
 * Anonymous booking flow. The hotel is found by slug in the public context;
 * everything after that runs in that hotel's signed tenant context (the
 * tenant id comes from our own lookup, never from the request), so RLS keeps
 * each booking inside its hotel.
 */
@Injectable()
export class PublicBookingService {
  private readonly logger = new Logger(PublicBookingService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: AppConfigService,
    private readonly tokens: BookingTokens,
    private readonly views: BookingViewService,
    private readonly notifier: BookingNotifier,
    private readonly notifications: NotificationService,
    private readonly taxes: TaxSettingsService,
    private readonly availability: AvailabilityService,
    private readonly guests: GuestsService,
    private readonly entitlements: EntitlementsService,
    private readonly commission: CommissionService,
    private readonly payments: BookingPaymentsService,
    private readonly paystack: PaystackClient,
    private readonly audit: AuditService,
    private readonly limits: RateLimitService,
    private readonly jobs: GuestJobsService,
    private readonly rates: RatesService,
    private readonly pricing: PricingService,
    private readonly promos: PromosService,
    private readonly loyalty: LoyaltyService,
  ) {}

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async hotelRef(slug: string): Promise<{ id: string; tenantId: string }> {
    const p = await this.db.public((tx) =>
      tx.property.findFirst({
        where: { slug: slug.toLowerCase(), tenant: { subscription: { is: { status: { not: 'SUSPENDED' } } } } },
        select: { id: true, tenantId: true },
      }),
    );
    if (!p) throw AppException.notFound('Hotel');
    return p;
  }

  private async loadHotel(tx: Tx, ref: { id: string; tenantId: string }): Promise<HotelRow> {
    const p = await tx.property.findFirst({ where: { id: ref.id, tenantId: ref.tenantId }, include: hotelInclude });
    if (!p) throw AppException.notFound('Hotel');
    return p;
  }

  /** Resolves the stay window from query/body input and the hotel's times. */
  resolveStay(
    p: Pick<Property, 'checkInTime' | 'checkOutTime'>,
    q: { stayType?: string; checkIn?: string; checkOut?: string; date?: string; startTime?: string; hours?: number },
    now = new Date(),
  ): StayWindow {
    if ((q.stayType ?? 'NIGHTLY') === 'DAY_USE') {
      if (!q.date || !q.startTime || !q.hours) throw Err.validation('date', 'date, startTime and hours are required for day use');
      const arrivalAt = lagosDateTime(q.date, q.startTime);
      const departureAt = new Date(arrivalAt.getTime() + q.hours * 3_600_000);
      if (arrivalAt.getTime() < now.getTime() - 10 * 60_000) throw Err.validation('startTime', 'The start time has already passed');
      if (q.date > addDays(lagosDate(now), 365)) throw Err.validation('date', 'Bookings open 365 days ahead');
      return { stayType: 'DAY_USE', arrivalAt, departureAt, checkIn: null, checkOut: null, date: q.date, startTime: q.startTime, hours: q.hours, nights: null, day: q.date, units: q.hours };
    }
    if (!q.checkIn || !q.checkOut) throw Err.validation('checkIn', 'checkIn and checkOut are required');
    const problem = checkStayDates(q.checkIn, q.checkOut, now);
    if (problem) throw Err.validation('checkIn', problem);
    const nights = diffDays(q.checkIn, q.checkOut);
    return {
      stayType: 'NIGHTLY',
      arrivalAt: lagosDateTime(q.checkIn, p.checkInTime),
      departureAt: lagosDateTime(q.checkOut, p.checkOutTime),
      checkIn: q.checkIn,
      checkOut: q.checkOut,
      date: null,
      startTime: null,
      hours: null,
      nights,
      day: q.checkIn,
      units: nights,
    };
  }

  /** roomTypeId -> rooms free for the whole window (blocks and out-of-order rooms excluded). */
  private async availableByType(tx: Tx, tenantId: string, p: HotelRow, w: { arrivalAt: Date; departureAt: Date }): Promise<Map<string, number>> {
    return this.availability.freeByType(tx, tenantId, p.roomTypes.map((rt) => rt.id), w.arrivalAt, w.departureAt);
  }

  /** Plans a guest can book on this channel, BAR first. */
  publicPlans(ctx: RateContext, channel: BookingChannel): PlanLike[] {
    return ctx.plans.filter((pl) => pl.active && pl.channels.includes(channel));
  }

  planPublic(pl: PlanLike, hotel: PolicyInput) {
    const policy = effectivePolicy(hotel, pl.cancelPolicy);
    return {
      id: pl.id ?? '',
      code: pl.code,
      name: pl.name,
      kind: pl.kind,
      description: pl.description ?? '',
      ...planTerms(pl),
      refundable: !policy.nonRefundable,
      nonRefundable: policy.nonRefundable,
      cancellationSummary: policyView(policy).summary,
      label: planLabel(pl),
    };
  }

  private price(rt: RoomType, w: StayWindow, comps: TaxComponent[]): PriceBreakdown | null {
    if (w.stayType === 'DAY_USE') {
      if (rt.hourlyPriceKobo === null) return null;
      return priceStay({ stayType: 'DAY_USE', rateKobo: rt.hourlyPriceKobo, roomTypeName: rt.name, components: comps, date: w.day, hours: w.hours! });
    }
    return priceStay({ stayType: 'NIGHTLY', rateKobo: rt.basePriceKobo, roomTypeName: rt.name, components: comps, arrivalDate: w.day, nights: w.nights! });
  }

  private async dayUseAllowed(tx: Tx, tenantId: string): Promise<boolean> {
    const ent = await this.entitlements.getEntitlements(tenantId, tx);
    return ent.features.includes('hourly_bookings');
  }

  private assertChannel(p: Property, channel: BookingChannel) {
    if (channel === 'MARKETPLACE' && !p.listedOnMarketplace) {
      throw appError(HttpStatus.BAD_REQUEST, 'CHANNEL_NOT_ALLOWED', 'This hotel takes bookings on its own website only', { channel });
    }
    if (!p.onlineBookingEnabled) {
      throw appError(HttpStatus.CONFLICT, 'ONLINE_BOOKING_DISABLED', `${p.name} is not taking online bookings right now. Please call the hotel.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Availability
  // ---------------------------------------------------------------------------

  async hotelAvailability(slug: string, q: AvailabilityQueryDto) {
    const ref = await this.hotelRef(slug);
    return runInProperty(ref.tenantId, ref.id, () => this.db.tenant(ref.tenantId, async (tx) => {
      const p = await this.loadHotel(tx, ref);
      const w = this.resolveStay(p, q);
      const adults = q.adults ?? q.guests ?? 1;
      const children = q.children ?? 0;
      if (w.stayType === 'DAY_USE' && !(await this.dayUseAllowed(tx, ref.tenantId))) {
        throw appError(HttpStatus.BAD_REQUEST, 'DAY_USE_UNAVAILABLE', `${p.name} does not offer day use`, { roomTypeId: null });
      }
      const comps = componentsFrom(await this.taxes.forProperty(tx, ref.tenantId, p.id));
      const avail = await this.availableByType(tx, ref.tenantId, p, w);
      const payOnline = p.payoutReady;
      const channel: BookingChannel = q.channel ?? (p.listedOnMarketplace ? 'MARKETPLACE' : 'BOOKING_SITE');
      const ctx = w.stayType === 'NIGHTLY' ? await this.rates.context(tx, ref.tenantId, w.checkIn!, w.checkOut!, undefined, p.id) : null;
      let promo: { code: string; valid: boolean; reason: string | null; message: string | null } | null = null;
      const roomTypes = [];
      for (const rt of p.roomTypes) {
        const available = avail.get(rt.id) ?? 0;
        let quote: PriceBreakdown | null;
        let restriction: { reason: string; date: string; minNights?: number } | null = null;
        const ratePlans: { ratePlan: ReturnType<PublicBookingService['planPublic']>; bookable: boolean; unavailableReason: string | null; quote: PriceBreakdown | null }[] = [];
        if (w.stayType === 'NIGHTLY' && ctx) {
          const hits = ctx.promotions ? restrictionHits(ctx.restrictions, rt.id, w.checkIn!, w.checkOut!) : [];
          restriction = hits[0] ? { reason: hits[0].reason, date: hits[0].date, ...(hits[0].minNights && { minNights: hits[0].minNights }) } : null;
          quote = null;
          for (const pl of this.publicPlans(ctx, channel)) {
            const why = planUnavailable(pl, rt.id, w.nights!, channel);
            let planQuote: PriceBreakdown | null = null;
            if (why !== 'ROOM_TYPE') {
              try {
                const priced = await this.pricing.price(
                  tx,
                  ref.tenantId,
                  { roomType: rt, arrivalDate: w.checkIn!, departureDate: w.checkOut!, ratePlanId: pl.id, promoCode: q.promoCode, channel, enforceRestrictions: false, promoStrict: false, skipPlanChecks: true },
                  { ctx, components: comps },
                );
                planQuote = priced.breakdown;
                if (q.promoCode && pl.isBar && !promo) {
                  promo = { code: q.promoCode.trim().toUpperCase(), valid: !priced.promoError, reason: priced.promoError?.reason ?? null, message: priced.promoError?.message ?? null };
                }
              } catch {
                planQuote = null;
              }
            }
            if (pl.isBar) quote = planQuote;
            if (why === 'ROOM_TYPE' || !planQuote) continue;
            const reason = why ?? (available < 1 ? 'SOLD_OUT' : restriction ? 'RESTRICTED' : null);
            ratePlans.push({ ratePlan: this.planPublic(pl, p), bookable: !reason && p.onlineBookingEnabled && adults + children <= rt.capacity, unavailableReason: reason, quote: planQuote });
          }
        } else {
          quote = this.price(rt, w, comps);
        }
        const reason = !p.onlineBookingEnabled
          ? 'ONLINE_BOOKING_DISABLED'
          : quote === null && w.stayType === 'DAY_USE'
            ? 'NO_HOURLY_RATE'
            : adults + children > rt.capacity
              ? 'CAPACITY'
              : available < 1
                ? 'SOLD_OUT'
                : restriction
                  ? 'RESTRICTED'
                  : null;
        roomTypes.push({
          roomType: toRoomTypePublic(rt, available),
          available,
          bookable: reason === null,
          unavailableReason: reason,
          lowAvailability: available >= 1 && available <= 2,
          quote,
          ratePlans,
          restriction,
        });
      }
      return {
        slug: p.slug,
        stayType: w.stayType,
        checkIn: w.checkIn,
        checkOut: w.checkOut,
        date: w.date,
        startTime: w.startTime,
        hours: w.hours,
        arrivalAt: w.arrivalAt.toISOString(),
        departureAt: w.departureAt.toISOString(),
        nights: w.nights,
        adults,
        children,
        channel,
        onlineBookingEnabled: p.onlineBookingEnabled,
        payOnlineAvailable: p.onlineBookingEnabled && payOnline,
        payAtHotelAvailable: p.onlineBookingEnabled && p.allowPayAtHotel,
        cancellationPolicy: policyView(p),
        freeCancellationUntil: freeCancellationUntil(w.arrivalAt, p)?.toISOString() ?? null,
        roomTypes,
        promo,
      };
    }));
  }

  /**
   * Price calendar for the date picker: per date, the cheapest nightly price
   * of a room type (capacity >= guests) with a room free that night, and the
   * restrictions that apply to arrivals on that date.
   */
  async priceCalendar(slug: string, q: PriceCalendarQueryDto) {
    const today = lagosDate();
    if (q.from < today) throw Err.validation('from', 'from cannot be in the past');
    if (q.to < q.from) throw Err.validation('to', '"to" must not be before "from"');
    if (diffDays(q.from, q.to) + 1 > 62) throw Err.validation('to', 'The range can be at most 62 days');
    const ref = await this.hotelRef(slug);
    return runInProperty(ref.tenantId, ref.id, () => this.db.tenant(ref.tenantId, async (tx) => {
      const p = await this.loadHotel(tx, ref);
      const guests = (q.adults ?? 1) + (q.children ?? 0);
      const channel: BookingChannel = q.channel ?? (p.listedOnMarketplace ? 'MARKETPLACE' : 'BOOKING_SITE');
      const ctx = await this.rates.context(tx, ref.tenantId, q.from, addDays(q.to, 1), undefined, p.id);
      const plans = this.publicPlans(ctx, channel).filter((pl) => !q.ratePlanId || pl.id === q.ratePlanId);
      const types = p.roomTypes.filter((rt) => rt.capacity >= guests && (!q.roomTypeId || rt.id === q.roomTypeId));
      const dates = dateRange(q.from, q.to);
      const windows = dates.map((d) => ({ date: d, start: lagosDateTime(d, p.checkInTime), end: lagosDateTime(addDays(d, 1), p.checkOutTime) }));
      const caps = await loadCapacity(tx, ref.tenantId, types.map((t) => t.id), windows[0].start, windows[windows.length - 1].end);
      return {
        slug: p.slug,
        from: q.from,
        to: q.to,
        currency: 'NGN' as const,
        days: windows.map((w) => {
          let min: number | null = null;
          let ruleName: string | null = null;
          let anyFree = false;
          let minNights: number | null = null;
          let cta = true;
          let ctd = true;
          let stop = true;
          for (const rt of types) {
            const free = freeRoomsOverWindow(caps.get(rt.id)!, w.start, w.end) >= 1;
            const r = ctx.promotions ? restrictionOn(ctx.restrictions, rt.id, w.date) : null;
            cta = cta && !!r?.closedToArrival;
            ctd = ctd && !!r?.closedToDeparture;
            stop = stop && !!r?.stopSell;
            if (r?.minNights) minNights = minNights === null ? r.minNights : Math.min(minNights, r.minNights);
            if (!free || r?.stopSell) continue;
            anyFree = true;
            for (const pl of plans) {
              if (pl.roomTypeIds.length && !pl.roomTypeIds.includes(rt.id)) continue;
              const n = resolveNights({ roomType: rt, plan: pl, dates: [w.date], rules: ctx.rules, overrides: ctx.overrides });
              if (!n) continue;
              if (pl.minNights && pl.minNights > 1) continue;
              if (min === null || n[0].rateKobo < min) {
                min = n[0].rateKobo;
                ruleName = n[0].ruleName;
              }
            }
          }
          if (!types.length) {
            cta = false;
            ctd = false;
            stop = false;
          }
          return {
            date: w.date,
            minRateKobo: anyFree ? min : null,
            available: anyFree && min !== null,
            closedToArrival: cta,
            closedToDeparture: ctd,
            stopSell: stop,
            minNights,
            ruleName: anyFree ? ruleName : null,
          };
        }),
      };
    }));
  }

  /**
   * Marketplace search with dates: counts come from SECURITY DEFINER
   * functions that only answer in the signed public context and return counts
   * (no booking or block details): app_public_room_type_peaks (active stays)
   * and app_public_unsellable_rooms (blocked / out-of-order rooms per night).
   * Prices come from the public rate tables (plans, seasons, overrides,
   * restrictions), resolved exactly like a quote.
   */
  async searchAvailability(
    tx: Tx,
    props: (Property & { roomTypes: (RoomType & { rooms: { status: string }[] })[]; taxSetting: Parameters<typeof componentsFrom>[0] | null })[],
    checkIn: string,
    checkOut: string,
    guests: number | undefined,
  ): Promise<Map<string, { availableRoomTypes: number; cheapestRateKobo: number; cheapestTotalKobo: number; nights: number } | null>> {
    const out = new Map<string, { availableRoomTypes: number; cheapestRateKobo: number; cheapestTotalKobo: number; nights: number } | null>();
    const groups = new Map<string, typeof props>();
    for (const p of props) {
      const key = `${p.checkInTime}|${p.checkOutTime}`;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    const nights = diffDays(checkIn, checkOut);
    const dates = stayDates(checkIn, checkOut);
    for (const [key, list] of groups) {
      const [inTime, outTime] = key.split('|');
      const start = lagosDateTime(checkIn, inTime);
      const end = lagosDateTime(checkOut, outTime);
      const ids = list.map((p) => p.id);
      const peaks = await tx.$queryRaw<{ room_type_id: string; peak: number }[]>`SELECT * FROM app_public_room_type_peaks(${ids}::uuid[], ${start}, ${end})`;
      const peakBy = new Map(peaks.map((r) => [r.room_type_id, Number(r.peak)]));
      const unsellable = await tx.$queryRaw<{ room_type_id: string; night: Date; unsellable: number }[]>`SELECT * FROM app_public_unsellable_rooms(${ids}::uuid[], ${dbDate(checkIn)}::date, ${dbDate(checkOut)}::date)`;
      const blockedBy = new Map<string, number>();
      for (const u of unsellable) blockedBy.set(u.room_type_id, Math.max(blockedBy.get(u.room_type_id) ?? 0, Number(u.unsellable)));
      for (const p of list) {
        if (!p.onlineBookingEnabled) {
          out.set(p.id, null);
          continue;
        }
        const features = (await this.entitlements.getEntitlements(p.tenantId).catch(() => null))?.features ?? [];
        const ctx = await this.rates.context(tx, p.tenantId, checkIn, checkOut, features, p.id);
        const comps = p.taxSetting ? componentsFrom(p.taxSetting) : DEFAULT_TAX;
        let best: { rate: number; total: number } | null = null;
        let bookableTypes = 0;
        for (const rt of p.roomTypes) {
          if (guests !== undefined && rt.capacity < guests) continue;
          const free = rt.rooms.length - (blockedBy.get(rt.id) ?? 0) - (peakBy.get(rt.id) ?? 0);
          if (free < 1) continue;
          if (ctx.promotions && restrictionHits(ctx.restrictions, rt.id, checkIn, checkOut).length) continue;
          let typeBest: { rate: number; total: number } | null = null;
          for (const pl of this.publicPlans(ctx, 'MARKETPLACE')) {
            if (planUnavailable(pl, rt.id, nights, 'MARKETPLACE')) continue;
            const n = resolveNights({ roomType: rt, plan: pl, dates, rules: ctx.rules, overrides: ctx.overrides });
            if (!n) continue;
            const avg = Math.round(n.reduce((a, x) => a + x.rateKobo, 0) / n.length);
            if (!typeBest || avg < typeBest.rate) typeBest = { rate: avg, total: priceNights({ roomTypeName: rt.name, components: comps, nights: n }).totalKobo };
          }
          if (!typeBest) continue;
          bookableTypes++;
          if (!best || typeBest.rate < best.rate) best = typeBest;
        }
        out.set(p.id, best ? { availableRoomTypes: bookableTypes, cheapestRateKobo: best.rate, cheapestTotalKobo: best.total, nights } : null);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Quote
  // ---------------------------------------------------------------------------

  async quote(dto: QuoteDto, guest?: GuestPrincipal) {
    const ref = await this.hotelRef(dto.hotelSlug);
    return runInProperty(ref.tenantId, ref.id, () => this.db.tenant(ref.tenantId, async (tx) => {
      const p = await this.loadHotel(tx, ref);
      this.assertChannel(p, dto.channel);
      const rt = p.roomTypes.find((x) => x.id === dto.roomTypeId);
      if (!rt) throw AppException.notFound('Room type');
      const w = this.resolveStay(p, dto);
      const adults = dto.adults ?? 1;
      const children = dto.children ?? 0;
      if (w.stayType === 'DAY_USE' && (!(await this.dayUseAllowed(tx, ref.tenantId)) || rt.hourlyPriceKobo === null)) {
        throw appError(HttpStatus.BAD_REQUEST, 'DAY_USE_UNAVAILABLE', `${rt.name} is not available for day use`, { roomTypeId: rt.id });
      }
      if (adults + children > rt.capacity) {
        throw appError(HttpStatus.BAD_REQUEST, 'CAPACITY_EXCEEDED', `${rt.name} sleeps up to ${rt.capacity}`, { capacity: rt.capacity });
      }
      const available = (await this.availableByType(tx, ref.tenantId, p, w)).get(rt.id) ?? 0;
      if (available < 1) {
        throw appError(HttpStatus.CONFLICT, 'ROOM_UNAVAILABLE', `${rt.name} is sold out for these dates`, { scope: 'ROOM_TYPE', roomTypeId: rt.id });
      }
      const comps = componentsFrom(await this.taxes.forProperty(tx, ref.tenantId, p.id));
      let breakdown: PriceBreakdown;
      let priced: StayPricing | null = null;
      if (w.stayType === 'NIGHTLY') {
        priced = await this.pricing.price(
          tx,
          ref.tenantId,
          { roomType: rt, arrivalDate: w.checkIn!, departureDate: w.checkOut!, ratePlanId: dto.ratePlanId ?? null, promoCode: dto.promoCode, channel: dto.channel, enforceRestrictions: true, promoStrict: true },
          { components: comps },
        );
        breakdown = priced.breakdown;
      } else {
        breakdown = this.price(rt, w, comps)!;
      }
      // M5 loyalty: points to earn, and a redemption spread over the nights (pre-tax).
      let loyalty: QuoteLoyalty | null = null;
      let pointsPerNight: number[] | null = null;
      let loyaltyMeta: { memberId: string | null; programme: string | null } = { memberId: null, programme: null };
      if (priced) {
        const l = await this.loyalty.quoteLoyalty(tx, ref.tenantId, guest, priced.nights, dto.redeemPoints);
        if (l) {
          loyalty = l.block;
          loyaltyMeta = { memberId: l.memberId, programme: l.programme };
          if (l.block.redeemValueKobo > 0) {
            pointsPerNight = l.perNight;
            breakdown = priceNights({
              roomTypeName: rt.name,
              components: comps,
              nights: priced.nights.map((n, i) => ({ date: n.date, rateKobo: n.rateKobo, discountKobo: n.discountKobo + l.perNight[i], loyaltyDiscountKobo: l.perNight[i], ruleName: n.ruleName })),
              ratePlan: priced.breakdown.ratePlan,
              promo: priced.promo ? { code: priced.promo.code, description: priced.promo.description, type: priced.promo.type } : null,
              loyaltyLabel: `${l.programme} points`,
            });
          }
        }
      } else {
        if (dto.redeemPoints) throw Err.validation('redeemPoints', 'Points can be redeemed on overnight stays only');
        const l = await this.loyalty.quoteLoyalty(tx, ref.tenantId, guest, [{ rateKobo: breakdown.roomSubtotalKobo }]);
        loyalty = l?.block ?? null;
      }
      const policy = effectivePolicy(p, priced?.plan.cancelPolicy ?? null);
      const signed = this.tokens.signQuote({
        tid: ref.tenantId,
        pid: p.id,
        rt: rt.id,
        ch: dto.channel,
        st: w.stayType,
        a: w.arrivalAt.toISOString(),
        d: w.departureAt.toISOString(),
        day: w.day,
        u: w.units,
        ad: adults,
        cd: children,
        rate: breakdown.rateKobo,
        tax: comps,
        total: breakdown.totalKobo,
        ...(priced && {
          rp: priced.plan.id,
          nr: priced.nights.map((n) => [n.date, n.rateKobo, n.discountKobo, n.baseRateKobo, n.source, n.ruleName] as [string, number, number, number, string, string | null]),
          pc: priced.promo?.id ?? null,
          pk: priced.promo?.code ?? null,
          cp: priced.plan.cancelPolicy,
        }),
        ...(pointsPerNight && loyalty && { lp: loyalty.pointsRedeemed, lm: loyaltyMeta.memberId!, ln: loyaltyMeta.programme!, ld: pointsPerNight }),
      });
      const payOnline = p.payoutReady;
      const payAtHotel = p.allowPayAtHotel && !policy.nonRefundable;
      return {
        quoteToken: signed.token,
        expiresAt: signed.expiresAt.toISOString(),
        hotel: {
          slug: p.slug,
          name: p.name,
          tagline: p.tagline,
          address: p.address,
          area: p.area,
          city: p.city,
          state: p.state,
          phone: p.phone,
          email: p.email,
          checkInTime: p.checkInTime,
          checkOutTime: p.checkOutTime,
          coverImageUrl: p.coverImageUrl,
          branding: { accentColor: p.accentColor, logoUrl: p.logoUrl },
          mapUrl: mapUrl(p),
        },
        roomType: { id: rt.id, name: rt.name, capacity: rt.capacity, bedType: rt.bedType, sizeSqm: rt.sizeSqm, image: toImages(rt.images)[0] ?? null },
        channel: dto.channel,
        stayType: w.stayType,
        checkIn: w.checkIn,
        checkOut: w.checkOut,
        date: w.date,
        startTime: w.startTime,
        hours: w.hours,
        nights: w.nights,
        arrivalAt: w.arrivalAt.toISOString(),
        departureAt: w.departureAt.toISOString(),
        adults,
        children,
        breakdown,
        depositDueKobo: payOnline ? breakdown.totalKobo : 0,
        paymentOptions: [
          {
            mode: 'ONLINE' as const,
            available: payOnline,
            dueNowKobo: breakdown.totalKobo,
            dueAtHotelKobo: 0,
            reason: payOnline ? null : `${p.name} does not take online payments yet`,
          },
          {
            mode: 'PAY_AT_HOTEL' as const,
            available: payAtHotel,
            dueNowKobo: 0,
            dueAtHotelKobo: breakdown.totalKobo,
            reason: payAtHotel ? null : policy.nonRefundable ? 'Non-refundable rates are paid when you book' : `${p.name} asks for payment when you book`,
          },
        ],
        ratePlan: breakdown.ratePlan,
        promo: breakdown.promo,
        loyalty,
        cancellationPolicy: policyView(policy),
        freeCancellationUntil: freeCancellationUntil(w.arrivalAt, policy)?.toISOString() ?? null,
        holdMinutes: HOLD_MINUTES,
        quoteTtlMinutes: QUOTE_TTL_MINUTES,
        available,
      };
    }));
  }

  // ---------------------------------------------------------------------------
  // Booking
  // ---------------------------------------------------------------------------

  private callbackUrl(raw: string | undefined, p: Pick<Property, 'customDomain' | 'customDomainVerifiedAt'>): string {
    const fallback = `${this.config.get('WEB_URL')}/booking/confirmation`;
    if (!raw) return fallback;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw Err.validation('callbackUrl', 'callbackUrl must be an absolute URL');
    }
    const web = new URL(this.config.get('WEB_URL'));
    const app = this.config.get('APP_DOMAIN').toLowerCase();
    const host = u.hostname.toLowerCase();
    const ok =
      u.origin === web.origin ||
      (u.protocol === 'https:' && (host === app || host.endsWith(`.${app}`))) ||
      (u.protocol === 'https:' && !!p.customDomain && !!p.customDomainVerifiedAt && host === p.customDomain.toLowerCase());
    if (!ok) throw Err.validation('callbackUrl', 'callbackUrl must be on the booking website');
    return u.toString();
  }

  private async newCode(tx: Tx, tenantId: string, hotelName: string): Promise<string> {
    const prefix = codePrefix(hotelName);
    for (let i = 0; i < 8; i++) {
      const code = reservationCode(prefix, i < 5 ? 4 : 5);
      const clash = await tx.reservation.findFirst({ where: { tenantId, code }, select: { id: true } });
      if (!clash) return code;
    }
    throw new Error('Could not generate a unique reservation code');
  }

  async create(dto: CreateBookingDto, principal: GuestPrincipal | undefined, ip?: string) {
    const q = this.tokens.verifyQuote(dto.quoteToken);
    const account = principal ? await this.db.system((tx) => tx.guestAccount.findUnique({ where: { id: principal.guestAccountId } })) : null;
    const fullName = (dto.guest?.fullName ?? account?.fullName ?? '').trim();
    const rawPhone = dto.guest?.phone ?? account?.phone ?? '';
    const email = (dto.guest?.email ?? account?.email ?? '').trim().toLowerCase() || null;
    if (fullName.length < 2) throw Err.validation('guest.fullName', 'Please enter the name the booking is for');
    const phone = normalisePhone(rawPhone);
    if (!phone) throw Err.validation('guest.phone', 'Enter a valid phone number, e.g. 0803 123 4567');
    if (dto.paymentMode === 'ONLINE' && !email) throw Err.validation('guest.email', 'An email address is needed to pay online (for your receipt)');
    await this.limits.consume(`booking:phone:${phone}`, 5, 600, 'phone', 'Too many bookings for this phone number. Please wait a few minutes.');

    let created;
    try {
      created = await runInProperty(q.tid, q.pid, () => this.db.tenant(q.tid, async (tx) => {
        const replay = await tx.reservation.findFirst({ where: { tenantId: q.tid, quoteRef: q.n }, include: stayInclude });
        if (replay) {
          const active = replay.status === 'CONFIRMED' || (replay.status === 'PENDING' && (!replay.holdExpiresAt || replay.holdExpiresAt > new Date()));
          if (replay.contactPhone === phone && active && replay.paymentMode === dto.paymentMode) {
            return { replay: true as const, r: replay, paymentId: null as string | null, ids: [] as string[] };
          }
          throw appError(HttpStatus.GONE, 'QUOTE_EXPIRED', 'This price quote has already been used. Check the price again to book another room.', { expiredAt: null });
        }
        const p = await tx.property.findFirst({ where: { id: q.pid, tenantId: q.tid }, include: { tenant: { include: { subscription: { include: { plan: true } } } } } });
        if (!p || !p.tenant.subscription || p.tenant.subscription.status === 'SUSPENDED') throw AppException.notFound('Hotel');
        this.assertChannel(p, q.ch);
        const rt = await tx.roomType.findFirst({ where: { id: q.rt, tenantId: q.tid, propertyId: p.id } });
        if (!rt) throw AppException.notFound('Room type');
        let payout: { subaccountCode: string } | null = null;
        if (dto.paymentMode === 'ONLINE') {
          payout = p.payoutReady ? await tx.payoutAccount.findUnique({ where: { propertyId: p.id }, select: { subaccountCode: true } }) : null;
          if (!payout) throw appError(HttpStatus.CONFLICT, 'ONLINE_PAYMENT_UNAVAILABLE', `${p.name} does not take online payments yet. Choose pay at hotel.`);
        } else if (!p.allowPayAtHotel) {
          throw appError(HttpStatus.CONFLICT, 'PAY_AT_HOTEL_UNAVAILABLE', `${p.name} asks for payment when you book.`);
        } else if (q.cp?.nonRefundable) {
          throw appError(HttpStatus.CONFLICT, 'PAY_AT_HOTEL_UNAVAILABLE', 'Non-refundable rates are paid when you book.');
        }
        const arrivalAt = new Date(q.a);
        const departureAt = new Date(q.d);
        if (departureAt <= new Date()) throw appError(HttpStatus.GONE, 'QUOTE_EXPIRED', 'These dates have passed. Check the price again.', { expiredAt: null });

        let guest = await this.guests.findOrCreateTx(tx, q.tid, { fullName, phone, email: email ?? undefined, consent: true, marketingOptIn: dto.marketingOptIn ?? false });
        if (account && !guest.guestAccountId && guest.phone === account.phone) {
          guest = await tx.guest.update({ where: { id: guest.id }, data: { guestAccountId: account.id } });
        }
        if (!guest.consentAt) guest = await tx.guest.update({ where: { id: guest.id }, data: { consentAt: new Date() } });

        await this.availability.assertAvailable(tx, q.tid, { roomTypeId: rt.id, arrivalAt, departureAt });

        const frozen: NightlyRate[] | null = q.nr
          ? q.nr.map(([date, rateKobo, promoKobo, baseRateKobo, source, ruleName], i) => {
              const points = q.ld?.[i] ?? 0;
              return { date, rateKobo, discountKobo: promoKobo + points, baseRateKobo, source: source as NightlyRate['source'], ruleId: null, ruleName, ...(points > 0 && { loyaltyDiscountKobo: points }) };
            })
          : null;
        const plan = q.rp ? await tx.ratePlan.findFirst({ where: { id: q.rp, tenantId: q.tid } }) : null;
        const breakdown =
          q.st === 'NIGHTLY' && frozen
            ? priceNights({
                roomTypeName: rt.name,
                components: q.tax,
                nights: frozen,
                ratePlan: plan ? { id: plan.id, code: plan.code, name: plan.name, kind: plan.kind, includesBreakfast: plan.includesBreakfast, refundable: !q.cp?.nonRefundable } : null,
                promo: q.pk ? { code: q.pk, description: '', type: '' } : null,
                ...(q.ln && { loyaltyLabel: `${q.ln} points` }),
              })
            : q.st === 'NIGHTLY'
              ? priceStay({ stayType: 'NIGHTLY', rateKobo: q.rate, roomTypeName: rt.name, components: q.tax, arrivalDate: q.day, nights: q.u })
              : priceStay({ stayType: 'DAY_USE', rateKobo: q.rate, roomTypeName: rt.name, components: q.tax, date: q.day, hours: q.u });
        if (breakdown.totalKobo !== q.total) throw appError(HttpStatus.BAD_REQUEST, 'QUOTE_INVALID', 'This price quote is not valid.');
        // The promo's usage limits are checked again now that the guest is known.
        if (q.pc && q.pk) {
          const check = await this.promos.check(tx, q.tid, {
            code: q.pk,
            roomTypeId: rt.id,
            arrivalDate: lagosDate(arrivalAt),
            departureDate: lagosDate(departureAt),
            channel: q.ch,
            guestPhone: phone,
            guestId: guest.id,
            lock: true,
          });
          if (check.reason && check.reason !== 'EXPIRED' && check.reason !== 'NOT_STARTED') throw this.promos.toError(check, q.pk);
        }
        const bps = effectiveCommissionBps(q.ch, p.tenant.subscription.plan.commissionBps);
        const commissionKobo = commissionFor(breakdown.totalKobo, bps);
        const online = dto.paymentMode === 'ONLINE';
        const holdExpiresAt = online ? new Date(Date.now() + HOLD_MINUTES * 60_000) : null;
        const code = await this.newCode(tx, q.tid, p.name);
        const r = await tx.reservation.create({
          data: {
            tenantId: q.tid,
            propertyId: p.id,
            code,
            guestId: guest.id,
            roomTypeId: rt.id,
            roomId: null,
            stayType: q.st,
            arrivalAt,
            departureAt,
            adults: q.ad,
            children: q.cd,
            source: q.ch,
            status: online ? 'PENDING' : 'CONFIRMED',
            rateKobo: q.rate,
            ratePlanId: q.rp ?? (await this.rates.ensureBar(tx, q.tid)).id,
            promoCodeId: q.pc ?? null,
            nightlyRates: (frozen ?? []) as unknown as Prisma.InputJsonValue,
            ...(q.cp && { cancelPolicy: q.cp as unknown as Prisma.InputJsonValue }),
            notes: dto.specialRequests ? `Guest request: ${dto.specialRequests}` : '',
            paymentMode: dto.paymentMode,
            guaranteeType: 'NONE',
            holdExpiresAt,
            commissionBps: bps,
            quotedTotalKobo: breakdown.totalKobo,
            quoteRef: q.n,
            quote: breakdown as unknown as Prisma.InputJsonValue,
            contactPhone: phone,
            contactEmail: email,
            specialRequests: dto.specialRequests ?? '',
            guestAccountId: account?.id ?? null,
          },
        });
        await tx.folio.create({ data: { tenantId: q.tid, propertyId: p.id, kind: 'RESERVATION', reservationId: r.id, guestId: guest.id, name: guest.fullName } });
        if (q.lp && q.lm) {
          // Points redeemed in the quote: only the signed-in member can book with them.
          const member = principal ? await this.loyalty.memberForGuest(tx, q.tid, principal) : null;
          if (!member || member.id !== q.lm || member.guestId !== guest.id) {
            throw appError(HttpStatus.CONFLICT, 'LOYALTY_NOT_MEMBER', 'Sign in as the loyalty member to book with points');
          }
          await this.loyalty.holdForBooking(tx, q.tid, q.lm, r.id, q.lp, p.id, code);
          await tx.reservation.update({ where: { id: r.id }, data: { loyaltyPoints: q.lp } });
        }
        if (q.pc) {
          await this.promos.redeem(tx, q.tid, {
            promoCodeId: q.pc,
            reservationId: r.id,
            guestPhone: phone,
            channel: q.ch,
            discountKobo: breakdown.discountKobo,
            nights: frozen?.length ?? q.u,
            status: online ? 'HELD' : 'CONFIRMED',
          });
        }
        let paymentId: string | null = null;
        if (online) {
          const pay = await tx.bookingPayment.create({
            data: {
              tenantId: q.tid,
              propertyId: p.id,
              reservationId: r.id,
              reference: BookingPaymentsService.newReference(),
              provider: this.paystack.providerName,
              amountKobo: breakdown.totalKobo,
              commissionKobo,
              commissionBps: bps,
              subaccountCode: payout!.subaccountCode,
              callbackUrl: this.callbackUrl(dto.callbackUrl, p),
              email: email!,
            },
          });
          paymentId = pay.id;
        } else if (commissionKobo > 0) {
          await this.commission.accrue(tx, { tenantId: q.tid, reservationId: r.id, amountKobo: commissionKobo, baseKobo: breakdown.totalKobo, bps, channel: q.ch });
        }
        await this.audit.record(tx, {
          tenantId: q.tid,
          actor: { kind: 'system', name: `Online booking (${q.ch === 'MARKETPLACE' ? 'marketplace' : 'booking site'})` },
          action: 'reservation.booked_online',
          entityType: 'reservation',
          entityId: r.id,
          metadata: { code, guest: fullName, channel: q.ch, paymentMode: dto.paymentMode, totalKobo: breakdown.totalKobo, commissionBps: bps, arrivalAt: q.a, departureAt: q.d },
          ip,
        });
        const row = await tx.reservation.findFirstOrThrow({ where: { id: r.id }, include: stayInclude });
        let ids: string[] = [];
        if (!online) {
          const stay = await this.notifier.stayContext(tx, row);
          ids = await this.notifications.queueTx(tx, [
            ...(await this.notifier.guest(tx, row, 'PAY_AT_HOTEL_CONFIRMED', {}, { stay, dedupe: true })),
            ...(await this.notifier.hotel(tx, row, {
              template: 'HOTEL_NEW_BOOKING',
              stay,
              channelLabel: q.ch === 'BOOKING_SITE' ? 'Booking site' : 'Marketplace',
              adminUrl: this.notifier.adminUrl(r.id),
              commissionKobo,
              guestPhone: phone,
              guestEmail: email,
            })),
          ]);
        }
        return { replay: false as const, r: row, paymentId, ids };
      }));
    } catch (e) {
      if (isExclusionViolation(e)) throw appError(HttpStatus.CONFLICT, 'ROOM_UNAVAILABLE', 'That room was just booked. Please choose another.', { scope: 'ROOM_TYPE', roomTypeId: q.rt });
      throw e;
    }

    const r = created.r;
    let payment: PaymentInit | null = null;
    if (created.replay) {
      if (r.paymentMode === 'ONLINE') {
        const last = [...r.bookingPayments].reverse().find((x) => x.status === 'INITIALIZED' && x.authorizationUrl);
        if (last) {
          payment = {
            reference: last.reference,
            authorizationUrl: last.authorizationUrl!,
            accessCode: last.accessCode,
            amountKobo: k(last.amountKobo),
            provider: this.paystack.providerName,
            holdExpiresAt: (r.holdExpiresAt ?? new Date()).toISOString(),
          };
        }
      }
    } else if (created.paymentId) {
      try {
        payment = await this.payments.initialize(q.tid, created.paymentId);
      } catch (e) {
        await this.releaseFailedHold(q.tid, r.id);
        throw e;
      }
      await this.jobs.scheduleHoldExpiry(q.tid, r.id, r.holdExpiresAt!);
    } else {
      await runAfter(async () => {
        await this.notifications.dispatch(created.ids);
        await this.jobs.schedulePreArrival(q.tid, r.id, r.arrivalAt);
      }, this.logger);
    }
    const booking = await this.db.tenant(q.tid, async (tx) => this.views.view(tx, await this.views.load(tx, q.tid, r.id)));
    const manageToken = this.views.manageToken(r);
    return {
      replayed: created.replay,
      body: { booking, manageToken, manageUrl: this.tokens.manageUrl(r.code, manageToken), payment },
    };
  }

  /** Paystack refused to start the checkout: give the room back at once. */
  private async releaseFailedHold(tenantId: string, reservationId: string) {
    try {
      await this.db.tenant(tenantId, (tx) =>
        tx.reservation.updateMany({
          where: { id: reservationId, tenantId, status: 'PENDING' },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'PAYMENT_INIT_FAILED', cancelledBy: 'SYSTEM' },
        }),
      );
    } catch (e) {
      this.logger.error(`Could not release hold ${reservationId}: ${(e as Error).message}`);
    }
  }
}
