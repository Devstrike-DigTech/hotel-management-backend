import { nextDunningStep, runDunning, type DunningState } from './dunning.logic.js';

const DAY = 86_400_000;
const now = new Date('2026-09-23T00:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);

const base: DunningState = {
  status: 'ACTIVE',
  trialEndsAt: null,
  currentPeriodEnd: null,
  pastDueAt: null,
  readOnlyAt: null,
  suspendedAt: null,
};

describe('dunning', () => {
  it('moves an expired trial to READ_ONLY', () => {
    const step = nextDunningStep({ ...base, status: 'TRIALING', trialEndsAt: daysAgo(1) }, now);
    expect(step).toMatchObject({ from: 'TRIALING', to: 'READ_ONLY' });
  });

  it('leaves a running trial alone', () => {
    expect(nextDunningStep({ ...base, status: 'TRIALING', trialEndsAt: daysAgo(-2) }, now)).toBeNull();
  });

  it('gives ACTIVE subscriptions a 3-day grace period', () => {
    expect(nextDunningStep({ ...base, currentPeriodEnd: daysAgo(2) }, now)).toBeNull();
    expect(nextDunningStep({ ...base, currentPeriodEnd: daysAgo(4) }, now)).toMatchObject({ to: 'PAST_DUE' });
  });

  it('moves PAST_DUE to READ_ONLY after 7 days', () => {
    expect(nextDunningStep({ ...base, status: 'PAST_DUE', pastDueAt: daysAgo(6) }, now)).toBeNull();
    expect(nextDunningStep({ ...base, status: 'PAST_DUE', pastDueAt: daysAgo(8) }, now)).toMatchObject({ to: 'READ_ONLY' });
  });

  it('suspends 30 days after READ_ONLY', () => {
    expect(nextDunningStep({ ...base, status: 'READ_ONLY', readOnlyAt: daysAgo(29) }, now)).toBeNull();
    expect(nextDunningStep({ ...base, status: 'READ_ONLY', readOnlyAt: daysAgo(31) }, now)).toMatchObject({ to: 'SUSPENDED' });
  });

  it('catches up through several stages with threshold timestamps', () => {
    const { state, steps } = runDunning({ ...base, currentPeriodEnd: daysAgo(50) }, now);
    expect(steps.map((s) => s.to)).toEqual(['PAST_DUE', 'READ_ONLY', 'SUSPENDED']);
    expect(state.status).toBe('SUSPENDED');
    expect(state.pastDueAt).toEqual(daysAgo(47));
    expect(state.readOnlyAt).toEqual(daysAgo(40));
    expect(state.suspendedAt).toEqual(daysAgo(10));
  });

  it('stops at the right stage when not fully overdue', () => {
    const { state } = runDunning({ ...base, currentPeriodEnd: daysAgo(12) }, now);
    expect(state.status).toBe('READ_ONLY');
  });

  it('never touches SUSPENDED or CANCELLED', () => {
    expect(nextDunningStep({ ...base, status: 'SUSPENDED', suspendedAt: daysAgo(100) }, now)).toBeNull();
    expect(nextDunningStep({ ...base, status: 'CANCELLED', currentPeriodEnd: daysAgo(100) }, now)).toBeNull();
  });
});
