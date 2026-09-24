import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';
import { PrismaClient } from '../generated/prisma/client.js';
import { AppConfigService } from '../config/app-config.service.js';
import { SecretBox } from '../common/crypto/secret-box.js';
import { propertyScopeExtension } from '../common/property-scope.js';
import { PlatformPrismaService } from './platform-prisma.service.js';

/** Registry row as the router needs it. */
export interface DedicatedRoute {
  tenantId: string;
  dbName: string;
  host: string | null;
  /** ACTIVE: served by the dedicated database. CUTOVER: still shared, writes refused. */
  status: string;
  mode: string;
  urlEnc: string | null;
  appUrlEnc: string | null;
  platformUrlEnc: string | null;
}

export interface TenantClients {
  key: string;
  app: PrismaClient;
  /** hotel_app client with the property-scope extension. */
  appScoped: { $transaction: PrismaClient['$transaction'] };
  platform: PrismaClient;
}

interface Entry extends TenantClients {
  lastUsed: number;
  inflight: number;
  ready: Promise<void>;
}

export const ROUTING_CHANNEL = 'hotel:tenant-db-routing';
const REFRESH_MS = 10_000;

/** Replaces host, port and database of `base` with those of `target`, keeping base's credentials. */
export function deriveUrl(base: string, target: string): string {
  const b = new URL(base);
  const t = new URL(target);
  b.hostname = t.hostname;
  b.port = t.port;
  b.pathname = t.pathname;
  return b.toString();
}

export const URL_PURPOSE = {
  admin: 'tenant-db:admin-url',
  app: 'tenant-db:app-url',
  platform: 'tenant-db:platform-url',
} as const;

/**
 * Decides which database serves a tenant and hands out Prisma clients for it
 * (M6 dedicated databases).
 *
 * - The registry (`tenant_databases`, shared database) is read in one query
 *   and cached; it is refreshed every 10 seconds and at once when another
 *   instance publishes a change on Redis (`hotel:tenant-db-routing`), or when
 *   the database gate answers "moved". Tenants without a row are shared.
 * - Clients per dedicated database (hotel_app with the property-scope
 *   extension, and hotel_platform with the signing key installed) are kept in
 *   a bounded LRU (`DEDICATED_DB_MAX_CLIENTS`); idle ones are disconnected
 *   when the bound is exceeded.
 * - RLS applies inside dedicated databases exactly as in the shared one: the
 *   same migrations, roles and signed context.
 */
@Injectable()
export class TenantDbRouter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantDbRouter.name);
  private routes = new Map<string, DedicatedRoute>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;
  private readonly clients = new Map<string, Entry>();
  private sub: Redis | null = null;
  private pub: Redis | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly platform: PlatformPrismaService,
    private readonly config: AppConfigService,
    private readonly secrets: SecretBox,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh().catch((e: Error) => this.logger.warn(`Routing registry not loaded yet: ${e.message}`));
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), REFRESH_MS);
    this.timer.unref();
    try {
      const url = this.config.get('REDIS_URL');
      this.sub = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
      this.pub = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
      this.sub.on('error', () => undefined);
      this.pub.on('error', () => undefined);
      await this.sub.connect();
      await this.pub.connect();
      await this.sub.subscribe(ROUTING_CHANNEL);
      this.sub.on('message', () => void this.refresh(true).catch(() => undefined));
    } catch (e) {
      this.logger.warn(`Routing change notifications unavailable (${(e as Error).message}); polling only`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.sub?.disconnect();
    this.pub?.disconnect();
    await Promise.all([...this.clients.values()].map((e) => this.close(e)));
    this.clients.clear();
  }

  /** Re-reads the registry (at most every second unless forced). */
  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.loadedAt < 1000) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const rows = await this.platform.$queryRaw<
          { tenant_id: string; mode: string; status: string | null; db_name: string | null; host: string | null; url_enc: string | null; app_url_enc: string | null; platform_url_enc: string | null }[]
        >`SELECT tenant_id, mode, status, db_name, host, url_enc, app_url_enc, platform_url_enc FROM tenant_databases WHERE mode = 'DEDICATED' OR status = 'CUTOVER'`;
        const next = new Map<string, DedicatedRoute>();
        for (const r of rows) {
          next.set(r.tenant_id, {
            tenantId: r.tenant_id, mode: r.mode, status: r.status ?? '', dbName: r.db_name ?? '', host: r.host,
            urlEnc: r.url_enc, appUrlEnc: r.app_url_enc, platformUrlEnc: r.platform_url_enc,
          });
        }
        this.routes = next;
        this.loadedAt = Date.now();
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** Tells every instance (this one included) to reload the registry now. */
  async announce(): Promise<void> {
    await this.refresh(true);
    try {
      await this.pub?.publish(ROUTING_CHANNEL, String(Date.now()));
    } catch {
      // Other instances fall back to the 10 s refresh and the database gate.
    }
  }

  /** The dedicated route of a tenant, or null when the shared database serves it. */
  dedicated(tenantId: string): DedicatedRoute | null {
    const r = this.routes.get(tenantId.toLowerCase());
    return r && r.mode === 'DEDICATED' && r.status === 'ACTIVE' ? r : null;
  }

  /** True while the tenant is in a cutover window (writes refused). */
  readOnly(tenantId: string): boolean {
    return this.routes.get(tenantId.toLowerCase())?.status === 'CUTOVER';
  }

  /** Every tenant currently served by a dedicated database. */
  activeDedicated(): DedicatedRoute[] {
    return [...this.routes.values()].filter((r) => r.mode === 'DEDICATED' && r.status === 'ACTIVE');
  }

  isDedicated(tenantId: string): boolean {
    return this.dedicated(tenantId) !== null;
  }

  /** Owner / app / platform URLs of a registry row. */
  urlsOf(r: Pick<DedicatedRoute, 'urlEnc' | 'appUrlEnc' | 'platformUrlEnc'>): { admin: string; app: string; platform: string } {
    if (!r.urlEnc) throw new Error('Dedicated database has no URL');
    const admin = this.secrets.open(r.urlEnc, URL_PURPOSE.admin);
    const app = r.appUrlEnc ? this.secrets.open(r.appUrlEnc, URL_PURPOSE.app) : deriveUrl(this.config.get('DATABASE_URL'), admin);
    const platform = r.platformUrlEnc
      ? this.secrets.open(r.platformUrlEnc, URL_PURPOSE.platform)
      : deriveUrl(this.config.get('DATABASE_PLATFORM_URL'), admin);
    return { admin, app, platform };
  }

  /** Clients for a dedicated database (created on first use, LRU-bounded). */
  async clientsFor(route: DedicatedRoute): Promise<TenantClients> {
    const key = `${route.host ?? ''}/${route.dbName}`;
    let e = this.clients.get(key);
    if (!e) {
      const urls = this.urlsOf(route);
      const max = this.config.get('DEDICATED_DB_POOL_MAX');
      const app = new PrismaClient({ adapter: new PrismaPg({ connectionString: urls.app, max }) });
      const platform = new PrismaClient({ adapter: new PrismaPg({ connectionString: urls.platform, max }) });
      const appScoped = app.$extends(propertyScopeExtension) as unknown as TenantClients['appScoped'];
      const secret = this.config.get('DB_CONTEXT_SECRET');
      const ready = (async () => {
        await platform.$executeRaw`SELECT app_install_context_key(${secret})`;
      })();
      e = { key, app, platform, appScoped, lastUsed: Date.now(), inflight: 0, ready };
      this.clients.set(key, e);
      ready.catch((err: Error) => {
        this.logger.error(`Dedicated database ${route.dbName} is not reachable: ${err.message}`);
        this.clients.delete(key);
        void this.close(e!);
      });
      this.evict();
    }
    await e.ready;
    e.lastUsed = Date.now();
    return e;
  }

  /** Runs `fn` with a dedicated database's clients, counted as in use (not evicted meanwhile). */
  async use<T>(route: DedicatedRoute, fn: (c: TenantClients) => Promise<T>): Promise<T> {
    const c = (await this.clientsFor(route)) as Entry;
    c.inflight += 1;
    try {
      return await fn(c);
    } finally {
      c.inflight -= 1;
      c.lastUsed = Date.now();
    }
  }

  /** Disconnects the clients of a database (before it is dropped). */
  async release(dbName: string): Promise<void> {
    for (const [key, e] of this.clients) {
      if (key.endsWith(`/${dbName}`)) {
        this.clients.delete(key);
        await this.close(e);
      }
    }
  }

  get openClients(): number {
    return this.clients.size;
  }

  private evict(): void {
    const max = this.config.get('DEDICATED_DB_MAX_CLIENTS');
    if (this.clients.size <= max) return;
    const idle = [...this.clients.values()].filter((e) => e.inflight === 0).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of idle) {
      if (this.clients.size <= max) break;
      this.clients.delete(e.key);
      void this.close(e);
    }
  }

  private async close(e: Entry): Promise<void> {
    await Promise.allSettled([e.app.$disconnect(), e.platform.$disconnect()]);
  }
}
