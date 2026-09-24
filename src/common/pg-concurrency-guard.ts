/**
 * No concurrent queries on one pg client.
 *
 * Inside an interactive Prisma transaction (every `db.tenant`, `db.control`,
 * `db.system` callback) all queries share one connection. Two sources can send
 * a query while the previous one is still running:
 * - application code running `Promise.all([tx.a(), tx.b()])` (use `inSeries` /
 *   `mapInSeries` from `common/utils/in-series.ts`; a unit test scans for it);
 * - Prisma's own query interpreter, which loads the relations of an `include`
 *   with `Promise.all` (a "join" node), even inside a transaction.
 * pg 8 queues such queries with the deprecation "Calling client.query() when
 * the client is already executing a query"; pg 9 makes it an error.
 *
 * The guard wraps `pg.Client.prototype.query`:
 * - `serialise` (default everywhere): promise-style queries on one client are
 *   chained, so pg only receives the next query once the previous one settled.
 *   Results and errors are unchanged.
 * - `throw`: a query sent while another runs fails with `PG_CONCURRENT_QUERY`
 *   (diagnostics: `PG_CONCURRENCY_GUARD=throw` finds the caller).
 * - `off`: no wrapping.
 * Callback-style and streaming (submittable) queries pass through untouched.
 */
import pg from 'pg';

export type PgGuardMode = 'off' | 'serialise' | 'throw';

const GUARDED = Symbol.for('hotel.pgConcurrencyGuard');
const TAIL = Symbol('hotel.pgQueryTail');

interface ClientInternals {
  _activeQuery?: unknown;
  _queryQueue?: unknown[];
  pipeline?: boolean;
  [TAIL]?: Promise<unknown>;
}

let mode: PgGuardMode = 'off';

export class ConcurrentQueryError extends Error {
  readonly code = 'PG_CONCURRENT_QUERY';
  constructor() {
    super('A query was sent on a pg client that is still running another one (run the queries of a transaction one after another, not with Promise.all)');
  }
}

/** True when pg itself has a query running or queued on this client. */
export function isBusy(client: ClientInternals): boolean {
  if (client.pipeline) return false;
  return !!client._activeQuery || (client._queryQueue?.length ?? 0) > 0;
}

export function pgGuardModeFromEnv(env: NodeJS.ProcessEnv = process.env): PgGuardMode {
  const v = env.PG_CONCURRENCY_GUARD;
  return v === 'off' || v === 'serialise' || v === 'throw' ? v : 'serialise';
}

export function pgGuardMode(): PgGuardMode {
  return mode;
}

function promiseStyle(args: unknown[]): boolean {
  const first = args[0] as { submit?: unknown } | undefined;
  return !args.some((a) => typeof a === 'function') && !(first && typeof first === 'object' && typeof first.submit === 'function');
}

export function installPgConcurrencyGuard(next: PgGuardMode = pgGuardModeFromEnv()): void {
  mode = next;
  const proto = pg.Client.prototype as unknown as Record<symbol | string, unknown>;
  if (proto[GUARDED]) return;
  const original = proto.query as (this: ClientInternals, ...args: unknown[]) => unknown;
  proto.query = function guardedQuery(this: ClientInternals, ...args: unknown[]) {
    if (mode === 'off' || !promiseStyle(args)) return original.apply(this, args);
    if (mode === 'throw') return isBusy(this) ? Promise.reject(new ConcurrentQueryError()) : original.apply(this, args);
    const run = () => original.apply(this, args) as Promise<unknown>;
    const tail = this[TAIL];
    const p = tail ? tail.then(run, run) : run();
    const settled = p.then(
      () => undefined,
      () => undefined,
    );
    this[TAIL] = settled;
    void settled.then(() => {
      if (this[TAIL] === settled) delete this[TAIL];
    });
    return p;
  };
  proto[GUARDED] = true;
}
