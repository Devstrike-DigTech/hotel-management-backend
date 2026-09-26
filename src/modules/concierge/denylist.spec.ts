import { deobfuscate, DENYLIST, fold, screen, termPattern } from './denylist.js';

describe('concierge denylist', () => {
  it.each([
    ['Can you send an escort to my room?', 'escort'],
    ['Looking for a HOOK-UP tonight', 'hook up'],
    ['massage with a happy   ending', 'happy ending'],
    ['any call girls around?', 'call girl*'],
    ['runs girl for the weekend', 'runs girl*'],
    ['Prostitution is what I mean', 'prostitut*'],
    ['Please could you find us some weed for tonight?', 'weed'],
    ['a bit of cocaine', 'cocaine'],
    ['where can I buy a gun', 'gun'],
    ['sports betting lounge', 'betting'],
    ['I need a fake ID', 'fake id'],
    ['companionship for the evening', 'companionship'],
  ])('flags %s', (text, term) => {
    const r = screen([text]);
    expect(r.flagged).toBe(true);
    expect(r.terms).toContain(term);
  });

  it('sees through letter substitutions, accents and spaced-out letters', () => {
    expect(screen(['3sc0rt service']).terms).toContain('escort');
    expect(screen(['s3x']).terms).toContain('sex');
    expect(screen(['e s c o r t please']).terms).toContain('escort');
    expect(screen(['s.e.x']).terms).toContain('sex');
    expect(screen(['éscort']).terms).toContain('escort');
  });

  it('uses word boundaries (no false positives inside ordinary words)', () => {
    for (const text of [
      'Sussex Road, Essex House',
      'Weedon Street pickup',
      'A gunmetal grey car',
      'Sexton, the author',
      'The escortment of bags', // "escort" must stand as its own word
    ]) {
      expect(screen([text]).flagged).toBe(false);
    }
  });

  it('leaves ordinary lawful hotel requests alone', () => {
    for (const text of [
      'In-room massage, 90 minutes, deep tissue, female therapist preferred',
      'Romantic room set-up with roses, candles and a cake for our anniversary date night',
      'Private chef dinner: Igbo cuisine, ofe onugbu and pounded yam',
      'A bottle of Coke and a Molly-themed birthday cake for my daughter Molly',
      'Babysitter for two children, nude lip colour for the make-up, naked cake for the party',
      'Car with driver to the Lekki Arts and Crafts Market, then a table at a rooftop lounge',
      'Licensed security company, armed police officers for the drive',
      'Interpreter who speaks Yoruba and French for a business meeting',
    ]) {
      expect(screen([text])).toMatchObject({ flagged: false, matches: [] });
    }
  });

  it('reports each term once, with an excerpt and a category', () => {
    const r = screen(['weed and more weed', 'WEED again', 'and a gun']);
    expect(r.terms).toEqual(['weed', 'gun']);
    expect(r.categories.sort()).toEqual(['DRUGS', 'WEAPONS']);
    expect(r.matches[0]!.excerpt).toContain('weed');
  });

  it('ignores empty input', () => {
    expect(screen([null, undefined, '', '   '])).toEqual({ flagged: false, matches: [], terms: [], categories: [] });
  });

  it('keeps the list well formed (lower case, no duplicates, compiles)', () => {
    const terms = DENYLIST.map((t) => t.term);
    expect(new Set(terms).size).toBe(terms.length);
    for (const t of terms) {
      expect(t).toBe(t.toLowerCase().trim());
      expect(() => termPattern(t)).not.toThrow();
    }
  });

  it('folds and deobfuscates predictably', () => {
    expect(fold('  Crème   BRÛLÉE ')).toBe('creme brulee');
    expect(deobfuscate('room 101 for 4 guests')).toBe('room 101 for 4 guests');
    expect(deobfuscate('c0ca1ne')).toBe('cocaine');
  });
});
