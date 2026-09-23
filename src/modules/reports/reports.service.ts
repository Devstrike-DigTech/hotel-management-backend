import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { PaymentMethod } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { addDays, dbDate, diffDays, fromDbDate, isIsoDate, lagosDate, lagosStartOfDay } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { Err, k } from '../ops/ops.helpers.js';
import { ShiftsService } from '../shifts/shifts.service.js';
import { computeDailyFlashes, emptyMethods, PAYMENT_METHODS, sumFlashes, type DailyFlash } from './stats.compute.js';

const MAX_RANGE = 92;

@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DbService,
    private readonly shifts: ShiftsService,
  ) {}

  private range(from?: string, to?: string) {
    const f = from ?? lagosDate();
    const t = to ?? f;
    if (!isIsoDate(f) || !isIsoDate(t)) throw Err.validation('from', 'Dates must be YYYY-MM-DD');
    if (t < f) throw Err.validation('to', '"to" must not be before "from"');
    if (diffDays(f, t) + 1 > MAX_RANGE) throw Err.validation('to', `The range can be at most ${MAX_RANGE} days`);
    return { from: f, to: t };
  }

  /** Ledger-computed flashes, with the night-audit snapshot used where one exists. */
  async flashes(tx: Tx, tenantId: string, from: string, to: string): Promise<DailyFlash[]> {
    const live = await computeDailyFlashes(tx, tenantId, from, to);
    const stored = await tx.dailyStat.findMany({ where: { tenantId, date: { gte: dbDate(from), lte: dbDate(to) } } });
    const snap = new Map(stored.map((s) => [fromDbDate(s.date), s.data as unknown as DailyFlash]));
    return live.map((d) => {
      const s = snap.get(d.date);
      return s ? { ...s, date: d.date, live: false } : d;
    });
  }

  daily(user: AuthUser, date?: string) {
    const { from } = this.range(date, date);
    return this.db.tenant(user.tenantId, async (tx) => (await this.flashes(tx, user.tenantId, from, from))[0]);
  }

  rangeReport(user: AuthUser, from: string, to: string) {
    const r = this.range(from, to);
    return this.db.tenant(user.tenantId, async (tx) => {
      const days = await this.flashes(tx, user.tenantId, r.from, r.to);
      return { from: r.from, to: r.to, days, totals: sumFlashes(days) };
    });
  }

  payments(user: AuthUser, from: string, to: string) {
    const r = this.range(from, to);
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<{ d: Date; type: string; method: string; uid: string | null; n: number; amt: bigint }[]>`
        SELECT e.business_date AS d, e.type::text AS type, e.payment_method::text AS method, e.created_by_id AS uid,
               count(*)::int AS n, COALESCE(sum(e.amount_kobo), 0)::bigint AS amt
        FROM folio_entries e
        WHERE e.tenant_id = ${user.tenantId}::uuid
          AND e.type IN ('PAYMENT', 'REFUND')
          AND e.business_date BETWEEN ${dbDate(r.from)}::date AND ${dbDate(r.to)}::date
          AND NOT EXISTS (SELECT 1 FROM folio_entries v WHERE v.ref_entry_id = e.id)
        GROUP BY 1, 2, 3, 4`;
      const names = new Map(
        (await tx.user.findMany({ where: { id: { in: rows.map((x) => x.uid).filter((x): x is string => !!x) } }, select: { id: true, fullName: true } })).map(
          (u) => [u.id, u.fullName],
        ),
      );
      const byMethod = new Map<string, { count: number; amountKobo: number }>();
      const byUser = new Map<string, { user: { id: string; fullName: string }; method: PaymentMethod; count: number; amountKobo: number }>();
      const byDay = new Map<string, { date: string; amountKobo: number; byMethod: Record<PaymentMethod, number> }>();
      let total = 0;
      for (const x of rows) {
        const money = -Number(x.amt); // payments are negative on the ledger, refunds positive
        const count = x.type === 'PAYMENT' ? x.n : 0;
        total += money;
        const m = byMethod.get(x.method) ?? { count: 0, amountKobo: 0 };
        m.count += count;
        m.amountKobo += money;
        byMethod.set(x.method, m);
        const uid = x.uid ?? 'system';
        const uk = `${uid}:${x.method}`;
        const u = byUser.get(uk) ?? {
          user: { id: uid, fullName: x.uid ? (names.get(x.uid) ?? 'Former staff member') : 'System' },
          method: x.method as PaymentMethod,
          count: 0,
          amountKobo: 0,
        };
        u.count += count;
        u.amountKobo += money;
        byUser.set(uk, u);
        const d = fromDbDate(x.d);
        const day = byDay.get(d) ?? { date: d, amountKobo: 0, byMethod: emptyMethods() };
        day.amountKobo += money;
        day.byMethod[x.method as PaymentMethod] += money;
        byDay.set(d, day);
      }
      return {
        from: r.from,
        to: r.to,
        totalKobo: total,
        byMethod: PAYMENT_METHODS.map((method) => ({ method, count: byMethod.get(method)?.count ?? 0, amountKobo: byMethod.get(method)?.amountKobo ?? 0 })),
        byUser: [...byUser.values()].sort((a, b) => b.amountKobo - a.amountKobo),
        byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
      };
    });
  }

  shiftReport(user: AuthUser, from: string, to: string) {
    const r = this.range(from, to);
    return this.db.tenant(user.tenantId, async (tx) => {
      const where: Prisma.CashierShiftWhereInput = {
        tenantId: user.tenantId,
        status: { in: ['CLOSED', 'APPROVED'] },
        openedAt: { gte: lagosStartOfDay(r.from), lt: lagosStartOfDay(addDays(r.to, 1)) },
      };
      const rows = await tx.cashierShift.findMany({ where, orderBy: { openedAt: 'desc' } });
      const items = [];
      for (const s of rows) items.push(await this.shifts.view(tx, user, s, false));
      const flagged = await tx.guardFlag.count({ where: { tenantId: user.tenantId, rule: 'SHIFT_VARIANCE', shiftId: { in: rows.map((s) => s.id) } } });
      const totals = {
        shifts: rows.length,
        openingFloatKobo: rows.reduce((a, s) => a + k(s.openingFloatKobo), 0),
        expectedCashKobo: rows.reduce((a, s) => a + k(s.expectedCashKobo), 0),
        countedCashKobo: rows.reduce((a, s) => a + k(s.countedCashKobo), 0),
        varianceCashKobo: items.reduce((a, s) => a + (s.varianceCashKobo ?? 0), 0),
        variancePosKobo: items.reduce((a, s) => a + (s.variancePosKobo ?? 0), 0),
        varianceTransferKobo: items.reduce((a, s) => a + (s.varianceTransferKobo ?? 0), 0),
        flagged,
      };
      return { from: r.from, to: r.to, items, totals };
    });
  }
}
