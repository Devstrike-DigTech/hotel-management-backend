import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException } from '../../common/errors/app-exception.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService } from '../../prisma/db.service.js';
import {
  toPublicFeature,
  toPublicPlan,
  type PublicFeature,
  type PublicPlan,
} from '../plans/plan.mapper.js';
import { checkStayDates, HOLD_MINUTES, mapUrl, policyView } from '../booking/booking.logic.js';
import { PublicBookingService } from '../booking/public-booking.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { componentsFrom } from '../folios/tax.logic.js';
import { Err } from '../ops/ops.helpers.js';
import { addDays, dateRange, lagosDate } from '../../common/time/lagos.js';
import { resolveNights } from '../rates/rates.logic.js';
import { RatesService } from '../rates/rates.service.js';
import {
  reviewSummaryOf,
  toHotelCard,
  toImages,
  toRoomTypePublic,
  type HotelCard,
  type HotelDetail,
} from './hotel.mapper.js';
import type { HotelSearchQueryDto } from './public.dto.js';

/** Hosts under APP_DOMAIN that are never hotel microsites. */
const RESERVED_SUBDOMAINS = new Set([
  'www',
  'app',
  'admin',
  'api',
  'console',
  'platform',
  'mail',
  'static',
  'cdn',
]);

const AVAILABLE_STATUSES = ['VACANT_CLEAN', 'VACANT_DIRTY'] as const;

/**
 * Anonymous marketplace reads. Everything here runs through `db.public()`,
 * i.e. the SELECT-only `public` RLS context: staff, tokens, invoices and
 * audit rows are invisible even if a query tried to reach them.
 */
@Injectable()
export class PublicService {
  constructor(
    private readonly rates: RatesService,
    private readonly db: DbService,
    private readonly config: AppConfigService,
    private readonly booking: PublicBookingService,
    private readonly entitlements: EntitlementsService,
  ) {}

  app() {
    return {
      appName: this.config.get('APP_NAME'),
      appDomain: this.config.get('APP_DOMAIN'),
      supportEmail: this.config.get('SUPPORT_EMAIL'),
    };
  }

  async plans(): Promise<PublicPlan[]> {
    const plans = await this.db.public((tx) =>
      tx.plan.findMany({
        where: { isActive: true },
        include: { features: true },
        orderBy: { sortOrder: 'asc' },
      }),
    );
    return plans.map(toPublicPlan);
  }

  async features(): Promise<PublicFeature[]> {
    const features = await this.db.public((tx) =>
      tx.feature.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }] }),
    );
    return features.map(toPublicFeature);
  }

  /** Base filter for hotels visible on the marketplace. */
  private marketplaceWhere(): Prisma.PropertyWhereInput {
    return {
      listedOnMarketplace: true,
      tenant: { subscription: { is: { status: { not: 'SUSPENDED' } } } },
      roomTypes: { some: {} },
    };
  }

  async cities(): Promise<{ name: string; state: string; hotelCount: number }[]> {
    const groups = await this.db.public((tx) =>
      tx.property.groupBy({
        by: ['city', 'state'],
        where: this.marketplaceWhere(),
        _count: { _all: true },
      }),
    );
    return groups
      .map((g) => ({ name: g.city, state: g.state, hotelCount: g._count._all }))
      .sort((a, b) => b.hotelCount - a.hotelCount || a.name.localeCompare(b.name));
  }

  async hotels(q: HotelSearchQueryDto): Promise<{
    items: HotelCard[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 12;
    const dated = Boolean(q.checkIn || q.checkOut);
    if (dated) {
      if (!q.checkIn || !q.checkOut) throw Err.validation('checkIn', 'Give both checkIn and checkOut');
      const problem = checkStayDates(q.checkIn, q.checkOut);
      if (problem) throw Err.validation('checkIn', problem);
    }
    const and: Prisma.PropertyWhereInput[] = [this.marketplaceWhere()];

    if (q.city) {
      and.push({ city: { equals: q.city, mode: 'insensitive' } });
    }
    if (q.q) {
      const contains = { contains: q.q, mode: 'insensitive' as const };
      and.push({
        OR: [
          { name: contains },
          { tagline: contains },
          { area: contains },
          { city: contains },
          { state: contains },
        ],
      });
    }
    if (!dated && (q.guests !== undefined || q.minPriceKobo !== undefined || q.maxPriceKobo !== undefined)) {
      and.push({
        roomTypes: {
          some: {
            ...(q.guests !== undefined && { capacity: { gte: q.guests } }),
            basePriceKobo: {
              ...(q.minPriceKobo !== undefined && { gte: q.minPriceKobo }),
              ...(q.maxPriceKobo !== undefined && { lte: q.maxPriceKobo }),
            },
          },
        },
      });
    }

    const where: Prisma.PropertyWhereInput = { AND: and };
    const { rows, avail } = await this.db.public(async (tx) => {
      const rows = await tx.property.findMany({
        where,
        include: {
          roomTypes: { include: { rooms: { select: { status: true } } } },
          taxSetting: true,
        },
      });
      const avail = dated ? await this.booking.searchAvailability(tx, rows, q.checkIn!, q.checkOut!, q.guests) : null;
      return { rows, avail };
    });

    const inRange = (price: number) =>
      (q.minPriceKobo === undefined || price >= q.minPriceKobo) && (q.maxPriceKobo === undefined || price <= q.maxPriceKobo);
    const cards: HotelCard[] = [];
    for (const p of rows) {
      if (avail) {
        const a = avail.get(p.id);
        if (!a || !inRange(a.cheapestRateKobo)) continue;
        cards.push(toHotelCard(p, [a.cheapestRateKobo], { checkIn: q.checkIn!, checkOut: q.checkOut!, ...a }));
      } else {
        cards.push(toHotelCard(p, p.roomTypes.map((r) => r.basePriceKobo)));
      }
    }
    const byName = (a: HotelCard, b: HotelCard) => a.name.localeCompare(b.name);
    const price = (c: HotelCard) => c.startingRateKobo ?? Number.MAX_SAFE_INTEGER;
    const sorters: Record<string, (a: HotelCard, b: HotelCard) => number> = {
      recommended: (a, b) => Number(b.featured) - Number(a.featured) || (b.rating ?? -1) - (a.rating ?? -1) || byName(a, b),
      price_asc: (a, b) => price(a) - price(b) || byName(a, b),
      price_desc: (a, b) => price(b) - price(a) || byName(a, b),
      rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || b.reviewCount - a.reviewCount || byName(a, b),
    };
    cards.sort(sorters[q.sort ?? 'recommended']);
    return {
      items: cards.slice((page - 1) * pageSize, page * pageSize),
      total: cards.length,
      page,
      pageSize,
    };
  }

  /**
   * A hotel page. Unlisted hotels are still reachable by slug (their own
   * booking microsite); suspended tenants are not.
   */
  async hotel(slug: string): Promise<HotelDetail> {
    const p = await this.db.public((tx) =>
      tx.property.findFirst({
        where: {
          slug: slug.toLowerCase(),
          tenant: { subscription: { is: { status: { not: 'SUSPENDED' } } } },
        },
        include: {
          roomTypes: {
            orderBy: [{ sortOrder: 'asc' }, { basePriceKobo: 'asc' }],
            include: {
              _count: {
                select: {
                  rooms: { where: { status: { in: [...AVAILABLE_STATUSES] } } },
                },
              },
            },
          },
          taxSetting: true,
        },
      }),
    );
    if (!p) throw AppException.notFound('Hotel');
    const ent = await this.entitlements.getEntitlements(p.tenantId).catch(() => null);
    const dayUse = !!ent?.features.includes('hourly_bookings') && p.roomTypes.some((r) => r.hourlyPriceKobo !== null);

    // Rate plans per room type with the cheapest night over the next 60 days.
    const today = lagosDate();
    const dates = dateRange(today, addDays(today, 59));
    const ctx = await this.db.public((tx) => this.rates.context(tx, p.tenantId, today, addDays(today, 59), ent?.features ?? [], p.id));
    const plans = ctx.plans.filter((pl) => pl.active && (pl.channels.includes('BOOKING_SITE') || pl.channels.includes('MARKETPLACE')));
    const planInfo = new Map(
      p.roomTypes.map((rt) => {
        const list = plans
          .map((pl) => {
            const n = resolveNights({ roomType: rt, plan: pl, dates, rules: ctx.rules, overrides: ctx.overrides });
            if (!n) return null;
            return { ...this.booking.planPublic(pl, p), fromRateKobo: Math.min(...n.map((x) => x.rateKobo)) };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
        return [rt.id, list];
      }),
    );
    // "From" prices are bookable for a single night: long-stay plans show on their own card only.
    const fromRate = (id: string, fallback: number) => {
      const list = (planInfo.get(id) ?? []).filter((x) => !x.minNights || x.minNights <= 1);
      return list.length ? Math.min(...list.map((x) => x.fromRateKobo)) : fallback;
    };

    return {
      ...toHotelCard(
        p,
        p.roomTypes.map((r) => fromRate(r.id, r.basePriceKobo)),
      ),
      description: p.description,
      address: p.address,
      phone: p.phone,
      email: p.email,
      checkInTime: p.checkInTime,
      checkOutTime: p.checkOutTime,
      images: toImages(p.images),
      roomTypes: p.roomTypes.map((rt) => ({ ...toRoomTypePublic(rt, rt._count.rooms), ratePlans: planInfo.get(rt.id) ?? [], fromRateKobo: fromRate(rt.id, rt.basePriceKobo) })),
      policies: p.policies,
      branding: { accentColor: p.accentColor, logoUrl: p.logoUrl },
      mapUrl: mapUrl(p),
      booking: {
        onlineBookingEnabled: p.onlineBookingEnabled,
        payOnlineAvailable: p.onlineBookingEnabled && p.payoutReady,
        payAtHotelAvailable: p.onlineBookingEnabled && p.allowPayAtHotel,
        holdMinutes: HOLD_MINUTES,
        marketplaceListed: p.listedOnMarketplace,
        dayUseAvailable: dayUse,
        cancellationPolicy: policyView(p),
        taxes: p.taxSetting
          ? componentsFrom(p.taxSetting).map((c) => ({ code: c.code, label: c.label, rateBps: c.rateBps, inclusive: c.inclusive }))
          : [{ code: 'VAT' as const, label: 'VAT', rateBps: 750, inclusive: false }],
      },
      reviewSummary: reviewSummaryOf(p),
    };
  }

  /**
   * Maps an incoming Host header to a hotel slug:
   *   grandview.<APP_DOMAIN>  -> "grandview"
   *   book.grandview.com      -> slug of the property with that verified domain
   */
  async resolveHost(rawHost: string): Promise<{ slug: string }> {
    const host = rawHost.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    const appDomain = this.config.get('APP_DOMAIN').toLowerCase();

    const found = await this.db.public(async (tx) => {
      const active = {
        tenant: { subscription: { is: { status: { not: 'SUSPENDED' as const } } } },
      };
      if (host.endsWith(`.${appDomain}`)) {
        const sub = host.slice(0, -(appDomain.length + 1));
        if (!sub || sub.includes('.') || RESERVED_SUBDOMAINS.has(sub)) {
          return null;
        }
        return tx.property.findFirst({
          where: { slug: sub, ...active },
          select: { slug: true },
        });
      }
      return tx.property.findFirst({
        where: {
          customDomain: host,
          customDomainVerifiedAt: { not: null },
          ...active,
        },
        select: { slug: true },
      });
    });

    if (!found) throw AppException.notFound('Hotel for this host');
    return { slug: found.slug };
  }
}
