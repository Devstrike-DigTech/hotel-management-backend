import { finalise, sumFlashes, type DailyFlash, emptyMethods } from './stats.compute.js';

function day(date: string, roomsSold: number, roomRevenueKobo: number, roomsAvailable = 20): DailyFlash {
  const f = {
    date, live: false, roomsTotal: 24, roomsOutOfOrder: 4, roomsAvailable, roomsSold, occupancyRate: 0, roomNightsPosted: roomsSold, adrKobo: 0, revparKobo: 0,
    roomRevenuePostedKobo: roomRevenueKobo, roomRevenueKobo, dayUseRevenueKobo: 1_000_000, otherRevenueKobo: 500_000, discountKobo: 200_000, taxKobo: 0, serviceChargeKobo: 0,
    totalRevenueKobo: 0, paymentsByMethod: { ...emptyMethods(), CASH: 100 }, paymentsTotalKobo: 100, refundsKobo: 0, dayUseCount: 1,
    arrivals: 1, departures: 1, noShows: 0, cancellations: 0, guestsInHouse: 0, openFlags: 0,
  };
  finalise(f);
  return f;
}

describe('daily flash maths', () => {
  it('derives occupancy, ADR, RevPAR and total revenue', () => {
    const f = day('2026-09-01', 15, 75_000_000);
    expect(f.occupancyRate).toBe(0.75);
    expect(f.adrKobo).toBe(5_000_000);
    expect(f.revparKobo).toBe(3_750_000);
    expect(f.totalRevenueKobo).toBe(75_000_000 + 1_000_000 + 500_000 - 200_000);
  });

  it('handles empty days without dividing by zero', () => {
    const f = day('2026-09-02', 0, 0, 0);
    expect(f.occupancyRate).toBe(0);
    expect(f.adrKobo).toBe(0);
    expect(f.revparKobo).toBe(0);
  });

  it('recomputes ratios from sums over a range', () => {
    const t = sumFlashes([day('2026-09-01', 10, 50_000_000), day('2026-09-02', 20, 90_000_000)]);
    expect(t.roomsSold).toBe(30);
    expect(t.roomsAvailable).toBe(40);
    expect(t.occupancyRate).toBe(0.75);
    expect(t.adrKobo).toBe(Math.round(140_000_000 / 30));
    expect(t.paymentsByMethod.CASH).toBe(200);
  });
});

describe('occupancy vs posted revenue', () => {
  it('counts occupancy from stays but ADR from posted nights only', () => {
    const f = day('2026-09-23', 12, 11_000_000);
    f.roomNightsPosted = 2; // tonight's charges are posted by the night audit later
    finalise(f);
    expect(f.occupancyRate).toBe(0.6);
    expect(f.adrKobo).toBe(5_500_000);
    expect(f.roomRevenueKobo).toBe(f.roomRevenuePostedKobo);
  });
});
