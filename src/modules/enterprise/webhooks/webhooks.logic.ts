/** Outbound webhooks (M6): event catalogue, signing and retry schedule. Pure, unit tested. */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_EVENTS = [
  { type: 'reservation.created', description: 'A reservation was created (front desk, booking site, marketplace, OTA or API)', object: 'reservation' },
  { type: 'reservation.updated', description: 'Dates, guests, room or price of a reservation changed', object: 'reservation' },
  { type: 'reservation.cancelled', description: 'A reservation was cancelled', object: 'reservation' },
  { type: 'reservation.checked_in', description: 'The guest checked in', object: 'reservation' },
  { type: 'reservation.checked_out', description: 'The guest checked out', object: 'reservation' },
  { type: 'reservation.no_show', description: 'The reservation was marked as a no-show', object: 'reservation' },
  { type: 'payment.received', description: 'A payment was recorded on a reservation folio', object: 'payment' },
  { type: 'room.status_changed', description: 'A room changed status (clean, dirty, out of order ...)', object: 'room' },
  { type: 'housekeeping.task_completed', description: 'A housekeeping task was marked done', object: 'housekeeping_task' },
  { type: 'review.published', description: 'A guest review was published', object: 'review' },
  { type: 'guard.flag_raised', description: 'Revenue Guard raised a flag', object: 'guard_flag' },
  { type: 'transfer.created', description: 'An arrival pickup or departure drop-off was booked', object: 'transfer' },
  { type: 'transfer.updated', description: 'A transfer changed: confirmed, driver assigned, on the way, completed, delayed or cancelled', object: 'transfer' },
  { type: 'concierge.request_created', description: 'A guest concierge request was made (private requests are never sent)', object: 'concierge_request' },
  { type: 'concierge.request_updated', description: 'A concierge request changed: quoted, confirmed, paid, scheduled, completed, declined or cancelled (private requests are never sent)', object: 'concierge_request' },
  { type: 'webhook.ping', description: 'Test event sent from the settings page', object: 'ping' },
] as const;

export const EVENT_TYPES: readonly string[] = WEBHOOK_EVENTS.map((e) => e.type);

/** Audit actions that produce a webhook event. */
export const AUDIT_EVENT_MAP: Record<string, string> = {
  'reservation.created': 'reservation.created',
  'reservation.booked_online': 'reservation.created',
  'reservation.updated': 'reservation.updated',
  'reservation.room_moved': 'reservation.updated',
  'reservation.confirmed': 'reservation.updated',
  'reservation.converted_to_nightly': 'reservation.updated',
  'reservation.cancelled': 'reservation.cancelled',
  'reservation.hold_expired': 'reservation.cancelled',
  'reservation.checked_in': 'reservation.checked_in',
  'reservation.checked_out': 'reservation.checked_out',
  'reservation.no_show': 'reservation.no_show',
  'folio.payment_recorded': 'payment.received',
  'reservation.paid_online': 'payment.received',
  'room.status_changed': 'room.status_changed',
  'housekeeping.task_done': 'housekeeping.task_completed',
  'review.published': 'review.published',
  'review.submitted': 'review.published',
  // M7: extras and answers changed at the desk.
  'reservation.extra_added': 'reservation.updated',
  'reservation.extra_removed': 'reservation.updated',
  'reservation.form_answers_updated': 'reservation.updated',
};

/** Seconds after the FIRST attempt at which attempts 2..8 run. */
export const RETRY_OFFSETS_SEC = [60, 5 * 60, 30 * 60, 2 * 3600, 5 * 3600, 10 * 3600, 24 * 3600];
export const MAX_ATTEMPTS = RETRY_OFFSETS_SEC.length + 1;

/** When the next attempt runs after `attempts` attempts (null = give up). */
export function nextAttemptAt(firstAttemptAt: Date, attempts: number): Date | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  const offset = RETRY_OFFSETS_SEC[attempts - 1];
  if (offset === undefined) return null;
  return new Date(firstAttemptAt.getTime() + offset * 1000);
}

/** Auto-disable: failing for 24 hours without a success and at least 10 failed attempts. */
export function shouldDisable(failingSince: Date | null, consecutiveFailures: number, now = new Date()): boolean {
  return !!failingSince && now.getTime() - failingSince.getTime() >= 24 * 3_600_000 && consecutiveFailures >= 10;
}

export function sign(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** `t=<unix>,v1=<hex>[,v1=<hex old secret>]` */
export function signatureHeader(secrets: string[], timestamp: number, body: string): string {
  return [`t=${timestamp}`, ...secrets.map((s) => `v1=${sign(s, timestamp, body)}`)].join(',');
}

/** Receiver-side check (documented for partners; used in tests). */
export function verifySignature(header: string, secret: string, body: string, now = Date.now(), toleranceSec = 300): boolean {
  const parts = header.split(',').map((p) => p.trim());
  const t = Number(parts.find((p) => p.startsWith('t='))?.slice(2));
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = Buffer.from(sign(secret, t, body), 'hex');
  return parts
    .filter((p) => p.startsWith('v1='))
    .some((p) => {
      const got = Buffer.from(p.slice(3), 'hex');
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
}

export function matchesEvents(subscribed: readonly string[], type: string): boolean {
  if (type === 'webhook.ping') return true;
  return subscribed.includes('*') || subscribed.includes(type);
}
