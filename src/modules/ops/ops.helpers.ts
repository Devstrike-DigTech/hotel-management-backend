import { HttpStatus } from '@nestjs/common';
import type { StaffRole } from '../../generated/prisma/enums.js';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import type { Tx } from '../../prisma/db.service.js';

export const MANAGERS: StaffRole[] = ['OWNER', 'MANAGER'];
export const DESK: StaffRole[] = ['OWNER', 'MANAGER', 'FRONT_DESK'];
export const DESK_READ: StaffRole[] = ['OWNER', 'MANAGER', 'FRONT_DESK', 'ACCOUNTANT'];
export const BACK_OFFICE: StaffRole[] = ['OWNER', 'MANAGER', 'ACCOUNTANT'];

export const isManager = (role: StaffRole) => role === 'OWNER' || role === 'MANAGER';

/** Largest single amount accepted anywhere (₦1bn), well inside safe integers. */
export const MAX_AMOUNT_KOBO = 100_000_000_000;

/** BigInt money column -> number (all values are far below 2^53). */
export function k(v: bigint | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'bigint' ? Number(v) : v;
}

export function kOrNull(v: bigint | number | null | undefined): number | null {
  return v === null || v === undefined ? null : k(v);
}

export function appError(status: HttpStatus, code: string, message: string, details?: unknown) {
  return new AppException(status, code, message, details);
}

export const Err = {
  invalidState: (status: string, allowed: string[], what = 'This record') =>
    appError(HttpStatus.CONFLICT, 'INVALID_STATE', `${what} is ${status.toLowerCase().replace(/_/g, ' ')}; allowed from ${allowed.join(', ')}`, { status, allowed }),
  validation: (field: string, message: string) =>
    appError(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR, message, { fields: { [field]: [message] } }),
};

/**
 * Validates an offline `clientCreatedAt`: at most 5 minutes in the future and
 * 72 hours in the past.
 */
export function parseClientCreatedAt(value: string | undefined, now = new Date()): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw Err.validation('clientCreatedAt', 'clientCreatedAt must be an ISO timestamp');
  if (d.getTime() > now.getTime() + 5 * 60_000) {
    throw Err.validation('clientCreatedAt', 'clientCreatedAt cannot be in the future');
  }
  if (d.getTime() < now.getTime() - 72 * 3_600_000) {
    throw Err.validation('clientCreatedAt', 'clientCreatedAt is more than 72 hours old');
  }
  return d;
}

/** True for Postgres exclusion-constraint violations (double booking). */
export function isExclusionViolation(err: unknown): boolean {
  const text = errorText(err);
  return text.includes('23P01') || text.includes('reservations_no_overlap') || text.includes('exclusion constraint');
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string };
  return e?.code === 'P2002' || errorText(err).includes('23505');
}

function errorText(err: unknown): string {
  if (!err) return '';
  try {
    const e = err as { message?: string; code?: string; meta?: unknown; cause?: unknown };
    return [e.message, e.code, JSON.stringify(e.meta ?? ''), JSON.stringify(e.cause ?? '')].join(' ');
  } catch {
    return err instanceof Error ? err.message : '';
  }
}

export async function primaryProperty(tx: Tx, tenantId: string) {
  const p = await tx.property.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
  if (!p) throw AppException.notFound('Property');
  return p;
}

/** id -> fullName for audit-style references (staff may have been deleted). */
export async function userNames(tx: Tx, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const rows = await tx.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true } });
  return new Map(rows.map((r) => [r.id, r.fullName]));
}

export function userRef(names: Map<string, string>, id: string | null | undefined, fallback?: string | null) {
  if (!id) return null;
  return { id, fullName: names.get(id) ?? fallback ?? 'Former staff member' };
}

export function paginate(page = 1, pageSize = 20) {
  const p = Math.max(1, page);
  const s = Math.min(100, Math.max(1, pageSize));
  return { page: p, pageSize: s, skip: (p - 1) * s, take: s };
}

/** Takes a transaction-scoped advisory lock keyed by an arbitrary string. */
export async function advisoryLock(tx: Tx, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
