import type { TaxCode } from '../../generated/prisma/enums.js';

export interface TaxComponent {
  code: TaxCode;
  label: string;
  rateBps: number;
  inclusive: boolean;
}

export interface TaxLine extends TaxComponent {
  amountKobo: number;
}

export interface ChargeBreakdown {
  /** The amount staff entered (tax-inclusive for inclusive components). */
  enteredKobo: number;
  /** Net line posted as the ROOM / DAY_USE / EXTRA / DISCOUNT entry. */
  netKobo: number;
  /** One line per enabled component (zero-rate components are omitted). */
  lines: TaxLine[];
  /** netKobo + every tax line = what the guest pays for this charge. */
  grossKobo: number;
}

export interface TaxSettingsLike {
  vatEnabled: boolean;
  vatRateBps: number;
  vatInclusive: boolean;
  consumptionEnabled: boolean;
  consumptionRateBps: number;
  consumptionInclusive: boolean;
  consumptionLabel: string;
  serviceChargeEnabled: boolean;
  serviceChargeRateBps: number;
  serviceChargeInclusive: boolean;
}

/** Round to the nearest kobo, halves away from zero (symmetrical for refunds and discounts). */
export function roundKobo(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/** Enabled components in posting order: service charge, VAT, consumption tax. */
export function componentsFrom(s: TaxSettingsLike): TaxComponent[] {
  const out: TaxComponent[] = [];
  if (s.serviceChargeEnabled && s.serviceChargeRateBps > 0) {
    out.push({ code: 'SERVICE_CHARGE', label: 'Service charge', rateBps: s.serviceChargeRateBps, inclusive: s.serviceChargeInclusive });
  }
  if (s.vatEnabled && s.vatRateBps > 0) {
    out.push({ code: 'VAT', label: 'VAT', rateBps: s.vatRateBps, inclusive: s.vatInclusive });
  }
  if (s.consumptionEnabled && s.consumptionRateBps > 0) {
    out.push({ code: 'CONSUMPTION', label: s.consumptionLabel || 'Consumption tax', rateBps: s.consumptionRateBps, inclusive: s.consumptionInclusive });
  }
  return out;
}

/**
 * Splits an entered amount into a net line and tax lines.
 *
 * Every component is computed on the net amount (no tax on tax):
 *   net   = entered / (1 + sum of inclusive rates)
 *   tax_i = round(net * rate_i)
 * Inclusive taxes are carved out of the entered amount (the net line absorbs
 * the rounding remainder, so net + inclusive taxes == entered exactly).
 * Exclusive taxes are added on top. Negative amounts (discounts) mirror
 * positive ones exactly.
 */
export function computeCharge(enteredKobo: number, components: TaxComponent[]): ChargeBreakdown {
  if (!Number.isSafeInteger(enteredKobo)) throw new Error('amount must be an integer number of kobo');
  const sign = enteredKobo < 0 ? -1 : 1;
  const entered = Math.abs(enteredKobo);
  const inclusiveBps = components.filter((c) => c.inclusive).reduce((a, c) => a + c.rateBps, 0);
  const netEstimate = Math.round((entered * 10_000) / (10_000 + inclusiveBps));

  const inclusiveLines = components
    .filter((c) => c.inclusive)
    .map((c) => ({ ...c, amountKobo: Math.round((netEstimate * c.rateBps) / 10_000) }));
  const net = entered - inclusiveLines.reduce((a, l) => a + l.amountKobo, 0);
  const exclusiveLines = components
    .filter((c) => !c.inclusive)
    .map((c) => ({ ...c, amountKobo: Math.round((net * c.rateBps) / 10_000) }));

  // Keep the configured order for display.
  const byCode = new Map([...inclusiveLines, ...exclusiveLines].map((l) => [l.code, l]));
  const lines = components
    .map((c) => byCode.get(c.code)!)
    .filter((l) => l.amountKobo !== 0)
    .map((l) => ({ ...l, amountKobo: sign * l.amountKobo }));

  const netKobo = sign * net;
  const grossKobo = netKobo + lines.reduce((a, l) => a + l.amountKobo, 0);
  return { enteredKobo, netKobo, lines, grossKobo };
}
