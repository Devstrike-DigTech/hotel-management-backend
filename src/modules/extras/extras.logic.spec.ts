import { componentsFrom, type TaxSettingsLike } from '../folios/tax.logic.js';
import type { PriceBreakdown } from '../booking/booking.logic.js';
import {
  canMove,
  checkPickupDetails,
  extraRuleIssue,
  priceExtra,
  quoteTransfer,
  withAddOns,
  withinHours,
  type ExtraLike,
  type PickupPointLike,
  type StayInfo,
} from './extras.logic.js';

const VAT: TaxSettingsLike = {
  vatEnabled: true, vatRateBps: 750, vatInclusive: false,
  consumptionEnabled: false, consumptionRateBps: 500, consumptionInclusive: false, consumptionLabel: 'Lagos consumption tax',
  serviceChargeEnabled: false, serviceChargeRateBps: 1000, serviceChargeInclusive: false,
};
const comps = componentsFrom(VAT);

const stay: StayInfo = { arrivalDate: '2026-10-10', departureDate: '2026-10-13', arrivalAt: new Date('2026-10-10T14:00:00+01:00'), nights: 3, adults: 2, children: 1, dayUse: false };

function extra(p: Partial<ExtraLike>): ExtraLike {
  return { id: 'e1', name: 'Breakfast buffet', category: 'FOOD', kind: 'STANDARD', pricing: 'PER_STAY', priceKobo: 1_000_000, maxUnits: null, taxable: true, channels: ['MARKETPLACE', 'BOOKING_SITE', 'FRONT_DESK'], availability: {}, dailyCap: null, leadTimeHours: 0, active: true, ...p };
}

const point = (p: Partial<PickupPointLike> = {}): PickupPointLike => ({
  id: 'p1', name: 'Murtala Muhammed International Airport', shortName: 'MMIA', kind: 'AIRPORT', city: 'Lagos', priceKobo: 2_500_000, dropOffPriceKobo: 2_200_000,
  vehicleOptions: [{ id: 'saloon', name: 'Saloon car', maxPassengers: 3, priceKobo: null }, { id: 'bus', name: 'Toyota Hiace bus', maxPassengers: 10, priceKobo: 5_000_000 }],
  leadTimeHours: 6, operatingHours: null, taxable: true, active: true, ...p,
});

describe('priceExtra', () => {
  it('PER_STAY, PER_NIGHT and PER_UNIT with exclusive VAT', () => {
    expect(priceExtra(extra({ pricing: 'PER_STAY' }), { extraId: 'e1' }, stay, comps, 'x').quoted).toMatchObject({ amountKobo: 1_000_000, taxKobo: 75_000, totalKobo: 1_075_000, serviceDates: ['2026-10-10'] });
    const night = priceExtra(extra({ pricing: 'PER_NIGHT' }), { extraId: 'e1' }, stay, comps, 'x').quoted!;
    expect(night).toMatchObject({ amountKobo: 3_000_000, nights: 3, totalKobo: 3_225_000 });
    expect(night.serviceDates).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
    expect(priceExtra(extra({ pricing: 'PER_UNIT', maxUnits: 3 }), { extraId: 'e1', quantity: 2 }, stay, comps, 'x').quoted).toMatchObject({ quantity: 2, amountKobo: 2_000_000 });
  });

  it('PER_PERSON_PER_NIGHT multiplies persons by nights and defaults to every guest', () => {
    const all = priceExtra(extra({ pricing: 'PER_PERSON_PER_NIGHT', priceKobo: 950_000 }), { extraId: 'e1' }, stay, comps, 'x').quoted!;
    expect(all).toMatchObject({ persons: 3, nights: 3, amountKobo: 950_000 * 9, taxKobo: Math.round(950_000 * 9 * 0.075) });
    expect(all.description).toBe('Breakfast buffet, 3 people x 3 nights');
    const two = priceExtra(extra({ pricing: 'PER_PERSON_PER_NIGHT', priceKobo: 950_000 }), { extraId: 'e1', quantity: 2 }, stay, comps, 'x').quoted!;
    expect(two.amountKobo).toBe(950_000 * 6);
    expect(priceExtra(extra({ pricing: 'PER_PERSON' }), { extraId: 'e1', quantity: 4 }, stay, comps, 'x').issues).toEqual([expect.objectContaining({ code: 'MAX' })]);
  });

  it('no tax on a non-taxable extra; inclusive VAT carved out', () => {
    expect(priceExtra(extra({ taxable: false }), { extraId: 'e1' }, stay, comps, 'x').quoted).toMatchObject({ taxKobo: 0, totalKobo: 1_000_000 });
    const inc = priceExtra(extra({ priceKobo: 1_075_000 }), { extraId: 'e1' }, stay, componentsFrom({ ...VAT, vatInclusive: true }), 'x').quoted!;
    expect(inc).toMatchObject({ netKobo: 1_000_000, taxKobo: 75_000, totalKobo: 1_075_000 });
  });

  it('refuses more units than allowed', () => {
    expect(priceExtra(extra({ pricing: 'PER_UNIT', maxUnits: 2 }), { extraId: 'e1', quantity: 3 }, stay, comps, 'x').issues).toEqual([expect.objectContaining({ code: 'MAX', meta: { max: 2 } })]);
  });
});

describe('extraRuleIssue', () => {
  const now = new Date('2026-10-09T18:00:00+01:00');
  it('checks channel, window, minimum nights, day-use and lead time', () => {
    expect(extraRuleIssue(extra({ channels: ['FRONT_DESK'] }), 'BOOKING_SITE', stay, now, { enforceLeadTime: true })?.code).toBe('NOT_AVAILABLE');
    expect(extraRuleIssue(extra({ availability: { validTo: '2026-10-01' } }), 'BOOKING_SITE', stay, now, { enforceLeadTime: true })?.code).toBe('OUT_OF_WINDOW');
    expect(extraRuleIssue(extra({ availability: { minNights: 4 } }), 'BOOKING_SITE', stay, now, { enforceLeadTime: true })?.code).toBe('OUT_OF_WINDOW');
    expect(extraRuleIssue(extra({ kind: 'LATE_CHECK_OUT' }), 'BOOKING_SITE', { ...stay, dayUse: true }, now, { enforceLeadTime: true })?.code).toBe('NOT_AVAILABLE');
    expect(extraRuleIssue(extra({ leadTimeHours: 48 }), 'BOOKING_SITE', stay, now, { enforceLeadTime: true })?.code).toBe('LEAD_TIME');
    expect(extraRuleIssue(extra({ leadTimeHours: 48 }), 'FRONT_DESK', stay, now, { enforceLeadTime: false })).toBeNull();
    expect(extraRuleIssue(extra({ active: false }), 'BOOKING_SITE', stay, now, { enforceLeadTime: true })?.code).toBe('INACTIVE');
  });
});

describe('quoteTransfer', () => {
  const now = new Date('2026-10-09T08:00:00+01:00');
  const sel = { direction: 'ARRIVAL' as const, pickupPointId: 'p1', passengers: 2, scheduledAt: '2026-10-10T11:20:00+01:00' };

  it('prices an arrival pickup (first vehicle) and a drop-off (drop-off price)', () => {
    expect(quoteTransfer(point(), sel, stay, comps, 't', now, { enforceLeadTime: true }).quoted).toMatchObject({ amountKobo: 2_500_000, taxKobo: 187_500, totalKobo: 2_687_500, vehicleOptionId: 'saloon', description: 'Airport pickup: MMIA, Saloon car' });
    const dep = quoteTransfer(point(), { ...sel, direction: 'DEPARTURE', scheduledAt: '2026-10-13T09:00:00+01:00' }, stay, comps, 't', now, { enforceLeadTime: true });
    expect(dep.quoted).toMatchObject({ amountKobo: 2_200_000, description: 'Airport drop-off: MMIA, Saloon car' });
    expect(quoteTransfer(point(), { ...sel, vehicleOptionId: 'bus' }, stay, comps, 't', now, { enforceLeadTime: true }).quoted?.amountKobo).toBe(5_000_000);
  });

  it('enforces the lead time online, not at the desk', () => {
    const late = new Date('2026-10-10T08:00:00+01:00');
    const r = quoteTransfer(point(), sel, stay, comps, 't', late, { enforceLeadTime: true, hotelPhone: '+234 802 555 0142' });
    expect(r.issues).toEqual([expect.objectContaining({ code: 'LEAD_TIME', meta: expect.objectContaining({ leadTimeHours: 6 }) })]);
    expect(r.issues[0]!.message).toContain('+234 802 555 0142');
    expect(quoteTransfer(point(), sel, stay, comps, 't', late, { enforceLeadTime: false }).issues).toEqual([]);
  });

  it('checks the day window, the vehicle size and the operating hours', () => {
    expect(quoteTransfer(point(), { ...sel, scheduledAt: '2026-10-12T11:00:00+01:00' }, stay, comps, 't', now, { enforceLeadTime: false }).issues[0]?.code).toBe('OUT_OF_WINDOW');
    expect(quoteTransfer(point(), { ...sel, scheduledAt: '2026-10-09T21:00:00+01:00' }, stay, comps, 't', now, { enforceLeadTime: false }).issues).toEqual([]);
    const big = quoteTransfer(point(), { ...sel, passengers: 5 }, stay, comps, 't', now, { enforceLeadTime: false });
    expect(big.issues).toEqual([expect.objectContaining({ code: 'TOO_MANY_PASSENGERS', meta: { max: 3 } })]);
    expect(big.issues[0]!.message).toContain('Toyota Hiace bus');
    const park = point({ kind: 'MOTOR_PARK', shortName: 'Jibowu', operatingHours: { open: '06:00', close: '21:00' } });
    expect(quoteTransfer(park, { ...sel, scheduledAt: '2026-10-10T22:30:00+01:00' }, stay, comps, 't', now, { enforceLeadTime: false }).issues[0]?.code).toBe('OUTSIDE_HOURS');
    expect(quoteTransfer(point({ active: false }), sel, stay, comps, 't', now, { enforceLeadTime: false }).issues[0]?.code).toBe('INACTIVE');
  });

  it('operating hours may run past midnight', () => {
    expect(withinHours({ open: '20:00', close: '02:00' }, new Date('2026-10-10T01:00:00+01:00'))).toBe(true);
    expect(withinHours({ open: '20:00', close: '02:00' }, new Date('2026-10-10T12:00:00+01:00'))).toBe(false);
    expect(withinHours(null, new Date())).toBe(true);
  });
});

describe('checkPickupDetails by kind', () => {
  const ctx = { transportCompanyIds: new Set(['abc-transport']), trainRouteIds: new Set(['lagos-ibadan']) };
  it('airport: airline and a flight number', () => {
    expect(checkPickupDetails('AIRPORT', { airline: 'Air Peace', flightNumber: 'p4 7121' }, 'd', ctx)).toEqual({ value: { airline: 'Air Peace', flightNumber: 'P4 7121', terminal: null }, issues: [] });
    const bad = checkPickupDetails('AIRPORT', { airline: 'Air Peace', flightNumber: 'tomorrow' }, 'd', ctx).issues;
    expect(bad).toEqual([expect.objectContaining({ path: 'd.flightNumber', code: 'PATTERN' })]);
    expect(checkPickupDetails('AIRPORT', {}, 'd', ctx).issues.map((i) => i.code)).toEqual(['REQUIRED', 'REQUIRED']);
  });
  it('motor park: a listed company or Other, and the departure city', () => {
    expect(checkPickupDetails('MOTOR_PARK', { transportCompanyId: 'abc-transport', departureCity: 'Enugu' }, 'd', ctx).issues).toEqual([]);
    expect(checkPickupDetails('MOTOR_PARK', { transportCompanyId: 'nope', departureCity: 'Enugu' }, 'd', ctx).issues[0]?.code).toBe('INVALID_OPTION');
    expect(checkPickupDetails('MOTOR_PARK', { departureCity: 'Enugu' }, 'd', ctx).issues[0]).toMatchObject({ path: 'd.transportCompanyOther', code: 'REQUIRED' });
  });
  it('train station: a listed route or Other; other kinds: free text', () => {
    expect(checkPickupDetails('TRAIN_STATION', { trainRouteId: 'lagos-ibadan', trainService: 'Express' }, 'd', ctx).issues).toEqual([]);
    expect(checkPickupDetails('TRAIN_STATION', {}, 'd', ctx).issues[0]).toMatchObject({ path: 'd.routeOther', code: 'REQUIRED' });
    expect(checkPickupDetails('JETTY', { details: 'The 16:30 ferry from Ikorodu' }, 'd', ctx).issues).toEqual([]);
    expect(checkPickupDetails('JETTY', {}, 'd', ctx).issues[0]?.code).toBe('REQUIRED');
  });
});

describe('transfer status flow', () => {
  it('moves forward only', () => {
    expect(canMove('REQUESTED', 'CONFIRMED')).toBe(true);
    expect(canMove('CONFIRMED', 'DRIVER_ASSIGNED')).toBe(true);
    expect(canMove('DRIVER_ASSIGNED', 'EN_ROUTE')).toBe(true);
    expect(canMove('EN_ROUTE', 'PICKED_UP')).toBe(true);
    expect(canMove('PICKED_UP', 'COMPLETED')).toBe(true);
    expect(canMove('REQUESTED', 'COMPLETED')).toBe(false);
    expect(canMove('COMPLETED', 'CANCELLED')).toBe(false);
    expect(canMove('PICKED_UP', 'NO_SHOW')).toBe(false);
  });
});

describe('withAddOns', () => {
  const room: PriceBreakdown = {
    nights: [], subtotalKobo: 10_000_000, discountKobo: 0, taxes: [{ code: 'VAT', label: 'VAT', rateBps: 750, inclusive: false, amountKobo: 750_000 }], taxTotalKobo: 750_000, totalKobo: 10_750_000,
  } as unknown as PriceBreakdown;

  it('adds add-on net and tax to the total and merges tax lines', () => {
    const b = withAddOns(room, [
      { kind: 'EXTRA', refId: 'e1', description: 'Breakfast', amountKobo: 3_000_000, netKobo: 3_000_000, taxKobo: 225_000, totalKobo: 3_225_000, taxes: [{ code: 'VAT', label: 'VAT', rateBps: 750, inclusive: false, amountKobo: 225_000 }] },
      { kind: 'TRANSFER', refId: 'p1', description: 'Airport pickup', amountKobo: 2_500_000, netKobo: 2_500_000, taxKobo: 187_500, totalKobo: 2_687_500, taxes: [{ code: 'VAT', label: 'VAT', rateBps: 750, inclusive: false, amountKobo: 187_500 }] },
    ]);
    expect(b.roomTotalKobo).toBe(10_750_000);
    expect(b.addOnsSubtotalKobo).toBe(5_500_000);
    expect(b.addOnsTaxKobo).toBe(412_500);
    expect(b.totalKobo).toBe(10_750_000 + 5_500_000 + 412_500);
    expect(b.taxes).toEqual([{ code: 'VAT', label: 'VAT', rateBps: 750, inclusive: false, amountKobo: 1_162_500 }]);
    expect(b.addOns[0]).not.toHaveProperty('taxes');
  });

  it('without add-ons the totals are unchanged', () => {
    const b = withAddOns(room, []);
    expect(b.totalKobo).toBe(room.totalKobo);
    expect(b.addOns).toEqual([]);
  });
});
