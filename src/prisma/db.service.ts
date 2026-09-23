import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

/** The client handed to callbacks: a Prisma interactive transaction. */
export type Tx = Prisma.TransactionClient;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

/**
 * Entry point for every database access that touches RLS-protected tables.
 *
 * Each helper opens an interactive transaction on the `hotel_app` connection
 * and, as its first statement, sets a *transaction-local* GUC with
 * `set_config(name, value, true)`. The policies installed by the
 * `rls_grants_audit` migration read those GUCs. Because the setting is local
 * to the transaction it is discarded on COMMIT/ROLLBACK and can never leak to
 * another request that later reuses the pooled connection.
 *
 * - `tenant(tenantId, fn)`: normal hotel work. Only rows whose `tenant_id`
 *   equals `tenantId` are visible or writable.
 * - `public(fn)`: anonymous marketplace reads. SELECT-only, limited to hotel,
 *   room type, room and subscription-status rows.
 * - `system(fn)`: cross-tenant access. Reserved for the platform console,
 *   Paystack webhooks and background jobs. Grep for `.system(` to audit use.
 */
@Injectable()
export class DbService {
  constructor(readonly prisma: PrismaService) {}

  tenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(tenantId)) {
      throw new Error('DbService.tenant called without a valid tenant id');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.context', 'tenant', true)`;
      return fn(tx);
    }, TX_OPTIONS);
  }

  public<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.context', 'public', true)`;
      return fn(tx);
    }, TX_OPTIONS);
  }

  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.context', 'system', true)`;
      return fn(tx);
    }, TX_OPTIONS);
  }
}
