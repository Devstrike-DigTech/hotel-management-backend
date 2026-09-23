import { Inject, Injectable, Logger } from '@nestjs/common';
import type { HousekeepingTask, Prisma, Room, RoomType } from '../../generated/prisma/client.js';
import type { HousekeepingTaskReason, HousekeepingTaskStatus, HousekeepingTaskType, TaskPriority } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { can, forbidden } from '../../common/permissions/can.js';
import { permissionsFor } from '../../common/permissions/catalogue.js';
import { addDays, dbDate, fromDbDate, isIsoDate, lagosDate, lagosStartOfDay } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { GuestsService, type UploadedFileLike } from '../guests/guests.service.js';
import { Err, paginate, parseClientCreatedAt, primaryProperty } from '../ops/ops.helpers.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/object-storage.js';
import { photosOf, storePhoto } from '../storage/photos.js';
import {
  autoBalance,
  checklistItems,
  DEFAULT_CHECKLISTS,
  effectivePriority,
  PRIORITY_ORDER,
  TASK_MINUTES,
  type Priority,
  type TaskType,
} from './housekeeping.logic.js';

type TaskRow = HousekeepingTask & {
  room: Room & { roomType: Pick<RoomType, 'id' | 'name'> };
  reservation: { code: string } | null;
  tickets?: { id: string }[];
};

const taskInclude = {
  room: { include: { roomType: { select: { id: true, name: true } } } },
  reservation: { select: { code: true } },
  tickets: { select: { id: true } },
} satisfies Prisma.HousekeepingTaskInclude;

export const OPEN_STATUSES: HousekeepingTaskStatus[] = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REJECTED'];
const DEFAULT_LIST: HousekeepingTaskStatus[] = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'DONE', 'REJECTED'];
const ALL: HousekeepingTaskStatus[] = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'DONE', 'INSPECTED', 'REJECTED', 'SKIPPED'];
const TURN_TYPES: HousekeepingTaskType[] = ['CHECKOUT_CLEAN', 'DEEP_CLEAN', 'INSPECTION', 'CUSTOM'];

export interface ChecklistEntry {
  id: string;
  label: string;
  done: boolean;
}

export interface ArrivalInfo {
  reservationId: string;
  code: string;
  guestName: string;
  arrivalAt: string;
}

function legacyReason(r: HousekeepingTaskReason): 'CHECKOUT' | 'ROOM_MOVE' | 'MANUAL' {
  return r === 'ROOM_MOVE' || r === 'MANUAL' ? r : 'CHECKOUT';
}

/**
 * Housekeeping: cleaning tasks with checklists, assignment and auto-balance,
 * the housekeeper's own list, inspection by a supervisor, stayover
 * generation, deep cleans every N stays, checklist templates and lost &
 * found. Room status follows the task: DONE turns a dirty room clean, or
 * waits for INSPECTED when the hotel requires inspection.
 */
@Injectable()
export class HousekeepingService {
  private readonly logger = new Logger(HousekeepingService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly guests: GuestsService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private async arrivalsToday(tx: Tx, tenantId: string, roomIds?: string[]): Promise<Map<string, ArrivalInfo>> {
    const today = lagosDate();
    const rows = await tx.reservation.findMany({
      where: {
        tenantId,
        roomId: roomIds ? { in: roomIds } : { not: null },
        status: { in: ['PENDING', 'CONFIRMED'] },
        arrivalAt: { gte: lagosStartOfDay(today), lt: lagosStartOfDay(addDays(today, 1)) },
      },
      select: { id: true, code: true, roomId: true, arrivalAt: true, guest: { select: { fullName: true } } },
      orderBy: { arrivalAt: 'asc' },
    });
    const out = new Map<string, ArrivalInfo>();
    for (const r of rows) if (r.roomId && !out.has(r.roomId)) out.set(r.roomId, { reservationId: r.id, code: r.code, guestName: r.guest.fullName, arrivalAt: r.arrivalAt.toISOString() });
    return out;
  }

  view(t: TaskRow, tenantId: string, arrivals: Map<string, ArrivalInfo>) {
    const checklist = (Array.isArray(t.checklist) ? t.checklist : []) as unknown as ChecklistEntry[];
    const arrival = arrivals.get(t.roomId) ?? null;
    const clean = t.room.status === 'VACANT_CLEAN' || t.room.status === 'RESERVED';
    const open = OPEN_STATUSES.includes(t.status);
    return {
      id: t.id,
      room: { id: t.room.id, number: t.room.number, floor: t.room.floor, status: t.room.status, roomType: { id: t.room.roomType.id, name: t.room.roomType.name } },
      type: t.type,
      priority: open ? effectivePriority(t.priority as Priority, t.type as TaskType, !!arrival, clean) : t.priority,
      basePriority: t.priority,
      status: t.status,
      source: t.reason,
      reason: legacyReason(t.reason),
      assignee: t.assigneeId ? { id: t.assigneeId, fullName: t.assigneeName ?? '' } : null,
      dueAt: t.dueAt?.toISOString() ?? null,
      startedAt: t.startedAt?.toISOString() ?? null,
      doneAt: t.completedAt?.toISOString() ?? null,
      inspectedAt: t.inspectedAt?.toISOString() ?? null,
      inspectedBy: t.inspectedById ? { id: t.inspectedById, fullName: t.inspectedByName ?? '' } : null,
      inspectionNote: t.inspectionNote,
      checklist,
      checklistDone: checklist.filter((c) => c.done).length,
      checklistTotal: checklist.length,
      notes: t.notes,
      photos: photosOf(t.photos).map((p) => ({ key: p.key, url: this.guests.fileUrl(tenantId, p.key), uploadedAt: p.uploadedAt })),
      estimatedMinutes: TASK_MINUTES[t.type as TaskType],
      arrivalToday: open ? arrival : null,
      reservationCode: t.reservation?.code ?? null,
      skippedReason: t.skippedReason,
      maintenanceTicketIds: (t.tickets ?? []).map((x) => x.id),
      businessDate: fromDbDate(t.businessDate),
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      completedAt: t.completedAt?.toISOString() ?? null,
      completedBy: t.completedById ? { id: t.completedById, fullName: t.completedByName ?? '' } : null,
    };
  }

  private async views(tx: Tx, tenantId: string, rows: TaskRow[]) {
    const arrivals = await this.arrivalsToday(tx, tenantId, [...new Set(rows.map((r) => r.roomId))]);
    return rows
      .map((r) => this.view(r, tenantId, arrivals))
      .sort((a, b) => PRIORITY_ORDER[a.priority as Priority] - PRIORITY_ORDER[b.priority as Priority] || a.room.floor - b.room.floor || a.room.number.localeCompare(b.room.number, 'en', { numeric: true }));
  }

  private async loadTask(tx: Tx, tenantId: string, id: string): Promise<TaskRow> {
    const t = await tx.housekeepingTask.findFirst({ where: { id, tenantId }, include: taskInclude });
    if (!t) throw AppException.notFound('Task');
    return t;
  }

  private async one(tx: Tx, tenantId: string, id: string) {
    const t = await this.loadTask(tx, tenantId, id);
    return this.view(t, tenantId, await this.arrivalsToday(tx, tenantId, [t.roomId]));
  }

  // ---------------------------------------------------------------------------
  // Checklists
  // ---------------------------------------------------------------------------

  private async checklistFor(tx: Tx, tenantId: string, roomTypeId: string, type: HousekeepingTaskType): Promise<ChecklistEntry[]> {
    const rows = await tx.housekeepingChecklist.findMany({ where: { tenantId, taskType: type, OR: [{ roomTypeId }, { roomTypeId: null }] } });
    const pick = rows.find((r) => r.roomTypeId === roomTypeId) ?? rows.find((r) => r.roomTypeId === null);
    // A damaged template (not a list of { id, label }) falls back to the built-in list.
    const stored = pick && Array.isArray(pick.items) ? (pick.items as unknown[]).filter((i): i is { id: string; label: string } => !!i && typeof i === 'object' && typeof (i as { id?: unknown }).id === 'string' && typeof (i as { label?: unknown }).label === 'string') : [];
    const items = stored.length ? stored : checklistItems(DEFAULT_CHECKLISTS[type as TaskType] ?? DEFAULT_CHECKLISTS.CUSTOM);
    return items.map((i) => ({ id: i.id, label: i.label, done: false }));
  }

  listChecklists(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.housekeepingChecklist.findMany({ where: { tenantId: user.tenantId } });
      const types = await tx.roomType.findMany({ where: { tenantId: user.tenantId }, select: { id: true, name: true } });
      const names = new Map(types.map((t) => [t.id, t.name]));
      const custom = rows.map((r) => ({
        id: r.id,
        roomTypeId: r.roomTypeId,
        roomTypeName: r.roomTypeId ? (names.get(r.roomTypeId) ?? null) : null,
        taskType: r.taskType,
        items: (Array.isArray(r.items) ? r.items : []) as { id: string; label: string }[],
        isDefault: false,
        updatedAt: r.updatedAt.toISOString(),
      }));
      const defaults = (Object.keys(DEFAULT_CHECKLISTS) as TaskType[])
        .filter((t) => !rows.some((r) => r.roomTypeId === null && r.taskType === t))
        .map((t) => ({ id: null, roomTypeId: null, roomTypeName: null, taskType: t, items: checklistItems(DEFAULT_CHECKLISTS[t]), isDefault: true, updatedAt: null }));
      return [...custom, ...defaults];
    });
  }

  putChecklist(user: AuthUser, dto: { roomTypeId: string | null; taskType: HousekeepingTaskType; items: { id?: string; label: string }[] }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      if (dto.roomTypeId && !(await tx.roomType.findFirst({ where: { id: dto.roomTypeId, tenantId: user.tenantId } }))) throw AppException.notFound('Room type');
      const used = new Set<string>();
      const items = dto.items.map((it, i) => {
        let id = it.id && /^[a-z0-9_-]{1,20}$/i.test(it.id) ? it.id : `i${i + 1}`;
        while (used.has(id)) id = `${id}x`;
        used.add(id);
        return { id, label: it.label.trim() };
      });
      const existing = await tx.housekeepingChecklist.findFirst({ where: { tenantId: user.tenantId, roomTypeId: dto.roomTypeId, taskType: dto.taskType } });
      const row = existing
        ? await tx.housekeepingChecklist.update({ where: { id: existing.id }, data: { items } })
        : await tx.housekeepingChecklist.create({ data: { tenantId: user.tenantId, propertyId: (await primaryProperty(tx, user.tenantId)).id, roomTypeId: dto.roomTypeId, taskType: dto.taskType, items } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'housekeeping.checklist_saved', entityType: 'housekeeping_checklist', entityId: row.id, metadata: { taskType: dto.taskType, roomTypeId: dto.roomTypeId, items: items.length }, ip });
      const rt = dto.roomTypeId ? await tx.roomType.findFirst({ where: { id: dto.roomTypeId }, select: { name: true } }) : null;
      return { id: row.id, roomTypeId: row.roomTypeId, roomTypeName: rt?.name ?? null, taskType: row.taskType, items, isDefault: false, updatedAt: row.updatedAt.toISOString() };
    });
  }

  deleteChecklist(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const row = await tx.housekeepingChecklist.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!row) throw AppException.notFound('Checklist');
      await tx.housekeepingChecklist.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'housekeeping.checklist_deleted', entityType: 'housekeeping_checklist', entityId: id, metadata: { taskType: row.taskType }, ip });
      return { success: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Creation (automatic and manual)
  // ---------------------------------------------------------------------------

  /**
   * Creates a cleaning task when the tenant has the housekeeping feature.
   * Check-outs count towards the room type's deep-clean interval; the task is
   * URGENT when the room has an arrival today. One open room-turning task per
   * room.
   */
  async createTask(
    tx: Tx,
    tenantId: string,
    features: readonly string[],
    input: { roomId: string; reason: HousekeepingTaskReason; reservationId?: string | null; notes?: string; type?: HousekeepingTaskType; priority?: TaskPriority },
  ): Promise<HousekeepingTask | null> {
    if (!features.includes('housekeeping')) return null;
    const room = await tx.room.findFirst({ where: { id: input.roomId, tenantId }, include: { roomType: true } });
    if (!room) return null;
    let type: HousekeepingTaskType = input.type ?? 'CHECKOUT_CLEAN';
    let reason = input.reason;
    if (TURN_TYPES.includes(type)) {
      const open = await tx.housekeepingTask.findFirst({ where: { tenantId, roomId: input.roomId, status: { in: OPEN_STATUSES }, type: { in: TURN_TYPES } } });
      if (open) return null;
    }
    if (input.reason === 'CHECKOUT') {
      const every = room.roomType.deepCleanEveryStays;
      const count = room.staysSinceDeepClean + 1;
      if (every && count >= every) {
        type = 'DEEP_CLEAN';
        reason = 'DEEP_CLEAN_RULE';
        await tx.room.update({ where: { id: room.id }, data: { staysSinceDeepClean: 0 } });
      } else {
        await tx.room.update({ where: { id: room.id }, data: { staysSinceDeepClean: count } });
      }
    }
    const arrival = (await this.arrivalsToday(tx, tenantId, [room.id])).get(room.id);
    return tx.housekeepingTask.create({
      data: {
        tenantId,
        propertyId: room.propertyId,
        roomId: room.id,
        reason,
        type,
        priority: input.priority ?? (arrival && type !== 'STAYOVER' ? 'URGENT' : 'NORMAL'),
        reservationId: input.reservationId ?? null,
        notes: input.notes ?? '',
        businessDate: dbDate(lagosDate()),
        checklist: (await this.checklistFor(tx, tenantId, room.roomTypeId, type)) as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * createTask for side effects of other actions (check-out, room move, block
   * release): runs under a savepoint so a housekeeping problem is logged and
   * never fails the check-out itself.
   */
  async createTaskSafe(
    tx: Tx,
    tenantId: string,
    features: readonly string[],
    input: Parameters<HousekeepingService['createTask']>[3],
  ): Promise<HousekeepingTask | null> {
    if (!features.includes('housekeeping')) return null;
    await tx.$executeRawUnsafe('SAVEPOINT housekeeping_task');
    try {
      const t = await this.createTask(tx, tenantId, features, input);
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT housekeeping_task');
      return t;
    } catch (e) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT housekeeping_task');
      this.logger.error(`Housekeeping task for room ${input.roomId} (${input.reason}) not created: ${(e as Error).message}`);
      return null;
    }
  }

  create(user: AuthUser, dto: { roomId: string; type: HousekeepingTaskType; priority?: TaskPriority; assigneeId?: string; dueAt?: string; notes?: string }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const room = await tx.room.findFirst({ where: { id: dto.roomId, tenantId: user.tenantId } });
      if (!room) throw AppException.notFound('Room');
      const assignee = dto.assigneeId ? await this.assignee(tx, user.tenantId, dto.assigneeId) : null;
      const t = await tx.housekeepingTask.create({
        data: {
          tenantId: user.tenantId,
          propertyId: room.propertyId,
          roomId: room.id,
          reason: 'MANUAL',
          type: dto.type,
          priority: dto.priority ?? 'NORMAL',
          status: assignee ? 'ASSIGNED' : 'OPEN',
          assigneeId: assignee?.id ?? null,
          assigneeName: assignee?.fullName ?? null,
          dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
          notes: dto.notes ?? '',
          businessDate: dbDate(lagosDate()),
          checklist: (await this.checklistFor(tx, user.tenantId, room.roomTypeId, dto.type)) as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'housekeeping.task_created', entityType: 'housekeeping_task', entityId: t.id, metadata: { room: room.number, type: dto.type, assignee: assignee?.fullName ?? null }, ip });
      return this.one(tx, user.tenantId, t.id);
    });
  }

  /** Daily 07:00: a STAYOVER task for every in-house room not departing today (idempotent). */
  async runStayover(tenantId: string, actorName = 'Stayover job'): Promise<number> {
    return this.db.tenant(tenantId, async (tx) => {
      const ent = await this.entitlements.getEntitlements(tenantId, tx);
      if (!ent.features.includes('housekeeping')) return 0;
      const property = await primaryProperty(tx, tenantId);
      if (!property.stayoverEnabled) return 0;
      const today = lagosDate();
      const inHouse = await tx.reservation.findMany({
        where: { tenantId, status: 'CHECKED_IN', stayType: 'NIGHTLY', roomId: { not: null }, departureAt: { gte: lagosStartOfDay(addDays(today, 1)) } },
        select: { id: true, roomId: true, room: { select: { roomTypeId: true } } },
      });
      let created = 0;
      for (const r of inHouse) {
        const exists = await tx.housekeepingTask.findFirst({ where: { tenantId, roomId: r.roomId!, type: 'STAYOVER', businessDate: dbDate(today) } });
        if (exists) continue;
        await tx.housekeepingTask.create({
          data: {
            tenantId,
            propertyId: property.id,
            roomId: r.roomId!,
            reservationId: r.id,
            reason: 'STAYOVER_JOB',
            type: 'STAYOVER',
            priority: 'NORMAL',
            businessDate: dbDate(today),
            checklist: (await this.checklistFor(tx, tenantId, r.room!.roomTypeId, 'STAYOVER')) as unknown as Prisma.InputJsonValue,
          },
        });
        created++;
      }
      if (created) {
        await this.audit.record(tx, { tenantId, actor: { kind: 'system', name: actorName }, action: 'housekeeping.stayovers_created', entityType: 'housekeeping_task', metadata: { date: today, created } });
      }
      return created;
    });
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  list(user: AuthUser, q: { status?: string; type?: string; assigneeId?: string; floor?: number; date?: string; roomId?: string }) {
    const statuses = (q.status ? q.status.split(',') : DEFAULT_LIST)
      .map((x) => (x === 'PENDING' ? 'OPEN' : x))
      .filter((x): x is HousekeepingTaskStatus => (ALL as string[]).includes(x));
    const types = q.type?.split(',').filter((x) => x in TASK_MINUTES) as HousekeepingTaskType[] | undefined;
    return this.db.tenant(user.tenantId, async (tx) => {
      // Default list: DONE tasks only while they still wait for inspection.
      let statusWhere: Prisma.HousekeepingTaskWhereInput = { status: { in: statuses } };
      if (!q.status) {
        const property = await primaryProperty(tx, user.tenantId);
        const active = statuses.filter((x) => x !== 'DONE');
        statusWhere = property.requireInspection
          ? { OR: [{ status: { in: active } }, { status: 'DONE', inspectedAt: null, type: { in: TURN_TYPES } }] }
          : { status: { in: active } };
      }
      const where: Prisma.HousekeepingTaskWhereInput = {
        tenantId: user.tenantId,
        ...statusWhere,
        ...(types?.length && { type: { in: types } }),
        ...(q.assigneeId && { assigneeId: q.assigneeId }),
        ...(q.floor !== undefined && { room: { floor: q.floor } }),
        ...(q.roomId && { roomId: q.roomId }),
        ...(q.date && isIsoDate(q.date) && { businessDate: dbDate(q.date) }),
      };
      const rows = await tx.housekeepingTask.findMany({ where, include: taskInclude, orderBy: { createdAt: 'desc' }, take: 300 });
      return this.views(tx, user.tenantId, rows);
    });
  }

  get(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, (tx) => this.one(tx, user.tenantId, id));
  }

  myTasks(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const today = lagosDate();
      const rows = await tx.housekeepingTask.findMany({
        where: {
          tenantId: user.tenantId,
          assigneeId: user.userId,
          OR: [{ status: { in: OPEN_STATUSES } }, { status: { in: ['DONE', 'INSPECTED', 'SKIPPED'] }, updatedAt: { gte: lagosStartOfDay(today) } }],
        },
        include: taskInclude,
      });
      const tasks = await this.views(tx, user.tenantId, rows);
      const open = tasks.filter((t) => OPEN_STATUSES.includes(t.status));
      return {
        date: today,
        tasks: [...open, ...tasks.filter((t) => !OPEN_STATUSES.includes(t.status))],
        summary: { total: tasks.length, done: tasks.length - open.length, minutesLeft: open.reduce((a, t) => a + t.estimatedMinutes, 0) },
      };
    });
  }

  inspections(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.housekeepingTask.findMany({ where: { tenantId: user.tenantId, status: 'DONE', inspectedAt: null, type: { in: TURN_TYPES } }, include: taskInclude, orderBy: { completedAt: 'asc' } });
      const property = await primaryProperty(tx, user.tenantId);
      const views = await this.views(tx, user.tenantId, rows);
      // Without mandatory inspection only rooms still dirty wait for a supervisor.
      return property.requireInspection ? views : views.filter((v) => v.room.status === 'VACANT_DIRTY');
    });
  }

  /** Active staff who clean rooms (HOUSEKEEPING, SUPERVISOR or a custom cleaning role). */
  private async housekeepers(tx: Tx, tenantId: string, forBalance: boolean) {
    const users = await tx.user.findMany({
      where: { tenantId, isActive: true, role: { in: forBalance ? ['HOUSEKEEPING', 'CUSTOM'] : ['HOUSEKEEPING', 'SUPERVISOR', 'CUSTOM'] } },
      select: { id: true, fullName: true, role: true, customRole: { select: { name: true, permissions: true } } },
      orderBy: { fullName: 'asc' },
    });
    return users.filter((u) => {
      if (u.role !== 'CUSTOM') return true;
      const perms = permissionsFor('CUSTOM', u.customRole?.permissions);
      return perms.has('housekeeping.work') && !perms.has('frontdesk.checkin');
    });
  }

  board(user: AuthUser, date?: string) {
    const day = date && isIsoDate(date) ? date : lagosDate();
    return this.db.tenant(user.tenantId, async (tx) => {
      const property = await primaryProperty(tx, user.tenantId);
      const rows = await tx.housekeepingTask.findMany({
        where: {
          tenantId: user.tenantId,
          OR: [{ businessDate: dbDate(day) }, { status: { in: OPEN_STATUSES }, businessDate: { lt: dbDate(day) } }, { status: 'DONE', inspectedAt: null }],
        },
        include: taskInclude,
      });
      const tasks = await this.views(tx, user.tenantId, rows);
      const staff = await this.housekeepers(tx, user.tenantId, false);
      const counts = Object.fromEntries(ALL.map((s) => [s, 0])) as Record<HousekeepingTaskStatus, number>;
      for (const t of tasks) counts[t.status]++;
      const rooms = await tx.room.findMany({ where: { tenantId: user.tenantId }, orderBy: [{ floor: 'asc' }, { number: 'asc' }] });
      const arrivals = await this.arrivalsToday(tx, user.tenantId);
      const inHouse = new Set(
        (await tx.reservation.findMany({ where: { tenantId: user.tenantId, status: 'CHECKED_IN', roomId: { not: null } }, select: { roomId: true } })).map((r) => r.roomId),
      );
      return {
        date: day,
        requireInspection: property.requireInspection,
        tasks,
        housekeepers: staff.map((s) => {
          const mine = tasks.filter((t) => t.assignee?.id === s.id);
          const open = mine.filter((t) => OPEN_STATUSES.includes(t.status));
          return {
            user: { id: s.id, fullName: s.fullName },
            role: s.role === 'CUSTOM' ? (s.customRole?.name ?? 'Custom') : s.role,
            minutes: open.reduce((a, t) => a + t.estimatedMinutes, 0),
            done: mine.length - open.length,
            total: mine.length,
          };
        }),
        counts,
        inspectionQueue: tasks.filter((t) => t.status === 'DONE' && !t.inspectedAt && TURN_TYPES.includes(t.type) && (property.requireInspection || t.room.status === 'VACANT_DIRTY')).length,
        rooms: rooms.map((r) => ({
          id: r.id,
          number: r.number,
          floor: r.floor,
          status: r.status,
          arrivalToday: arrivals.has(r.id),
          inHouse: inHouse.has(r.id),
          openTask: tasks.find((t) => t.room.id === r.id && OPEN_STATUSES.includes(t.status))?.id ?? null,
        })),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Assignment
  // ---------------------------------------------------------------------------

  private async assignee(tx: Tx, tenantId: string, id: string) {
    const u = await tx.user.findFirst({ where: { id, tenantId, isActive: true }, select: { id: true, fullName: true, role: true, customRole: { select: { permissions: true } } } });
    if (!u) throw Err.validation('assigneeId', 'Unknown or inactive staff member');
    if (!permissionsFor(u.role, u.customRole?.permissions).has('housekeeping.work')) throw Err.validation('assigneeId', `${u.fullName} does not do housekeeping`);
    return u;
  }

  assign(user: AuthUser, dto: { assigneeId: string | null; taskIds?: string[]; floor?: number }, ip?: string) {
    if (!dto.taskIds?.length && dto.floor === undefined) throw Err.validation('taskIds', 'Give taskIds or a floor');
    return this.db.tenant(user.tenantId, async (tx) => {
      const who = dto.assigneeId ? await this.assignee(tx, user.tenantId, dto.assigneeId) : null;
      const where: Prisma.HousekeepingTaskWhereInput = {
        tenantId: user.tenantId,
        status: { in: ['OPEN', 'ASSIGNED', 'REJECTED'] },
        ...(dto.taskIds?.length ? { id: { in: dto.taskIds } } : { room: { floor: dto.floor } }),
      };
      const rows = await tx.housekeepingTask.findMany({ where, select: { id: true, status: true } });
      for (const r of rows) {
        await tx.housekeepingTask.update({
          where: { id: r.id },
          data: { assigneeId: who?.id ?? null, assigneeName: who?.fullName ?? null, ...(r.status !== 'REJECTED' && { status: who ? 'ASSIGNED' : 'OPEN' }) },
        });
      }
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'housekeeping.assigned', entityType: 'housekeeping_task', metadata: { assignee: who?.fullName ?? null, tasks: rows.length, floor: dto.floor ?? null }, ip });
      const updated = await tx.housekeepingTask.findMany({ where: { id: { in: rows.map((r) => r.id) } }, include: taskInclude });
      return { updated: rows.length, tasks: await this.views(tx, user.tenantId, updated) };
    });
  }

  suggest(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const staff = await this.housekeepers(tx, user.tenantId, true);
      const rows = await tx.housekeepingTask.findMany({ where: { tenantId: user.tenantId, status: { in: OPEN_STATUSES } }, include: taskInclude });
      const tasks = await this.views(tx, user.tenantId, rows);
      const ids = staff.map((s) => s.id);
      const plan = autoBalance(
        tasks.map((t) => ({
          id: t.id,
          floor: t.room.floor,
          roomNumber: t.room.number,
          minutes: t.estimatedMinutes,
          priority: t.priority as Priority,
          lockedTo: t.status === 'IN_PROGRESS' && t.assignee && ids.includes(t.assignee.id) ? t.assignee.id : null,
        })),
        ids,
      );
      const current = new Map<string, number>();
      for (const t of tasks) if (t.assignee) current.set(t.assignee.id, (current.get(t.assignee.id) ?? 0) + t.estimatedMinutes);
      return {
        date: lagosDate(),
        housekeepers: staff.map((s) => ({
          user: { id: s.id, fullName: s.fullName },
          role: s.role === 'CUSTOM' ? (s.customRole?.name ?? 'Custom') : s.role,
          assignedMinutes: current.get(s.id) ?? 0,
          proposedMinutes: plan.load.get(s.id) ?? 0,
          taskCount: [...plan.assignments.values()].filter((x) => x === s.id).length,
        })),
        proposal: tasks
          .filter((t) => plan.assignments.has(t.id))
          .map((t) => ({ taskId: t.id, roomNumber: t.room.number, floor: t.room.floor, type: t.type, minutes: t.estimatedMinutes, assigneeId: plan.assignments.get(t.id)!, currentAssigneeId: t.assignee?.id ?? null })),
        totalMinutes: tasks.reduce((a, t) => a + t.estimatedMinutes, 0),
        targetMinutesEach: plan.target,
      };
    });
  }

  applyAssignments(user: AuthUser, dto: { assignments: { taskId: string; assigneeId: string }[] }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const people = new Map<string, { id: string; fullName: string }>();
      let updated = 0;
      for (const a of dto.assignments) {
        if (!people.has(a.assigneeId)) people.set(a.assigneeId, await this.assignee(tx, user.tenantId, a.assigneeId));
        const who = people.get(a.assigneeId)!;
        const t = await tx.housekeepingTask.findFirst({ where: { id: a.taskId, tenantId: user.tenantId, status: { in: ['OPEN', 'ASSIGNED', 'REJECTED'] } } });
        if (!t) continue;
        await tx.housekeepingTask.update({ where: { id: t.id }, data: { assigneeId: who.id, assigneeName: who.fullName, ...(t.status !== 'REJECTED' && { status: 'ASSIGNED' }) } });
        updated++;
      }
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'housekeeping.balanced', entityType: 'housekeeping_task', metadata: { updated, housekeepers: [...people.values()].map((p) => p.fullName) }, ip });
      return { updated };
    });
  }

  // ---------------------------------------------------------------------------
  // Work
  // ---------------------------------------------------------------------------

  private async record(tx: Tx, user: AuthUser, t: TaskRow, action: string, metadata: Record<string, unknown>, ip?: string, clientCreatedAt?: Date | null) {
    await this.audit.record(tx, {
      tenantId: user.tenantId,
      actor: userActor(user),
      action,
      entityType: 'housekeeping_task',
      entityId: t.id,
      metadata: { room: t.room.number, type: t.type, ...metadata, ...(clientCreatedAt && { clientCreatedAt: clientCreatedAt.toISOString() }) },
      ip,
    });
  }

  private assertState(t: TaskRow, allowed: HousekeepingTaskStatus[]) {
    if (!allowed.includes(t.status)) throw Err.invalidState(t.status, allowed, 'This task');
  }

  start(user: AuthUser, id: string, dto: { clientCreatedAt?: string }, ip?: string) {
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    return this.db.tenant(user.tenantId, async (tx) => {
      const t = await this.loadTask(tx, user.tenantId, id);
      if (t.status === 'IN_PROGRESS') return this.one(tx, user.tenantId, id);
      this.assertState(t, ['OPEN', 'ASSIGNED', 'REJECTED']);
      await tx.housekeepingTask.update({
        where: { id },
        data: { status: 'IN_PROGRESS', startedAt: clientCreatedAt ?? new Date(), assigneeId: t.assigneeId ?? user.userId, assigneeName: t.assigneeName ?? user.fullName, clientCreatedAt },
      });
      await this.record(tx, user, t, 'housekeeping.task_started', { from: t.status }, ip, clientCreatedAt);
      return this.one(tx, user.tenantId, id);
    });
  }

  private mergeChecklist(current: unknown, ticks: { id: string; done: boolean }[] | undefined): ChecklistEntry[] {
    const list = (Array.isArray(current) ? current : []) as ChecklistEntry[];
    if (!ticks) return list;
    const m = new Map(ticks.map((x) => [x.id, x.done]));
    return list.map((c) => (m.has(c.id) ? { ...c, done: m.get(c.id)! } : c));
  }

  checklist(user: AuthUser, id: string, dto: { items: { id: string; done: boolean }[]; clientCreatedAt?: string }) {
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    return this.db.tenant(user.tenantId, async (tx) => {
      const t = await this.loadTask(tx, user.tenantId, id);
      this.assertState(t, ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REJECTED']);
      const list = this.mergeChecklist(t.checklist, dto.items);
      await tx.housekeepingTask.update({
        where: { id },
        data: {
          checklist: list as unknown as Prisma.InputJsonValue,
          ...(t.status !== 'IN_PROGRESS' && {
            status: 'IN_PROGRESS',
            startedAt: t.startedAt ?? clientCreatedAt ?? new Date(),
            assigneeId: t.assigneeId ?? user.userId,
            assigneeName: t.assigneeName ?? user.fullName,
          }),
        },
      });
      return this.one(tx, user.tenantId, id);
    });
  }

  finish(user: AuthUser, id: string, dto: { notes?: string; checklist?: { id: string; done: boolean }[]; clientCreatedAt?: string }, ip?: string) {
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    return this.db.tenant(user.tenantId, async (tx) => {
      const t = await this.loadTask(tx, user.tenantId, id);
      if (t.status === 'DONE' || t.status === 'INSPECTED') return this.one(tx, user.tenantId, id);
      this.assertState(t, ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REJECTED']);
      const property = await primaryProperty(tx, user.tenantId);
      const at = clientCreatedAt ?? new Date();
      await tx.housekeepingTask.update({
        where: { id },
        data: {
          status: 'DONE',
          completedAt: at,
          completedById: user.userId,
          completedByName: user.fullName,
          startedAt: t.startedAt ?? at,
          assigneeId: t.assigneeId ?? user.userId,
          assigneeName: t.assigneeName ?? user.fullName,
          checklist: this.mergeChecklist(t.checklist, dto.checklist) as unknown as Prisma.InputJsonValue,
          ...(dto.notes !== undefined && { notes: dto.notes }),
          clientCreatedAt,
        },
      });
      let roomTo: string | null = null;
      if (TURN_TYPES.includes(t.type) && t.room.status === 'VACANT_DIRTY' && !property.requireInspection) {
        await tx.room.update({ where: { id: t.roomId }, data: { status: 'VACANT_CLEAN' } });
        roomTo = 'VACANT_CLEAN';
      }
      await this.record(
        tx,
        user,
        t,
        'housekeeping.task_done',
        { from: t.status, roomStatus: roomTo ?? t.room.status, awaitingInspection: property.requireInspection && TURN_TYPES.includes(t.type) },
        ip,
        clientCreatedAt,
      );
      return this.one(tx, user.tenantId, id);
    });
  }

  skip(user: AuthUser, id: string, dto: { reason: string; clientCreatedAt?: string }, ip?: string) {
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    return this.db.tenant(user.tenantId, async (tx) => {
      const t = await this.loadTask(tx, user.tenantId, id);
      this.assertState(t, ['OPEN', 'ASSIGNED', 'REJECTED']);
      await tx.housekeepingTask.update({
        where: { id },
        data: { status: 'SKIPPED', skippedReason: dto.reason, completedAt: clientCreatedAt ?? new Date(), completedById: user.userId, completedByName: user.fullName },
      });
      await this.record(tx, user, t, 'housekeeping.task_skipped', { reason: dto.reason }, ip, clientCreatedAt);
      return this.one(tx, user.tenantId, id);
    });
  }

  inspect(user: AuthUser, id: string, dto: { result: 'PASS' | 'FAIL'; note?: string; clientCreatedAt?: string }, ip?: string) {
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    if (dto.result === 'FAIL' && !dto.note?.trim()) throw Err.validation('note', 'Say what needs redoing');
    return this.db.tenant(user.tenantId, async (tx) => {
      const t = await this.loadTask(tx, user.tenantId, id);
      this.assertState(t, ['DONE']);
      const at = clientCreatedAt ?? new Date();
      if (dto.result === 'PASS') {
        await tx.housekeepingTask.update({ where: { id }, data: { status: 'INSPECTED', inspectedAt: at, inspectedById: user.userId, inspectedByName: user.fullName, inspectionNote: dto.note ?? null } });
        if (t.room.status === 'VACANT_DIRTY') await tx.room.update({ where: { id: t.roomId }, data: { status: 'VACANT_CLEAN' } });
      } else {
        await tx.housekeepingTask.update({
          where: { id },
          data: { status: 'REJECTED', priority: 'HIGH', inspectedAt: null, inspectedById: user.userId, inspectedByName: user.fullName, inspectionNote: dto.note!, completedAt: null },
        });
      }
      await this.record(tx, user, t, dto.result === 'PASS' ? 'housekeeping.inspected' : 'housekeeping.rejected', { note: dto.note ?? null, cleanedBy: t.completedByName }, ip, clientCreatedAt);
      return this.one(tx, user.tenantId, id);
    });
  }

  /** PATCH /housekeeping/tasks/:id (M2 shape plus assignment fields). */
  async update(
    user: AuthUser,
    id: string,
    dto: { status?: string; notes?: string; clientCreatedAt?: string; priority?: TaskPriority; assigneeId?: string | null; dueAt?: string | null },
    ip?: string,
  ) {
    const assigning = dto.priority !== undefined || dto.assigneeId !== undefined || dto.dueAt !== undefined;
    if (assigning && !can(user, 'housekeeping.assign')) throw forbidden('housekeeping.assign', 'Only a supervisor can assign or reprioritise tasks');
    if (assigning || (dto.notes !== undefined && !dto.status)) {
      await this.db.tenant(user.tenantId, async (tx) => {
        const t = await this.loadTask(tx, user.tenantId, id);
        const who = dto.assigneeId ? await this.assignee(tx, user.tenantId, dto.assigneeId) : null;
        await tx.housekeepingTask.update({
          where: { id },
          data: {
            ...(dto.priority !== undefined && { priority: dto.priority }),
            ...(dto.dueAt !== undefined && { dueAt: dto.dueAt ? new Date(dto.dueAt) : null }),
            ...(dto.notes !== undefined && { notes: dto.notes }),
            ...(dto.assigneeId !== undefined && {
              assigneeId: who?.id ?? null,
              assigneeName: who?.fullName ?? null,
              ...((t.status === 'OPEN' || t.status === 'ASSIGNED') && { status: who ? 'ASSIGNED' : 'OPEN' }),
            }),
          },
        });
        await this.record(tx, user, t, 'housekeeping.task_updated', { changes: Object.keys(dto) }, ip);
      });
    }
    const status = dto.status === 'PENDING' ? 'OPEN' : dto.status;
    if (status === 'IN_PROGRESS') return this.start(user, id, { clientCreatedAt: dto.clientCreatedAt }, ip);
    if (status === 'DONE') return this.finish(user, id, { notes: dto.notes, clientCreatedAt: dto.clientCreatedAt }, ip);
    if (status === 'OPEN') {
      const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
      return this.db.tenant(user.tenantId, async (tx) => {
        const t = await this.loadTask(tx, user.tenantId, id);
        await tx.housekeepingTask.update({
          where: { id },
          data: { status: t.assigneeId ? 'ASSIGNED' : 'OPEN', completedAt: null, completedById: null, completedByName: null, ...(dto.notes !== undefined && { notes: dto.notes }) },
        });
        await this.record(tx, user, t, 'housekeeping.task_reopened', { from: t.status }, ip, clientCreatedAt);
        return this.one(tx, user.tenantId, id);
      });
    }
    if (status) throw Err.validation('status', 'Use the start, finish, skip or inspect actions for that status');
    return this.get(user, id);
  }

  async addPhoto(user: AuthUser, id: string, file: UploadedFileLike | undefined, ip?: string) {
    const photo = await storePhoto(this.storage, user.tenantId, 'housekeeping', file);
    return this.db.tenant(user.tenantId, async (tx) => {
      const t = await this.loadTask(tx, user.tenantId, id);
      await tx.housekeepingTask.update({ where: { id }, data: { photos: [...photosOf(t.photos), photo] as unknown as Prisma.InputJsonValue } });
      await this.record(tx, user, t, 'housekeeping.photo_added', { key: photo.key }, ip);
      return this.one(tx, user.tenantId, id);
    });
  }

  /** Photo keys of a task (to attach to a maintenance ticket). */
  async taskForIssue(tx: Tx, tenantId: string, id: string) {
    return this.loadTask(tx, tenantId, id);
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  settings(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const types = await tx.roomType.findMany({ where: { tenantId: user.tenantId }, orderBy: [{ sortOrder: 'asc' }, { basePriceKobo: 'asc' }] });
      return {
        requireInspection: p.requireInspection,
        stayoverEnabled: p.stayoverEnabled,
        stayoverTime: '07:00',
        taskMinutes: TASK_MINUTES,
        deepCleanEveryStays: types.map((t) => ({ roomTypeId: t.id, roomTypeName: t.name, every: t.deepCleanEveryStays })),
      };
    });
  }

  async putSettings(user: AuthUser, dto: { requireInspection?: boolean; stayoverEnabled?: boolean; deepCleanEveryStays?: { roomTypeId: string; every: number | null }[] }, ip?: string) {
    await this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      await tx.property.update({
        where: { id: p.id },
        data: { ...(dto.requireInspection !== undefined && { requireInspection: dto.requireInspection }), ...(dto.stayoverEnabled !== undefined && { stayoverEnabled: dto.stayoverEnabled }) },
      });
      for (const d of dto.deepCleanEveryStays ?? []) {
        const rt = await tx.roomType.findFirst({ where: { id: d.roomTypeId, tenantId: user.tenantId } });
        if (!rt) throw AppException.notFound('Room type');
        await tx.roomType.update({ where: { id: rt.id }, data: { deepCleanEveryStays: d.every } });
      }
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'housekeeping.settings_updated', entityType: 'property', entityId: p.id, metadata: { ...dto }, ip });
    });
    return this.settings(user);
  }

  // ---------------------------------------------------------------------------
  // Lost & found
  // ---------------------------------------------------------------------------

  private lostView(i: Prisma.LostFoundItemGetPayload<{ include: { room: true } }>, tenantId: string, guest: { id: string; fullName: string; phone: string | null } | null, code: string | null) {
    return {
      id: i.id,
      description: i.description,
      category: i.category,
      room: i.room ? { id: i.room.id, number: i.room.number, floor: i.room.floor, status: i.room.status } : null,
      location: i.location,
      foundBy: i.foundById ? { id: i.foundById, fullName: i.foundByName ?? '' } : null,
      foundAt: i.foundAt.toISOString(),
      status: i.status,
      storageLocation: i.storageLocation,
      guest,
      reservationCode: code,
      returnedTo: i.returnedTo,
      returnedAt: i.returnedAt?.toISOString() ?? null,
      disposedAt: i.disposedAt?.toISOString() ?? null,
      notes: i.notes,
      photos: photosOf(i.photos).map((p) => ({ key: p.key, url: this.guests.fileUrl(tenantId, p.key) })),
      createdAt: i.createdAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
    };
  }

  private async lostViews(tx: Tx, tenantId: string, rows: Prisma.LostFoundItemGetPayload<{ include: { room: true } }>[]) {
    const guests = await tx.guest.findMany({ where: { id: { in: rows.map((r) => r.guestId).filter((x): x is string => !!x) } }, select: { id: true, fullName: true, phone: true } });
    const res = await tx.reservation.findMany({ where: { id: { in: rows.map((r) => r.reservationId).filter((x): x is string => !!x) } }, select: { id: true, code: true } });
    const g = new Map(guests.map((x) => [x.id, x]));
    const c = new Map(res.map((x) => [x.id, x.code]));
    return rows.map((r) => this.lostView(r, tenantId, r.guestId ? (g.get(r.guestId) ?? null) : null, r.reservationId ? (c.get(r.reservationId) ?? null) : null));
  }

  listLost(user: AuthUser, q: { status?: string; q?: string; from?: string; to?: string; page?: number; pageSize?: number }) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const statuses = q.status?.split(',').filter((s) => ['HELD', 'RETURNED', 'DISPOSED'].includes(s)) as ('HELD' | 'RETURNED' | 'DISPOSED')[] | undefined;
      const where: Prisma.LostFoundItemWhereInput = {
        tenantId: user.tenantId,
        ...(statuses?.length && { status: { in: statuses } }),
        ...(q.q && { OR: [{ description: { contains: q.q, mode: 'insensitive' } }, { category: { contains: q.q, mode: 'insensitive' } }, { room: { number: q.q } }] }),
        ...((q.from || q.to) && { foundAt: { ...(q.from && { gte: lagosStartOfDay(q.from) }), ...(q.to && { lt: lagosStartOfDay(addDays(q.to, 1)) }) } }),
      };
      const rows = await tx.lostFoundItem.findMany({ where, include: { room: true }, orderBy: { foundAt: 'desc' }, skip: pg.skip, take: pg.take });
      const total = await tx.lostFoundItem.count({ where });
      return { items: await this.lostViews(tx, user.tenantId, rows), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  createLost(
    user: AuthUser,
    dto: { description: string; category?: string; roomId?: string; location?: string; foundAt?: string; storageLocation?: string; reservationId?: string; guestId?: string; notes?: string; clientCreatedAt?: string },
    ip?: string,
  ) {
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    return this.db.tenant(user.tenantId, async (tx) => {
      let reservationId = dto.reservationId ?? null;
      let guestId = dto.guestId ?? null;
      if (dto.roomId) {
        const room = await tx.room.findFirst({ where: { id: dto.roomId, tenantId: user.tenantId } });
        if (!room) throw AppException.notFound('Room');
        if (!reservationId && !guestId) {
          // Link the most recent stay in the room (usually the guest who just left).
          const last = await tx.reservation.findFirst({
            where: { tenantId: user.tenantId, roomId: room.id, status: { in: ['CHECKED_OUT', 'CHECKED_IN'] } },
            orderBy: [{ checkedOutAt: { sort: 'desc', nulls: 'last' } }, { checkedInAt: 'desc' }],
            select: { id: true, guestId: true },
          });
          reservationId = last?.id ?? null;
          guestId = last?.guestId ?? null;
        }
      }
      if (reservationId && !guestId) {
        const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId: user.tenantId }, select: { guestId: true } });
        if (!r) throw AppException.notFound('Reservation');
        guestId = r.guestId;
      }
      const item = await tx.lostFoundItem.create({
        data: {
          tenantId: user.tenantId,
          propertyId: (await primaryProperty(tx, user.tenantId)).id,
          description: dto.description,
          category: dto.category ?? 'Other',
          roomId: dto.roomId ?? null,
          location: dto.location ?? null,
          foundById: user.userId,
          foundByName: user.fullName,
          foundAt: dto.foundAt ? new Date(dto.foundAt) : (clientCreatedAt ?? new Date()),
          storageLocation: dto.storageLocation ?? null,
          guestId,
          reservationId,
          notes: dto.notes ?? '',
        },
        include: { room: true },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'lost_found.logged', entityType: 'lost_found_item', entityId: item.id, metadata: { description: item.description, room: item.room?.number ?? null }, ip });
      return (await this.lostViews(tx, user.tenantId, [item]))[0];
    });
  }

  updateLost(
    user: AuthUser,
    id: string,
    dto: { description?: string; category?: string; storageLocation?: string; guestId?: string | null; notes?: string; status?: 'HELD' | 'RETURNED' | 'DISPOSED'; returnedTo?: string },
    ip?: string,
  ) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const i = await tx.lostFoundItem.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!i) throw AppException.notFound('Item');
      if (dto.status === 'RETURNED' && !dto.returnedTo?.trim() && !i.returnedTo) throw Err.validation('returnedTo', 'Say who the item was returned to');
      const now = new Date();
      const item = await tx.lostFoundItem.update({
        where: { id },
        data: {
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.category !== undefined && { category: dto.category }),
          ...(dto.storageLocation !== undefined && { storageLocation: dto.storageLocation }),
          ...(dto.guestId !== undefined && { guestId: dto.guestId }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
          ...(dto.status !== undefined && {
            status: dto.status,
            ...(dto.status === 'RETURNED' && { returnedAt: now, returnedTo: dto.returnedTo ?? i.returnedTo }),
            ...(dto.status === 'DISPOSED' && { disposedAt: now }),
            ...(dto.status === 'HELD' && { returnedAt: null, disposedAt: null }),
          }),
        },
        include: { room: true },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'lost_found.updated', entityType: 'lost_found_item', entityId: id, metadata: { changes: Object.keys(dto), status: item.status }, ip });
      return (await this.lostViews(tx, user.tenantId, [item]))[0];
    });
  }

  async addLostPhoto(user: AuthUser, id: string, file: UploadedFileLike | undefined, ip?: string) {
    const photo = await storePhoto(this.storage, user.tenantId, 'lost-found', file);
    return this.db.tenant(user.tenantId, async (tx) => {
      const i = await tx.lostFoundItem.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!i) throw AppException.notFound('Item');
      const item = await tx.lostFoundItem.update({ where: { id }, data: { photos: [...photosOf(i.photos), photo] as unknown as Prisma.InputJsonValue }, include: { room: true } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'lost_found.photo_added', entityType: 'lost_found_item', entityId: id, metadata: { key: photo.key }, ip });
      return (await this.lostViews(tx, user.tenantId, [item]))[0];
    });
  }

  /** Housekeeping timeline of a room over the last day (Revenue Guard evidence). */
  static async timeline(tx: Tx, tenantId: string, roomId: string, since = new Date(Date.now() - 24 * 3_600_000)) {
    const rows = await tx.housekeepingTask.findMany({
      where: { tenantId, roomId, OR: [{ updatedAt: { gte: since } }, { completedAt: { gte: since } }] },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((t) => ({
      taskId: t.id,
      type: t.type,
      status: t.status,
      startedAt: t.startedAt?.toISOString() ?? null,
      doneAt: t.completedAt?.toISOString() ?? null,
      by: t.completedByName ?? t.assigneeName ?? null,
    }));
  }
}
