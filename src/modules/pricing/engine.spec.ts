import { easterSunday, holidayNights, nationalEvents, nationalEventsBetween } from './events.js';
import { median, relevantCompetitors, roundPrice, suggest, type EngineInput } from './engine.js';

const base: EngineInput = {
  date: '2026-10-14', // a Wednesday
  currentKobo: 5_000_000,
  capacity: 10,
  sold: 5,
  daysOut: 14,
  reference: [],
  events: [],
  competitorKobo: [],
  guardrail: { enabled: true, floorKobo: 3_500_000, ceilingKobo: 10_000_000, maxDailyChangeBps: 1500 },
  minChangeBps: 300,
  frozen: false,
  manualOverride: false,
};

describe('dynamic pricing engine', () => {
  const history = (otbAtLead: number, final: number) => [1, 2, 3, 4].map(() => ({ otbAtLead, final }));

  it('low demand at normal pace never raises: it holds far out and cuts close in, never below the standard rate without strong evidence', () => {
    // 1 of 10 booked 20 days out; the same nights usually picked up 2 more.
    const hold = suggest({ ...base, sold: 1, daysOut: 30, reference: history(1, 3) });
    expect(hold.changeBps).toBe(0);
    expect(hold.blockedBy).toBe('BELOW_MIN_CHANGE');
    // Weekend season on top of the standard rate: a cut stops at the standard rate.
    const soft = suggest({ ...base, currentKobo: 5_500_000, baseKobo: 5_000_000, sold: 1, daysOut: 14, reference: history(1, 3) });
    expect(soft.suggestedKobo).toBe(5_250_000);
    expect(soft.reason).toBe('10% booked 14 days out; forecast 30% with the usual late bookings -> -5%');
    const season = suggest({ ...base, currentKobo: 5_500_000, baseKobo: 5_000_000, sold: 0, daysOut: 14, reference: history(0, 2) });
    expect(season.suggestedKobo).toBe(5_000_000);
    expect(season.reason).toMatch(/-> -9% \(kept at the standard rate\)$/);
    // Already at the standard rate and not clearly weak: hold.
    expect(suggest({ ...base, sold: 1, daysOut: 14, reference: history(1, 3) }).changeBps).toBe(0);
    // Clearly weak (history, under 30%, within a week): may go below it.
    const weak = suggest({ ...base, sold: 0, daysOut: 4, reference: history(0, 1) });
    expect(weak.suggestedKobo).toBe(4_500_000);
    expect(weak.reason).toMatch(/-> -10%$/);
  });

  it('competitors cannot pull a low-demand night up, and hotel-wide competitor prices only compare with similar rooms', () => {
    const out = suggest({ ...base, sold: 0, daysOut: 25, reference: history(0, 2), competitorKobo: [9_000_000, 9_500_000] });
    expect(out.changeBps).toBe(0);
    expect(out.factors.map((f) => f.code)).not.toContain('COMPETITOR');
    // Not low demand thanks to the usual late pickup, but only 10% on the books: competitors still cannot pull it up.
    const thin = suggest({ ...base, sold: 1, daysOut: 12, reference: history(1, 7), competitorKobo: [7_000_000] });
    expect(thin.changeBps).toBe(0);
    const busy = suggest({ ...base, sold: 5, daysOut: 12, reference: history(5, 7), competitorKobo: [7_000_000] });
    expect(busy.factors.find((f) => f.code === 'COMPETITOR')?.effectBps).toBe(1000);
    const rows = [
      { rateKobo: 6_000_000, roomTypeId: null },
      { rateKobo: 25_000_000, roomTypeId: null },
      { rateKobo: 9_000_000, roomTypeId: 'suite' },
    ];
    expect(relevantCompetitors(5_500_000, rows, 'std')).toEqual([6_000_000]);
    expect(relevantCompetitors(16_000_000, rows, 'suite')).toEqual([25_000_000, 9_000_000]);
  });

  it('raises when the books are full, capped per day, and explains it', () => {
    const out = suggest({ ...base, sold: 9, daysOut: 12 });
    expect(out.factors[0]).toMatchObject({ code: 'OCCUPANCY', effectBps: 2000 });
    expect(out.suggestedKobo).toBe(5_750_000);
    expect(out.reason).toBe('90% booked 12 days out -> +15% (capped at +15% per day)');
  });

  it('raises on a real pace spike (2+ rooms and 10+ points ahead with 30%+ booked), ignores one booking in a small room type', () => {
    const spike = suggest({ ...base, sold: 5, daysOut: 20, reference: history(1, 5) });
    expect(spike.occupancy.paceDeltaPts).toBe(40);
    expect(spike.factors.find((f) => f.code === 'PACE')?.effectBps).toBe(1000);
    expect(spike.changeBps).toBe(1000);
    expect(spike.reason).toContain('40 points ahead of usual pace');
    // Three suites, one booked where none usually are: not a trend.
    const suite = suggest({ ...base, currentKobo: 16_000_000, baseKobo: 16_000_000, capacity: 3, sold: 1, daysOut: 18, reference: history(0, 1), guardrail: { ...base.guardrail, ceilingKobo: 30_000_000, floorKobo: 12_000_000 } });
    expect(suite.changeBps).toBe(0);
  });

  it('applies an event only on its nights, even when the books are thin', () => {
    const on = suggest({ ...base, date: '2026-10-02', sold: 2, daysOut: 9, reference: history(1, 3), events: [{ name: 'Independence Day weekend', upliftBps: 1800 }] });
    expect(on.factors.map((f) => f.code)).toEqual(['EVENT', 'GUARDRAIL']);
    expect(on.changeBps).toBe(1500);
    expect(on.reason).toContain('Independence Day weekend: +18%');
    expect(on.reason).toMatch(/-> \+15%/);
    // The Monday after: no event, low demand -> no raise.
    const after = suggest({ ...base, date: '2026-10-05', sold: 2, daysOut: 12, reference: history(1, 3) });
    expect(after.changeBps).toBeLessThanOrEqual(0);
  });

  it('reads last-minute nights with rooms left, and never flips direction by rounding', () => {
    const near = suggest({ ...base, sold: 1, daysOut: 2, reference: history(1, 2), guardrail: { ...base.guardrail, floorKobo: 4_500_000 } });
    expect(near.factors.map((f) => f.code)).toEqual(['OCCUPANCY', 'LEAD_TIME', 'GUARDRAIL']);
    expect(near.suggestedKobo).toBe(4_500_000);
    expect(near.reason).toContain('rooms left close to arrival');
    const tiny = suggest({ ...base, currentKobo: 5_020_000, sold: 7, daysOut: 10, minChangeBps: 0 });
    expect(tiny.suggestedKobo).toBeGreaterThanOrEqual(5_020_000);
  });

  it('leaves frozen nights and manual overrides alone, and respects the ceiling', () => {
    expect(suggest({ ...base, sold: 10, frozen: true }).blockedBy).toBe('FROZEN');
    expect(suggest({ ...base, sold: 10, manualOverride: true }).blockedBy).toBe('MANUAL_OVERRIDE');
    const capped = suggest({ ...base, sold: 10, guardrail: { ...base.guardrail, ceilingKobo: 5_400_000 } });
    expect(capped.suggestedKobo).toBe(5_400_000);
  });

  it('every reason says the direction it moves', () => {
    for (let sold = 0; sold <= 10; sold++) {
      for (const daysOut of [1, 5, 14, 30, 70]) {
        const o = suggest({ ...base, sold, daysOut, reference: history(Math.max(0, sold - 2), Math.min(10, sold + 1)) });
        const tail = o.reason.split('-> ')[1]!;
        if (o.changeBps > 0) expect(tail.startsWith('+')).toBe(true);
        else if (o.changeBps < 0) expect(tail.startsWith('-')).toBe(true);
        else expect(tail.startsWith('hold')).toBe(true);
        if (o.occupancy.forecast < 0.5 && o.changeBps > 0) throw new Error(`raised at low demand: ${o.reason}`);
      }
    }
  });

  it('rounds to ₦500 and takes medians', () => {
    expect(roundPrice(5_024_999)).toBe(5_000_000);
    expect(roundPrice(5_025_000)).toBe(5_050_000);
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3);
  });
});

describe('Nigerian events calendar', () => {
  it('computes Easter (Western) and the Easter weekend', () => {
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
    const easter = nationalEvents(2026).find((e) => e.id === 'national:easter-2026')!;
    // Nights: Thursday (eve of Good Friday) to Sunday (eve of Easter Monday); not Monday night.
    expect([easter.dateFrom, easter.dateTo]).toEqual(['2026-04-02', '2026-04-05']);
  });

  it('marks Eid dates as moon dependent and spans Detty December into January', () => {
    const y = nationalEvents(2026);
    expect(y.find((e) => e.name === 'Eid el-Fitr')).toMatchObject({ moonDependent: true, impact: 'MEDIUM' });
    expect(y.find((e) => e.name === 'Detty December')).toMatchObject({ dateFrom: '2026-12-15', dateTo: '2027-01-04', city: 'Lagos' });
    // Independence Day 2026 is a Thursday (Friday bridged): nights Wed 30 Sep to Sat 3 Oct, nothing on Sunday night.
    expect(y.find((e) => e.name === 'Independence Day weekend')).toMatchObject({ dateFrom: '2026-09-30', dateTo: '2026-10-03', upliftBps: 1800 });
    expect(y.find((e) => e.name === 'Christmas and Boxing Day')).toMatchObject({ dateFrom: '2026-12-24', dateTo: '2026-12-25' });
  });

  it('turns a holiday into the nights before each day off', () => {
    expect(holidayNights('2027-10-01')).toEqual({ from: '2027-09-30', to: '2027-10-02' }); // Friday
    expect(holidayNights('2029-10-01')).toEqual({ from: '2029-09-28', to: '2029-09-30' }); // Monday
    expect(holidayNights('2030-10-01')).toEqual({ from: '2030-09-27', to: '2030-09-30' }); // Tuesday + bridge
    expect(holidayNights('2025-10-01')).toEqual({ from: '2025-09-30', to: '2025-09-30' }); // Wednesday
    const nights = nationalEventsBetween('2026-10-04', '2026-10-06').filter((e) => e.name === 'Independence Day weekend');
    expect(nights).toEqual([]);
  });

  it('finds events overlapping a range, including last year\'s Detty December', () => {
    const jan = nationalEventsBetween('2026-12-31', '2027-01-03').map((e) => e.id);
    expect(jan).toEqual(expect.arrayContaining(['national:detty-december-2026', 'national:new-year-2027']));
  });
});
