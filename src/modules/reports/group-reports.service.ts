import { Injectable } from '@nestjs/common';
import { RoomStatus } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { propertyAccessDenied } from '../../common/guards/permission.guard.js';
import { addDays, dateRange, diffDays, isIsoDate, lagosDate, lagosStartOfDay } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { Err, k } from '../ops/ops.helpers.js';
import { PropertyService, type PropertySummary } from '../property/property.service.js';
import { computeDailyFlashes, round4, type DailyFlash } from './stats.compute.js';

export interface GroupRow {
  roomsAvailable: number;
  roomsSold: number;
  occupancyRate: number;
  adrKobo: number;
  revparKobo: number;
  roomRevenueKobo: number;
  posRevenueKobo: number;
  otherRevenueKobo: number;
  totalRevenueKobo: number;
  paymentsKobo: number;
  reservations: number;
  otaCommissionKobo: number;
}

/** Sums rows and recomputes the ratios from the sums (never averages ratios). */
export function sumGroupRows(rows: GroupRow[]): GroupRow {
  const t: GroupRow = {
    roomsAvailable: 0, roomsSold: 0, occupancyRate: 0, adrKobo: 0, revparKobo: 0, roomRevenueKobo: 0,
    posRevenueKobo: 0, otherRevenueKobo: 0, totalRevenueKobo: 0, paymentsKobo: 0, reservations: 0, otaCommissionKobo: 0,
  };
  for (const r of rows) {
    t.roomsAvailable += r.roomsAvailable;
    t.roomsSold += r.roomsSold;
    t.roomRevenueKobo += r.roomRevenueKobo;
    t.posRevenueKobo += r.posRevenueKobo;
    t.otherRevenueKobo += r.otherRevenueKobo;
    t.totalRevenueKobo += r.totalRevenueKobo;
    t.paymentsKobo += r.paymentsKobo;
    t.reservations += r.reservations;
    t.otaCommissionKobo += r.otaCommissionKobo;
  }
  return withRatios(t);
}

function withRatios(t: GroupRow): GroupRow {
  t.occupancyRate = t.roomsAvailable ? round4(t.roomsSold / t.roomsAvailable) : 0;
  t.adrKobo = t.roomsSold ? Math.round(t.roomRevenueKobo / t.roomsSold) : 0;
  t.revparKobo = t.roomsAvailable ? Math.round(t.roomRevenueKobo / t.roomsAvailable) : 0;
  return t;
}

/**
 * M5 group reports: consolidated figures across the properties a user can
 * access, per property and per day. Runs without the property filter on
 * purpose (every query below names its property explicitly).
 */
@Injectable()
export class GroupReportsService {
  constructor(
    private readonly db: DbService,
    private readonly properties: PropertyService,
  ) {}

  /** The properties to report on: the user's, optionally narrowed (403 for any not accessible). */
  private async targets(tx: Tx, user: AuthUser, propertyIds?: string): Promise<PropertySummary[]> {
    const mine = await this.properties.summaries(tx, user);
    if (!propertyIds) return mine;
    const wanted = propertyIds.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    for (const id of wanted) if (!mine.some((p) => p.id === id)) throw propertyAccessDenied(id);
    return mine.filter((p) => wanted.includes(p.id));
  }

  report(user: AuthUser, from: string, to: string, propertyIds?: string) {
    if (!isIsoDate(from) || !isIsoDate(to)) throw Err.validation('from', 'from and to must be YYYY-MM-DD');
    if (to < from) throw Err.validation('to', '"to" must not be before "from"');
    if (diffDays(from, to) + 1 > 92) throw Err.validation('to', 'The range can be at most 92 days');
    return this.db.tenant(user.tenantId, (tx) =>
      this.db.withAllProperties(user.tenantId, async () => {
        const props = await this.targets(tx, user, propertyIds);
        const perProperty: (GroupRow & { property: PropertySummary })[] = [];
        const byDay = new Map<string, { date: string; sold: number; avail: number; room: number; total: number; byProperty: Record<string, { occupancyRate: number; roomRevenueKobo: number; totalRevenueKobo: number }> }>();
        for (const d of dateRange(from, to)) byDay.set(d, { date: d, sold: 0, avail: 0, room: 0, total: 0, byProperty: {} });
        for (const p of props) {
          const days = await computeDailyFlashes(tx, user.tenantId, from, to, [p.id]);
          const pos = await this.posByDay(tx, user.tenantId, p.id, from, to);
          const extras = await this.extras(tx, user.tenantId, p.id, from, to);
          const row = this.rowFrom(days, pos, extras);
          perProperty.push({ property: p, ...row });
          for (const d of days) {
            const b = byDay.get(d.date)!;
            const total = d.totalRevenueKobo;
            b.sold += d.roomsSold;
            b.avail += d.roomsAvailable;
            b.room += d.roomRevenueKobo;
            b.total += total;
            b.byProperty[p.id] = { occupancyRate: d.occupancyRate, roomRevenueKobo: d.roomRevenueKobo, totalRevenueKobo: total };
          }
        }
        return {
          from,
          to,
          properties: perProperty,
          totals: sumGroupRows(perProperty),
          byDay: [...byDay.values()].map((b) => ({
            date: b.date,
            occupancyRate: b.avail ? round4(b.sold / b.avail) : 0,
            roomRevenueKobo: b.room,
            totalRevenueKobo: b.total,
            byProperty: b.byProperty,
          })),
        };
      }),
    );
  }

  private rowFrom(days: DailyFlash[], pos: Map<string, number>, extras: { reservations: number; otaCommissionKobo: number }): GroupRow {
    const posTotal = [...pos.values()].reduce((a, b) => a + b, 0);
    const t: GroupRow = {
      roomsAvailable: 0, roomsSold: 0, occupancyRate: 0, adrKobo: 0, revparKobo: 0, roomRevenueKobo: 0,
      posRevenueKobo: posTotal, otherRevenueKobo: 0, totalRevenueKobo: 0, paymentsKobo: 0,
      reservations: extras.reservations, otaCommissionKobo: extras.otaCommissionKobo,
    };
    let extra = 0;
    for (const d of days) {
      t.roomsAvailable += d.roomsAvailable;
      t.roomsSold += d.roomsSold;
      t.roomRevenueKobo += d.roomRevenueKobo;
      t.totalRevenueKobo += d.totalRevenueKobo;
      t.paymentsKobo += d.paymentsTotalKobo - d.refundsKobo;
      extra += d.otherRevenueKobo;
    }
    // POS sales settled or charged to a room post EXTRA lines on folios, so they are
    // inside otherRevenueKobo already; report them separately.
    t.otherRevenueKobo = Math.max(0, extra - posTotal);
    return withRatios(t);
  }

  /** Net POS sales (excluding tax) per Lagos day of settlement. */
  private async posByDay(tx: Tx, tenantId: string, propertyId: string, from: string, to: string) {
    const rows = await tx.posOrder.findMany({
      where: { tenantId, propertyId, status: 'SETTLED', settledAt: { gte: lagosStartOfDay(from), lt: lagosStartOfDay(addDays(to, 1)) } },
      select: { settledAt: true, netKobo: true },
    });
    const out = new Map<string, number>();
    for (const r of rows) {
      const d = lagosDate(r.settledAt!);
      out.set(d, (out.get(d) ?? 0) + k(r.netKobo));
    }
    return out;
  }

  private async extras(tx: Tx, tenantId: string, propertyId: string, from: string, to: string) {
    const window = { gte: lagosStartOfDay(from), lt: lagosStartOfDay(addDays(to, 1)) };
    const reservations = await tx.reservation.count({ where: { tenantId, propertyId, arrivalAt: window, status: { notIn: ['CANCELLED'] } } });
    const ota = await tx.reservation.aggregate({
      where: { tenantId, propertyId, arrivalAt: window, source: 'OTA', status: { notIn: ['CANCELLED'] } },
      _sum: { otaCommissionKobo: true },
    });
    return { reservations, otaCommissionKobo: k(ota._sum.otaCommissionKobo) };
  }

  /** Today's snapshot for every accessible property ("All properties" dashboard). */
  dashboard(user: AuthUser) {
    return this.db.tenant(user.tenantId, (tx) =>
      this.db.withAllProperties(user.tenantId, async () => {
        const props = await this.targets(tx, user);
        const today = lagosDate();
        const start = lagosStartOfDay(today);
        const end = lagosStartOfDay(addDays(today, 1));
        const rows: {
          property: PropertySummary; rooms: { total: number; byStatus: Record<RoomStatus, number> }; occupancyRate: number;
          arrivals: number; departures: number; inHouse: number; openFlags: number; unreadMessages: number; openPosOrders: number;
          roomRevenueTodayKobo: number; posRevenueTodayKobo: number;
        }[] = [];
        for (const p of props) {
          const groups = await tx.room.groupBy({ by: ['status'], where: { tenantId: user.tenantId, propertyId: p.id }, _count: { _all: true } });
          const byStatus = Object.fromEntries(Object.values(RoomStatus).map((s) => [s, 0])) as Record<RoomStatus, number>;
          for (const g of groups) byStatus[g.status] = g._count._all;
          const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
          const sellable = total - byStatus.OUT_OF_ORDER;
          const base = { tenantId: user.tenantId, propertyId: p.id };
          const arrivals = await tx.reservation.count({ where: { ...base, arrivalAt: { gte: start, lt: end }, status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] } } });
          const departures = await tx.reservation.count({ where: { ...base, departureAt: { gte: start, lt: end }, status: { in: ['CHECKED_IN', 'CHECKED_OUT'] } } });
          const inHouse = await tx.reservation.count({ where: { ...base, status: 'CHECKED_IN' } });
          const openFlags = await tx.guardFlag.count({ where: { ...base, status: { in: ['OPEN', 'ACKNOWLEDGED'] } } });
          const unread = await tx.conversation.aggregate({ where: { ...base, status: { not: 'CLOSED' } }, _sum: { unreadCount: true } });
          const openPosOrders = await tx.posOrder.count({ where: { ...base, status: 'OPEN' } });
          const room = await tx.folioEntry.aggregate({ where: { ...base, type: 'ROOM', businessDate: new Date(`${today}T00:00:00Z`), refEntryId: null }, _sum: { amountKobo: true } });
          const pos = await tx.posOrder.aggregate({ where: { ...base, status: 'SETTLED', settledAt: { gte: start, lt: end } }, _sum: { netKobo: true } });
          rows.push({
            property: p,
            rooms: { total, byStatus },
            occupancyRate: sellable > 0 ? round4(byStatus.OCCUPIED / sellable) : 0,
            arrivals,
            departures,
            inHouse,
            openFlags,
            unreadMessages: unread._sum.unreadCount ?? 0,
            openPosOrders,
            roomRevenueTodayKobo: k(room._sum.amountKobo),
            posRevenueTodayKobo: k(pos._sum.netKobo),
          });
        }
        const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
        const occ = sum((r) => r.rooms.byStatus.OCCUPIED);
        const sellable = sum((r) => r.rooms.total - r.rooms.byStatus.OUT_OF_ORDER);
        return {
          date: today,
          properties: rows,
          totals: {
            rooms: sum((r) => r.rooms.total),
            occupancyRate: sellable ? round4(occ / sellable) : 0,
            arrivals: sum((r) => r.arrivals),
            departures: sum((r) => r.departures),
            inHouse: sum((r) => r.inHouse),
            openFlags: sum((r) => r.openFlags),
            roomRevenueTodayKobo: sum((r) => r.roomRevenueTodayKobo),
            posRevenueTodayKobo: sum((r) => r.posRevenueTodayKobo),
          },
        };
      }),
    );
  }
}
