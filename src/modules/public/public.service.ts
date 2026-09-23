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
import {
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
    private readonly db: DbService,
    private readonly config: AppConfigService,
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
    if (
      q.guests !== undefined ||
      q.minPriceKobo !== undefined ||
      q.maxPriceKobo !== undefined
    ) {
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
    const { rows, total } = await this.db.public(async (tx) => {
      const rows = await tx.property.findMany({
        where,
        include: { roomTypes: { select: { basePriceKobo: true } } },
        orderBy: [
          { featured: 'desc' },
          { rating: { sort: 'desc', nulls: 'last' } },
          { name: 'asc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
      const total = await tx.property.count({ where });
      return { rows, total };
    });

    return {
      items: rows.map((p) =>
        toHotelCard(
          p,
          p.roomTypes.map((r) => r.basePriceKobo),
        ),
      ),
      total,
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
        },
      }),
    );
    if (!p) throw AppException.notFound('Hotel');

    return {
      ...toHotelCard(
        p,
        p.roomTypes.map((r) => r.basePriceKobo),
      ),
      description: p.description,
      address: p.address,
      phone: p.phone,
      email: p.email,
      checkInTime: p.checkInTime,
      checkOutTime: p.checkOutTime,
      images: toImages(p.images),
      roomTypes: p.roomTypes.map((rt) => toRoomTypePublic(rt, rt._count.rooms)),
      policies: p.policies,
      branding: { accentColor: p.accentColor, logoUrl: p.logoUrl },
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
