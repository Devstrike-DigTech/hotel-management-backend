import type { SubscriptionStatus } from '../../generated/prisma/enums.js';

const DAY = 24 * 60 * 60 * 1000;

export const GRACE_DAYS = 3; // ACTIVE past period end -> PAST_DUE
export const PAST_DUE_DAYS = 7; // PAST_DUE -> READ_ONLY
export const READ_ONLY_DAYS = 30; // READ_ONLY -> SUSPENDED

export interface DunningState {
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  pastDueAt: Date | null;
  readOnlyAt: Date | null;
  suspendedAt: Date | null;
}

export interface DunningStep {
  from: SubscriptionStatus;
  to: SubscriptionStatus;
  at: Date;
}

/**
 * One dunning transition, or null if the subscription is where it should be.
 * Transition timestamps are the moment the threshold was crossed (not "now"),
 * so a job that was down for days still produces the correct timeline.
 *
 *   TRIALING  past trialEndsAt                      -> READ_ONLY
 *   ACTIVE    past currentPeriodEnd + 3d             -> PAST_DUE
 *   PAST_DUE  past pastDueAt + 7d                    -> READ_ONLY
 *   READ_ONLY past readOnlyAt + 30d                  -> SUSPENDED
 */
export function nextDunningStep(s: DunningState, now: Date): DunningStep | null {
  const t = now.getTime();
  switch (s.status) {
    case 'TRIALING': {
      if (s.trialEndsAt && s.trialEndsAt.getTime() <= t) {
        return { from: 'TRIALING', to: 'READ_ONLY', at: s.trialEndsAt };
      }
      return null;
    }
    case 'ACTIVE': {
      if (!s.currentPeriodEnd) return null;
      const due = s.currentPeriodEnd.getTime() + GRACE_DAYS * DAY;
      return due <= t ? { from: 'ACTIVE', to: 'PAST_DUE', at: new Date(due) } : null;
    }
    case 'PAST_DUE': {
      const base =
        s.pastDueAt?.getTime() ??
        (s.currentPeriodEnd ? s.currentPeriodEnd.getTime() + GRACE_DAYS * DAY : null);
      if (base === null) return null;
      const due = base + PAST_DUE_DAYS * DAY;
      return due <= t ? { from: 'PAST_DUE', to: 'READ_ONLY', at: new Date(due) } : null;
    }
    case 'READ_ONLY': {
      if (!s.readOnlyAt) return null;
      const due = s.readOnlyAt.getTime() + READ_ONLY_DAYS * DAY;
      return due <= t ? { from: 'READ_ONLY', to: 'SUSPENDED', at: new Date(due) } : null;
    }
    default:
      return null;
  }
}

/** Applies steps until stable. Returns the final state and every step taken. */
export function runDunning(
  initial: DunningState,
  now: Date,
): { state: DunningState; steps: DunningStep[] } {
  let state = { ...initial };
  const steps: DunningStep[] = [];
  for (let i = 0; i < 5; i++) {
    const step = nextDunningStep(state, now);
    if (!step) break;
    steps.push(step);
    state = {
      ...state,
      status: step.to,
      ...(step.to === 'PAST_DUE' && { pastDueAt: step.at }),
      ...(step.to === 'READ_ONLY' && { readOnlyAt: step.at }),
      ...(step.to === 'SUSPENDED' && { suspendedAt: step.at }),
    };
  }
  return { state, steps };
}
