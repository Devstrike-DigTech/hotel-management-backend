/**
 * Every e2e suite runs with the pg concurrency guard (default `serialise`,
 * `PG_CONCURRENCY_GUARD=throw` to locate a caller) and fails when pg reports a
 * query sent on a client that is still busy ("Calling client.query() when the
 * client is already executing a query"), which pg 9 turns into an error.
 */
import { installPgConcurrencyGuard, pgGuardModeFromEnv } from '../src/common/pg-concurrency-guard.js';

installPgConcurrencyGuard(pgGuardModeFromEnv());

const overlaps: string[] = [];
process.on('warning', (w) => {
  if (w.message.includes('already executing a query')) overlaps.push(w.stack ?? w.message);
});

afterAll(() => {
  expect(overlaps, 'concurrent queries on one pg client').toEqual([]);
});
