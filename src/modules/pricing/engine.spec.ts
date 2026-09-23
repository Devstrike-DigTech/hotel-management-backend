import { easterSunday, nationalEvents, nationalEventsBetween } from './events.js';
import { median, roundPrice, suggest, type EngineInput } from './engine.js';

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
  it('raises the price as the forecast fills, explained in plain language', () => {
    const out = suggest({ ...base, sold: 9, daysOut: 12 });
    expect(out.factors[0]).toMatchObject({ code: 'OCCUPANCY', effectBps: 2000 });
    expect(out.suggestedKobo).toBe(5_750_000); // +20% capped at +15% per day
    expect(out.reason).toBe('90% booked 12 days out -> +15% (capped at +15% per day)');
    expect(out.factors.find((f) => f.code === 'GUARDRAIL')?.effectBps).toBe(-500);
    expect(out.blockedBy).toBeNull();
  });

  it('forecasts with the pickup of the same weekday in past weeks, and reads pace', () => {
    const reference = [
      { otbAtLead: 3, final: 8 },
      { otbAtLead: 3, final: 7 },
      { otbAtLead: 3, final: 8 },
      { otbAtLead: 3, final: 9 },
    ];
    const out = suggest({ ...base, sold: 5, reference });
    // Pickup 5 on top of 5 on the books -> 100% forecast; 20 points ahead of usual pace.
    expect(out.occupancy).toMatchObject({ onTheBooks: 0.5, forecast: 1, paceDeltaPts: 20 });
    expect(out.factors.map((f) => f.code)).toEqual(['OCCUPANCY', 'PACE', 'GUARDRAIL']);
    expect(out.confidence).toBe('HIGH');
    expect(out.reason).toContain('20 points ahead of usual pace');
  });

  it('cuts only close to arrival and never below the floor', () => {
    expect(suggest({ ...base, sold: 1, daysOut: 30 }).blockedBy).toBe('BELOW_MIN_CHANGE');
    const near = suggest({ ...base, sold: 1, daysOut: 2, guardrail: { ...base.guardrail, floorKobo: 4_500_000 } });
    expect(near.factors.map((f) => f.code)).toContain('LEAD_TIME');
    expect(near.suggestedKobo).toBe(4_500_000);
    expect(near.reason).toContain('at the floor of ₦45,000');
  });

  it('adds the strongest event, weekend nights and half the competitor gap', () => {
    const out = suggest({
      ...base,
      date: '2026-10-02', // Friday
      sold: 7,
      events: [{ name: 'Independence Day weekend', upliftBps: 1800 }, { name: 'Small fair', upliftBps: 500 }],
      competitorKobo: [7_000_000, 8_000_000, 6_000_000],
      guardrail: { ...base.guardrail, maxDailyChangeBps: 10_000 },
    });
    const codes = Object.fromEntries(out.factors.map((f) => [f.code, f.effectBps]));
    expect(codes).toMatchObject({ OCCUPANCY: 600, DAY_OF_WEEK: 300, EVENT: 1800, COMPETITOR: 1000 });
    expect(out.reason).toContain('Independence Day weekend: +18%');
    expect(out.suggestedKobo).toBe(roundPrice(5_000_000 * 1.37));
  });

  it('leaves frozen nights and manual overrides alone, and respects the ceiling', () => {
    expect(suggest({ ...base, sold: 10, frozen: true }).blockedBy).toBe('FROZEN');
    expect(suggest({ ...base, sold: 10, manualOverride: true }).blockedBy).toBe('MANUAL_OVERRIDE');
    const capped = suggest({ ...base, sold: 10, guardrail: { ...base.guardrail, ceilingKobo: 5_400_000 } });
    expect(capped.suggestedKobo).toBe(5_400_000);
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
    expect([easter.dateFrom, easter.dateTo]).toEqual(['2026-04-03', '2026-04-06']);
  });

  it('marks Eid dates as moon dependent and spans Detty December into January', () => {
    const y = nationalEvents(2026);
    expect(y.find((e) => e.name === 'Eid el-Fitr')).toMatchObject({ moonDependent: true, impact: 'MEDIUM' });
    expect(y.find((e) => e.name === 'Detty December')).toMatchObject({ dateFrom: '2026-12-15', dateTo: '2027-01-05', city: 'Lagos' });
    // Independence Day 2026 is a Thursday: the long weekend runs to Sunday.
    expect(y.find((e) => e.name === 'Independence Day weekend')).toMatchObject({ dateFrom: '2026-10-01', dateTo: '2026-10-04', upliftBps: 1800 });
  });

  it('finds events overlapping a range, including last year\'s Detty December', () => {
    const jan = nationalEventsBetween('2027-01-01', '2027-01-03').map((e) => e.id);
    expect(jan).toEqual(expect.arrayContaining(['national:detty-december-2026', 'national:new-year-2027']));
  });
});
