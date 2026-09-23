import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client.js';
import { AppConfigService } from '../config/app-config.service.js';
import { PlatformPrismaService } from './platform-prisma.service.js';
import { PrismaService } from './prisma.service.js';
import { idempotencyContext } from '../modules/idempotency/idempotency.context.js';
import { activePropertyFilter, currentScope, propertyScopeExtension } from '../common/property-scope.js';

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
 * Entry point for every database access that touches RLS-protected tables.
 *
 * - `tenant(tenantId, fn)`: normal hotel work on the `hotel_app` connection.
 *   The first statement of the transaction sets, transaction-locally,
 *   `app.tenant_id` and `app.context_sig` = HMAC(DB_CONTEXT_SECRET,
 *   'tenant:<id>'). The policies accept the tenant id only when the signature
 *   verifies against the key in `app_private`, which hotel_app cannot read,
 *   so SQL running as hotel_app cannot switch to another tenant by setting a
 *   GUC.
 * - `public(fn)`: anonymous marketplace reads (signed 'public' context);
 *   SELECT-only on hotel, room type, room and subscription-status rows.
 * - `system(fn)`: cross-tenant work on the separate `hotel_platform`
 *   connection (policies granted TO hotel_platform). Reserved for the
 *   platform console, Paystack webhooks and scheduled jobs that enumerate
 *   tenants. Grep for `.system(` to audit use.
 */
@Injectable()
export class DbService {
  private readonly secret: string;
  /** hotel_app client with the property-scope query extension (M5). */
  private readonly scoped: { $transaction: PrismaService['$transaction'] };

  constructor(
    readonly prisma: PrismaService,
    private readonly platform: PlatformPrismaService,
    config: AppConfigService,
  ) {
    this.secret = config.get('DB_CONTEXT_SECRET');
    this.scoped = prisma.$extends(propertyScopeExtension) as unknown as { $transaction: PrismaService['$transaction'] };
  }

  tenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(tenantId)) {
      throw new Error('DbService.tenant called without a valid tenant id');
    }
    const id = tenantId.toLowerCase();
    const sig = signContext(this.secret, `tenant:${id}`);
    const idem = idempotencyContext.getStore();
    // M5: the property filter of the current request / job for this tenant
    // (null = none). See common/property-scope.ts.
    const filter = currentScope(id)?.propertyIds ?? null;
    return activePropertyFilter.run(filter, () => this.scoped.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${id}, true), set_config('app.context_sig', ${sig}, true)`;
      const result = await fn(tx);
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

  public<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const sig = signContext(this.secret, 'public');
    return activePropertyFilter.run(null, () => this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.context', 'public', true), set_config('app.context_sig', ${sig}, true)`;
      return fn(tx);
    }, TX_OPTIONS));
  }

  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return activePropertyFilter.run(null, () => this.platform.$transaction((tx) => fn(tx), TX_OPTIONS));
  }
}
