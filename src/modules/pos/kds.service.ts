import { Injectable } from '@nestjs/common';
import type { KdsStation, KdsTicketStatus, Prisma } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { Err } from '../ops/ops.helpers.js';
import { KDS_TRANSITIONS, nextBump } from './pos.logic.js';
import { ticketView } from './pos.service.js';

const include = { lines: { orderBy: { createdAt: 'asc' } }, order: { include: { outlet: true } } } satisfies Prisma.PosTicketInclude;
const ACTIVE: KdsTicketStatus[] = ['NEW', 'PREPARING', 'READY'];

/** Kitchen display: tickets per station with timers, status changes and bump. */
@Injectable()
export class KdsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private async views(tx: Tx, rows: Prisma.PosTicketGetPayload<{ include: typeof include }>[]) {
    const roomIds = [...new Set(rows.map((r) => r.order.roomId).filter((x): x is string => !!x))];
    const rooms = new Map((roomIds.length ? await tx.room.findMany({ where: { id: { in: roomIds } }, select: { id: true, number: true } }) : []).map((r) => [r.id, r.number]));
    const now = new Date();
    return rows.map((t) => ticketView(t, t.order.roomId ? (rooms.get(t.order.roomId) ?? null) : null, now));
  }

  list(user: AuthUser, q: { station?: 'KITCHEN' | 'BAR'; outletId?: string; status?: string; since?: string }) {
    const statuses = q.status
      ? (q.status.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s in KDS_TRANSITIONS) as KdsTicketStatus[])
      : ACTIVE;
    let since: Date | null = null;
    if (q.since) {
      since = new Date(q.since);
      if (Number.isNaN(since.getTime())) throw Err.validation('since', 'since must be an ISO timestamp');
    }
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.posTicket.findMany({
        where: {
          tenantId: user.tenantId,
          ...(q.station && { station: q.station as KdsStation }),
          ...(q.outletId && { outletId: q.outletId }),
          // With `since`, every ticket changed since then (so bumped ones disappear on the screen).
          ...(since ? { updatedAt: { gte: since } } : { status: { in: statuses } }),
        },
        include,
        orderBy: { createdAt: 'asc' },
        take: 200,
      });
      return this.views(tx, rows);
    });
  }

  private async load(tx: Tx, tenantId: string, id: string) {
    const t = await tx.posTicket.findFirst({ where: { id, tenantId }, include });
    if (!t) throw AppException.notFound('Ticket');
    return t;
  }

  private async move(tx: Tx, user: AuthUser, id: string, to: KdsTicketStatus) {
    const t = await this.load(tx, user.tenantId, id);
    const allowed = KDS_TRANSITIONS[t.status] ?? [];
    if (!allowed.includes(to)) throw Err.invalidState(t.status, allowed.length ? allowed : ['NEW', 'PREPARING', 'READY'], 'This ticket');
    const now = new Date();
    await tx.posTicket.update({
      where: { id },
      data: {
        status: to,
        ...(to === 'PREPARING' && !t.startedAt && { startedAt: now }),
        ...(to === 'READY' && { readyAt: now, startedAt: t.startedAt ?? now }),
        ...(to === 'SERVED' && { servedAt: now }),
        ...(to === 'NEW' && { startedAt: null }),
      },
    });
    await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'kds.ticket_status', entityType: 'pos_ticket', entityId: id, metadata: { number: t.number, from: t.status, to } });
    return (await this.views(tx, [await this.load(tx, user.tenantId, id)]))[0];
  }

  setStatus(user: AuthUser, id: string, status: KdsTicketStatus) {
    return this.db.tenant(user.tenantId, (tx) => this.move(tx, user, id, status));
  }

  bump(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const t = await this.load(tx, user.tenantId, id);
      const to = nextBump(t.status);
      if (!to) throw Err.invalidState(t.status, ['NEW', 'PREPARING', 'READY'], 'This ticket');
      // Bump from NEW goes straight to READY (a quick drink at the bar).
      if (t.status === 'NEW' && to === 'READY') {
        const now = new Date();
        await tx.posTicket.update({ where: { id }, data: { status: 'READY', startedAt: now, readyAt: now } });
        await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'kds.ticket_status', entityType: 'pos_ticket', entityId: id, metadata: { number: t.number, from: t.status, to } });
        return (await this.views(tx, [await this.load(tx, user.tenantId, id)]))[0];
      }
      return this.move(tx, user, id, to as KdsTicketStatus);
    });
  }

  print(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const t = await this.load(tx, user.tenantId, id);
      const p = await tx.property.findFirstOrThrow({ where: { id: t.propertyId }, select: { name: true } });
      return { hotel: { name: p.name }, outlet: t.order.outlet.name, ticket: (await this.views(tx, [t]))[0], printedAt: new Date().toISOString() };
    });
  }
}
