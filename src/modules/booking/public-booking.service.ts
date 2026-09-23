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
import { maxConcurrent } from '../reservations/availability.logic.js';
import { ACTIVE, AvailabilityService } from '../reservations/availability.service.js';
import {
  checkStayDates,
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
import type { AvailabilityQueryDto, CreateBookingDto, QuoteDto } from './booking.dto.js';
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

  /** roomTypeId -> rooms free for the whole window (sellable minus peak of active stays). */
  private async availableByType(tx: Tx, tenantId: string, p: HotelRow, w: { arrivalAt: Date; departureAt: Date }): Promise<Map<string, number>> {
    const stays = await tx.reservation.findMany({
      where: { tenantId, propertyId: p.id, status: { in: ACTIVE }, arrivalAt: { lt: w.departureAt }, departureAt: { gt: w.arrivalAt } },
      select: { roomTypeId: true, arrivalAt: true, departureAt: true },
    });
    const out = new Map<string, number>();
    for (const rt of p.roomTypes) {
      const sellable = rt.rooms.filter((r) => r.status !== 'OUT_OF_ORDER').length;
      const peak = maxConcurrent(
        stays.filter((s) => s.roomTypeId === rt.id).map((s) => ({ start: s.arrivalAt, end: s.departureAt })),
        w.arrivalAt,
        w.departureAt,
      );
      out.set(rt.id, Math.max(0, sellable - peak));
    }
    return out;
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
    return this.db.tenant(ref.tenantId, async (tx) => {
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
        onlineBookingEnabled: p.onlineBookingEnabled,
        payOnlineAvailable: p.onlineBookingEnabled && payOnline,
        payAtHotelAvailable: p.onlineBookingEnabled && p.allowPayAtHotel,
        cancellationPolicy: policyView(p),
        freeCancellationUntil: freeCancellationUntil(w.arrivalAt, p)?.toISOString() ?? null,
        roomTypes: p.roomTypes.map((rt) => {
          const available = avail.get(rt.id) ?? 0;
          const quote = this.price(rt, w, comps);
          const reason = !p.onlineBookingEnabled
            ? 'ONLINE_BOOKING_DISABLED'
            : quote === null
              ? 'NO_HOURLY_RATE'
              : adults + children > rt.capacity
                ? 'CAPACITY'
                : available < 1
                  ? 'SOLD_OUT'
                  : null;
          return {
            roomType: toRoomTypePublic(rt, available),
            available,
            bookable: reason === null,
            unavailableReason: reason,
            lowAvailability: available >= 1 && available <= 2,
            quote,
          };
        }),
      };
    });
  }

  /**
   * Marketplace search with dates: counts come from the SECURITY DEFINER
   * function app_public_room_type_peaks, which only answers in the signed
   * public context and returns per-room-type peaks (no booking details).
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
    for (const [key, list] of groups) {
      const [inTime, outTime] = key.split('|');
      const start = lagosDateTime(checkIn, inTime);
      const end = lagosDateTime(checkOut, outTime);
      const ids = list.map((p) => p.id);
      const peaks = await tx.$queryRaw<{ room_type_id: string; peak: number }[]>`SELECT * FROM app_public_room_type_peaks(${ids}::uuid[], ${start}, ${end})`;
      const peakBy = new Map(peaks.map((r) => [r.room_type_id, Number(r.peak)]));
      for (const p of list) {
        if (!p.onlineBookingEnabled) {
          out.set(p.id, null);
          continue;
        }
        const comps = p.taxSetting ? componentsFrom(p.taxSetting) : DEFAULT_TAX;
        const bookable = p.roomTypes.filter((rt) => {
          if (guests !== undefined && rt.capacity < guests) return false;
          const sellable = rt.rooms.filter((r) => r.status !== 'OUT_OF_ORDER').length;
          return sellable - (peakBy.get(rt.id) ?? 0) >= 1;
        });
        if (!bookable.length) {
          out.set(p.id, null);
          continue;
        }
        const cheapest = bookable.reduce((a, b) => (b.basePriceKobo < a.basePriceKobo ? b : a));
        const total = priceStay({ stayType: 'NIGHTLY', rateKobo: cheapest.basePriceKobo, roomTypeName: cheapest.name, components: comps, arrivalDate: checkIn, nights }).totalKobo;
        out.set(p.id, { availableRoomTypes: bookable.length, cheapestRateKobo: cheapest.basePriceKobo, cheapestTotalKobo: total, nights });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Quote
  // ---------------------------------------------------------------------------

  async quote(dto: QuoteDto) {
    const ref = await this.hotelRef(dto.hotelSlug);
    return this.db.tenant(ref.tenantId, async (tx) => {
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
      const breakdown = this.price(rt, w, comps)!;
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
      });
      const payOnline = p.payoutReady;
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
            available: p.allowPayAtHotel,
            dueNowKobo: 0,
            dueAtHotelKobo: breakdown.totalKobo,
            reason: p.allowPayAtHotel ? null : `${p.name} asks for payment when you book`,
          },
        ],
        cancellationPolicy: policyView(p),
        freeCancellationUntil: freeCancellationUntil(w.arrivalAt, p)?.toISOString() ?? null,
        holdMinutes: HOLD_MINUTES,
        quoteTtlMinutes: QUOTE_TTL_MINUTES,
        available,
      };
    });
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
      created = await this.db.tenant(q.tid, async (tx) => {
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
          payout = p.payoutReady ? await tx.payoutAccount.findUnique({ where: { tenantId: q.tid }, select: { subaccountCode: true } }) : null;
          if (!payout) throw appError(HttpStatus.CONFLICT, 'ONLINE_PAYMENT_UNAVAILABLE', `${p.name} does not take online payments yet. Choose pay at hotel.`);
        } else if (!p.allowPayAtHotel) {
          throw appError(HttpStatus.CONFLICT, 'PAY_AT_HOTEL_UNAVAILABLE', `${p.name} asks for payment when you book.`);
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

        const breakdown =
          q.st === 'NIGHTLY'
            ? priceStay({ stayType: 'NIGHTLY', rateKobo: q.rate, roomTypeName: rt.name, components: q.tax, arrivalDate: q.day, nights: q.u })
            : priceStay({ stayType: 'DAY_USE', rateKobo: q.rate, roomTypeName: rt.name, components: q.tax, date: q.day, hours: q.u });
        if (breakdown.totalKobo !== q.total) throw appError(HttpStatus.BAD_REQUEST, 'QUOTE_INVALID', 'This price quote is not valid.');
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
        let paymentId: string | null = null;
        if (online) {
          const pay = await tx.bookingPayment.create({
            data: {
              tenantId: q.tid,
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
      });
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
