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

/** The weekend around a fixed date: Friday before to Sunday after when it touches a weekend. */
function withWeekend(date: string): { from: string; to: string } {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (dow === 1) return { from: addDays(date, -3), to: date }; // Monday: Fri-Mon
  if (dow === 5) return { from: date, to: addDays(date, 2) }; // Friday: Fri-Sun
  if (dow === 4) return { from: date, to: addDays(date, 3) }; // Thursday: long weekend
  if (dow === 2) return { from: addDays(date, -4), to: date }; // Tuesday: bridge
  return { from: date, to: date };
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
  const out: CalendarEvent[] = [
    ev('new-year', "New Year's Day", `${year}-01-01`, `${year}-01-01`, 'HIGH'),
    ev('easter', 'Easter (Good Friday to Easter Monday)', addDays(easter, -2), addDays(easter, 1), 'HIGH'),
    ev('workers-day', "Workers' Day", withWeekend(`${year}-05-01`).from, withWeekend(`${year}-05-01`).to, 'LOW'),
    ev('democracy-day', 'Democracy Day', withWeekend(`${year}-06-12`).from, withWeekend(`${year}-06-12`).to, 'MEDIUM'),
    ev('independence-day', 'Independence Day weekend', withWeekend(`${year}-10-01`).from, withWeekend(`${year}-10-01`).to, 'HIGH'),
    ev('christmas', 'Christmas and Boxing Day', `${year}-12-24`, `${year}-12-26`, 'VERY_HIGH'),
    ev('detty-december', 'Detty December', `${year}-12-15`, `${year + 1}-01-05`, 'HIGH', { city: 'Lagos', note: 'Concerts, weddings and returnees in Lagos.' }),
  ];
  const moon = MOON[year];
  if (moon) {
    out.push(
      ev('eid-el-fitr', 'Eid el-Fitr', moon.fitr, addDays(moon.fitr, 1), 'MEDIUM', { moonDependent: true, note: 'Approximate: confirm when the moon is sighted.' }),
      ev('eid-el-kabir', 'Eid el-Kabir', moon.kabir, addDays(moon.kabir, 1), 'MEDIUM', { moonDependent: true, note: 'Approximate: confirm when the moon is sighted.' }),
      ev('mawlid', 'Eid el-Maulud', moon.mawlid, moon.mawlid, 'LOW', { moonDependent: true, note: 'Approximate: confirm when the moon is sighted.' }),
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
