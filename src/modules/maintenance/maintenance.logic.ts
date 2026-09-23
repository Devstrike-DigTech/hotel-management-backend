/** Maintenance rules: SLA by priority, ticket numbers, age buckets. */

export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export const SLA_HOURS: Record<Priority, number> = { URGENT: 4, HIGH: 24, NORMAL: 72, LOW: 168 };

export function slaDueAt(createdAt: Date, priority: Priority): Date {
  return new Date(createdAt.getTime() + SLA_HOURS[priority] * 3_600_000);
}

export function ticketNumber(seq: number): string {
  return `MT-${String(seq).padStart(6, '0')}`;
}

export const CLOSED_STATUSES = ['RESOLVED', 'CLOSED'] as const;

export function slaState(t: { status: string; slaDueAt: Date; resolvedAt: Date | null }, now = new Date()) {
  const closed = t.status === 'RESOLVED' || t.status === 'CLOSED';
  const end = closed ? (t.resolvedAt ?? now) : now;
  return {
    breached: end.getTime() > t.slaDueAt.getTime(),
    remainingMinutes: closed ? null : Math.round((t.slaDueAt.getTime() - now.getTime()) / 60_000),
  };
}

export function ageBucket(createdAt: Date, now = new Date()): '0-1d' | '1-3d' | '3-7d' | '7d+' {
  const days = (now.getTime() - createdAt.getTime()) / 86_400_000;
  if (days < 1) return '0-1d';
  if (days < 3) return '1-3d';
  if (days < 7) return '3-7d';
  return '7d+';
}

/** Next due time after `from`, skipping periods that were missed. */
export function nextDue(current: Date, everyDays: number, now = new Date()): Date {
  const step = everyDays * 86_400_000;
  let next = current.getTime() + step;
  while (next <= now.getTime()) next += step;
  return new Date(next);
}
