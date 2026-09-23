import type { PaymentMethod } from '../../generated/prisma/enums.js';
import type { Tx } from '../../prisma/db.service.js';
import { addDays, dateRange, dbDate, fromDbDate, lagosDate, lagosStartOfDay } from '../../common/time/lagos.js';

export const PAYMENT_METHODS: PaymentMethod[] = ['CASH', 'TRANSFER', 'POS', 'CARD_ONLINE', 'COMPLIMENTARY', 'CITY_LEDGER'];

export interface DailyFlash {
  date: string;
  live: boolean;
  roomsTotal: number;
  roomsOutOfOrder: number;
  roomsAvailable: number;
  roomsSold: number;
  occupancyRate: number;
  adrKobo: number;
  revparKobo: number;
  roomRevenueKobo: number;
  dayUseRevenueKobo: number;
  otherRevenueKobo: number;
  discountKobo: number;
  taxKobo: number;
  serviceChargeKobo: number;
  totalRevenueKobo: number;
  paymentsByMethod: Record<PaymentMethod, number>;
  paymentsTotalKobo: number;
  refundsKobo: number;
  dayUseCount: number;
  arrivals: number;
  departures: number;
  noShows: number;
  cancellations: number;
  guestsInHouse: number;
  openFlags: number;
}

export const emptyMethods = (): Record<PaymentMethod, number> =>
  Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0])) as Record<PaymentMethod, number>;

export const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/**
 * Computes the daily flash for every date in [from, to] from the ledger
 * (voided entries excluded). Works with any client that can read the
 * tenant's rows (a tenant transaction, or the owner connection in the seed).
 */
export async function computeDailyFlashes(tx: Tx, tenantId: string, from: string, to: string): Promise<DailyFlash[]> {
  const dates = dateRange(from, to);
  const rows = await tx.$queryRaw<{ d: Date; type: string; method: string | null; n: number; amt: bigint }[]>`
    SELECT e.business_date AS d, e.type::text AS type, e.payment_method::text AS method,
           count(*)::int AS n, COALESCE(sum(e.amount_kobo), 0)::bigint AS amt
    FROM folio_entries e
    WHERE e.tenant_id = ${tenantId}::uuid
      AND e.business_date BETWEEN ${dbDate(from)}::date AND ${dbDate(to)}::date
      AND e.type <> 'VOID'
      AND NOT EXISTS (SELECT 1 FROM folio_entries v WHERE v.ref_entry_id = e.id)
    GROUP BY 1, 2, 3`;
  const guests = await tx.$queryRaw<{ d: Date; g: number }[]>`
    SELECT e.business_date AS d, COALESCE(sum(r.adults + r.children), 0)::int AS g
    FROM folio_entries e
    JOIN folios f ON f.id = e.folio_id
    JOIN reservations r ON r.id = f.reservation_id
    WHERE e.tenant_id = ${tenantId}::uuid AND e.type = 'ROOM'
      AND e.business_date BETWEEN ${dbDate(from)}::date AND ${dbDate(to)}::date
      AND NOT EXISTS (SELECT 1 FROM folio_entries v WHERE v.ref_entry_id = e.id)
    GROUP BY 1`;
  const start = lagosStartOfDay(from);
  const end = lagosStartOfDay(addDays(to, 1));
  const res = await tx.reservation.findMany({
    where: {
      tenantId,
      OR: [
        { checkedInAt: { gte: start, lt: end } },
        { checkedOutAt: { gte: start, lt: end } },
        { cancelledAt: { gte: start, lt: end } },
        { status: 'NO_SHOW', arrivalAt: { gte: start, lt: end } },
        { stayType: 'DAY_USE', arrivalAt: { gte: start, lt: end } },
      ],
    },
    select: { status: true, stayType: true, arrivalAt: true, checkedInAt: true, checkedOutAt: true, cancelledAt: true },
  });
  const rooms = await tx.room.findMany({ where: { tenantId }, select: { status: true } });
  const roomsTotal = rooms.length;
  const roomsOutOfOrder = rooms.filter((r) => r.status === 'OUT_OF_ORDER').length;
  const openFlags = await tx.guardFlag.count({ where: { tenantId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } } });

  const byDate = new Map<string, DailyFlash>();
  for (const d of dates) {
    byDate.set(d, {
      date: d,
      live: true,
      roomsTotal,
      roomsOutOfOrder,
      roomsAvailable: Math.max(0, roomsTotal - roomsOutOfOrder),
      roomsSold: 0,
      occupancyRate: 0,
      adrKobo: 0,
      revparKobo: 0,
      roomRevenueKobo: 0,
      dayUseRevenueKobo: 0,
      otherRevenueKobo: 0,
      discountKobo: 0,
      taxKobo: 0,
      serviceChargeKobo: 0,
      totalRevenueKobo: 0,
      paymentsByMethod: emptyMethods(),
      paymentsTotalKobo: 0,
      refundsKobo: 0,
      dayUseCount: 0,
      arrivals: 0,
      departures: 0,
      noShows: 0,
      cancellations: 0,
      guestsInHouse: 0,
      openFlags,
    });
  }
  for (const r of rows) {
    const f = byDate.get(fromDbDate(r.d));
    if (!f) continue;
    const amt = Number(r.amt);
    switch (r.type) {
      case 'ROOM':
        f.roomsSold += r.n;
        f.roomRevenueKobo += amt;
        break;
      case 'DAY_USE':
        f.dayUseRevenueKobo += amt;
        break;
      case 'EXTRA':
        f.otherRevenueKobo += amt;
        break;
      case 'DISCOUNT':
        f.discountKobo += -amt;
        break;
      case 'TAX':
        f.taxKobo += amt;
        break;
      case 'SERVICE_CHARGE':
        f.serviceChargeKobo += amt;
        break;
      case 'PAYMENT':
        if (r.method) f.paymentsByMethod[r.method as PaymentMethod] += -amt;
        f.paymentsTotalKobo += -amt;
        break;
      case 'REFUND':
        f.refundsKobo += amt;
        break;
    }
  }
  for (const g of guests) {
    const f = byDate.get(fromDbDate(g.d));
    if (f) f.guestsInHouse = g.g;
  }
  for (const r of res) {
    const bump = (at: Date | null, key: 'arrivals' | 'departures' | 'cancellations' | 'noShows' | 'dayUseCount') => {
      if (!at) return;
      const f = byDate.get(lagosDate(at));
      if (f) f[key] += 1;
    };
    bump(r.checkedInAt, 'arrivals');
    bump(r.checkedOutAt, 'departures');
    bump(r.cancelledAt, 'cancellations');
    if (r.status === 'NO_SHOW') bump(r.arrivalAt, 'noShows');
    if (r.stayType === 'DAY_USE' && (r.status === 'CHECKED_IN' || r.status === 'CHECKED_OUT')) bump(r.arrivalAt, 'dayUseCount');
  }
  for (const f of byDate.values()) finalise(f);
  return dates.map((d) => byDate.get(d)!);
}

export function finalise(f: Pick<DailyFlash, 'roomsSold' | 'roomsAvailable' | 'roomRevenueKobo' | 'dayUseRevenueKobo' | 'otherRevenueKobo' | 'discountKobo' | 'occupancyRate' | 'adrKobo' | 'revparKobo' | 'totalRevenueKobo'>) {
  f.occupancyRate = f.roomsAvailable > 0 ? round4(Math.min(1, f.roomsSold / f.roomsAvailable)) : 0;
  f.adrKobo = f.roomsSold > 0 ? Math.round(f.roomRevenueKobo / f.roomsSold) : 0;
  f.revparKobo = f.roomsAvailable > 0 ? Math.round(f.roomRevenueKobo / f.roomsAvailable) : 0;
  f.totalRevenueKobo = f.roomRevenueKobo + f.dayUseRevenueKobo + f.otherRevenueKobo - f.discountKobo;
}

/** Sums a list of daily flashes; ratios are recomputed from the sums. */
export function sumFlashes(days: DailyFlash[]) {
  const t = {
    roomsAvailable: 0,
    roomsSold: 0,
    occupancyRate: 0,
    adrKobo: 0,
    revparKobo: 0,
    roomRevenueKobo: 0,
    dayUseRevenueKobo: 0,
    otherRevenueKobo: 0,
    discountKobo: 0,
    taxKobo: 0,
    serviceChargeKobo: 0,
    totalRevenueKobo: 0,
    paymentsByMethod: emptyMethods(),
    paymentsTotalKobo: 0,
    refundsKobo: 0,
    dayUseCount: 0,
    arrivals: 0,
    departures: 0,
    noShows: 0,
    cancellations: 0,
  };
  for (const d of days) {
    t.roomsAvailable += d.roomsAvailable;
    t.roomsSold += d.roomsSold;
    t.roomRevenueKobo += d.roomRevenueKobo;
    t.dayUseRevenueKobo += d.dayUseRevenueKobo;
    t.otherRevenueKobo += d.otherRevenueKobo;
    t.discountKobo += d.discountKobo;
    t.taxKobo += d.taxKobo;
    t.serviceChargeKobo += d.serviceChargeKobo;
    t.paymentsTotalKobo += d.paymentsTotalKobo;
    t.refundsKobo += d.refundsKobo;
    t.dayUseCount += d.dayUseCount;
    t.arrivals += d.arrivals;
    t.departures += d.departures;
    t.noShows += d.noShows;
    t.cancellations += d.cancellations;
    for (const m of PAYMENT_METHODS) t.paymentsByMethod[m] += d.paymentsByMethod[m] ?? 0;
  }
  finalise(t);
  return t;
}
