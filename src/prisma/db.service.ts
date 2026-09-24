import { HttpStatus, Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac } from 'node:crypto';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { AppConfigService } from '../config/app-config.service.js';
import { PlatformPrismaService } from './platform-prisma.service.js';
import { PrismaService } from './prisma.service.js';
import { idempotencyContext } from '../modules/idempotency/idempotency.context.js';
import { activePropertyFilter, currentScope, propertyScopeExtension, propertyScopeStore } from '../common/property-scope.js';
import { AppException } from '../common/errors/app-exception.js';
import { TenantDbRouter, type DedicatedRoute } from './tenant-db-router.js';

/** The client handed to callbacks: a Prisma interactive transaction. */
export type Tx = Prisma.TransactionClient;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/** hex(HMAC-SHA256(secret, payload)); the database recomputes the same value. */
export function signContext(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * M6 test API keys: every tenant transaction that writes is rolled back and
 * its result carried out in a DryRunRollback (see the partner API).
 */
export const dryRunContext = new AsyncLocalStorage<{ tenantId: string }>();

export class DryRunRollback<T = unknown> extends Error {
  constructor(readonly result: T) {
    super('dry run: rolled back');
  }
}

/** 409 while a tenant moves to (or from) its dedicated database. */
export function tenantMigrating(retryAfterSec = 5): AppException {
  return new AppException(HttpStatus.CONFLICT, 'TENANT_MIGRATING', 'This hotel is being moved to its own database. Try again in a few seconds.', {
    retryAfterSec,
  });
}

/** Where a fan-out result came from. */
export interface DbTarget {
  /** "shared" or the dedicated database name. */
  target: string;
  /** Tenant of a dedicated database; null for the shared one. */
  tenantId: string | null;
}

type TxClient = { $transaction: PrismaService['$transaction'] };

/**
 * Entry point for every database access that touches RLS-protected tables.
 *
 * - `tenant(tenantId, fn)`: normal hotel work on the `hotel_app` connection
 *   of the database that serves the tenant (shared, or its dedicated
 *   database, M6). The first statement sets, transaction-locally,
 *   `app.tenant_id` and `app.context_sig` = HMAC(DB_CONTEXT_SECRET,
 *   'tenant:<id>'), and asks the database gate whether the tenant is still
 *   served there. The policies accept the tenant id only when the signature
 *   verifies against the key in `app_private`, which hotel_app cannot read,
 *   so SQL running as hotel_app cannot switch to another tenant by setting a
 *   GUC.
 * - `control(tenantId, fn)`: the same signed context, always on the shared
 *   database: control-plane rows (API keys, white-label, SSO, support,
 *   exports) that stay there when the tenant has a dedicated database.
 * - `public(fn)` / `publicFor(tenantId, fn)` / `publicAll(fn)`: anonymous
 *   marketplace reads (signed 'public' context; SELECT-only on hotel, room
 *   type, room and subscription-status rows) on the shared database, a
 *   tenant's database, or every database.
 * - `system(fn)` / `systemFor(tenantId, fn)` / `systemAll(fn)`: cross-tenant
 *   work on the `hotel_platform` connection (policies granted TO
 *   hotel_platform) of the shared database, a tenant's database, or every
 *   database. Reserved for the platform console, webhooks and scheduled
 *   jobs. Grep for `.system` to audit use.
 */
@Injectable()
export class DbService {
  private readonly secret: string;
  /** hotel_app client with the property-scope query extension (M5). */
  private readonly scoped: TxClient;

  constructor(
    readonly prisma: PrismaService,
    private readonly platform: PlatformPrismaService,
    config: AppConfigService,
    readonly router: TenantDbRouter,
  ) {
    this.secret = config.get('DB_CONTEXT_SECRET');
    this.scoped = prisma.$extends(propertyScopeExtension) as unknown as TxClient;
  }

  async tenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(tenantId)) {
      throw new Error('DbService.tenant called without a valid tenant id');
    }
    const id = tenantId.toLowerCase();
    const route = this.router.dedicated(id);
    if (!route) return this.runTenant(id, this.scoped, false, fn);
    return this.router.use(route, (c) => this.runTenant(id, c.appScoped, true, fn));
  }

  private runTenant<T>(id: string, client: TxClient, dedicated: boolean, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const sig = signContext(this.secret, `tenant:${id}`);
    const idem = idempotencyContext.getStore();
    const dry = dryRunContext.getStore();
    // M5: the property filter of the current request / job for this tenant
    // (null = none). See common/property-scope.ts.
    const filter = currentScope(id)?.propertyIds ?? null;
    return activePropertyFilter.run(filter, () => client.$transaction(async (tx) => {
      const [gate] = await tx.$queryRaw<{ gate: string }[]>`SELECT set_config('app.tenant_id', ${id}, true) AS t, set_config('app.context_sig', ${sig}, true) AS s, app_tenant_gate(${id}::uuid) AS gate`;
      if (gate?.gate === 'moved') {
        // Another instance moved the tenant: reload the routing and let the client retry.
        void this.router.announce();
        throw tenantMigrating(1);
      }
      const result = await fn(tx);
      const readOnly = gate?.gate === 'read_only' || (!dedicated && this.router.readOnly(id));
      if (readOnly || (dry && dry.tenantId.toLowerCase() === id)) {
        const [w] = await tx.$queryRaw<{ wrote: boolean }[]>`SELECT txid_current_if_assigned() IS NOT NULL AS wrote`;
        if (w?.wrote) {
          if (readOnly) throw tenantMigrating();
          throw new DryRunRollback(result);
        }
      }
      if (idem && idem.tenantId.toLowerCase() === id) {
        // Mark the request's Idempotency-Key as applied in the same
        // transaction as its writes. txid_current_if_assigned() is non-null
        // only if this transaction has written something, so read-only
        // transactions leave the key retryable.
        await tx.$executeRaw`UPDATE idempotency_keys SET applied = true
          WHERE tenant_id = ${id}::uuid AND key = ${idem.key} AND NOT applied AND txid_current_if_assigned() IS NOT NULL`;
      }
      return result;
    }, TX_OPTIONS));
  }

  /**
   * Signed tenant context on the SHARED database, whatever database serves
   * the tenant's operational data: control-plane tables (M6).
   */
  control<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(tenantId)) {
      throw new Error('DbService.control called without a valid tenant id');
    }
    const id = tenantId.toLowerCase();
    const sig = signContext(this.secret, `tenant:${id}`);
    return activePropertyFilter.run(null, () => this.scoped.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${id}, true), set_config('app.context_sig', ${sig}, true)`;
      return fn(tx);
    }, TX_OPTIONS));
  }

  /**
   * Runs `fn` (queries on an open tenant transaction, or new ones) without
   * the property filter: group-wide reads and writes that span the group's
   * properties on purpose (group reports, creating a property, relocation
   * suggestions). RLS still limits it to the tenant.
   */
  withAllProperties<T>(_tenantId: string, fn: () => Promise<T>): Promise<T> {
    // Awaited inside the context: Prisma queries are lazy and run when awaited.
    return propertyScopeStore.exit(() => activePropertyFilter.run(null, async () => await fn()));
  }

  public<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.runPublic(this.prisma, fn);
  }

  /** Public context on the database that serves `tenantId`. */
  async publicFor<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const route = this.router.dedicated(tenantId);
    if (!route) return this.public(fn);
    return this.router.use(route, (c) => this.runPublic(c.app, fn));
  }

  /** Public context on the shared database and on every dedicated database. */
  async publicAll<T>(fn: (tx: Tx, target: DbTarget) => Promise<T>): Promise<T[]> {
    const shared = this.public((tx) => fn(tx, { target: 'shared', tenantId: null }));
    const others = this.router.activeDedicated().map((r) =>
      this.router.use(r, (c) => this.runPublic(c.app, (tx) => fn(tx, { target: r.dbName, tenantId: r.tenantId }))),
    );
    return Promise.all([shared, ...others]);
  }

  private runPublic<T>(client: TxClient | PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const sig = signContext(this.secret, 'public');
    return activePropertyFilter.run(null, () => (client as TxClient).$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.context', 'public', true), set_config('app.context_sig', ${sig}, true)`;
      return fn(tx);
    }, TX_OPTIONS));
  }

  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return activePropertyFilter.run(null, () => this.platform.$transaction((tx) => fn(tx), TX_OPTIONS));
  }

  /** Platform context on the database that serves `tenantId` (shared when null). */
  async systemFor<T>(tenantId: string | null | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const route = tenantId ? this.router.dedicated(tenantId) : null;
    if (!route) return this.system(fn);
    return this.onDedicated(route, fn);
  }

  /**
   * Platform context on the shared database and on every dedicated database
   * (sweeps over tenant data), one after the other.
   */
  async systemAll<T>(fn: (tx: Tx, target: DbTarget) => Promise<T>): Promise<T[]> {
    const shared = await this.system((tx) => fn(tx, { target: 'shared', tenantId: null }));
    const out: T[] = [shared];
    for (const r of this.router.activeDedicated()) {
      out.push(await this.onDedicated(r, (tx) => fn(tx, { target: r.dbName, tenantId: r.tenantId })));
    }
    return out;
  }

  private onDedicated<T>(r: DedicatedRoute, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.router.use(r, (c) => activePropertyFilter.run(null, () => c.platform.$transaction((tx) => fn(tx), TX_OPTIONS)));
  }

  /**
   * Runs a raw lookup (the SECURITY DEFINER auth functions) on the shared
   * hotel_app connection, then on every dedicated database until one returns
   * a value: sign-in by email and refresh-token lookup happen before the
   * tenant is known.
   */
  async findAcross<T>(fn: (client: PrismaClient) => Promise<T | undefined>): Promise<T | undefined> {
    const found = await fn(this.prisma);
    if (found !== undefined) return found;
    for (const r of this.router.activeDedicated()) {
      const hit = await this.router.use(r, (c) => fn(c.app)).catch(() => undefined);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
}
