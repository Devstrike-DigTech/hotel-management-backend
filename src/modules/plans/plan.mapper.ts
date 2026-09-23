import type { Feature, Plan, PlanFeature } from '../../generated/prisma/client.js';
import { FEATURE_CODES } from '../entitlements/entitlements.constants.js';
import { normaliseLimits } from '../entitlements/entitlements.logic.js';

export interface PublicPlan {
  code: string;
  name: string;
  tagline: string;
  priceMonthlyKobo: number | null;
  priceYearlyKobo: number | null;
  limits: Record<string, number>;
  features: string[];
  commissionBps: number | null;
  highlighted: boolean;
  sortOrder: number;
}

export interface PublicFeature {
  code: string;
  name: string;
  description: string;
  category: string;
}

const FEATURE_ORDER = new Map<string, number>(
  FEATURE_CODES.map((c, i) => [c, i]),
);

/** Sort feature codes in catalogue order (stable, human-friendly). */
export function sortFeatureCodes(codes: string[]): string[] {
  return [...codes].sort(
    (a, b) =>
      (FEATURE_ORDER.get(a) ?? 999) - (FEATURE_ORDER.get(b) ?? 999) ||
      a.localeCompare(b),
  );
}

export function toPublicPlan(
  plan: Plan & { features: PlanFeature[] },
): PublicPlan {
  return {
    code: plan.code,
    name: plan.name,
    tagline: plan.tagline,
    priceMonthlyKobo: plan.priceMonthlyKobo,
    priceYearlyKobo: plan.priceYearlyKobo,
    limits: normaliseLimits(plan.limits),
    features: sortFeatureCodes(plan.features.map((f) => f.featureCode)),
    commissionBps: plan.commissionBps,
    highlighted: plan.highlighted,
    sortOrder: plan.sortOrder,
  };
}

export function toPublicFeature(f: Feature): PublicFeature {
  return {
    code: f.code,
    name: f.name,
    description: f.description,
    category: f.category,
  };
}
