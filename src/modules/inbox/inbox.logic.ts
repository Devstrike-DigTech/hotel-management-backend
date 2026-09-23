/**
 * Guest WhatsApp inbox rules (pure): the 24-hour window, keyword task
 * suggestions, arrival-time replies and quick-reply placeholders.
 */

export const WINDOW_MS = 24 * 3_600_000;

export type MaintenanceCategoryCode = 'AC_HVAC' | 'PLUMBING' | 'ELECTRICAL' | 'APPLIANCE' | 'IT';

export interface KeywordHit {
  kind: 'HOUSEKEEPING' | 'MAINTENANCE';
  keyword: string;
  category: MaintenanceCategoryCode | null;
  summary: string;
}

const HOUSEKEEPING: [RegExp, string, string][] = [
  [/\btowels?\b/i, 'towel', 'Towels requested'],
  [/\btoiletr(y|ies)\b/i, 'toiletries', 'Toiletries requested'],
  [/\bsoap\b/i, 'soap', 'Soap requested'],
  [/\bclean(ing)?\b/i, 'clean', 'Room cleaning requested'],
  [/\bsheets?\b/i, 'sheets', 'Fresh sheets requested'],
  [/\bpillows?\b/i, 'pillow', 'Extra pillow requested'],
  [/\bblankets?\b/i, 'blanket', 'Blanket requested'],
  [/\btissues?\b/i, 'tissue', 'Tissue requested'],
];

const MAINTENANCE: [RegExp, string, MaintenanceCategoryCode, string][] = [
  [/\b(a\/?c|air ?con(dition(er|ing)?)?|cooling)\b/i, 'AC', 'AC_HVAC', 'Air conditioning problem'],
  [/\b(shower|tap|leak(ing)?|water)\b/i, 'water', 'PLUMBING', 'Water or plumbing problem'],
  [/\b(light|bulb|power|socket|nepa)\b/i, 'light', 'ELECTRICAL', 'Power or lighting problem'],
  [/\b(tv|television|remote)\b/i, 'TV', 'APPLIANCE', 'TV or remote problem'],
  [/\b(wi-?fi|internet)\b/i, 'wifi', 'IT', 'Wi-Fi problem'],
];

/** Task suggestions for an in-house guest's message (one per kind / category). */
export function keywordHits(text: string): KeywordHit[] {
  const out: KeywordHit[] = [];
  for (const [re, keyword, summary] of HOUSEKEEPING) {
    if (re.test(text) && !out.some((h) => h.kind === 'HOUSEKEEPING')) out.push({ kind: 'HOUSEKEEPING', keyword, category: null, summary });
  }
  for (const [re, keyword, category, summary] of MAINTENANCE) {
    if (re.test(text) && !out.some((h) => h.category === category)) out.push({ kind: 'MAINTENANCE', keyword, category, summary });
  }
  return out;
}

/**
 * An arrival time from a guest's reply: "3pm", "3:30 pm", "15:30", "around 2 pm",
 * "by 11am", "noon". Returns "HH:MM" or null.
 */
export function parseArrivalTime(text: string): string | null {
  const t = text.toLowerCase().trim();
  if (/\bnoon\b|\bmidday\b/.test(t)) return '12:00';
  if (/\bmidnight\b/.test(t)) return '00:00';
  const m = t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![a-z0-9])/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.replace(/\./g, '');
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'pm' && h !== 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
  } else {
    // Bare numbers need a colon ("15:30") to count as a time; "1" is the confirmation.
    if (!m[2] || h > 23) return null;
  }
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** "15:30" -> "3:30pm" */
export function humanTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
}

export function isConfirmation(text: string): boolean {
  return /^\s*(1|yes|confirm(ed)?)\s*[.!]?\s*$/i.test(text);
}

/** The 24-hour customer-service window after the guest's last message. */
export function windowOf(lastInboundAt: Date | null, now = new Date()): { open: boolean; expiresAt: string | null } {
  if (!lastInboundAt) return { open: false, expiresAt: null };
  const exp = new Date(lastInboundAt.getTime() + WINDOW_MS);
  return { open: exp.getTime() > now.getTime(), expiresAt: exp.toISOString() };
}

export const QUICK_REPLY_PLACEHOLDERS = [
  'guest_first_name',
  'hotel_name',
  'wifi_name',
  'wifi_password',
  'check_out_time',
  'check_in_time',
  'directions',
  'hotel_phone',
  'reservation_code',
  'room_number',
] as const;

export type QuickReplyVars = Partial<Record<(typeof QUICK_REPLY_PLACEHOLDERS)[number], string | null>>;

/** Fills {{placeholders}}; unknown or empty ones become an empty string. */
export function renderQuickReply(body: string, vars: QuickReplyVars): string {
  return body
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, k: string) => (vars as Record<string, string | null | undefined>)[k] ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] || 'there';
}

/** Phone digits in international form (Nigerian 0-prefixed numbers become 234...). */
export function phoneDigits(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('0') && d.length === 11) return `234${d.slice(1)}`;
  return d;
}
