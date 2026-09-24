import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The Prisma CLI of this project (a production image ships it for `migrate deploy`). */
export function prismaBin(cwd = process.cwd()): string {
  const local = join(cwd, 'node_modules', '.bin', 'prisma');
  return existsSync(local) ? local : 'prisma';
}

/**
 * Applies every pending migration to one database (`prisma migrate deploy`
 * with DATABASE_MIGRATION_URL pointing at it). Returns the CLI output.
 */
export async function migrateDatabase(ownerUrl: string, cwd = process.cwd()): Promise<string> {
  const { stdout, stderr } = await run(prismaBin(cwd), ['migrate', 'deploy'], {
    cwd,
    env: { ...process.env, DATABASE_MIGRATION_URL: ownerUrl },
    timeout: 600_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return `${stdout}\n${stderr}`.trim();
}
