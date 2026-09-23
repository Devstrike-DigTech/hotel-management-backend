/**
 * Creates a fresh `hotel_test` database, applies all migrations (including
 * RLS) as the owner role and loads the seed. Runs once per e2e invocation.
 */
import { execSync } from 'node:child_process';
import pg from 'pg';

export default async function setup(): Promise<void> {
  const db = process.env.E2E_DB_NAME ?? 'hotel_test';
  if (!/^[a-z_][a-z0-9_]*$/.test(db) || !db.includes('test')) throw new Error(`Bad E2E_DB_NAME ${db} (must name a test database)`);
  const ownerUrl = process.env.DATABASE_MIGRATION_URL!;
  const adminUrl = new URL(ownerUrl);
  adminUrl.pathname = '/postgres';

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
  } finally {
    await admin.end();
  }

  const env = { ...process.env, DATABASE_MIGRATION_URL: ownerUrl };
  execSync('pnpm exec prisma migrate deploy', { env, stdio: 'pipe' });
  execSync('pnpm exec tsx prisma/seed.ts', { env, stdio: 'pipe' });
}
