import { PrismaPg } from '@prisma/adapter-pg';
import { pgGuardMode } from '../src/common/pg-concurrency-guard.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { ownerClient } from './helpers.js';

/**
 * test/setup-pg-guard.ts installs the guard and fails a suite when pg warns
 * about a query sent on a busy client. These cases used to produce that
 * warning; with the guard they run one after another.
 */
describe('pg concurrency guard', () => {
  it('is on in the e2e run', () => {
    expect(pgGuardMode()).toBe('serialise');
  });

  it('serialises overlapping queries on one client and keeps results and errors', async () => {
    const c = ownerClient();
    await c.connect();
    try {
      const order: number[] = [];
      const results = await Promise.allSettled([
        c.query('SELECT 1 AS n FROM pg_sleep(0.05)').then((r) => (order.push(1), r)),
        c.query('SELECT 2 AS n').then((r) => (order.push(2), r)),
        c.query('SELECT nope FROM no_such_table'),
        c.query('SELECT 4 AS n'),
      ]);
      expect(order).toEqual([1, 2]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
      expect((results[3] as PromiseFulfilledResult<{ rows: { n: number }[] }>).value.rows[0]!.n).toBe(4);
    } finally {
      await c.end();
    }
  });

  it('a Prisma transaction with parallel relation loads and Promise.all stays correct', async () => {
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_MIGRATION_URL! }) });
    try {
      const r = await prisma.$transaction(async (tx) => {
        // Several relations of one include: Prisma loads them with Promise.all on the transaction's client.
        const res = await tx.reservation.findFirst({ include: { room: true, roomType: true, guest: true, folio: { include: { entries: true } } } });
        const [a, b] = await Promise.all([tx.$queryRaw<{ n: number }[]>`SELECT 1 AS n FROM pg_sleep(0.02)`, tx.$queryRaw<{ n: number }[]>`SELECT 2 AS n`]);
        return { res, a, b };
      });
      expect(r.res).not.toBeNull();
      expect([r.a[0]!.n, r.b[0]!.n]).toEqual([1, 2]);
    } finally {
      await prisma.$disconnect();
    }
  });
});
