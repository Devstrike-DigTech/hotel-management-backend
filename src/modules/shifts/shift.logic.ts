import type { FolioEntryType, PaymentMethod } from '../../generated/prisma/enums.js';

export interface ShiftMovement {
  type: FolioEntryType; // PAYMENT, REFUND, or VOID of one of those
  method: PaymentMethod | null;
  /** Signed ledger amount (payments negative, refunds positive, voids mirror). */
  amountKobo: number;
}

export interface ShiftExpected {
  expectedCashKobo: number;
  expectedPosKobo: number;
  expectedTransferKobo: number;
  paymentsCount: number;
}

export interface ShiftVariance {
  varianceCashKobo: number;
  variancePosKobo: number;
  varianceTransferKobo: number;
  varianceTotalKobo: number;
}

/** ₦500: variance strictly beyond this on any method raises SHIFT_VARIANCE. */
export const VARIANCE_THRESHOLD_KOBO = 50_000;
/** ₦5,000: above this the flag is HIGH. */
export const VARIANCE_HIGH_KOBO = 500_000;

/**
 * Money the drawer / terminals should hold. Ledger signs are inverted: a
 * payment is a negative folio entry but money in; a refund positive, money out.
 * VOID entries carry the method of what they void, so voided payments cancel.
 */
export function expectedTotals(openingFloatKobo: number, movements: ShiftMovement[]): ShiftExpected {
  const sum = (m: PaymentMethod) =>
    movements.filter((x) => x.method === m).reduce((a, x) => a - x.amountKobo, 0);
  return {
    expectedCashKobo: openingFloatKobo + sum('CASH'),
    expectedPosKobo: sum('POS'),
    expectedTransferKobo: sum('TRANSFER'),
    paymentsCount: movements.filter((m) => m.type === 'PAYMENT').length,
  };
}

export function variance(
  expected: ShiftExpected,
  counted: { countedCashKobo: number; declaredPosKobo: number; declaredTransferKobo: number },
): ShiftVariance {
  const varianceCashKobo = counted.countedCashKobo - expected.expectedCashKobo;
  const variancePosKobo = counted.declaredPosKobo - expected.expectedPosKobo;
  const varianceTransferKobo = counted.declaredTransferKobo - expected.expectedTransferKobo;
  return {
    varianceCashKobo,
    variancePosKobo,
    varianceTransferKobo,
    varianceTotalKobo: varianceCashKobo + variancePosKobo + varianceTransferKobo,
  };
}

/** Sum of naira denominations ({ "1000": 3, "500": 2 }) in kobo. */
export function denominationTotalKobo(denominations: Record<string, number>): number {
  return Object.entries(denominations).reduce((a, [note, count]) => a + Number(note) * 100 * count, 0);
}
