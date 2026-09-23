import { dailyAvailability, isFree, maxConcurrent } from './availability.logic.js';

const t = (h: number) => new Date(Date.UTC(2026, 8, 23, h));
const iv = (a: number, b: number) => ({ start: t(a), end: t(b) });

describe('maxConcurrent', () => {
  it('is 0 with no intervals', () => {
    expect(maxConcurrent([], t(0), t(10))).toBe(0);
  });

  it('counts only the part inside the window', () => {
    expect(maxConcurrent([iv(0, 5), iv(6, 9)], t(5), t(6))).toBe(0);
    expect(maxConcurrent([iv(0, 5), iv(4, 9)], t(0), t(10))).toBe(2);
  });

  it('treats touching ranges as not overlapping ([) semantics)', () => {
    expect(maxConcurrent([iv(0, 5), iv(5, 9)], t(0), t(10))).toBe(1);
  });

  it('finds the peak, not the total overlapping', () => {
    // three stays overlap the window but never more than two at once
    expect(maxConcurrent([iv(0, 3), iv(2, 5), iv(4, 8)], t(0), t(10))).toBe(2);
  });
});

describe('isFree', () => {
  it('detects overlap and allows back-to-back stays', () => {
    expect(isFree([iv(10, 12)], t(12), t(14))).toBe(true);
    expect(isFree([iv(10, 13)], t(12), t(14))).toBe(false);
    expect(isFree([iv(15, 20)], t(12), t(15))).toBe(true);
  });
});

describe('dailyAvailability', () => {
  it('subtracts out-of-order rooms and overlapping stays per night', () => {
    const nights = [
      { date: '2026-09-23', start: t(13), end: t(35) },
      { date: '2026-09-24', start: t(37), end: t(59) },
    ];
    const days = dailyAvailability(nights, 5, 1, [iv(13, 35), iv(13, 59), iv(20, 22)]);
    expect(days[0]).toEqual({ date: '2026-09-23', sellable: 4, outOfOrder: 1, booked: 3, available: 1 });
    expect(days[1]).toEqual({ date: '2026-09-24', sellable: 4, outOfOrder: 1, booked: 1, available: 3 });
  });

  it('never reports negative availability', () => {
    const nights = [{ date: '2026-09-23', start: t(13), end: t(35) }];
    expect(dailyAvailability(nights, 1, 1, [iv(13, 35)])[0].available).toBe(0);
  });
});
