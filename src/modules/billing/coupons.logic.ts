import type { BillingInterval } from '../../generated/prisma/enums.js';

export interface CouponTerms {
  code: string;
  name: string;
  percentOff: number | null;
  amountOffKobo: number | null;
  durationMonths: number | null;
  planCodes: string[];
  intervals: string[];
  maxRedemptions: number | null;
  redemptions: number;
  validFrom: Date | null;
  validUntil: Date | null;
  active: boolean;
}

/** Why a coupon cannot be used for this plan and interval (null = it can). */
export function couponProblem(c: CouponTerms, planCode: string, interval: BillingInterval, now = new Date()): string | null {
  if (!c.active) return 'This coupon is no longer active';
  if (c.validFrom && c.validFrom > now) return 'This coupon is not valid yet';
  if (c.validUntil && c.validUntil <= now) return 'This coupon has expired';
  if (c.maxRedemptions !== null && c.redemptions >= c.maxRedemptions) return 'This coupon has been used up';
  if (c.planCodes.length && !c.planCodes.includes(planCode)) return `This coupon does not apply to the ${planCode} plan`;
  if (c.intervals.length && !c.intervals.includes(interval)) return `This coupon does not apply to ${interval.toLowerCase()} billing`;
  return null;
}

/** Discount on one invoice, in kobo (never more than the amount). */
export function couponDiscount(c: Pick<CouponTerms, 'percentOff' | 'amountOffKobo'>, amountKobo: number): number {
  const raw = c.percentOff !== null ? Math.round((amountKobo * c.percentOff) / 100) : (c.amountOffKobo ?? 0);
  return Math.max(0, Math.min(amountKobo, raw));
}

/** Billing months one invoice covers. */
export function monthsCovered(interval: BillingInterval): number {
  return interval === 'YEARLY' ? 12 : 1;
}

/** Months still discounted after paying an invoice (null = forever). */
export function monthsAfter(remaining: number | null, interval: BillingInterval): number | null {
  if (remaining === null) return null;
  return Math.max(0, remaining - monthsCovered(interval));
}
