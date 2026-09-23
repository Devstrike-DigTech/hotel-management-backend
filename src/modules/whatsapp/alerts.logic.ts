/** Owner alert rules: urgency, quiet hours (Lagos time), debounce. */

export interface GuardAlertSettings {
  enabled: boolean;
  recipients: { owners: boolean; managers: boolean; userIds: string[] };
  channels: ('WHATSAPP' | 'EMAIL')[];
  debounceMinutes: number;
  urgentRules: string[];
  urgentAmountKobo: number;
}

export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
}

export const DEFAULT_GUARD_ALERTS: GuardAlertSettings = {
  enabled: true,
  recipients: { owners: true, managers: false, userIds: [] },
  channels: ['WHATSAPP'],
  debounceMinutes: 3,
  urgentRules: ['OCCUPIED_WITHOUT_STAY', 'PAYMENT_ORPHANED'],
  urgentAmountKobo: 10_000_000,
};

export const DEFAULT_QUIET_HOURS: QuietHours = { enabled: true, start: '23:30', end: '06:00' };

export function guardAlertSettings(v: unknown): GuardAlertSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<GuardAlertSettings>;
  return {
    ...DEFAULT_GUARD_ALERTS,
    ...o,
    recipients: { ...DEFAULT_GUARD_ALERTS.recipients, ...o.recipients },
  };
}

export function quietHours(v: unknown): QuietHours {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<QuietHours>;
  return { ...DEFAULT_QUIET_HOURS, ...o };
}

export function isUrgent(flag: { rule: string; amountKobo: number | null }, s: GuardAlertSettings): boolean {
  return s.urgentRules.includes(flag.rule) || (flag.amountKobo ?? 0) >= s.urgentAmountKobo;
}

/** Minutes since Lagos midnight (UTC+1, no daylight saving). */
function lagosMinutes(at: Date): number {
  const m = (at.getUTCHours() * 60 + at.getUTCMinutes() + 60) % 1440;
  return m;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** True when `at` falls inside the quiet window (which may wrap past midnight). */
export function inQuietHours(at: Date, q: QuietHours): boolean {
  if (!q.enabled) return false;
  const now = lagosMinutes(at);
  const s = toMinutes(q.start);
  const e = toMinutes(q.end);
  if (s === e) return false;
  return s < e ? now >= s && now < e : now >= s || now < e;
}

/** The moment quiet hours end after `at` (only meaningful inside them). */
export function quietHoursEnd(at: Date, q: QuietHours): Date {
  const now = lagosMinutes(at);
  const e = toMinutes(q.end);
  const wait = (e - now + 1440) % 1440 || 1440;
  const out = new Date(at.getTime() + wait * 60_000);
  out.setUTCSeconds(0, 0);
  return out;
}

/** When an alert raised at `at` should go out. */
export function alertSchedule(at: Date, urgent: boolean, s: GuardAlertSettings, q: QuietHours): { scheduledFor: Date; deferred: boolean } {
  if (urgent) return { scheduledFor: at, deferred: false };
  if (inQuietHours(at, q)) return { scheduledFor: quietHoursEnd(at, q), deferred: true };
  return { scheduledFor: new Date(at.getTime() + s.debounceMinutes * 60_000), deferred: false };
}

/** The reply command in an inbound WhatsApp message. */
export function parseCommand(text: string): 'ACK' | 'DIGEST' | 'HELP' {
  const t = text.trim().toUpperCase().replace(/[.!]+$/, '');
  if (t === '1' || t === 'ACK' || t === 'ACKNOWLEDGE' || t === 'OK') return 'ACK';
  if (t === 'DIGEST' || t === 'SUMMARY') return 'DIGEST';
  return 'HELP';
}
