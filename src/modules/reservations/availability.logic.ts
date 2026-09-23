export interface Interval {
  start: Date;
  end: Date;
}

/**
 * The largest number of intervals active at the same instant inside
 * [start, end). Used to check room-type capacity: a new stay fits when
 * maxConcurrent(existing) + 1 <= sellable rooms. Interval graphs are perfect,
 * so if concurrency never exceeds the room count, a room assignment exists.
 */
export function maxConcurrent(intervals: Interval[], start: Date, end: Date): number {
  const s = start.getTime();
  const e = end.getTime();
  const events: [number, number][] = [];
  for (const iv of intervals) {
    const a = Math.max(iv.start.getTime(), s);
    const b = Math.min(iv.end.getTime(), e);
    if (a < b) {
      events.push([a, 1], [b, -1]);
    }
  }
  // Ends sort before starts at the same instant ('[)' ranges touch, not overlap).
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of events) {
    cur += d;
    if (cur > max) max = cur;
  }
  return max;
}

export function isFree(stays: Interval[], start: Date, end: Date): boolean {
  return !stays.some((iv) => iv.start.getTime() < end.getTime() && start.getTime() < iv.end.getTime());
}

/** Number of intervals overlapping [start, end). */
export function countOverlapping(intervals: Interval[], start: Date, end: Date): number {
  return intervals.filter((iv) => iv.start.getTime() < end.getTime() && start.getTime() < iv.end.getTime()).length;
}

export interface DayCount {
  date: string;
  sellable: number;
  outOfOrder: number;
  booked: number;
  available: number;
}

/** Per-night counts for one room type. */
export function dailyAvailability(
  nights: { date: string; start: Date; end: Date }[],
  totalRooms: number,
  outOfOrder: number,
  stays: Interval[],
): DayCount[] {
  const sellable = Math.max(0, totalRooms - outOfOrder);
  return nights.map((n) => {
    const booked = countOverlapping(stays, n.start, n.end);
    return { date: n.date, sellable, outOfOrder, booked, available: Math.max(0, sellable - booked) };
  });
}
