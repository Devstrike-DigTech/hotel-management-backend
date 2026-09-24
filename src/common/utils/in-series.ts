/**
 * Runs async work one step at a time. Inside a transaction every query uses
 * the same connection, so `Promise.all([tx.a(), tx.b()])` would send them at
 * once on one pg client (pg 8 queues them with a deprecation warning, pg 9
 * refuses). Use these instead of Promise.all whenever the steps share a `tx`.
 */
export async function inSeries<T extends readonly (() => unknown)[]>(...steps: T): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const out: unknown[] = [];
  for (const step of steps) out.push(await step());
  return out as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

/** `Promise.all(items.map(fn))`, one item at a time (order kept). */
export async function mapInSeries<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R> | R): Promise<R[]> {
  const out: R[] = [];
  for (const [i, item] of items.entries()) out.push(await fn(item, i));
  return out;
}
