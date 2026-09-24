import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../prisma/db.service.js';
import { registerAuditHook } from '../audit/audit.service.js';

const LISTING_ENTITIES = new Set(['property', 'room_type', 'review', 'custom_domain', 'tenant', 'subscription', 'rate_plan']);

export interface ListingRoute {
  tenantId: string;
  propertyId: string;
  slug: string;
  dedicated: boolean;
}

/**
 * The `public_listings` projection (shared database): one row per property of
 * every tenant, wherever the tenant's data lives. Marketplace search, host
 * resolution and hotel pages use it to find which database serves a hotel,
 * and to list hotels of dedicated tenants without opening their database for
 * every query. Refreshed shortly after any audited change to a property,
 * room type, review or domain, on cutover, and every 15 minutes.
 */
@Injectable()
export class ListingsService implements OnModuleInit {
  private readonly logger = new Logger(ListingsService.name);
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(private readonly db: DbService) {}

  onModuleInit(): void {
    registerAuditHook(async (_tx, entry) => {
      if (entry.tenantId && LISTING_ENTITIES.has(entry.entityType)) this.schedule(entry.tenantId);
    });
  }

  /** Debounced refresh of one tenant's listings (after the audited transaction commits). */
  schedule(tenantId: string, delayMs = 1500): void {
    const t = this.pending.get(tenantId);
    if (t) clearTimeout(t);
    const timer = setTimeout(() => {
      this.pending.delete(tenantId);
      void this.refreshTenant(tenantId).catch((e: Error) => this.logger.warn(`Listing refresh failed for ${tenantId}: ${e.message}`));
    }, delayMs);
    timer.unref();
    this.pending.set(tenantId, timer);
  }

  async refreshTenant(tenantId: string): Promise<number> {
    const tenant = await this.db.system((tx) => tx.tenant.findUnique({ where: { id: tenantId }, include: { subscription: { select: { status: true } } } }));
    if (!tenant) {
      await this.db.system((tx) => tx.publicListing.deleteMany({ where: { tenantId } }));
      return 0;
    }
    const dedicated = this.db.router.isDedicated(tenantId);
    const props = await this.db.systemFor(tenantId, (tx) =>
      tx.property.findMany({ where: { tenantId }, include: { roomTypes: { select: { basePriceKobo: true } } }, orderBy: { createdAt: 'asc' } }),
    );
    const suspended = tenant.subscription?.status === 'SUSPENDED' || tenant.lifecycle !== 'ACTIVE';
    await this.db.system(async (tx) => {
      await tx.publicListing.deleteMany({ where: { tenantId, propertyId: { notIn: props.map((p) => p.id) } } });
      for (const p of props) {
        const data = {
          tenantId,
          tenantSlug: tenant.slug,
          tenantName: tenant.name,
          slug: p.slug,
          name: p.name,
          city: p.city,
          state: p.state,
          area: p.area,
          tagline: p.tagline,
          coverImageUrl: p.coverImageUrl,
          listed: p.listedOnMarketplace && p.roomTypes.length > 0,
          suspended,
          dedicated,
          customDomain: p.customDomain,
          customDomainVerified: !!(p.customDomain && p.customDomainVerifiedAt),
          startingRateKobo: p.roomTypes.length ? Math.min(...p.roomTypes.map((r) => r.basePriceKobo)) : null,
          rating: p.reviewCount > 0 ? p.rating : null,
          reviewCount: p.reviewCount,
          featured: p.featured,
          propertyCreatedAt: p.createdAt,
        };
        // A slug or domain can only belong to one listing: clear stale holders first.
        await tx.publicListing.deleteMany({ where: { OR: [{ slug: p.slug }, ...(p.customDomain ? [{ customDomain: p.customDomain }] : [])], NOT: { propertyId: p.id } } });
        await tx.publicListing.upsert({ where: { propertyId: p.id }, create: { propertyId: p.id, ...data }, update: data });
      }
    });
    return props.length;
  }

  async refreshAll(): Promise<{ tenants: number; listings: number }> {
    const tenants = await this.db.system((tx) => tx.tenant.findMany({ select: { id: true } }));
    let listings = 0;
    for (const t of tenants) {
      try {
        listings += await this.refreshTenant(t.id);
      } catch (e) {
        this.logger.warn(`Listing refresh failed for ${t.id}: ${(e as Error).message}`);
      }
    }
    return { tenants: tenants.length, listings };
  }

  /** Which tenant (and database) serves a property slug; null when unknown. */
  async bySlug(slug: string): Promise<ListingRoute | null> {
    const l = await this.db.system((tx) => tx.publicListing.findUnique({ where: { slug: slug.toLowerCase() } }));
    return l ? { tenantId: l.tenantId, propertyId: l.propertyId, slug: l.slug, dedicated: this.db.router.isDedicated(l.tenantId) } : null;
  }

  /** Which tenant serves a verified custom domain; null when unknown. */
  async byDomain(host: string): Promise<ListingRoute | null> {
    const l = await this.db.system((tx) => tx.publicListing.findFirst({ where: { customDomain: host.toLowerCase(), customDomainVerified: true } }));
    return l ? { tenantId: l.tenantId, propertyId: l.propertyId, slug: l.slug, dedicated: this.db.router.isDedicated(l.tenantId) } : null;
  }
}
