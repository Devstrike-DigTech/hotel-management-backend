import { ageBucket, nextDue, slaDueAt, slaState, ticketNumber } from './maintenance.logic.js';

const at = new Date('2026-09-23T08:00:00Z');

describe('maintenance rules', () => {
  it('sets the SLA by priority', () => {
    expect(slaDueAt(at, 'URGENT').toISOString()).toBe('2026-09-23T12:00:00.000Z');
    expect(slaDueAt(at, 'HIGH').toISOString()).toBe('2026-09-24T08:00:00.000Z');
    expect(slaDueAt(at, 'NORMAL').toISOString()).toBe('2026-09-26T08:00:00.000Z');
    expect(slaDueAt(at, 'LOW').toISOString()).toBe('2026-09-30T08:00:00.000Z');
  });

  it('reports breaches for open and resolved tickets', () => {
    const due = slaDueAt(at, 'URGENT');
    expect(slaState({ status: 'OPEN', slaDueAt: due, resolvedAt: null }, new Date('2026-09-23T13:00:00Z'))).toEqual({ breached: true, remainingMinutes: -60 });
    expect(slaState({ status: 'RESOLVED', slaDueAt: due, resolvedAt: new Date('2026-09-23T11:00:00Z') }, new Date('2026-09-24T00:00:00Z'))).toEqual({ breached: false, remainingMinutes: null });
  });

  it('numbers tickets MT-000123', () => {
    expect(ticketNumber(123)).toBe('MT-000123');
  });

  it('buckets open tickets by age', () => {
    expect(ageBucket(new Date(at.getTime() - 3_600_000), at)).toBe('0-1d');
    expect(ageBucket(new Date(at.getTime() - 2 * 86_400_000), at)).toBe('1-3d');
    expect(ageBucket(new Date(at.getTime() - 5 * 86_400_000), at)).toBe('3-7d');
    expect(ageBucket(new Date(at.getTime() - 9 * 86_400_000), at)).toBe('7d+');
  });

  it('moves a schedule to its next future due date, skipping missed periods', () => {
    const due = new Date('2026-09-01T05:00:00Z');
    expect(nextDue(due, 10, new Date('2026-09-01T06:00:00Z')).toISOString()).toBe('2026-09-11T05:00:00.000Z');
    expect(nextDue(due, 10, new Date('2026-09-23T06:00:00Z')).toISOString()).toBe('2026-10-01T05:00:00.000Z');
  });
});
