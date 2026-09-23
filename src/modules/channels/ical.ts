import { addDays } from '../../common/time/lagos.js';

/**
 * iCalendar (RFC 5545) for OTA availability sync. Exports carry only
 * blocked date ranges ("Not available"); imports read each VEVENT's UID,
 * dates and summary. All-day dates are Lagos calendar dates; an event's
 * DTEND is exclusive (the checkout day), like OTA feeds.
 */

export interface BlockedRange {
  from: string; // first blocked night, YYYY-MM-DD
  to: string; // day after the last blocked night (exclusive)
}

/** Groups sorted blocked nights into consecutive ranges. */
export function nightsToRanges(nights: string[]): BlockedRange[] {
  const sorted = [...new Set(nights)].sort();
  const out: BlockedRange[] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && last.to === n) last.to = addDays(n, 1);
    else out.push({ from: n, to: addDays(n, 1) });
  }
  return out;
}

const icsDate = (d: string) => d.replace(/-/g, '');

/** Folds lines longer than 75 octets (RFC 5545 3.1). */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length) {
    parts.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  return parts.join('\r\n');
}

const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

/** A calendar of blocked ranges; UIDs are stable for the same range and feed. */
export function buildIcs(o: { prodId: string; calName: string; feedKey: string; ranges: BlockedRange[]; now?: Date }): string {
  const stamp = (o.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${escape(o.prodId)}//Availability//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escape(o.calName)}`,
  ];
  for (const r of o.ranges) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${o.feedKey}-${icsDate(r.from)}-${icsDate(r.to)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(r.from)}`,
      `DTEND;VALUE=DATE:${icsDate(r.to)}`,
      'SUMMARY:Not available',
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export interface IcsEvent {
  uid: string;
  start: string; // YYYY-MM-DD (Lagos)
  end: string; // exclusive
  summary: string;
  description: string;
}

/** Unfolds continuation lines. */
function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function unescape(s: string): string {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/** DTSTART / DTEND value to a Lagos date: DATE values as is, UTC or floating times shifted to Lagos. */
function toDate(value: string, params: string): string | null {
  const v = value.trim();
  if (/^\d{8}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, z] = m;
  if (z || /TZID=/i.test(params) === false) {
    const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
    const lagos = new Date(utc + (z ? 60 * 60 * 1000 : 0));
    return lagos.toISOString().slice(0, 10);
  }
  return `${y}-${mo}-${d}`;
}

/** Parses the VEVENTs of an iCal feed (unknown properties ignored). */
export function parseIcs(text: string): IcsEvent[] {
  const out: IcsEvent[] = [];
  let cur: Partial<IcsEvent> | null = null;
  for (const raw of unfold(text)) {
    const line = raw.trimEnd();
    if (line === 'BEGIN:VEVENT') {
      cur = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur?.uid && cur.start) {
        const end = cur.end && cur.end > cur.start ? cur.end : addDays(cur.start, 1);
        out.push({ uid: cur.uid, start: cur.start, end, summary: cur.summary ?? '', description: cur.description ?? '' });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const head = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [name, ...paramList] = head.split(';');
    const params = paramList.join(';');
    switch (name.toUpperCase()) {
      case 'UID':
        cur.uid = value.trim();
        break;
      case 'DTSTART':
        cur.start = toDate(value, params) ?? undefined;
        break;
      case 'DTEND':
        cur.end = toDate(value, params) ?? undefined;
        break;
      case 'SUMMARY':
        cur.summary = unescape(value);
        break;
      case 'DESCRIPTION':
        cur.description = unescape(value);
        break;
    }
  }
  return out;
}

/** OTAs export their own blocks next to reservations: those are not bookings. */
export function isOtaBlock(e: Pick<IcsEvent, 'summary'>): boolean {
  return /not available|blocked|unavailable|closed/i.test(e.summary);
}

/** Guest name from a summary like "Reserved - Adaeze Okafor" or "Adaeze Okafor (HMXYZ)", else null. */
export function guestNameFrom(e: Pick<IcsEvent, 'summary'>): string | null {
  const s = e.summary.replace(/^(reserved|reservation|booking|airbnb)\s*[-:]?\s*/i, '').replace(/\([^)]*\)/g, '').trim();
  if (!s || /^(reserved|booking|airbnb|reservation)$/i.test(s)) return null;
  return /^[A-Za-z][A-Za-z .'-]{1,80}$/.test(s) ? s : null;
}
