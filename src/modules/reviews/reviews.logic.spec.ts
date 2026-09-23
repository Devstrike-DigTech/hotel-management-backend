import { aggregate, displayName, looksLikePii, stayMonth } from './reviews.logic.js';

describe('reviews logic', () => {
  it('shows first name and last initial', () => {
    expect(displayName('Chiamaka Okonkwo')).toBe('Chiamaka O.');
    expect(displayName('  funke   akindele-bello ')).toBe('Funke A.');
    expect(displayName('Tunde')).toBe('Tunde');
    expect(displayName('')).toBe('Guest');
  });

  it('spots phone numbers and emails in review text', () => {
    expect(looksLikePii('Call me on 0803 123 4567 anytime')).toBe(true);
    expect(looksLikePii('whatsapp +234-812-555-0100')).toBe(true);
    expect(looksLikePii('write to ada@example.ng')).toBe(true);
    expect(looksLikePii('Room 205 was lovely, 10/10, stayed 3 nights in 2026')).toBe(false);
  });

  it('aggregates averages, stars and traveller types', () => {
    const a = aggregate([
      { overall: 5, cleanliness: 5, service: 4, location: 5, value: 4, travellerType: 'COUPLE' },
      { overall: 4, cleanliness: 4, service: 4, location: 5, value: 3, travellerType: 'BUSINESS' },
      { overall: 2, cleanliness: 3, service: 2, location: 4, value: 2, travellerType: 'BUSINESS' },
    ]);
    expect(a).toMatchObject({ rating: 3.7, count: 3, cleanliness: 4, service: 3.3, location: 4.7, value: 3 });
    expect(a.stars).toEqual({ '1': 0, '2': 1, '3': 0, '4': 1, '5': 1 });
    expect(a.byTravellerType).toMatchObject({ BUSINESS: 2, COUPLE: 1, FAMILY: 0 });
    expect(aggregate([])).toMatchObject({ rating: null, count: 0 });
    expect(stayMonth('2026-08-14')).toBe('2026-08');
  });
});
