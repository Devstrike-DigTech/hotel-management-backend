/** Partner API scopes (M6) and the key format. Pure functions, unit tested. */

export const API_SCOPES = [
  { scope: 'reservations:read', label: 'Read reservations', description: 'List and read reservations', write: false, permissions: ['reservations.view'] },
  { scope: 'reservations:write', label: 'Write reservations', description: 'Create, change and cancel reservations', write: true, permissions: ['reservations.view', 'reservations.create', 'reservations.edit', 'reservations.cancel'] },
  { scope: 'availability:read', label: 'Read availability', description: 'Rooms available per room type and night', write: false, permissions: ['reservations.view'] },
  { scope: 'rates:read', label: 'Read rates', description: 'Resolved nightly rates and restrictions', write: false, permissions: ['rates.view'] },
  { scope: 'rates:write', label: 'Write rates', description: 'Set and clear date rate overrides', write: true, permissions: ['rates.view', 'rates.manage'] },
  { scope: 'guests:read', label: 'Read guests', description: 'Guest names and contact details (no ID documents)', write: false, permissions: ['guests.view'] },
  { scope: 'folios:read', label: 'Read folios', description: 'Folio balances and entries of reservations', write: false, permissions: ['folio.view'] },
  { scope: 'rooms:read', label: 'Read rooms', description: 'Rooms and their status', write: false, permissions: [] },
  { scope: 'rooms:write', label: 'Write room status', description: 'Change the status of a room', write: true, permissions: ['rooms.status'] },
  { scope: 'housekeeping:read', label: 'Read housekeeping', description: 'Housekeeping tasks', write: false, permissions: ['housekeeping.view'] },
  { scope: 'housekeeping:write', label: 'Complete housekeeping', description: 'Mark housekeeping tasks done', write: true, permissions: ['housekeeping.view', 'housekeeping.work'] },
  { scope: 'webhooks:manage', label: 'Manage webhooks', description: 'Create and change webhook endpoints', write: true, permissions: ['integrations.view', 'integrations.manage'] },
  { scope: 'reports:read', label: 'Read reports', description: 'Daily occupancy, ADR, RevPAR and revenue', write: false, permissions: ['reports.view'] },
] as const;

export type ApiScope = (typeof API_SCOPES)[number]['scope'];
export const SCOPE_CODES: readonly string[] = API_SCOPES.map((s) => s.scope);

/** Hotel permissions a key with these scopes acts with (writes reuse the hotel services). */
export function permissionsForScopes(scopes: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const s of API_SCOPES) if (scopes.includes(s.scope)) for (const p of s.permissions) out.add(p);
  return out;
}

export type KeyEnvironment = 'LIVE' | 'TEST';

const KEY_RE = /^hk_(live|test)_([a-z0-9]{10})_([A-Za-z0-9]{40})$/;

export interface ParsedKey {
  environment: KeyEnvironment;
  prefix: string;
  secret: string;
}

/** Splits `hk_live_<prefix>_<secret>`; null when malformed. */
export function parseApiKey(raw: string | undefined | null): ParsedKey | null {
  const m = KEY_RE.exec((raw ?? '').trim());
  if (!m) return null;
  return { environment: m[1] === 'live' ? 'LIVE' : 'TEST', prefix: m[2]!, secret: m[3]! };
}

export function formatApiKey(environment: KeyEnvironment, prefix: string, secret: string): string {
  return `hk_${environment === 'LIVE' ? 'live' : 'test'}_${prefix}_${secret}`;
}

export function displayKey(environment: KeyEnvironment, prefix: string, last4: string): string {
  return `hk_${environment === 'LIVE' ? 'live' : 'test'}_${prefix}_...${last4}`;
}

export function keyStatus(k: { revokedAt: Date | null; expiresAt: Date | null }, now = new Date()): 'ACTIVE' | 'REVOKED' | 'EXPIRED' {
  if (k.revokedAt) return 'REVOKED';
  if (k.expiresAt && k.expiresAt <= now) return 'EXPIRED';
  return 'ACTIVE';
}

/** Rate limits per plan (requests per minute, burst per second). */
export function rateLimitsFor(planCode: string | null, enterprisePerMinute = 600, defaultPerMinute = 120): { perMinute: number; perSecond: number } {
  return planCode === 'enterprise' ? { perMinute: enterprisePerMinute, perSecond: 50 } : { perMinute: defaultPerMinute, perSecond: 20 };
}

/** Opaque cursor over (createdAt, id). */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const createdAt = new Date(at ?? '');
    if (!id || Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
