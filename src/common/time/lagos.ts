/**
 * Africa/Lagos helpers. Lagos is UTC+1 all year (no daylight saving), so the
 * conversions are plain offsets; no timezone database is needed.
 */
export const LAGOS_TZ = 'Africa/Lagos';
const OFFSET_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Lagos calendar date (YYYY-MM-DD) of an instant. */
export function lagosDate(d: Date = new Date()): string {
  return new Date(d.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** Lagos calendar year of an instant. */
export function lagosYear(d: Date = new Date()): number {
  return Number(lagosDate(d).slice(0, 4));
}

export function isIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The instant of `date` at `time` (HH:MM) in Lagos. */
export function lagosDateTime(date: string, time = '00:00'): Date {
  if (!isIsoDate(date)) throw new Error(`Invalid date ${date}`);
  const t = TIME_RE.test(time) ? time : '00:00';
  return new Date(`${date}T${t}:00+01:00`);
}

/** Start of the Lagos day (00:00 Lagos) as an instant. */
export function lagosStartOfDay(date: string): Date {
  return lagosDateTime(date, '00:00');
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(d.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (b - a). */
export function diffDays(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS,
  );
}

/** Inclusive list of dates from `from` to `to`. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** A DATE column value (UTC midnight) for a Lagos business date. */
export function dbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** Business date string from a DATE column value. */
export function fromDbDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Number of hotel nights between arrival and departure (by Lagos date). */
export function nightsBetween(arrivalAt: Date, departureAt: Date): number {
  return Math.max(1, diffDays(lagosDate(arrivalAt), lagosDate(departureAt)));
}

/** Billable hours for a day-use stay (rounded up, minimum 1). */
export function billableHours(arrivalAt: Date, departureAt: Date): number {
  return Math.max(
    1,
    Math.ceil((departureAt.getTime() - arrivalAt.getTime()) / (60 * 60 * 1000)),
  );
}

/** The window of hotel night `date`: [date checkIn, date+1 checkOut). */
export function nightWindow(
  date: string,
  checkInTime: string,
  checkOutTime: string,
): { start: Date; end: Date } {
  return {
    start: lagosDateTime(date, checkInTime),
    end: lagosDateTime(addDays(date, 1), checkOutTime),
  };
}

export function overlaps(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}
