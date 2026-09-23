import type { BillingInterval } from '../../generated/prisma/enums.js';

/** Adds whole calendar months in UTC, clamping to the month's last day. */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export function addInterval(date: Date, interval: BillingInterval): Date {
  return addMonths(date, interval === 'YEARLY' ? 12 : 1);
}

export function priceFor(
  plan: { priceMonthlyKobo: number | null; priceYearlyKobo: number | null },
  interval: BillingInterval,
): number | null {
  return interval === 'YEARLY' ? plan.priceYearlyKobo : plan.priceMonthlyKobo;
}
