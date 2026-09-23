import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { RoomStatus } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { lagosDate, lagosStartOfDay, addDays } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { LedgerService } from '../folios/ledger.service.js';
import { registrationComplete } from '../reservations/reservations.service.js';
import { ShiftsService } from '../shifts/shifts.service.js';

const include = { guest: true, room: true, roomType: true, folio: { select: { id: true } } } satisfies Prisma.ReservationInclude;
type Row = Prisma.ReservationGetPayload<{ include: typeof include }>;

/** Today's board: arrivals, in-house, departures and day-use, plus counters. */
@Injectable()
export class FrontDeskService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly shifts: ShiftsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async todayTx(tx: Tx, user: AuthUser, now = new Date()) {
    const today = lagosDate(now);
    const start = lagosStartOfDay(today);
    const end = lagosStartOfDay(addDays(today, 1));
    const rows = await tx.reservation.findMany({
      where: {
        tenantId: user.tenantId,
        OR: [
          { status: 'CHECKED_IN' },
          { status: { in: ['PENDING', 'CONFIRMED'] }, arrivalAt: { gte: start, lt: end } },
          { checkedInAt: { gte: start, lt: end } },
          { status: 'CHECKED_OUT', checkedOutAt: { gte: start, lt: end } },
          { stayType: 'DAY_USE', arrivalAt: { gte: start, lt: end }, status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] } },
        ],
      },
      include,
      orderBy: { arrivalAt: 'asc' },
    });
    const balances = await this.ledger.balances(tx, rows.map((r) => r.folio?.id).filter((x): x is string => !!x));
    const view = (r: Row) => ({
      id: r.id,
      code: r.code,
      status: r.status,
      stayType: r.stayType,
      source: r.source,
      guest: { id: r.guest.id, fullName: r.guest.fullName, phone: r.guest.phone, vip: r.guest.vip },
      room: r.room ? { id: r.room.id, number: r.room.number, floor: r.room.floor, status: r.room.status } : null,
      roomType: { id: r.roomType.id, name: r.roomType.name },
      arrivalAt: r.arrivalAt.toISOString(),
      departureAt: r.departureAt.toISOString(),
      adults: r.adults,
      children: r.children,
      balanceKobo: r.folio ? (balances.get(r.folio.id) ?? 0) : 0,
      registrationComplete: registrationComplete(r, r.guest),
      overdue: r.status === 'CHECKED_IN' && r.departureAt < now,
    });
    const arrivalDay = (r: Row) => lagosDate(r.arrivalAt) === today || (r.checkedInAt && lagosDate(r.checkedInAt) === today);
    const arrivals = rows.filter((r) => ['PENDING', 'CONFIRMED', 'CHECKED_IN'].includes(r.status) && arrivalDay(r));
    const inHouse = rows.filter((r) => r.status === 'CHECKED_IN');
    const departures = rows.filter(
      (r) => (r.status === 'CHECKED_IN' && lagosDate(r.departureAt) <= today) || (r.status === 'CHECKED_OUT' && r.checkedOutAt && lagosDate(r.checkedOutAt) === today),
    );
    const dayUse = rows.filter((r) => r.stayType === 'DAY_USE' && lagosDate(r.arrivalAt) === today);

    const groups = await tx.room.groupBy({ by: ['status'], where: { tenantId: user.tenantId }, _count: { _all: true } });
    const byStatus = Object.fromEntries(Object.values(RoomStatus).map((s) => [s, 0])) as Record<RoomStatus, number>;
    for (const g of groups) byStatus[g.status] = g._count._all;
    const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
    const guard = ent.features.includes('revenue_guard_basic') || ent.features.includes('revenue_guard_full');
    const openFlags = guard ? await tx.guardFlag.count({ where: { tenantId: user.tenantId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } } }) : null;
    return {
      businessDate: today,
      arrivals: arrivals.map(view),
      inHouse: inHouse.map(view),
      departures: departures.map(view),
      dayUse: dayUse.map(view),
      counts: {
        arrivals: arrivals.length,
        arrivalsPending: arrivals.filter((r) => r.status !== 'CHECKED_IN').length,
        inHouse: inHouse.length,
        departures: departures.length,
        departuresPending: departures.filter((r) => r.status === 'CHECKED_IN').length,
        dayUse: dayUse.length,
      },
      rooms: { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus },
      openFlags,
      myShift: await this.shifts.currentTx(tx, user),
    };
  }

  today(user: AuthUser) {
    return this.db.tenant(user.tenantId, (tx) => this.todayTx(tx, user));
  }

  /** Compact version for /dashboard/summary. */
  async summaryTx(tx: Tx, user: AuthUser) {
    const t = await this.todayTx(tx, user);
    return {
      frontDesk: { businessDate: t.businessDate, ...t.counts },
      openFlags: t.openFlags,
      myShift: t.myShift,
    };
  }
}
