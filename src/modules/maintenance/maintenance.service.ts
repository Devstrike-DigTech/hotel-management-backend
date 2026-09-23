import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { MaintenanceCategory, Prisma, TaskPriority, TicketStatus } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { can, forbidden } from '../../common/permissions/can.js';
import { addDays, dateRange, dbDate, fromDbDate, humanDateTime, isIsoDate, lagosDate, lagosStartOfDay } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, SYSTEM_ACTOR, userActor } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { GuestsService, type UploadedFileLike } from '../guests/guests.service.js';
import { HousekeepingService } from '../housekeeping/housekeeping.service.js';
import { DocumentsService } from '../invoices/documents.service.js';
import { appError, Err, k, paginate, parseClientCreatedAt, primaryProperty } from '../ops/ops.helpers.js';
import { ACTIVE_STATUSES, loadCapacity, rawFreeRooms } from '../rates/capacity.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/object-storage.js';
import { photosOf, storePhoto, type StoredPhoto } from '../storage/photos.js';
import { ageBucket, nextDue, slaDueAt, slaState, ticketNumber } from './maintenance.logic.js';

const ticketInclude = {
  room: { include: { roomType: { select: { id: true, name: true } } } },
  blocks: { orderBy: { createdAt: 'desc' as const }, include: { room: true } },
} satisfies Prisma.MaintenanceTicketInclude;

type TicketRow = Prisma.MaintenanceTicketGetPayload<{ include: typeof ticketInclude }>;
type BlockRow = Prisma.RoomBlockGetPayload<{ include: { room: true; ticket: { select: { number: true } } } }>;

const OPEN: TicketStatus[] = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'];
const MAX_BLOCK_DAYS = 180;

export interface TicketInput {
  roomId?: string;
  area?: string;
  category: MaintenanceCategory;
  priority?: TaskPriority;
  title: string;
  description?: string;
  assigneeId?: string;
  vendorName?: string;
  vendorPhone?: string;
  blocksRoom?: boolean;
  outOfOrderFrom?: string;
  outOfOrderTo?: string;
  force?: boolean;
  clientCreatedAt?: string;
}

/**
 * Maintenance: numbered tickets with SLA by priority and a timeline, room
 * blocks (out-of-order windows honoured by availability, quotes, public
 * search and the ledger), preventive schedules, the generator diesel log
 * and reports.
 */
@Injectable()
export class MaintenanceService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly docs: DocumentsService,
    private readonly guests: GuestsService,
    private readonly housekeeping: HousekeepingService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  blockView(b: BlockRow | (Prisma.RoomBlockGetPayload<{ include: { room: true } }> & { ticket?: { number: string } | null }), now = new Date()) {
    return {
      id: b.id,
      room: { id: b.room.id, number: b.room.number, floor: b.room.floor, status: b.room.status },
      from: b.startsAt.toISOString(),
      to: b.endsAt.toISOString(),
      reason: b.reason,
      ticketId: b.ticketId,
      ticketNumber: b.ticket?.number ?? null,
      active: b.startsAt <= now && b.endsAt > now,
      createdBy: b.createdById ? { id: b.createdById, fullName: b.createdByName ?? '' } : null,
      createdAt: b.createdAt.toISOString(),
      releasedAt: b.releasedAt?.toISOString() ?? null,
    };
  }

  private ticketView(t: TicketRow, tenantId: string, showCost = true) {
    const sla = slaState(t);
    const block = t.blocks[0] ?? null;
    return {
      id: t.id,
      number: t.number,
      room: t.room ? { id: t.room.id, number: t.room.number, floor: t.room.floor, status: t.room.status, roomType: { id: t.room.roomType.id, name: t.room.roomType.name } } : null,
      area: t.area,
      category: t.category,
      priority: t.priority,
      status: t.status,
      title: t.title,
      description: t.description,
      photos: photosOf(t.photos).map((p) => ({ key: p.key, url: this.guests.fileUrl(tenantId, p.key), uploadedAt: p.uploadedAt })),
      reportedBy: t.reportedById ? { id: t.reportedById, fullName: t.reportedByName ?? '' } : t.reportedByName ? { id: '', fullName: t.reportedByName } : null,
      assignee: t.assigneeId ? { id: t.assigneeId, fullName: t.assigneeName ?? '' } : null,
      vendorName: t.vendorName,
      vendorPhone: t.vendorPhone,
      blocksRoom: t.blocksRoom,
      block: block ? this.blockView({ ...block, ticket: { number: t.number } }) : null,
      costKobo: showCost && t.costKobo !== null ? k(t.costKobo) : null,
      resolutionNote: t.resolutionNote,
      slaDueAt: t.slaDueAt.toISOString(),
      slaBreached: sla.breached,
      slaRemainingMinutes: sla.remainingMinutes,
      housekeepingTaskId: t.housekeepingTaskId,
      scheduleId: t.scheduleId,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      startedAt: t.startedAt?.toISOString() ?? null,
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      closedAt: t.closedAt?.toISOString() ?? null,
    };
  }

  private canSeeCost(user: AuthUser) {
    return can(user, 'maintenance.manage') || can(user, 'reports.financial');
  }

  private async detail(tx: Tx, user: AuthUser, id: string) {
    const t = await tx.maintenanceTicket.findFirst({ where: { id, tenantId: user.tenantId }, include: ticketInclude });
    if (!t) throw AppException.notFound('Ticket');
    const events = await tx.maintenanceTicketEvent.findMany({ where: { ticketId: id }, orderBy: { createdAt: 'asc' } });
    return {
      ...this.ticketView(t, user.tenantId, this.canSeeCost(user)),
      timeline: events.map((e) => ({
        id: e.id,
        at: e.createdAt.toISOString(),
        by: e.byId || e.byName ? { id: e.byId ?? '', fullName: e.byName ?? '' } : null,
        kind: e.kind,
        from: e.fromValue,
        to: e.toValue,
        note: e.note,
      })),
    };
  }

  private event(tx: Tx, tenantId: string, ticketId: string, kind: string, by: { id: string | null; name: string } | null, e: { from?: string | null; to?: string | null; note?: string | null } = {}) {
    return tx.maintenanceTicketEvent.create({
      data: { tenantId, ticketId, kind, fromValue: e.from ?? null, toValue: e.to ?? null, note: e.note ?? null, byId: by?.id ?? null, byName: by?.name ?? null },
    });
  }

  // ---------------------------------------------------------------------------
  // Tickets
  // ---------------------------------------------------------------------------

  list(user: AuthUser, q: { status?: string; priority?: string; category?: string; roomId?: string; assigneeId?: string; q?: string; overdue?: string; page?: number; pageSize?: number }) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const statuses = q.status === 'all' ? undefined : q.status ? (q.status.split(',') as TicketStatus[]) : OPEN;
      const where: Prisma.MaintenanceTicketWhereInput = {
        tenantId: user.tenantId,
        ...(statuses && { status: { in: statuses } }),
        ...(q.priority && { priority: { in: q.priority.split(',') as TaskPriority[] } }),
        ...(q.category && { category: { in: q.category.split(',') as MaintenanceCategory[] } }),
        ...(q.roomId && { roomId: q.roomId }),
        ...(q.assigneeId && { assigneeId: q.assigneeId }),
        ...(q.overdue === 'true' && { slaDueAt: { lt: new Date() }, status: { in: OPEN } }),
        ...(q.q && { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { number: { contains: q.q.toUpperCase() } }, { area: { contains: q.q, mode: 'insensitive' } }, { room: { number: q.q } }] }),
      };
      const rows = await tx.maintenanceTicket.findMany({ where, include: ticketInclude, orderBy: [{ slaDueAt: 'asc' }, { createdAt: 'desc' }], skip: pg.skip, take: pg.take });
      const total = await tx.maintenanceTicket.count({ where });
      const seeCost = this.canSeeCost(user);
      const items = rows.map((r) => this.ticketView(r, user.tenantId, seeCost));
      items.sort((a, b) => Number(b.slaBreached && !b.resolvedAt) - Number(a.slaBreached && !a.resolvedAt) || b.createdAt.localeCompare(a.createdAt));
      return { items, total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  get(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, (tx) => this.detail(tx, user, id));
  }

  private async staff(tx: Tx, tenantId: string, id: string) {
    const u = await tx.user.findFirst({ where: { id, tenantId, isActive: true }, select: { id: true, fullName: true } });
    if (!u) throw Err.validation('assigneeId', 'Unknown or inactive staff member');
    return u;
  }

  /** Creates a ticket inside a transaction (API, housekeeping issues, schedules). */
  async createTx(
    tx: Tx,
    tenantId: string,
    input: TicketInput & { photos?: StoredPhoto[]; housekeepingTaskId?: string | null; scheduleId?: string | null },
    actor: { id: string | null; name: string },
  ) {
    if (!input.roomId && !input.area?.trim()) throw Err.validation('roomId', 'Give a room or an area');
    const room = input.roomId ? await tx.room.findFirst({ where: { id: input.roomId, tenantId } }) : null;
    if (input.roomId && !room) throw AppException.notFound('Room');
    const assignee = input.assigneeId ? await this.staff(tx, tenantId, input.assigneeId) : null;
    const priority = input.priority ?? 'NORMAL';
    const createdAt = parseClientCreatedAt(input.clientCreatedAt) ?? new Date();
    const { seq } = await this.docs.nextNumber(tx, tenantId, 'MAINTENANCE_TICKET', 0);
    const number = ticketNumber(seq);
    const t = await tx.maintenanceTicket.create({
      data: {
        tenantId,
        propertyId: room?.propertyId ?? (await primaryProperty(tx, tenantId)).id,
        number,
        roomId: room?.id ?? null,
        area: input.area?.trim() || null,
        category: input.category,
        priority,
        status: assignee ? 'ASSIGNED' : 'OPEN',
        title: input.title,
        description: input.description ?? '',
        photos: (input.photos ?? []) as unknown as Prisma.InputJsonValue,
        reportedById: actor.id,
        reportedByName: actor.name,
        assigneeId: assignee?.id ?? null,
        assigneeName: assignee?.fullName ?? null,
        vendorName: input.vendorName ?? null,
        vendorPhone: input.vendorPhone ?? null,
        blocksRoom: !!input.blocksRoom,
        slaDueAt: slaDueAt(createdAt, priority),
        housekeepingTaskId: input.housekeepingTaskId ?? null,
        scheduleId: input.scheduleId ?? null,
        createdAt,
      },
    });
    await this.event(tx, tenantId, t.id, 'CREATED', actor, { to: t.status, note: input.title });
    if (assignee) await this.event(tx, tenantId, t.id, 'ASSIGNED', actor, { to: assignee.fullName });
    if (input.blocksRoom) {
      if (!room) throw Err.validation('blocksRoom', 'Only a ticket for a room can block it');
      if (!input.outOfOrderTo) throw Err.validation('outOfOrderTo', 'Say until when the room is out of order');
      const block = await this.blockTx(tx, tenantId, { roomId: room.id, from: input.outOfOrderFrom ?? new Date().toISOString(), to: input.outOfOrderTo, reason: input.title, ticketId: t.id, force: input.force }, actor);
      await this.event(tx, tenantId, t.id, 'BLOCK', actor, { note: `Room ${room.number} out of order until ${humanDateTime(new Date(block.block.to))}` });
    }
    return t;
  }

  create(user: AuthUser, dto: TicketInput, ip?: string) {
    if ((dto.assigneeId || dto.vendorName || dto.blocksRoom) && !can(user, 'maintenance.manage')) {
      throw forbidden('maintenance.manage', 'Only maintenance managers can assign tickets or block rooms');
    }
    return this.db.tenant(user.tenantId, async (tx) => {
      const t = await this.createTx(tx, user.tenantId, dto, { id: user.userId, name: user.fullName });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'maintenance.ticket_created',
        entityType: 'maintenance_ticket',
        entityId: t.id,
        metadata: { number: t.number, title: t.title, priority: t.priority, category: t.category, blocksRoom: t.blocksRoom },
        ip,
      });
      return this.detail(tx, user, t.id);
    });
  }

  /** "Photo of issue" from the housekeeper's phone: a ticket for the task's room. */
  createFromTask(user: AuthUser, taskId: string, dto: { title: string; category: MaintenanceCategory; description?: string; priority?: TaskPriority; photoKeys?: string[]; blocksRoom?: boolean }, ip?: string) {
    if (dto.blocksRoom && !can(user, 'maintenance.manage')) throw forbidden('maintenance.manage', 'Only maintenance managers can block rooms');
    return this.db.tenant(user.tenantId, async (tx) => {
      const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
      await this.entitlements.assertFeature(ent, 'maintenance');
      const task = await this.housekeeping.taskForIssue(tx, user.tenantId, taskId);
      const photos = photosOf(task.photos).filter((p) => !dto.photoKeys || dto.photoKeys.includes(p.key));
      const t = await this.createTx(
        tx,
        user.tenantId,
        {
          roomId: task.roomId,
          category: dto.category,
          priority: dto.priority,
          title: dto.title,
          description: dto.description ?? `Reported during ${task.type.toLowerCase().replace(/_/g, ' ')} of room ${task.room.number}.`,
          photos,
          housekeepingTaskId: task.id,
        },
        { id: user.userId, name: user.fullName },
      );
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'maintenance.ticket_created',
        entityType: 'maintenance_ticket',
        entityId: t.id,
        metadata: { number: t.number, title: t.title, fromHousekeepingTask: task.id, room: task.room.number },
        ip,
      });
      return this.detail(tx, user, t.id);
    });
  }

  update(user: AuthUser, id: string, dto: { title?: string; description?: string; category?: MaintenanceCategory; priority?: TaskPriority; assigneeId?: string | null; vendorName?: string; vendorPhone?: string; area?: string }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const t = await tx.maintenanceTicket.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!t) throw AppException.notFound('Ticket');
      const by = { id: user.userId, name: user.fullName };
      let assignee: { id: string; fullName: string } | null | undefined;
      if (dto.assigneeId !== undefined) assignee = dto.assigneeId ? await this.staff(tx, user.tenantId, dto.assigneeId) : null;
      await tx.maintenanceTicket.update({
        where: { id },
        data: {
          ...(dto.title !== undefined && { title: dto.title }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.category !== undefined && { category: dto.category }),
          ...(dto.area !== undefined && { area: dto.area }),
          ...(dto.vendorName !== undefined && { vendorName: dto.vendorName }),
          ...(dto.vendorPhone !== undefined && { vendorPhone: dto.vendorPhone }),
          ...(dto.priority !== undefined && { priority: dto.priority, slaDueAt: slaDueAt(t.createdAt, dto.priority) }),
          ...(assignee !== undefined && {
            assigneeId: assignee?.id ?? null,
            assigneeName: assignee?.fullName ?? null,
            ...(t.status === 'OPEN' && assignee && { status: 'ASSIGNED' as const }),
            ...(t.status === 'ASSIGNED' && !assignee && { status: 'OPEN' as const }),
          }),
        },
      });
      if (dto.priority && dto.priority !== t.priority) await this.event(tx, user.tenantId, id, 'STATUS', by, { from: t.priority, to: dto.priority, note: 'Priority changed' });
      if (assignee !== undefined) await this.event(tx, user.tenantId, id, 'ASSIGNED', by, { from: t.assigneeName, to: assignee?.fullName ?? null });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'maintenance.ticket_updated', entityType: 'maintenance_ticket', entityId: id, metadata: { number: t.number, changes: Object.keys(dto) }, ip });
      return this.detail(tx, user, id);
    });
  }

  setStatus(user: AuthUser, id: string, dto: { status: TicketStatus; note?: string; resolutionNote?: string; costKobo?: number; clientCreatedAt?: string }, ip?: string) {
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    return this.db.tenant(user.tenantId, async (tx) => {
      const t = await tx.maintenanceTicket.findFirst({ where: { id, tenantId: user.tenantId }, include: { room: true } });
      if (!t) throw AppException.notFound('Ticket');
      const manager = can(user, 'maintenance.manage');
      if (!manager) {
        if (!can(user, 'maintenance.work')) throw forbidden('maintenance.work');
        if (t.assigneeId && t.assigneeId !== user.userId) throw forbidden('maintenance.manage', 'This ticket is assigned to someone else');
        if (dto.status === 'CLOSED' || ((t.status === 'RESOLVED' || t.status === 'CLOSED') && dto.status !== t.status)) {
          throw forbidden('maintenance.manage', 'Only a maintenance manager can close or reopen tickets');
        }
      }
      if (dto.status === 'RESOLVED' && !dto.resolutionNote?.trim() && !t.resolutionNote) throw Err.validation('resolutionNote', 'Say what was done');
      if (t.status === dto.status && dto.costKobo === undefined) return this.detail(tx, user, id);
      const now = clientCreatedAt ?? new Date();
      const by = { id: user.userId, name: user.fullName };
      await tx.maintenanceTicket.update({
        where: { id },
        data: {
          status: dto.status,
          ...(dto.status === 'IN_PROGRESS' && !t.startedAt && { startedAt: now }),
          ...(dto.status === 'IN_PROGRESS' && !t.assigneeId && { assigneeId: user.userId, assigneeName: user.fullName }),
          ...(dto.status === 'RESOLVED' && { resolvedAt: now, resolutionNote: dto.resolutionNote ?? t.resolutionNote }),
          ...(dto.status === 'CLOSED' && { closedAt: now, resolvedAt: t.resolvedAt ?? now }),
          ...((dto.status === 'OPEN' || dto.status === 'ASSIGNED' || dto.status === 'IN_PROGRESS' || dto.status === 'ON_HOLD') && { resolvedAt: null, closedAt: null }),
          ...(dto.costKobo !== undefined && { costKobo: BigInt(dto.costKobo) }),
        },
      });
      if (t.status !== dto.status) await this.event(tx, user.tenantId, id, 'STATUS', by, { from: t.status, to: dto.status, note: dto.note ?? dto.resolutionNote ?? null });
      if (dto.costKobo !== undefined) await this.event(tx, user.tenantId, id, 'COST', by, { to: String(dto.costKobo) });
      if ((dto.status === 'RESOLVED' || dto.status === 'CLOSED') && t.status !== 'RESOLVED' && t.status !== 'CLOSED') {
        // Give the room back: end the ticket's block now.
        const blocks = await tx.roomBlock.findMany({ where: { tenantId: user.tenantId, ticketId: id, endsAt: { gt: now }, releasedAt: null } });
        for (const b of blocks) await this.releaseTx(tx, user.tenantId, b.id, by, now);
      }
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'maintenance.ticket_status',
        entityType: 'maintenance_ticket',
        entityId: id,
        metadata: { number: t.number, from: t.status, to: dto.status, ...(dto.costKobo !== undefined && { costKobo: dto.costKobo }), ...(clientCreatedAt && { clientCreatedAt: clientCreatedAt.toISOString() }) },
        ip,
      });
      return this.detail(tx, user, id);
    });
  }

  comment(user: AuthUser, id: string, body: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const t = await tx.maintenanceTicket.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!t) throw AppException.notFound('Ticket');
      await this.event(tx, user.tenantId, id, 'COMMENT', { id: user.userId, name: user.fullName }, { note: body });
      await tx.maintenanceTicket.update({ where: { id }, data: { updatedAt: new Date() } });
      return this.detail(tx, user, id);
    });
  }

  async addPhoto(user: AuthUser, id: string, file: UploadedFileLike | undefined) {
    const photo = await storePhoto(this.storage, user.tenantId, 'maintenance', file);
    return this.db.tenant(user.tenantId, async (tx) => {
      const t = await tx.maintenanceTicket.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!t) throw AppException.notFound('Ticket');
      await tx.maintenanceTicket.update({ where: { id }, data: { photos: [...photosOf(t.photos), photo] as unknown as Prisma.InputJsonValue } });
      await this.event(tx, user.tenantId, id, 'PHOTO', { id: user.userId, name: user.fullName }, { to: photo.key });
      return this.detail(tx, user, id);
    });
  }

  // ---------------------------------------------------------------------------
  // Room blocks
  // ---------------------------------------------------------------------------

  listBlocks(user: AuthUser, q: { from?: string; to?: string; roomId?: string; active?: string }) {
    const from = q.from && isIsoDate(q.from) ? q.from : lagosDate();
    const to = q.to && isIsoDate(q.to) ? q.to : addDays(from, 60);
    return this.db.tenant(user.tenantId, async (tx) => {
      const now = new Date();
      const rows = await tx.roomBlock.findMany({
        where: {
          tenantId: user.tenantId,
          ...(q.roomId && { roomId: q.roomId }),
          ...(q.active === 'true' ? { startsAt: { lte: now }, endsAt: { gt: now } } : { startsAt: { lt: lagosStartOfDay(addDays(to, 1)) }, endsAt: { gt: lagosStartOfDay(from) } }),
        },
        include: { room: true, ticket: { select: { number: true } } },
        orderBy: { startsAt: 'asc' },
      });
      return rows.map((b) => this.blockView(b, now));
    });
  }

  /** Free rooms of the same type for a displaced stay. */
  private async suggestions(tx: Tx, tenantId: string, roomTypeId: string, exceptRoomId: string, arrivalAt: Date, departureAt: Date) {
    const rooms = await tx.room.findMany({ where: { tenantId, roomTypeId, id: { not: exceptRoomId }, status: { not: 'OUT_OF_ORDER' } }, orderBy: [{ floor: 'asc' }, { number: 'asc' }] });
    const out: { roomId: string; number: string; floor: number }[] = [];
    for (const r of rooms) {
      const busy = await tx.reservation.count({ where: { tenantId, roomId: r.id, status: { in: ACTIVE_STATUSES }, arrivalAt: { lt: departureAt }, departureAt: { gt: arrivalAt } } });
      const blocked = await tx.roomBlock.count({ where: { tenantId, roomId: r.id, startsAt: { lt: departureAt }, endsAt: { gt: arrivalAt } } });
      if (!busy && !blocked) out.push({ roomId: r.id, number: r.number, floor: r.floor });
      if (out.length >= 5) break;
    }
    return out;
  }

  /**
   * Creates (or with `blockId` extends) a room block. Active stays in the room
   * during the window are conflicts: refused unless `force`, which moves
   * future stays off the room (they keep their room type) and returns them
   * with free-room suggestions. A guest in house always refuses.
   */
  async blockTx(
    tx: Tx,
    tenantId: string,
    input: { roomId: string; from: string; to: string; reason: string; ticketId?: string | null; force?: boolean; blockId?: string },
    actor: { id: string | null; name: string },
  ) {
    const startsAt = new Date(input.from);
    const endsAt = new Date(input.to);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw Err.validation('from', 'from and to must be ISO timestamps');
    if (endsAt <= startsAt) throw Err.validation('to', '"to" must be after "from"');
    if (endsAt.getTime() - startsAt.getTime() > MAX_BLOCK_DAYS * 86_400_000) throw Err.validation('to', `A block can be at most ${MAX_BLOCK_DAYS} days`);
    const room = await tx.room.findFirst({ where: { id: input.roomId, tenantId } });
    if (!room) throw AppException.notFound('Room');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`room-type:${tenantId}:${room.roomTypeId}`}, 0))`;
    const clashes = await tx.reservation.findMany({
      where: { tenantId, roomId: room.id, status: { in: ACTIVE_STATUSES }, arrivalAt: { lt: endsAt }, departureAt: { gt: startsAt } },
      include: { guest: { select: { fullName: true } } },
      orderBy: { arrivalAt: 'asc' },
    });
    const conflicts = [];
    for (const c of clashes) {
      conflicts.push({
        reservationId: c.id,
        code: c.code,
        guestName: c.guest.fullName,
        status: c.status,
        arrivalAt: c.arrivalAt.toISOString(),
        departureAt: c.departureAt.toISOString(),
        roomId: c.roomId,
        suggestions: await this.suggestions(tx, tenantId, room.roomTypeId, room.id, c.arrivalAt, c.departureAt),
      });
    }
    // Unassigned stays of the type that would no longer fit once the room is blocked.
    const cap = (await loadCapacity(tx, tenantId, [room.roomTypeId], startsAt, endsAt, {})).get(room.roomTypeId)!;
    const withBlock = { ...cap, blocks: [...cap.blocks.filter((b) => !(input.blockId && b.roomId === room.id)), { roomId: room.id, start: startsAt, end: endsAt }] };
    if (rawFreeRooms(withBlock, startsAt, endsAt) < 0) {
      const unassigned = await tx.reservation.findMany({
        where: { tenantId, roomTypeId: room.roomTypeId, roomId: null, status: { in: ['PENDING', 'CONFIRMED'] }, arrivalAt: { lt: endsAt }, departureAt: { gt: startsAt } },
        include: { guest: { select: { fullName: true } } },
      });
      for (const u of unassigned) {
        conflicts.push({ reservationId: u.id, code: u.code, guestName: u.guest.fullName, status: u.status, arrivalAt: u.arrivalAt.toISOString(), departureAt: u.departureAt.toISOString(), roomId: null, suggestions: [] });
      }
    }
    if (clashes.some((c) => c.status === 'CHECKED_IN')) {
      throw appError(HttpStatus.CONFLICT, 'BLOCK_CONFLICT', `Room ${room.number} has a guest in house during this window; move the guest first`, { conflicts });
    }
    if (conflicts.length && !input.force) {
      throw appError(HttpStatus.CONFLICT, 'BLOCK_CONFLICT', `Room ${room.number} has ${conflicts.length} booking${conflicts.length === 1 ? '' : 's'} during this window`, { conflicts });
    }
    for (const c of clashes) {
      await tx.reservation.update({ where: { id: c.id }, data: { roomId: null } });
    }
    const block = input.blockId
      ? await tx.roomBlock.update({ where: { id: input.blockId }, data: { startsAt, endsAt, reason: input.reason }, include: { room: true, ticket: { select: { number: true } } } })
      : await tx.roomBlock.create({
          data: { tenantId, propertyId: room.propertyId, roomId: room.id, roomTypeId: room.roomTypeId, startsAt, endsAt, reason: input.reason, ticketId: input.ticketId ?? null, createdById: actor.id, createdByName: actor.name },
          include: { room: true, ticket: { select: { number: true } } },
        });
    const now = new Date();
    if (startsAt <= now && endsAt > now && room.status !== 'OUT_OF_ORDER') {
      await tx.room.update({ where: { id: room.id }, data: { status: 'OUT_OF_ORDER' } });
      block.room.status = 'OUT_OF_ORDER';
    }
    return { block: this.blockView(block), displaced: conflicts };
  }

  createBlock(user: AuthUser, dto: { roomId: string; from: string; to: string; reason: string; ticketId?: string; force?: boolean }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      if (dto.ticketId && !(await tx.maintenanceTicket.findFirst({ where: { id: dto.ticketId, tenantId: user.tenantId } }))) throw AppException.notFound('Ticket');
      const out = await this.blockTx(tx, user.tenantId, dto, { id: user.userId, name: user.fullName });
      if (dto.ticketId) {
        await tx.maintenanceTicket.update({ where: { id: dto.ticketId }, data: { blocksRoom: true } });
        await this.event(tx, user.tenantId, dto.ticketId, 'BLOCK', { id: user.userId, name: user.fullName }, { note: `Room ${out.block.room.number} blocked until ${humanDateTime(new Date(out.block.to))}` });
      }
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'room_block.created',
        entityType: 'room_block',
        entityId: out.block.id,
        metadata: { room: out.block.room.number, from: out.block.from, to: out.block.to, reason: dto.reason, force: !!dto.force, displaced: out.displaced.map((d) => d.code) },
        ip,
      });
      return { ...out.block, displaced: out.displaced };
    });
  }

  updateBlock(user: AuthUser, id: string, dto: { to?: string; reason?: string; force?: boolean }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const b = await tx.roomBlock.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!b) throw AppException.notFound('Room block');
      const out = await this.blockTx(
        tx,
        user.tenantId,
        { roomId: b.roomId, from: b.startsAt.toISOString(), to: dto.to ?? b.endsAt.toISOString(), reason: dto.reason ?? b.reason, force: dto.force, blockId: b.id },
        { id: user.userId, name: user.fullName },
      );
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'room_block.updated', entityType: 'room_block', entityId: id, metadata: { to: out.block.to, reason: out.block.reason }, ip });
      return { ...out.block, displaced: out.displaced };
    });
  }

  /** Ends a block now: an out-of-order room becomes dirty with a cleaning task. */
  async releaseTx(tx: Tx, tenantId: string, id: string, by: { id: string | null; name: string }, now = new Date()) {
    const b = await tx.roomBlock.findFirst({ where: { id, tenantId }, include: { room: true } });
    if (!b) throw AppException.notFound('Room block');
    await tx.roomBlock.update({ where: { id }, data: { endsAt: b.endsAt > now ? (b.startsAt > now ? b.startsAt : now) : b.endsAt, releasedAt: now } });
    const stillBlocked = await tx.roomBlock.count({ where: { tenantId, roomId: b.roomId, id: { not: id }, startsAt: { lte: now }, endsAt: { gt: now } } });
    if (!stillBlocked && b.room.status === 'OUT_OF_ORDER') {
      await tx.room.update({ where: { id: b.roomId }, data: { status: 'VACANT_DIRTY' } });
      const features = (await this.entitlements.getEntitlements(tenantId, tx)).features;
      await this.housekeeping.createTaskSafe(tx, tenantId, features, { roomId: b.roomId, reason: 'MAINTENANCE', notes: `Back in service after: ${b.reason}` });
    }
    if (b.ticketId) await this.event(tx, tenantId, b.ticketId, 'BLOCK', by, { note: `Room ${b.room.number} back in service` });
  }

  releaseBlock(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      await this.releaseTx(tx, user.tenantId, id, { id: user.userId, name: user.fullName });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'room_block.released', entityType: 'room_block', entityId: id, metadata: {}, ip });
      return { success: true };
    });
  }

  /** Hourly: blocks that started take their room out of order; ended ones give it back. */
  async applyBlocks(tenantId: string): Promise<{ started: number; ended: number }> {
    return this.db.tenant(tenantId, async (tx) => {
      const now = new Date();
      const active = await tx.roomBlock.findMany({ where: { tenantId, startsAt: { lte: now }, endsAt: { gt: now } }, include: { room: true } });
      let started = 0;
      for (const b of active) {
        if (b.room.status === 'VACANT_CLEAN' || b.room.status === 'VACANT_DIRTY' || b.room.status === 'RESERVED') {
          await tx.room.update({ where: { id: b.roomId }, data: { status: 'OUT_OF_ORDER' } });
          started++;
        }
      }
      const ended = await tx.roomBlock.findMany({ where: { tenantId, endsAt: { lte: now, gt: new Date(now.getTime() - 7 * 86_400_000) }, releasedAt: null } });
      let back = 0;
      for (const b of ended) {
        if (active.some((a) => a.roomId === b.roomId)) continue;
        await this.releaseTx(tx, tenantId, b.id, { id: null, name: SYSTEM_ACTOR.name }, now);
        back++;
      }
      return { started, ended: back };
    });
  }

  // ---------------------------------------------------------------------------
  // Preventive schedules
  // ---------------------------------------------------------------------------

  private async scheduleView(tx: Tx, s: Prisma.MaintenanceScheduleGetPayload<object>) {
    const rooms = s.roomIds.length ? await tx.room.findMany({ where: { id: { in: s.roomIds } }, orderBy: [{ floor: 'asc' }, { number: 'asc' }] }) : [];
    const openTickets = await tx.maintenanceTicket.count({ where: { scheduleId: s.id, status: { in: OPEN } } });
    return {
      id: s.id,
      title: s.title,
      category: s.category,
      priority: s.priority,
      rooms: rooms.map((r) => ({ id: r.id, number: r.number, floor: r.floor, status: r.status })),
      area: s.area,
      everyDays: s.everyDays,
      nextDueAt: s.nextDueAt.toISOString(),
      lastRunAt: s.lastRunAt?.toISOString() ?? null,
      checklist: s.checklist,
      active: s.active,
      openTickets,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  listSchedules(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.maintenanceSchedule.findMany({ where: { tenantId: user.tenantId }, orderBy: [{ active: 'desc' }, { nextDueAt: 'asc' }] });
      const out = [];
      for (const r of rows) out.push(await this.scheduleView(tx, r));
      return out;
    });
  }

  scheduleCalendar(user: AuthUser, q: { from?: string; to?: string }) {
    const from = q.from && isIsoDate(q.from) ? q.from : lagosDate();
    const to = q.to && isIsoDate(q.to) ? q.to : addDays(from, 90);
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.maintenanceSchedule.findMany({ where: { tenantId: user.tenantId, active: true } });
      const days = new Map<string, { id: string; title: string; category: string; roomCount: number; area: string | null }[]>();
      const end = lagosStartOfDay(addDays(to, 1)).getTime();
      for (const s of rows) {
        let t = s.nextDueAt.getTime();
        let guard = 0;
        while (t < end && guard++ < 400) {
          const d = lagosDate(new Date(t));
          if (d >= from) days.set(d, [...(days.get(d) ?? []), { id: s.id, title: s.title, category: s.category, roomCount: s.roomIds.length, area: s.area }]);
          t += s.everyDays * 86_400_000;
        }
      }
      return dateRange(from, to).map((d) => ({ date: d, schedules: days.get(d) ?? [] }));
    });
  }

  private scheduleData(dto: { title?: string; category?: MaintenanceCategory; priority?: TaskPriority; roomIds?: string[]; area?: string | null; everyDays?: number; nextDueAt?: string; checklist?: string[]; active?: boolean }) {
    let next: Date | undefined;
    if (dto.nextDueAt) {
      next = isIsoDate(dto.nextDueAt) ? lagosStartOfDay(dto.nextDueAt) : new Date(dto.nextDueAt);
      if (Number.isNaN(next.getTime())) throw Err.validation('nextDueAt', 'nextDueAt must be a date or ISO timestamp');
    }
    return {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.category !== undefined && { category: dto.category }),
      ...(dto.priority !== undefined && { priority: dto.priority }),
      ...(dto.roomIds !== undefined && { roomIds: dto.roomIds }),
      ...(dto.area !== undefined && { area: dto.area }),
      ...(dto.everyDays !== undefined && { everyDays: dto.everyDays }),
      ...(next && { nextDueAt: next }),
      ...(dto.checklist !== undefined && { checklist: dto.checklist }),
      ...(dto.active !== undefined && { active: dto.active }),
    };
  }

  createSchedule(user: AuthUser, dto: { title: string; category: MaintenanceCategory; priority?: TaskPriority; roomIds?: string[]; area?: string; everyDays: number; nextDueAt: string; checklist?: string[]; active?: boolean }, ip?: string) {
    if (!dto.roomIds?.length && !dto.area?.trim()) throw Err.validation('roomIds', 'Give rooms or an area');
    return this.db.tenant(user.tenantId, async (tx) => {
      if (dto.roomIds?.length) {
        const found = await tx.room.count({ where: { tenantId: user.tenantId, id: { in: dto.roomIds } } });
        if (found !== new Set(dto.roomIds).size) throw Err.validation('roomIds', 'Unknown room');
      }
      const s = await tx.maintenanceSchedule.create({ data: { tenantId: user.tenantId, propertyId: (await primaryProperty(tx, user.tenantId)).id, ...(this.scheduleData(dto) as Required<Pick<Prisma.MaintenanceScheduleUncheckedCreateInput, 'title' | 'category' | 'everyDays' | 'nextDueAt'>>) } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'maintenance.schedule_created', entityType: 'maintenance_schedule', entityId: s.id, metadata: { title: s.title, everyDays: s.everyDays }, ip });
      return this.scheduleView(tx, s);
    });
  }

  updateSchedule(user: AuthUser, id: string, dto: { title?: string; category?: MaintenanceCategory; priority?: TaskPriority; roomIds?: string[]; area?: string | null; everyDays?: number; nextDueAt?: string; checklist?: string[]; active?: boolean }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const s = await tx.maintenanceSchedule.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!s) throw AppException.notFound('Schedule');
      const updated = await tx.maintenanceSchedule.update({ where: { id }, data: this.scheduleData(dto) });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'maintenance.schedule_updated', entityType: 'maintenance_schedule', entityId: id, metadata: { title: updated.title, changes: Object.keys(dto) }, ip });
      return this.scheduleView(tx, updated);
    });
  }

  deleteSchedule(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const s = await tx.maintenanceSchedule.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!s) throw AppException.notFound('Schedule');
      await tx.maintenanceSchedule.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'maintenance.schedule_deleted', entityType: 'maintenance_schedule', entityId: id, metadata: { title: s.title }, ip });
      return { success: true };
    });
  }

  /** Daily 06:00: tickets for schedules that are due, then move them to the next date. */
  async runSchedules(tenantId: string, now = new Date()): Promise<number> {
    return this.db.tenant(tenantId, async (tx) => {
      const ent = await this.entitlements.getEntitlements(tenantId, tx);
      if (!ent.features.includes('maintenance')) return 0;
      const due = await tx.maintenanceSchedule.findMany({ where: { tenantId, active: true, nextDueAt: { lte: now } } });
      let created = 0;
      for (const s of due) {
        const description = s.checklist.length ? s.checklist.map((c) => `- ${c}`).join('\n') : `Preventive maintenance every ${s.everyDays} days.`;
        const targets: (string | null)[] = s.roomIds.length ? s.roomIds : [null];
        for (const roomId of targets) {
          await this.createTx(
            tx,
            tenantId,
            { roomId: roomId ?? undefined, area: roomId ? undefined : (s.area ?? s.title), category: s.category, priority: s.priority, title: s.title, description, scheduleId: s.id },
            { id: null, name: 'Preventive schedule' },
          );
          created++;
        }
        await tx.maintenanceSchedule.update({ where: { id: s.id }, data: { lastRunAt: now, nextDueAt: nextDue(s.nextDueAt, s.everyDays, now) } });
      }
      if (created) await this.audit.record(tx, { tenantId, actor: { kind: 'system', name: 'Preventive schedule' }, action: 'maintenance.schedules_run', entityType: 'maintenance_schedule', metadata: { created } });
      return created;
    });
  }

  // ---------------------------------------------------------------------------
  // Diesel log
  // ---------------------------------------------------------------------------

  private fuelView(f: Prisma.FuelLogGetPayload<object>) {
    const cost = k(f.costKobo);
    return {
      id: f.id,
      date: fromDbDate(f.date),
      litres: Math.round(f.litres * 10) / 10,
      costKobo: cost,
      pricePerLitreKobo: f.litres > 0 ? Math.round(cost / f.litres) : 0,
      supplier: f.supplier,
      runHours: f.runHours,
      generator: f.generator,
      notes: f.notes,
      loggedBy: f.loggedById ? { id: f.loggedById, fullName: f.loggedByName ?? '' } : null,
      createdAt: f.createdAt.toISOString(),
    };
  }

  listFuel(user: AuthUser, q: { from?: string; to?: string; page?: number; pageSize?: number }) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const where: Prisma.FuelLogWhereInput = {
        tenantId: user.tenantId,
        ...((q.from || q.to) && { date: { ...(q.from && { gte: dbDate(q.from) }), ...(q.to && { lte: dbDate(q.to) }) } }),
      };
      const rows = await tx.fuelLog.findMany({ where, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], skip: pg.skip, take: pg.take });
      const total = await tx.fuelLog.count({ where });
      return { items: rows.map((r) => this.fuelView(r)), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  createFuel(user: AuthUser, dto: { date?: string; litres: number; costKobo: number; supplier: string; runHours?: number; generator?: string; notes?: string; clientCreatedAt?: string }, ip?: string) {
    const date = dto.date ?? lagosDate(parseClientCreatedAt(dto.clientCreatedAt) ?? new Date());
    if (!isIsoDate(date) || date > lagosDate()) throw Err.validation('date', 'date must be YYYY-MM-DD and not in the future');
    return this.db.tenant(user.tenantId, async (tx) => {
      const f = await tx.fuelLog.create({
        data: {
          tenantId: user.tenantId,
          propertyId: (await primaryProperty(tx, user.tenantId)).id,
          date: dbDate(date),
          litres: dto.litres,
          costKobo: BigInt(dto.costKobo),
          supplier: dto.supplier,
          runHours: dto.runHours ?? null,
          generator: dto.generator ?? null,
          notes: dto.notes ?? '',
          loggedById: user.userId,
          loggedByName: user.fullName,
        },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'fuel.logged', entityType: 'fuel_log', entityId: f.id, metadata: { date, litres: dto.litres, costKobo: dto.costKobo, supplier: dto.supplier }, ip });
      return this.fuelView(f);
    });
  }

  updateFuel(user: AuthUser, id: string, dto: { date?: string; litres?: number; costKobo?: number; supplier?: string; runHours?: number | null; generator?: string; notes?: string }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const f = await tx.fuelLog.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!f) throw AppException.notFound('Fuel log entry');
      if (dto.date && (!isIsoDate(dto.date) || dto.date > lagosDate())) throw Err.validation('date', 'date must be YYYY-MM-DD and not in the future');
      const updated = await tx.fuelLog.update({
        where: { id },
        data: {
          ...(dto.date !== undefined && { date: dbDate(dto.date) }),
          ...(dto.litres !== undefined && { litres: dto.litres }),
          ...(dto.costKobo !== undefined && { costKobo: BigInt(dto.costKobo) }),
          ...(dto.supplier !== undefined && { supplier: dto.supplier }),
          ...(dto.runHours !== undefined && { runHours: dto.runHours }),
          ...(dto.generator !== undefined && { generator: dto.generator }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
        },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'fuel.updated', entityType: 'fuel_log', entityId: id, metadata: { changes: Object.keys(dto) }, ip });
      return this.fuelView(updated);
    });
  }

  deleteFuel(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const f = await tx.fuelLog.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!f) throw AppException.notFound('Fuel log entry');
      await tx.fuelLog.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'fuel.deleted', entityType: 'fuel_log', entityId: id, metadata: { date: fromDbDate(f.date), litres: f.litres, costKobo: k(f.costKobo) }, ip });
      return { success: true };
    });
  }

  fuelSummary(user: AuthUser, q: { from?: string; to?: string }) {
    const today = lagosDate();
    const from = q.from && isIsoDate(q.from) ? q.from : `${today.slice(0, 7)}-01`;
    const to = q.to && isIsoDate(q.to) ? q.to : today;
    if (to < from) throw Err.validation('to', '"to" must not be before "from"');
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.fuelLog.findMany({ where: { tenantId: user.tenantId, date: { gte: dbDate(from), lte: dbDate(to) } } });
      const days = dateRange(from, to);
      const byDay = new Map(days.map((d) => [d, { litres: 0, costKobo: 0, runHours: null as number | null }]));
      let litres = 0;
      let cost = 0;
      let hours = 0;
      let hoursKnown = 0;
      for (const r of rows) {
        const d = byDay.get(fromDbDate(r.date));
        litres += r.litres;
        cost += k(r.costKobo);
        if (r.runHours !== null) {
          hours += r.runHours;
          hoursKnown += r.litres;
        }
        if (d) {
          d.litres += r.litres;
          d.costKobo += k(r.costKobo);
          if (r.runHours !== null) d.runHours = (d.runHours ?? 0) + r.runHours;
        }
      }
      const span = days.length;
      const prevTo = addDays(from, -1);
      const prevFrom = addDays(from, -span);
      const prev = await tx.fuelLog.aggregate({ where: { tenantId: user.tenantId, date: { gte: dbDate(prevFrom), lte: dbDate(prevTo) } }, _sum: { costKobo: true } });
      const sixAgo = `${addDays(`${today.slice(0, 7)}-01`, -160).slice(0, 7)}-01`;
      const recent = await tx.fuelLog.findMany({ where: { tenantId: user.tenantId, date: { gte: dbDate(sixAgo) } }, select: { date: true, litres: true, costKobo: true } });
      const months = new Map<string, { litres: number; costKobo: number }>();
      for (const r of recent) {
        const m = fromDbDate(r.date).slice(0, 7);
        const cur = months.get(m) ?? { litres: 0, costKobo: 0 };
        cur.litres += r.litres;
        cur.costKobo += k(r.costKobo);
        months.set(m, cur);
      }
      const round1 = (x: number) => Math.round(x * 10) / 10;
      return {
        from,
        to,
        litres: round1(litres),
        costKobo: cost,
        avgPricePerLitreKobo: litres > 0 ? Math.round(cost / litres) : 0,
        litresPerDay: round1(litres / span),
        costPerDayKobo: Math.round(cost / span),
        runHours: round1(hours),
        litresPerRunHour: hours > 0 ? round1(hoursKnown / hours) : null,
        deliveries: rows.length,
        days: days.map((d) => ({ date: d, litres: round1(byDay.get(d)!.litres), costKobo: byDay.get(d)!.costKobo, runHours: byDay.get(d)!.runHours })),
        byMonth: [...months.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-6).map(([month, v]) => ({ month, litres: round1(v.litres), costKobo: v.costKobo })),
        previousPeriodCostKobo: k(prev._sum.costKobo),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------------------

  reports(user: AuthUser, q: { from?: string; to?: string }) {
    const today = lagosDate();
    const from = q.from && isIsoDate(q.from) ? q.from : addDays(today, -29);
    const to = q.to && isIsoDate(q.to) ? q.to : today;
    const seeCost = this.canSeeCost(user);
    return this.db.tenant(user.tenantId, async (tx) => {
      const start = lagosStartOfDay(from);
      const end = lagosStartOfDay(addDays(to, 1));
      const now = new Date();
      const open = await tx.maintenanceTicket.findMany({ where: { tenantId: user.tenantId, status: { in: OPEN } }, include: ticketInclude });
      const inRange = await tx.maintenanceTicket.findMany({ where: { tenantId: user.tenantId, OR: [{ createdAt: { gte: start, lt: end } }, { resolvedAt: { gte: start, lt: end } }] }, include: ticketInclude });
      const ages: Record<string, number> = { '0-1d': 0, '1-3d': 0, '3-7d': 0, '7d+': 0 };
      for (const t of open) ages[ageBucket(t.createdAt, now)]++;
      const dueInRange = inRange.filter((t) => t.slaDueAt >= start && t.slaDueAt < end);
      const breached = [...new Map([...inRange, ...open].map((t) => [t.id, t])).values()].filter((t) => slaState(t, now).breached);
      const resolved = inRange.filter((t) => t.resolvedAt && t.resolvedAt >= start && t.resolvedAt < end);
      const mttr = resolved.length ? resolved.reduce((a, t) => a + (t.resolvedAt!.getTime() - t.createdAt.getTime()), 0) / resolved.length / 3_600_000 : null;
      const categories = new Map<string, { costKobo: number; tickets: number }>();
      const rooms = new Map<string, { room: { id: string; number: string; floor: number; status: string }; tickets: number; costKobo: number; last: Date }>();
      for (const t of inRange.filter((x) => x.createdAt >= start && x.createdAt < end)) {
        const c = categories.get(t.category) ?? { costKobo: 0, tickets: 0 };
        c.tickets++;
        c.costKobo += k(t.costKobo);
        categories.set(t.category, c);
        if (t.room) {
          const r = rooms.get(t.room.id) ?? { room: { id: t.room.id, number: t.room.number, floor: t.room.floor, status: t.room.status }, tickets: 0, costKobo: 0, last: t.createdAt };
          r.tickets++;
          r.costKobo += k(t.costKobo);
          if (t.createdAt > r.last) r.last = t.createdAt;
          rooms.set(t.room.id, r);
        }
      }
      const blocks = await tx.roomBlock.findMany({ where: { tenantId: user.tenantId, startsAt: { lt: end }, endsAt: { gt: start } } });
      const blockedNights = blocks.reduce((a, b) => a + Math.max(0, Math.ceil((Math.min(b.endsAt.getTime(), end.getTime()) - Math.max(b.startsAt.getTime(), start.getTime())) / 86_400_000)), 0);
      const fuel = await tx.fuelLog.aggregate({ where: { tenantId: user.tenantId, date: { gte: dbDate(from), lte: dbDate(to) } }, _sum: { litres: true, costKobo: true } });
      return {
        from,
        to,
        openByAge: Object.entries(ages).map(([bucket, count]) => ({ bucket, count })),
        open: open.length,
        overdue: open.filter((t) => t.slaDueAt < now).length,
        createdInRange: inRange.filter((t) => t.createdAt >= start && t.createdAt < end).length,
        resolvedInRange: resolved.length,
        slaBreaches: {
          count: breached.length,
          rate: dueInRange.length ? Math.round((dueInRange.filter((t) => slaState(t, now).breached).length / dueInRange.length) * 10_000) / 10_000 : 0,
          items: breached.slice(0, 20).map((t) => this.ticketView(t, user.tenantId, seeCost)),
        },
        meanTimeToResolveHours: mttr === null ? null : Math.round(mttr * 10) / 10,
        costByCategory: [...categories.entries()].map(([category, v]) => ({ category, costKobo: seeCost ? v.costKobo : null, tickets: v.tickets })).sort((a, b) => b.tickets - a.tickets),
        problemRooms: [...rooms.values()]
          .sort((a, b) => b.tickets - a.tickets || b.costKobo - a.costKobo)
          .slice(0, 10)
          .map((r) => ({ room: r.room, tickets: r.tickets, costKobo: seeCost ? r.costKobo : null, lastTicketAt: r.last.toISOString() })),
        blockedRoomNights: blockedNights,
        fuel: { litres: Math.round((fuel._sum.litres ?? 0) * 10) / 10, costKobo: seeCost ? k(fuel._sum.costKobo) : null },
      };
    });
  }
}
