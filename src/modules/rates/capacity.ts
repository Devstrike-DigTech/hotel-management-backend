/**
 * Sellable capacity with room blocks (M4). A room cannot be sold while a
 * RoomBlock covers the moment, or at all when its status is OUT_OF_ORDER and
 * no block covers "now" (a manual out-of-order with no end date).
 */
import type { ReservationStatus } from '../../generated/prisma/enums.js';
import type { Tx } from '../../prisma/db.service.js';

export const ACTIVE_STATUSES: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'CHECKED_IN'];

export interface Iv {
  start: Date;
  end: Date;
}

export interface BlockIv extends Iv {
  roomId: string;
}

export interface CapacityInput {
  totalRooms: number;
  /** Active stays of the type overlapping the window (assigned or not). */
  stays: Iv[];
  /** Blocks of rooms of the type overlapping the window. */
  blocks: BlockIv[];
  /** Rooms OUT_OF_ORDER with no block covering now: unsellable throughout. */
  openEndedOutOfOrder: string[];
}

/**
 * Rooms free for the WHOLE window [start, end): the minimum, over every
 * moment of the window, of rooms not blocked minus stays in progress. A new
 * stay fits when this is >= 1. With no blocks this equals
 * `sellable - peak concurrency` (M2).
 */
export function freeRoomsOverWindow(c: CapacityInput, start: Date, end: Date): number {
  return Math.max(0, rawFreeRooms(c, start, end));
}

/** Like freeRoomsOverWindow but may be negative (more stays than rooms: overbooked). */
export function rawFreeRooms(c: CapacityInput, start: Date, end: Date): number {
  const s = start.getTime();
  const e = end.getTime();
  const points = new Set<number>([s]);
  for (const iv of [...c.stays, ...c.blocks]) {
    const a = iv.start.getTime();
    const b = iv.end.getTime();
    if (a > s && a < e) points.add(a);
    if (b > s && b < e) points.add(b);
  }
  const permanent = new Set(c.openEndedOutOfOrder);
  let min = Number.POSITIVE_INFINITY;
  for (const t of points) {
    const inUse = c.stays.filter((iv) => iv.start.getTime() <= t && t < iv.end.getTime()).length;
    const blocked = new Set(permanent);
    for (const b of c.blocks) if (b.start.getTime() <= t && t < b.end.getTime()) blocked.add(b.roomId);
    min = Math.min(min, c.totalRooms - blocked.size - inUse);
  }
  return min === Number.POSITIVE_INFINITY ? c.totalRooms : min;
}

/** Loads the capacity inputs of room types for a window, inside a tenant transaction. */
export async function loadCapacity(
  tx: Tx,
  tenantId: string,
  roomTypeIds: string[],
  start: Date,
  end: Date,
  opts: { excludeReservationId?: string | null; now?: Date } = {},
): Promise<Map<string, CapacityInput>> {
  const now = opts.now ?? new Date();
  const rooms = await tx.room.findMany({ where: { tenantId, roomTypeId: { in: roomTypeIds } }, select: { id: true, roomTypeId: true, status: true } });
  const stays = await tx.reservation.findMany({
    where: {
      tenantId,
      roomTypeId: { in: roomTypeIds },
      status: { in: ACTIVE_STATUSES },
      arrivalAt: { lt: end },
      departureAt: { gt: start },
      ...(opts.excludeReservationId && { id: { not: opts.excludeReservationId } }),
    },
    select: { roomTypeId: true, arrivalAt: true, departureAt: true },
  });
  const blocks = await tx.roomBlock.findMany({
    where: { tenantId, roomId: { in: rooms.map((r) => r.id) }, OR: [{ startsAt: { lt: end }, endsAt: { gt: start } }, { startsAt: { lte: now }, endsAt: { gt: now } }] },
    select: { roomId: true, roomTypeId: true, startsAt: true, endsAt: true },
  });
  const coveredNow = new Set(blocks.filter((b) => b.startsAt <= now && b.endsAt > now).map((b) => b.roomId));
  const out = new Map<string, CapacityInput>();
  for (const id of roomTypeIds) {
    const typeRooms = rooms.filter((r) => r.roomTypeId === id);
    out.set(id, {
      totalRooms: typeRooms.length,
      stays: stays.filter((s) => s.roomTypeId === id).map((s) => ({ start: s.arrivalAt, end: s.departureAt })),
      blocks: blocks
        .filter((b) => b.roomTypeId === id && b.startsAt < end && b.endsAt > start)
        .map((b) => ({ roomId: b.roomId, start: b.startsAt, end: b.endsAt })),
      openEndedOutOfOrder: typeRooms.filter((r) => r.status === 'OUT_OF_ORDER' && !coveredNow.has(r.id)).map((r) => r.id),
    });
  }
  return out;
}

/**
 * Unsellable rooms per room type and night (`${roomTypeId}|${date}` -> count)
 * for night windows [D check-in, D+1 check-out).
 */
export async function unsellableByNight(
  tx: Tx,
  tenantId: string,
  windows: { date: string; start: Date; end: Date }[],
  now = new Date(),
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!windows.length) return out;
  const start = windows[0].start;
  const end = windows[windows.length - 1].end;
  const rooms = await tx.room.findMany({ where: { tenantId }, select: { id: true, roomTypeId: true, status: true } });
  const blocks = await tx.roomBlock.findMany({
    where: { tenantId, OR: [{ startsAt: { lt: end }, endsAt: { gt: start } }, { startsAt: { lte: now }, endsAt: { gt: now } }] },
    select: { roomId: true, startsAt: true, endsAt: true },
  });
  const coveredNow = new Set(blocks.filter((b) => b.startsAt <= now && b.endsAt > now).map((b) => b.roomId));
  for (const r of rooms) {
    const permanent = r.status === 'OUT_OF_ORDER' && !coveredNow.has(r.id);
    const mine = blocks.filter((b) => b.roomId === r.id);
    for (const w of windows) {
      if (permanent || mine.some((b) => b.startsAt < w.end && b.endsAt > w.start)) {
        const key = `${r.roomTypeId}|${w.date}`;
        out.set(key, (out.get(key) ?? 0) + 1);
      }
    }
  }
  return out;
}

/** The block covering any part of [start, end) for a room, if any. */
export async function roomBlockDuring(tx: Tx, tenantId: string, roomId: string, start: Date, end: Date) {
  return tx.roomBlock.findFirst({
    where: { tenantId, roomId, startsAt: { lt: end }, endsAt: { gt: start } },
    orderBy: { startsAt: 'asc' },
  });
}
