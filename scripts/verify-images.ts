/**
 * Checks that every image URL used by the seed answers HTTP 200.
 *   pnpm images:verify
 * Exits non-zero if any URL fails, listing the failures.
 */
import { allImageUrls } from '../prisma/seed-data/hotels.js';

async function check(url: string): Promise<{ url: string; status: number | string }> {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(15_000) });
    await res.body?.cancel();
    return { url, status: res.status };
  } catch (err) {
    return { url, status: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const urls = allImageUrls();
  const results = await Promise.all(urls.map(check));
  const failed = results.filter((r) => r.status !== 200);
  for (const r of results) console.log(`${String(r.status).padEnd(6)} ${r.url}`);
  console.log(`\n${urls.length - failed.length}/${urls.length} OK`);
  if (failed.length) process.exitCode = 1;
}

void main();
