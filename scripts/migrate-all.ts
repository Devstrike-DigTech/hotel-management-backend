/**
 * `pnpm db:migrate:all`: applies pending migrations to the shared database
 * and to every dedicated tenant database (the console's
 * POST /platform/databases/migrate-all does the same). Reads the registry
 * directly (no Nest container), decrypting each database URL with the
 * platform data key. Exit code 1 if any target failed.
 */
import 'dotenv/config';
import pg from 'pg';
import { platformKeyMaterial, SecretCipher } from '../src/common/crypto/secret-box.js';
import { validateEnv } from '../src/config/env.schema.js';
import { migrateDatabase } from '../src/modules/dedicated-db/migrate.js';
import { URL_PURPOSE } from '../src/prisma/tenant-db-router.js';

const env = validateEnv(process.env);
const shared = env.DATABASE_MIGRATION_URL;
if (!shared) {
  console.error('DATABASE_MIGRATION_URL is not set');
  process.exit(1);
}
const cipher = new SecretCipher(platformKeyMaterial({ PLATFORM_DATA_KEY: env.PLATFORM_DATA_KEY, GUEST_DATA_KEY: env.GUEST_DATA_KEY }));

async function applied(url: string): Promise<string[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const { rows } = await c
      .query<{ migration_name: string }>(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`)
      .catch(() => ({ rows: [] as { migration_name: string }[] }));
    return rows.map((r) => r.migration_name);
  } finally {
    await c.end();
  }
}

const targets: { target: string; url: string; tenantId: string | null }[] = [{ target: 'shared', url: shared, tenantId: null }];
{
  const c = new pg.Client({ connectionString: shared });
  await c.connect();
  const { rows } = await c
    .query<{ tenant_id: string; db_name: string | null; url_enc: string | null }>(
      `SELECT tenant_id, db_name, url_enc FROM tenant_databases WHERE mode = 'DEDICATED' AND url_enc IS NOT NULL ORDER BY db_name`,
    )
    .catch(() => ({ rows: [] as { tenant_id: string; db_name: string | null; url_enc: string | null }[] }));
  await c.end();
  for (const r of rows) targets.push({ target: r.db_name ?? r.tenant_id, url: cipher.open(r.url_enc!, URL_PURPOSE.admin), tenantId: r.tenant_id });
}

let failed = 0;
for (const t of targets) {
  try {
    const before = await applied(t.url);
    await migrateDatabase(t.url);
    const after = await applied(t.url);
    const fresh = after.filter((m) => !before.includes(m));
    if (t.tenantId) {
      const c = new pg.Client({ connectionString: shared });
      await c.connect();
      await c.query(`UPDATE tenant_databases SET version = $2, last_migrated_at = now() WHERE tenant_id = $1`, [t.tenantId, after[after.length - 1] ?? null]);
      await c.end();
    }
    console.log(`ok     ${t.target}${fresh.length ? ` (applied: ${fresh.join(', ')})` : ' (up to date)'}`);
  } catch (e) {
    failed++;
    console.log(`FAILED ${t.target}\n       ${(e as Error).message.slice(0, 500)}`);
  }
}
process.exit(failed ? 1 : 0);
