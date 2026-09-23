/* Test doubles shared by the entitlements unit tests. */
import type { ExecutionContext } from '@nestjs/common';
import type { AppRequest } from '../common/auth-types.js';
import type { DbService, Tx } from '../prisma/db.service.js';

export interface FakeState {
  planCode: string;
  planFeatures: string[];
  limits: Record<string, number>;
  status: string;
  currentPeriodEnd: Date | null;
  overrides: { featureCode: string; enabled: boolean }[];
  usage: { rooms: number; staff: number; properties: number };
}

export const CATALOGUE = [
  { code: 'starter', name: 'Starter', sortOrder: 1, isActive: true, limits: { max_rooms: 20, max_staff: 3, max_properties: 1 }, features: [{ featureCode: 'front_desk' }] },
  { code: 'growth', name: 'Growth', sortOrder: 2, isActive: true, limits: { max_rooms: 60, max_staff: 15, max_properties: 1 }, features: [{ featureCode: 'front_desk' }, { featureCode: 'housekeeping' }] },
  { code: 'pro', name: 'Pro', sortOrder: 3, isActive: true, limits: { max_rooms: 200, max_staff: 50, max_properties: 3 }, features: [{ featureCode: 'front_desk' }, { featureCode: 'housekeeping' }, { featureCode: 'pos' }] },
];

export function fakeTx(state: FakeState): Tx {
  const plan = CATALOGUE.find((p) => p.code === state.planCode)!;
  return {
    subscription: {
      findUnique: async () => ({
        status: state.status,
        interval: 'MONTHLY',
        trialEndsAt: null,
        currentPeriodEnd: state.currentPeriodEnd,
        plan: {
          ...plan,
          limits: state.limits,
          features: state.planFeatures.map((featureCode) => ({ featureCode })),
        },
      }),
    },
    tenantFeatureOverride: { findMany: async () => state.overrides },
    room: { count: async () => state.usage.rooms },
    user: { count: async () => state.usage.staff },
    property: { count: async () => state.usage.properties },
    plan: { findMany: async () => CATALOGUE },
  } as unknown as Tx;
}

export function fakeDb(state: FakeState): DbService {
  const tx = fakeTx(state);
  return {
    prisma: tx,
    tenant: async <T>(_id: string, fn: (t: Tx) => Promise<T>) => fn(tx),
  } as unknown as DbService;
}

export function defaultState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    planCode: 'growth',
    planFeatures: ['front_desk', 'housekeeping'],
    limits: { max_rooms: 60, max_staff: 15, max_properties: 1 },
    status: 'ACTIVE',
    currentPeriodEnd: new Date(Date.now() + 86_400_000),
    overrides: [],
    usage: { rooms: 10, staff: 2, properties: 1 },
    ...overrides,
  };
}

export const TENANT_ID = '11111111-1111-4111-8111-111111111111';

export function httpContext(
  req: Partial<AppRequest>,
  handler: () => void = () => undefined,
): ExecutionContext {
  class Ctl {}
  return {
    getHandler: () => handler,
    getClass: () => Ctl,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}
