import type { SubscriptionStatus } from '../../generated/prisma/enums.js';
import { UNLIMITED } from './entitlements.constants.js';

export interface PlanLike {
  code: string;
  sortOrder: number;
  isActive: boolean;
  limits: Record<string, number>;
  features: string[];
}

export interface OverrideLike {
  featureCode: string;
  enabled: boolean;
}

/**
 * M7: feature codes that are other names of one capability. Basic logo and
 * colours moved from Growth (`booking_site_branding`) to every plan
 * (`brand_kit`); the old code stays as an alias so nothing breaks.
 */
export const FEATURE_ALIASES: Record<string, string> = { booking_site_branding: 'brand_kit' };

function canonical(code: string): string {
  return FEATURE_ALIASES[code] ?? code;
}

/** Adds every alias of a canonical code that is present (for output and gates). */
export function expandAliases(codes: Iterable<string>): string[] {
  const set = new Set([...codes].map(canonical));
  for (const [alias, target] of Object.entries(FEATURE_ALIASES)) if (set.has(target)) set.add(alias);
  return [...set].sort();
}

/**
 * Effective feature set = plan features, plus overrides with enabled=true
 * (add-ons), minus overrides with enabled=false (explicit removals).
 * Aliases are resolved first (an override on either name applies to both).
 * Returned sorted for stable API output.
 */
export function computeFeatures(
  planFeatures: readonly string[],
  overrides: readonly OverrideLike[],
): string[] {
  const set = new Set(planFeatures.map(canonical));
  for (const o of overrides) {
    if (o.enabled) set.add(canonical(o.featureCode));
    else set.delete(canonical(o.featureCode));
  }
  return expandAliases(set);
}

/** Normalises a plan's JSON limits column into a numeric record. */
export function normaliseLimits(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== 'number' && typeof v !== 'string') continue;
      if (typeof v === 'string' && v.trim() === '') continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) out[k] = Math.trunc(n);
    }
  }
  return out;
}

/** True when adding `adding` more would exceed `max` (-1 = unlimited). */
export function exceedsLimit(
  max: number | undefined,
  current: number,
  adding = 1,
): boolean {
  if (max === undefined || max === UNLIMITED) return false;
  return current + adding > max;
}

/** Cheapest active plan that includes the feature (by sortOrder). */
export function requiredPlanFor(
  feature: string,
  plans: readonly PlanLike[],
): string | null {
  const match = [...plans]
    .filter((p) => p.isActive && expandAliases(p.features).includes(feature))
    .sort((a, b) => a.sortOrder - b.sortOrder)[0];
  return match?.code ?? null;
}

/**
 * The next plan (above the current one) whose limit accommodates `needed`.
 * Returns null when no plan does.
 */
export function upgradePlanFor(
  limit: string,
  needed: number,
  currentPlanCode: string,
  plans: readonly PlanLike[],
): string | null {
  const sorted = [...plans]
    .filter((p) => p.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const current = sorted.find((p) => p.code === currentPlanCode);
  const floor = current?.sortOrder ?? Number.NEGATIVE_INFINITY;
  const match = sorted.find((p) => {
    if (p.sortOrder <= floor) return false;
    const max = p.limits[limit];
    return max === undefined || max === UNLIMITED || max >= needed;
  });
  return match?.code ?? null;
}

/**
 * Whether writes are blocked for a subscription state. READ_ONLY and
 * SUSPENDED always block; CANCELLED blocks once the paid period has ended.
 */
export function isWriteBlocked(
  status: SubscriptionStatus,
  currentPeriodEnd: Date | null,
  now: Date = new Date(),
): boolean {
  if (status === 'READ_ONLY' || status === 'SUSPENDED') return true;
  if (status === 'CANCELLED') {
    return !currentPeriodEnd || currentPeriodEnd.getTime() < now.getTime();
  }
  return false;
}
