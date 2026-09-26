import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpStatus } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { AppException } from './errors/app-exception.js';

/**
 * Property scope (M5 multi-property).
 *
 * Row-level security isolates tenants (hotel groups). Inside a group, every
 * operational table carries a `property_id`, and each staff request runs in
 * exactly one current property (header `X-Property-Id`, validated against
 * the user's access by the PermissionGuard). The scope lives in an
 * AsyncLocalStorage store for the duration of the request (or of a job's
 * per-property unit of work).
 *
 * `DbService.tenant()` runs its transaction on a Prisma client extended with
 * `propertyScopeExtension`: every read, update and delete on a
 * property-scoped model gets `AND propertyId IN (<scope>)`, and every create
 * must carry a property id inside the scope. So a query that forgets its
 * property filter still cannot see or touch another property's rows, the
 * same way RLS backs up the tenant filter. Raw SQL is not covered: the few
 * raw queries filter by property explicitly.
 *
 * Group-wide work (group reports, loyalty across properties) runs with
 * `withProperties(ids)`; tenant-wide models (guests, staff, corporate
 * accounts, promo codes, loyalty) are never filtered.
 */
export interface PropertyScope {
  tenantId: string;
  /** The current property: default for creates and for "the hotel" lookups. */
  propertyId: string | null;
  /** Properties visible in this scope; null = no property filter. */
  propertyIds: string[] | null;
  /**
   * M8: the staff member of the request (their effective permissions), for
   * views composed deep inside shared code (e.g. private concierge requests
   * masked in the reservation detail). Absent in jobs and public paths.
   */
  viewer?: { userId: string; permissions: ReadonlySet<string> };
}

/** M8: permissions of the staff member of the current request, if any. */
export function currentViewer(tenantId: string): { userId: string; permissions: ReadonlySet<string> } | null {
  return currentScope(tenantId)?.viewer ?? null;
}

export const propertyScopeStore = new AsyncLocalStorage<PropertyScope>();

/** The active scope, if it belongs to `tenantId` (when given). */
export function currentScope(tenantId?: string): PropertyScope | undefined {
  const s = propertyScopeStore.getStore();
  if (!s) return undefined;
  if (tenantId && s.tenantId.toLowerCase() !== tenantId.toLowerCase()) return undefined;
  return s;
}

/** The current property id for `tenantId`, or null outside a single-property scope. */
export function currentPropertyId(tenantId?: string): string | null {
  return currentScope(tenantId)?.propertyId ?? null;
}

/** Runs `fn` scoped to one property of a tenant (jobs, public booking paths). */
export function runInProperty<T>(tenantId: string, propertyId: string, fn: () => T): T {
  return propertyScopeStore.run({ tenantId, propertyId, propertyIds: [propertyId] }, fn);
}

/** Runs `fn` over several properties (group reports); `propertyId` stays the current one if it is among them. */
export function withProperties<T>(tenantId: string, propertyIds: string[], fn: () => T): T {
  const cur = currentPropertyId(tenantId);
  return propertyScopeStore.run(
    { tenantId, propertyId: cur && propertyIds.includes(cur) ? cur : (propertyIds[0] ?? null), propertyIds },
    fn,
  );
}

/** Runs `fn` with no property filter (tenant-wide maintenance jobs; use sparingly). */
export function withoutPropertyScope<T>(fn: () => T): T {
  return propertyScopeStore.exit(fn);
}

/** Models whose rows belong to one property (Prisma model names). */
export const PROPERTY_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'RoomType', 'Room', 'Reservation', 'Folio', 'FolioEntry', 'GuestInvoice', 'Receipt',
  'TaxSetting', 'DigestSetting', 'NotificationSetting', 'CashierShift', 'GuardFlag', 'OwnerDigest',
  'NightAuditRun', 'DailyStat', 'HousekeepingTask', 'HousekeepingChecklist', 'LostFoundItem',
  'MaintenanceTicket', 'RoomBlock', 'MaintenanceSchedule', 'FuelLog',
  'RatePlan', 'RateRule', 'RateOverride', 'RateRestriction', 'Review', 'PayoutAccount',
  'BookingPayment', 'CommissionEntry',
  // M5
  'PosOutlet', 'PosCategory', 'PosItem', 'PosPriceRule', 'PosOrder', 'PosOrderLine', 'PosTicket',
  'StockItem', 'StockMovement', 'StockCount', 'MinibarPar',
  'ChannelConnection', 'IcalFeed', 'ChannelMapping', 'ChannelSyncLog', 'ChannelBooking',
  'PricingSetting', 'PricingGuardrail', 'PricingFrozenDate', 'PricingEvent', 'CompetitorRate',
  'PriceSuggestion', 'PriceChange',
  'Conversation', 'ConversationMessage', 'QuickReply', 'TaskSuggestion', 'InboxSetting',
  'CustomDomain',
  // M7 (themes and assets can belong to the group root: filtered explicitly)
  'BookingForm', 'BookingFormVersion', 'FormUpload', 'Extra', 'PickupPoint', 'ReservationExtra', 'Transfer', 'SetupProgress',
  // M8
  'ConciergeSettings', 'ConciergeVendor', 'ConciergeService', 'ConciergeRequest', 'ConciergePayment',
]);

const FILTERED_OPS = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany',
  'count', 'aggregate', 'groupBy',
  'update', 'updateMany', 'updateManyAndReturn', 'delete', 'deleteMany', 'upsert',
]);
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);

/** The property filter for the transaction being run (set by DbService.tenant). */
export const activePropertyFilter = new AsyncLocalStorage<string[] | null>();

function outOfScope(model: string, propertyId: unknown): AppException {
  return new AppException(HttpStatus.FORBIDDEN, 'PROPERTY_ACCESS_DENIED', `This ${model} belongs to a property you cannot access here`, {
    propertyId: typeof propertyId === 'string' ? propertyId : null,
  });
}

function checkCreate(model: string, data: unknown, ids: string[]) {
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    const pid = (row as { propertyId?: unknown } | null)?.propertyId;
    if (typeof pid === 'string' && !ids.includes(pid)) throw outOfScope(model, pid);
  }
}

/**
 * Prisma client extension enforcing the property filter held in
 * `activePropertyFilter` (see the module comment).
 */
export const propertyScopeExtension = Prisma.defineExtension({
  name: 'property-scope',
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }) {
        const ids = activePropertyFilter.getStore();
        if (!ids || !PROPERTY_SCOPED_MODELS.has(model)) return query(args);
        const a = (args ?? {}) as { where?: Record<string, unknown>; data?: unknown; create?: unknown };
        if (CREATE_OPS.has(operation)) {
          checkCreate(model, a.data, ids);
          return query(args);
        }
        if (FILTERED_OPS.has(operation)) {
          const cond = ids.length === 1 ? { propertyId: ids[0] } : { propertyId: { in: ids } };
          const where = a.where ?? {};
          const and = where.AND === undefined ? [] : Array.isArray(where.AND) ? where.AND : [where.AND];
          a.where = { ...where, AND: [...and, cond] };
          if (operation === 'upsert') checkCreate(model, a.create, ids);
          return query(a as typeof args);
        }
        return query(args);
      },
    },
  },
});

/**
 * Property ids to filter by in raw SQL and explicit queries: the given ids,
 * else the active scope's for this tenant, else null (no filter).
 */
export function scopeIds(tenantId: string, explicit?: string[] | null): string[] | null {
  if (explicit) return explicit;
  return currentScope(tenantId)?.propertyIds ?? null;
}

/** `AND <alias>.property_id = ANY(...)` for raw SQL, or nothing without a scope. */
export function propertySql(ids: string[] | null, column = 'property_id'): Prisma.Sql {
  if (!ids) return Prisma.empty;
  return Prisma.sql` AND ${Prisma.raw(column)} = ANY(${ids}::uuid[])`;
}

/** Prisma where fragment for an explicit property filter (in addition to the scope). */
export function propertyWhere(ids: string[] | null): { propertyId?: { in: string[] } } {
  return ids ? { propertyId: { in: ids } } : {};
}
