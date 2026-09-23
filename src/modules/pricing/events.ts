import { addDays } from '../../common/time/lagos.js';

export type EventImpact = 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';

export const IMPACT_BPS: Record<EventImpact, number> = { LOW: 500, MEDIUM: 1000, HIGH: 1800, VERY_HIGH: 3000 };

export interface CalendarEvent {
  id: string;
  kind: 'NATIONAL' | 'CUSTOM';
  name: string;
  dateFrom: string;
  dateTo: string; // inclusive
  impact: EventImpact;
  upliftBps: number;
  moonDependent: boolean;
  city: string | null;
  disabled: boolean;
  note: string;
}

/** Western Easter Sunday (anonymous Gregorian computus). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Approximate Islamic holidays in Nigeria (the Federal Government confirms
 * them after the moon is sighted, usually within a day of these dates).
 */
const MOON: Record<number, { fitr: string; kabir: string; mawlid: string }> = {
  2025: { fitr: '2025-03-30', kabir: '2025-06-06', mawlid: '2025-09-04' },
  2026: { fitr: '2026-03-20', kabir: '2026-05-27', mawlid: '2026-08-25' },
  2027: { fitr: '2027-03-09', kabir: '2027-05-16', mawlid: '2027-08-14' },
  2028: { fitr: '2028-02-26', kabir: '2028-05-05', mawlid: '2028-08-03' },
  2029: { fitr: '2029-02-14', kabir: '2029-04-24', mawlid: '2029-07-24' },
};

/**
 * Event dates are NIGHTS (the date a guest sleeps over): the eve of each day
 * off. A public holiday on a weekday takes the adjoining weekend (and the
 * usual bridge day for Tuesday / Thursday holidays); nothing spills onto a
 * night followed by a working day.
 */
export function holidayNights(holiday: string): { from: string; to: string } {
  const dow = new Date(`${holiday}T12:00:00Z`).getUTCDay();
  switch (dow) {
    case 1: // Monday: Sat, Sun, Mon off
      return { from: addDays(holiday, -3), to: addDays(holiday, -1) };
    case 2: // Tuesday (+ Monday bridge): Sat-Tue off
      return { from: addDays(holiday, -4), to: addDays(holiday, -1) };
    case 4: // Thursday (+ Friday bridge): Thu-Sun off
      return { from: addDays(holiday, -1), to: addDays(holiday, 2) };
    case 5: // Friday: Fri-Sun off
      return { from: addDays(holiday, -1), to: addDays(holiday, 1) };
    case 6: // Saturday: Sat, Sun off
      return { from: addDays(holiday, -1), to: holiday };
    case 0: // Sunday: Sat, Sun off
      return { from: addDays(holiday, -2), to: addDays(holiday, -1) };
    default: // Wednesday: the eve only
      return { from: addDays(holiday, -1), to: addDays(holiday, -1) };
  }
}

/** The Nigerian national calendar for one year (keys are stable per year). */
export function nationalEvents(year: number): CalendarEvent[] {
  const ev = (key: string, name: string, from: string, to: string, impact: EventImpact, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
    id: `national:${key}-${year}`,
    kind: 'NATIONAL',
    name,
    dateFrom: from,
    dateTo: to,
    impact,
    upliftBps: IMPACT_BPS[impact],
    moonDependent: false,
    city: null,
    disabled: false,
    note: '',
    ...extra,
  });
  const easter = easterSunday(year);
  const h = (date: string) => holidayNights(date);
  const out: CalendarEvent[] = [
    // Nights are inclusive: `dateTo` is the last night that gets the uplift.
    ev('new-year', "New Year's Eve and Day", `${year - 1}-12-31`, `${year - 1}-12-31`, 'HIGH'),
    ev('easter', 'Easter (Good Friday to Easter Monday)', addDays(easter, -3), easter, 'HIGH'),
    ev('workers-day', "Workers' Day", h(`${year}-05-01`).from, h(`${year}-05-01`).to, 'LOW'),
    ev('democracy-day', 'Democracy Day', h(`${year}-06-12`).from, h(`${year}-06-12`).to, 'MEDIUM'),
    ev('independence-day', 'Independence Day weekend', h(`${year}-10-01`).from, h(`${year}-10-01`).to, 'HIGH'),
    ev('christmas', 'Christmas and Boxing Day', `${year}-12-24`, `${year}-12-25`, 'VERY_HIGH'),
    ev('detty-december', 'Detty December', `${year}-12-15`, `${year + 1}-01-04`, 'HIGH', { city: 'Lagos', note: 'Concerts, weddings and returnees in Lagos.' }),
  ];
  const moon = MOON[year];
  if (moon) {
    out.push(
      ev('eid-el-fitr', 'Eid el-Fitr', addDays(moon.fitr, -1), moon.fitr, 'MEDIUM', { moonDependent: true, note: 'Approximate: confirm when the moon is sighted.' }),
      ev('eid-el-kabir', 'Eid el-Kabir', addDays(moon.kabir, -1), moon.kabir, 'MEDIUM', { moonDependent: true, note: 'Approximate: confirm when the moon is sighted.' }),
      ev('mawlid', 'Eid el-Maulud', addDays(moon.mawlid, -1), addDays(moon.mawlid, -1), 'LOW', { moonDependent: true, note: 'Approximate: confirm when the moon is sighted.' }),
    );
  }
  return out;
}

/** National events overlapping [from, to]. */
export function nationalEventsBetween(from: string, to: string): CalendarEvent[] {
  const y0 = Number(from.slice(0, 4)) - 1;
  const y1 = Number(to.slice(0, 4));
  const out: CalendarEvent[] = [];
  for (let y = y0; y <= y1; y++) out.push(...nationalEvents(y));
  return out.filter((e) => e.dateFrom <= to && e.dateTo >= from).sort((a, b) => a.dateFrom.localeCompare(b.dateFrom));
}
