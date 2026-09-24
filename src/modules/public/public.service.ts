import { runInProperty } from '../../common/property-scope.js';
import { WhiteLabelService } from '../enterprise/white-label/white-label.service.js';
import { normalisePhone } from '../../common/utils/phone.js';
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
import { BookingFormService } from '../booking-form/booking-form.service.js';
import { ThemeService } from '../site/theme.service.js';
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
    private readonly themes: ThemeService,
    private readonly forms: BookingFormService,
    private readonly whiteLabel: WhiteLabelService,
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
    // M6: counted over the shared and every dedicated database.
    const parts = await this.db.publicAll((tx, t) =>
      tx.property.groupBy({
        by: ['city', 'state'],
        where: { AND: [this.marketplaceWhere(), t.tenants] },
        _count: { _all: true },
      }),
    );
    const merged = new Map<string, { name: string; state: string; hotelCount: number }>();
    for (const g of parts.flat()) {
      const key = `${g.city}|${g.state}`;
      const cur = merged.get(key) ?? { name: g.city, state: g.state, hotelCount: 0 };
      cur.hotelCount += g._count._all;
      merged.set(key, cur);
    }
    return [...merged.values()].sort((a, b) => b.hotelCount - a.hotelCount || a.name.localeCompare(b.name));
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

    // M6: every database answers for its own hotels (shared and dedicated tenants).
    const parts = await this.db.publicAll(async (tx, t) => {
      const rows = await tx.property.findMany({
        where: { AND: [...and, t.tenants] },
        include: {
          roomTypes: { include: { rooms: { select: { status: true } } } },
          taxSetting: true,
        },
      });
      const avail = dated ? await this.booking.searchAvailability(tx, rows, q.checkIn!, q.checkOut!, q.guests) : null;
      return { rows, avail };
    });
    const rows = parts.flatMap((x) => x.rows);
    const avail = dated ? new Map(parts.flatMap((x) => [...(x.avail ?? new Map()).entries()])) : null;

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
    const pageItems = cards.slice((page - 1) * pageSize, page * pageSize);
    await this.attachGroups(pageItems, new Map(rows.map((r) => [r.slug, r.tenantId])));
    return {
      items: pageItems,
      total: cards.length,
      page,
      pageSize,
    };
  }

  /**
   * A hotel page. Unlisted hotels are still reachable by slug (their own
   * booking microsite); suspended tenants are not.
   */
  async hotel(slug: string, host?: string): Promise<HotelDetail & { whiteLabel: ReturnType<WhiteLabelService['publicBrand']>; siteTheme: unknown }> {
    const p = await this.db.publicForSlug(slug, (tx, t) =>
      tx.property.findFirst({
        where: {
          ...t.tenants,
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
    const ctx = await this.db.publicFor(p.tenantId, (tx) => this.rates.context(tx, p.tenantId, today, addDays(today, 59), ent?.features ?? [], p.id));
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

    const site = await this.siteExtras(p.tenantId, p.id, ent?.features ?? []);
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
      branding: { accentColor: p.accentColor, logoUrl: p.logoUrl, faviconUrl: site.siteTheme.brand.faviconUrl },
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
        ...site.booking,
      },
      reviewSummary: reviewSummaryOf(p),
      // M5
      group: (await this.groupsFor([p.tenantId])).get(p.tenantId) ?? null,
      canonicalUrl: `https://${this.canonicalHost(p)}`,
      whatsapp: await this.whatsappFor(p, ent?.features ?? []),
      // M6: brand kit only on the property's own verified domain.
      whiteLabel: this.whiteLabel.publicBrand(p.tenantId, host, p),
      // M7: the published booking-site theme.
      siteTheme: site.siteTheme,
    };
  }

  /** M7: published theme, extras and pickups flags, form version (hotel page). */
  private async siteExtras(tenantId: string, propertyId: string, features: readonly string[]) {
    return runInProperty(tenantId, propertyId, () =>
      this.db.tenant(tenantId, async (tx) => {
        const siteTheme = await this.themes.publishedPublicTx(tx, tenantId, propertyId);
        const form = await this.forms.publishedVersionTx(tx, tenantId, propertyId);
        const fields = this.forms.fieldsOf(form);
        const offered = features.includes('paid_extras');
        const extrasAvailable = offered && (await tx.extra.count({ where: { tenantId, propertyId, active: true } })) > 0;
        const pickupsAvailable = offered && fields.some((f) => f.type === 'PICKUP' && f.required !== 'HIDDEN') && (await tx.pickupPoint.count({ where: { tenantId, propertyId, active: true } })) > 0;
        return { siteTheme, booking: { extrasAvailable, pickupsAvailable, bookingFormVersion: form.version } };
      }),
    );
  }

  /** `https://` host for a property: its verified custom domain, else its subdomain. */
  canonicalHost(p: { slug: string; customDomain: string | null; customDomainVerifiedAt: Date | null }): string {
    return p.customDomain && p.customDomainVerifiedAt ? p.customDomain : `${p.slug}.${this.config.get('APP_DOMAIN').toLowerCase()}`;
  }

  /**
   * Group info per tenant (only groups with 2+ non-suspended properties;
   * single-property hotels get null). Public context: tenants and
   * properties only.
   */
  async groupsFor(tenantIds: string[]): Promise<Map<string, { slug: string; name: string; propertyCount: number }>> {
    const ids = [...new Set(tenantIds)];
    if (!ids.length) return new Map();
    const counted = await this.db.publicAll((tx, t) => tx.property.groupBy({ by: ['tenantId'], where: { AND: [{ tenantId: { in: ids } }, t.tenants] }, _count: { _all: true } }));
    const rows = { counts: counted.flat(), tenants: await this.db.public((tx) => tx.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, slug: true, name: true } })) };
    const n = new Map(rows.counts.map((c) => [c.tenantId, c._count._all]));
    const out = new Map<string, { slug: string; name: string; propertyCount: number }>();
    for (const t of rows.tenants) {
      const count = n.get(t.id) ?? 0;
      if (count >= 2) out.set(t.id, { slug: t.slug, name: t.name, propertyCount: count });
    }
    return out;
  }

  private async attachGroups(cards: HotelCard[], tenantBySlug: Map<string, string>) {
    const groups = await this.groupsFor([...tenantBySlug.values()]);
    for (const c of cards) c.group = groups.get(tenantBySlug.get(c.slug) ?? '') ?? null;
  }

  /** "Chat on WhatsApp" for hotels with whatsapp_messaging. */
  private async whatsappFor(p: { id: string; tenantId: string; phone: string }, features: readonly string[]) {
    if (!features.includes('whatsapp_messaging')) return { available: false, phone: null, waUrl: null };
    const setting = await runInProperty(p.tenantId, p.id, () =>
      this.db.tenant(p.tenantId, (tx) => tx.inboxSetting.findUnique({ where: { propertyId: p.id }, select: { enabled: true, whatsappPhone: true } })),
    ).catch(() => null);
    if (setting && !setting.enabled) return { available: false, phone: null, waUrl: null };
    const phone = normalisePhone(setting?.whatsappPhone || p.phone);
    if (!phone) return { available: false, phone: null, waUrl: null };
    return { available: true, phone, waUrl: `https://wa.me/${phone.replace(/\D/g, '')}` };
  }

  /** GET /public/groups/:slug: the group's properties (microsite root). */
  async groupPage(slug: string, host?: string) {
    const tenant = await this.db.public((tx) =>
      tx.tenant.findFirst({
        where: { slug: slug.toLowerCase(), subscription: { is: { status: { not: 'SUSPENDED' } } } },
        select: { id: true, slug: true, name: true },
      }),
    );
    const data = tenant
      ? {
          tenant,
          rows: await this.db.publicFor(tenant.id, (tx) =>
            tx.property.findMany({
              where: { tenantId: tenant.id },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              include: { roomTypes: { include: { rooms: { select: { status: true } } } }, taxSetting: true },
            }),
          ),
        }
      : null;
    if (!data) throw AppException.notFound('Hotel group');
    const first = data.rows[0];
    const count = data.rows.length;
    return {
      slug: data.tenant.slug,
      name: data.tenant.name,
      branding: { accentColor: first?.accentColor ?? null, logoUrl: first?.logoUrl ?? null },
      propertyCount: count,
      properties: data.rows.map((p) => ({
        ...toHotelCard(p, p.roomTypes.map((r) => r.basePriceKobo)),
        group: count >= 2 ? { slug: data.tenant.slug, name: data.tenant.name, propertyCount: count } : null,
        canonicalUrl: `https://${this.canonicalHost(p)}`,
      })),
      // M6: brand kit when served on the group's own verified domain.
      whiteLabel: await this.whiteLabel.groupBrand(data.tenant.id, host),
      // M7
      siteTheme: await this.themes.publicGroupTheme(data.tenant.slug).catch(() => null),
    };
  }

  /**
   * Maps an incoming Host header to a hotel slug:
   *   grandview.<APP_DOMAIN>  -> "grandview"
   *   book.grandview.com      -> slug of the property with that verified domain
   */
  async resolveHost(rawHost: string): Promise<{ slug: string; kind: 'PROPERTY' | 'GROUP'; groupSlug: string; canonicalHost: string; whiteLabel: boolean; brand: ReturnType<WhiteLabelService['brandOf']> }> {
    const host = rawHost.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    const appDomain = this.config.get('APP_DOMAIN').toLowerCase();
    const select = { slug: true, tenantId: true, customDomain: true, customDomainVerifiedAt: true, tenant: { select: { slug: true } } } as const;

    const active = {
      tenant: { subscription: { is: { status: { not: 'SUSPENDED' as const } } } },
    };
    // M6: each lookup runs on the database that serves the tenant.
    const found = await (async () => {
      if (host.endsWith(`.${appDomain}`)) {
        const sub = host.slice(0, -(appDomain.length + 1));
        if (!sub || sub.includes('.') || RESERVED_SUBDOMAINS.has(sub)) {
          return null;
        }
        // M5: the group's own subdomain (tenant slug) with 2+ properties is the group root.
        const tenant = await this.db.public((tx) => tx.tenant.findFirst({ where: { slug: sub, subscription: { is: { status: { not: 'SUSPENDED' } } } }, select: { id: true, slug: true } }));
        if (tenant) {
          const props = await this.db.publicFor(tenant.id, (tx) => tx.property.findMany({ where: { tenantId: tenant.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select }));
          if (props.length >= 2) return { kind: 'GROUP' as const, p: props[0], groupSlug: tenant.slug };
        }
        const p = await this.db.publicForSlug(sub, (tx, t) => tx.property.findFirst({ where: { ...t.tenants, slug: sub, ...active }, select }));
        return p ? { kind: 'PROPERTY' as const, p, groupSlug: p.tenant.slug } : null;
      }
      // M6: a verified custom domain of a group root.
      const group = (
        await this.db.systemAll((tx, t) => tx.customDomain.findFirst({ where: { ...t.tenants, domain: host, scope: 'GROUP', status: 'VERIFIED' }, select: { tenantId: true } }))
      ).find(Boolean);
      if (group) {
        const tenant = await this.db.public((tx) => tx.tenant.findFirst({ where: { id: group.tenantId, lifecycle: 'ACTIVE', subscription: { is: { status: { not: 'SUSPENDED' } } } }, select: { id: true, slug: true } }));
        if (!tenant) return null;
        const props = await this.db.publicFor(tenant.id, (tx) => tx.property.findMany({ where: { tenantId: tenant.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select }));
        return props[0] ? { kind: 'GROUP' as const, p: props[0], groupSlug: tenant.slug, groupDomain: host } : null;
      }
      const tid = await this.db.dedicatedTenantFor({ customDomain: host });
      const lookup = (tx: Parameters<Parameters<DbService['public']>[0]>[0], tenants: object) =>
        tx.property.findFirst({ where: { ...tenants, customDomain: host, customDomainVerifiedAt: { not: null }, ...active }, select });
      const p = tid ? await this.db.publicFor(tid, (tx) => lookup(tx, { tenantId: tid })) : await this.db.public((tx) => lookup(tx, this.db.sharedTarget().tenants));
      return p ? { kind: 'PROPERTY' as const, p, groupSlug: p.tenant.slug } : null;
    })();

    if (!found) throw AppException.notFound('Hotel for this host');
    return {
      slug: found.p.slug,
      kind: found.kind,
      groupSlug: found.groupSlug,
      canonicalHost: found.kind === 'GROUP' ? ('groupDomain' in found && found.groupDomain ? found.groupDomain : `${found.groupSlug}.${appDomain}`) : this.canonicalHost(found.p),
      ...(() => {
        const own = found.kind === 'GROUP' ? 'groupDomain' in found && !!found.groupDomain : found.p.customDomain === host && !!found.p.customDomainVerifiedAt;
        const brand = own ? this.whiteLabel.brandOf(found.p.tenantId) : null;
        return { whiteLabel: !!brand, brand };
      })(),
    };
  }
}
