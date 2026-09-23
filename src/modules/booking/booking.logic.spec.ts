import type { TaxComponent } from '../folios/tax.logic.js';
import {
  cancellationOutcome,
  checkStayDates,
  commissionFor,
  commissionReversal,
  displayStatus,
  effectiveCommissionBps,
  freeCancellationUntil,
  HOLD_EXPIRED_REASON,
  policySummary,
  priceStay,
} from './booking.logic.js';

const VAT: TaxComponent = { code: 'VAT', label: 'VAT', rateBps: 750, inclusive: false };
const LAGOS: TaxComponent = { code: 'CONSUMPTION', label: 'Lagos consumption tax', rateBps: 500, inclusive: false };
const policy = { freeCancellationHours: 48, lateCancellationFeePct: 100, noShowFeePct: 100 };

describe('priceStay (quote tax)', () => {
  it('prices each night like the folio: rate x nights plus exclusive VAT', () => {
    const b = priceStay({ stayType: 'NIGHTLY', rateKobo: 5_000_000, roomTypeName: 'Standard', components: [VAT], arrivalDate: '2026-10-01', nights: 3 });
    expect(b.units).toBe(3);
    expect(b.lines.map((l) => l.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(b.lines[0].description).toBe('Standard, night of Thu 1 Oct 2026');
    expect(b.roomSubtotalKobo).toBe(15_000_000);
    expect(b.taxes).toEqual([{ ...VAT, amountKobo: 1_125_000 }]);
    expect(b.totalKobo).toBe(16_125_000);
    expect(b.firstNightTotalKobo).toBe(5_375_000);
  });

  it('sums several components, each on the net amount (no tax on tax)', () => {
    const b = priceStay({ stayType: 'NIGHTLY', rateKobo: 8_500_000, roomTypeName: 'Deluxe', components: [VAT, LAGOS], arrivalDate: '2026-10-01', nights: 2 });
    expect(b.taxes.map((t) => t.amountKobo)).toEqual([1_275_000, 850_000]);
    expect(b.totalKobo).toBe(17_000_000 + 1_275_000 + 850_000);
  });

  it('carves inclusive taxes out of the rate so the total equals rate x nights', () => {
    const incl: TaxComponent = { ...VAT, inclusive: true };
    const b = priceStay({ stayType: 'NIGHTLY', rateKobo: 1_075_000, roomTypeName: 'Room', components: [incl], arrivalDate: '2026-10-01', nights: 2 });
    expect(b.totalKobo).toBe(2_150_000);
    expect(b.taxes[0].amountKobo).toBe(150_000);
    expect(b.roomSubtotalKobo).toBe(2_000_000);
  });

  it('rounds per night, the same way the night audit posts (not on the total)', () => {
    const b = priceStay({ stayType: 'NIGHTLY', rateKobo: 3_333_333, roomTypeName: 'Room', components: [VAT], arrivalDate: '2026-10-01', nights: 3 });
    expect(b.taxes[0].amountKobo).toBe(3 * Math.round(3_333_333 * 0.075));
  });

  it('prices day use as one block of hours', () => {
    const b = priceStay({ stayType: 'DAY_USE', rateKobo: 1_000_000, roomTypeName: 'Standard', components: [VAT], date: '2026-10-01', hours: 4 });
    expect(b.unit).toBe('HOUR');
    expect(b.lines).toHaveLength(1);
    expect(b.totalKobo).toBe(4_300_000);
  });
});

describe('commission', () => {
  it('uses the plan rate on the marketplace and zero on the booking site', () => {
    expect(effectiveCommissionBps('MARKETPLACE', 800)).toBe(800);
    expect(effectiveCommissionBps('BOOKING_SITE', 800)).toBe(0);
    expect(effectiveCommissionBps('MARKETPLACE', null)).toBe(0);
  });

  it('is a rounded share of the room + tax total', () => {
    expect(commissionFor(19_125_000, 800)).toBe(1_530_000);
    expect(commissionFor(12_345, 1000)).toBe(1_235); // 1234.5 rounds half away from zero
    expect(commissionFor(10_000_000, 0)).toBe(0);
  });

  it('reverses in proportion to the refund and never more than what is left', () => {
    expect(commissionReversal(1_600_000, 0, 20_000_000, 20_000_000)).toBe(1_600_000);
    expect(commissionReversal(1_600_000, 0, 10_000_000, 20_000_000)).toBe(800_000);
    expect(commissionReversal(1_600_000, 800_000, 20_000_000, 20_000_000)).toBe(800_000);
    expect(commissionReversal(1_600_000, 1_600_000, 5_000_000, 20_000_000)).toBe(0);
    expect(commissionReversal(0, 0, 5_000_000, 20_000_000)).toBe(0);
  });
});

describe('cancellation policy', () => {
  const arrivalAt = new Date('2026-10-10T13:00:00.000Z'); // 14:00 Lagos
  const base = { arrivalAt, policy, paidKobo: 20_000_000, firstNightTotalKobo: 10_750_000, paymentMode: 'ONLINE' as const };

  it('is free until freeCancellationHours before check-in', () => {
    const o = cancellationOutcome({ ...base, now: new Date('2026-10-08T12:59:00.000Z') });
    expect(o).toMatchObject({ free: true, feeKobo: 0, refundKobo: 20_000_000, freeCancellationUntil: '2026-10-08T13:00:00.000Z' });
  });

  it('charges the first night (room + taxes) after that and refunds the rest', () => {
    const o = cancellationOutcome({ ...base, now: new Date('2026-10-08T13:00:00.000Z') });
    expect(o).toMatchObject({ free: false, feeKobo: 10_750_000, refundKobo: 9_250_000 });
  });

  it('applies a partial fee percentage and caps the fee at what was paid', () => {
    const half = cancellationOutcome({ ...base, policy: { ...policy, lateCancellationFeePct: 50 }, now: new Date('2026-10-09T00:00:00.000Z') });
    expect(half.feeKobo).toBe(5_375_000);
    const capped = cancellationOutcome({ ...base, paidKobo: 5_000_000, now: new Date('2026-10-09T00:00:00.000Z') });
    expect(capped).toMatchObject({ feeKobo: 5_000_000, refundKobo: 0 });
  });

  it('charges nothing for pay-at-hotel bookings (nothing was paid)', () => {
    const o = cancellationOutcome({ ...base, paymentMode: 'PAY_AT_HOTEL', paidKobo: 0, now: new Date('2026-10-10T10:00:00.000Z') });
    expect(o).toMatchObject({ feeKobo: 0, refundKobo: 0 });
  });

  it('summarises the policy for guests', () => {
    expect(policySummary(policy)).toBe('Free cancellation until 48 hours before check-in. After that, the first night is charged.');
    expect(policySummary({ ...policy, lateCancellationFeePct: 50, freeCancellationHours: 24 })).toBe(
      'Free cancellation until 24 hours before check-in. After that, 50% of the first night is charged.',
    );
    expect(policySummary({ ...policy, lateCancellationFeePct: 0 })).toBe('Free cancellation until check-in time.');
    expect(freeCancellationUntil(arrivalAt, policy, new Date('2026-10-09T00:00:00.000Z'))).toBeNull();
  });
});

describe('displayStatus', () => {
  const now = new Date('2026-10-01T10:00:00.000Z');
  it('distinguishes a live hold, an expired hold and a cancellation', () => {
    expect(displayStatus({ status: 'PENDING', cancelReason: null, holdExpiresAt: new Date('2026-10-01T10:10:00Z'), paymentMode: 'ONLINE' }, now)).toBe('AWAITING_PAYMENT');
    expect(displayStatus({ status: 'PENDING', cancelReason: null, holdExpiresAt: new Date('2026-10-01T09:59:00Z'), paymentMode: 'ONLINE' }, now)).toBe('EXPIRED');
    expect(displayStatus({ status: 'CANCELLED', cancelReason: HOLD_EXPIRED_REASON, holdExpiresAt: null, paymentMode: 'ONLINE' }, now)).toBe('EXPIRED');
    expect(displayStatus({ status: 'CANCELLED', cancelReason: 'Change of plans', holdExpiresAt: null, paymentMode: 'ONLINE' }, now)).toBe('CANCELLED');
    expect(displayStatus({ status: 'CHECKED_OUT', cancelReason: null, holdExpiresAt: null, paymentMode: null }, now)).toBe('COMPLETED');
  });
});

describe('checkStayDates', () => {
  const now = new Date('2026-10-01T10:00:00.000Z');
  it('accepts a normal stay and rejects past, reversed, too long and too far', () => {
    expect(checkStayDates('2026-10-01', '2026-10-03', now)).toBeNull();
    expect(checkStayDates('2026-09-30', '2026-10-02', now)).toMatch(/past/);
    expect(checkStayDates('2026-10-05', '2026-10-05', now)).toMatch(/after check-in/);
    expect(checkStayDates('2026-10-01', '2026-11-15', now)).toMatch(/30 nights/);
    expect(checkStayDates('2027-10-05', '2027-10-06', now)).toMatch(/365/);
  });
});
