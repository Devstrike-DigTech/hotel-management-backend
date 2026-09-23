import { slugify } from './slug.js';

describe('slugify', () => {
  it('lowercases, strips accents and joins words with dashes', () => {
    expect(slugify('The Palmwine House')).toBe('the-palmwine-house');
    expect(slugify('  Hôtel Élan & Co.  ')).toBe('hotel-elan-and-co');
  });
  it('falls back when nothing usable remains', () => {
    expect(slugify('!!!')).toBe('hotel');
  });
  it('respects the maximum length without a trailing dash', () => {
    const s = slugify('a'.repeat(40) + ' bbbbbbbbbbbb', 42);
    expect(s.length).toBeLessThanOrEqual(42);
    expect(s.endsWith('-')).toBe(false);
  });
});
