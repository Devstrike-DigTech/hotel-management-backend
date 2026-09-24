/**
 * Seed helpers that need the API's services outside Nest: provisioning a
 * real dedicated database for Harmattan (the same pipeline as the console)
 * and failed BullMQ jobs for the health page.
 */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { ConfigService } from '@nestjs/config';
import { SecretBox } from '../../src/common/crypto/secret-box.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { validateEnv, type Env } from '../../src/config/env.schema.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { databaseExists, dedicatedDbName, dropDatabase } from '../../src/modules/dedicated-db/engine.js';
import { ListingsService } from '../../src/modules/dedicated-db/listings.service.js';
import { ProvisioningService } from '../../src/modules/dedicated-db/provisioning.service.js';
import { EntitlementsService } from '../../src/modules/entitlements/entitlements.service.js';
import { redisConnection } from '../../src/modules/jobs/jobs.constants.js';
import { PlatformAuditService } from '../../src/modules/platform/security/platform-audit.service.js';
import { DbService } from '../../src/prisma/db.service.js';
import { PlatformPrismaService } from '../../src/prisma/platform-prisma.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { TenantDbRouter } from '../../src/prisma/tenant-db-router.js';

function config(): AppConfigService {
  const env = validateEnv(process.env);
  return new AppConfigService({ get: (k: keyof Env) => env[k] } as unknown as ConfigService<Env, true>);
}

/** Moves a tenant into its own database `<prefix><slug>` (dev: created through the owner role). */
export async function provisionDedicated(tenantId: string, slug: string): Promise<{ status: string; dbName: string; tables: number; durationMs: number }> {
  const cfg = config();
  const admin = cfg.get('DATABASE_ADMIN_URL') ?? cfg.get('DATABASE_MIGRATION_URL');
  if (!admin) throw new Error('No DATABASE_ADMIN_URL or DATABASE_MIGRATION_URL');
  const dbName = dedicatedDbName(cfg.get('DEDICATED_DB_PREFIX'), slug);
  // A database left over from an earlier seed (the registry was reset) is dropped first.
  if (await databaseExists(admin, dbName)) await dropDatabase(admin, dbName);

  const secrets = new SecretBox(cfg);
  const prisma = new PrismaService(cfg);
  const platform = new PlatformPrismaService(cfg);
  await platform.onModuleInit(); // installs the tenant context key (fresh databases)
  const router = new TenantDbRouter(platform, cfg, secrets);
  await router.onModuleInit();
  const db = new DbService(prisma, platform, cfg, router);
  const provisioning = new ProvisioningService(db, router, cfg, secrets, new EntitlementsService(db), new ListingsService(db), new AuditService(db), new PlatformAuditService(db));
  const started = Date.now();
  try {
    const p = await provisioning.provision(null, tenantId, { source: 'AUTO' });
    await provisioning.wait(p.id);
    const done = await provisioning.provisioning(p.id);
    return { status: done.status, dbName, tables: done.tables.length, durationMs: Date.now() - started };
  } finally {
    await router.onModuleDestroy();
    await prisma.$disconnect();
    await platform.$disconnect();
  }
}

/** A few failed jobs on the BullMQ queues so the health page has something to retry. */
export async function seedFailedJobs(): Promise<number> {
  const cfg = config();
  const connection = new Redis(redisConnection(cfg.get('REDIS_URL')));
  const specs = [
    { queue: 'platform', name: 'webhooks-deliver', reason: 'Connection terminated unexpectedly (dedicated database restart)' },
    { queue: 'guest', name: 'notify', reason: 'Termii: 503 Service Unavailable' },
    { queue: 'operations', name: 'channel-ari-flush', reason: 'Channex 429: rate limit exceeded' },
  ];
  let n = 0;
  try {
    for (const s of specs) {
      const q = new Queue(s.queue, { connection, prefix: 'hotel' });
      const jobId = `seed-failed-${s.name}`;
      const existing = await q.getJob(jobId);
      if (!existing) {
        // Parked as a delayed job, then moved into the failed set by hand (no worker runs it).
        await q.add(s.name, { seeded: true }, { jobId, delay: 365 * 86_400_000, attempts: 3 });
        const key = `hotel:${s.queue}`;
        const now = Date.now();
        await connection.zrem(`${key}:delayed`, jobId);
        await connection.zadd(`${key}:failed`, now, jobId);
        await connection.hset(`${key}:${jobId}`, 'failedReason', s.reason, 'finishedOn', String(now), 'processedOn', String(now - 1200), 'attemptsMade', '3', 'stacktrace', JSON.stringify([`Error: ${s.reason}`]), 'delay', '0');
      }
      await q.close();
      n++;
    }
  } finally {
    connection.disconnect();
  }
  return n;
}
