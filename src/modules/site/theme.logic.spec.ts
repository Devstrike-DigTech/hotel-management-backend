import { FONT_PAIRINGS, TEMPLATES, templateById } from './site.registry.js';
import { gateViolation, normaliseDraft, sectionsCustomised, switchTemplate, themeChanges, validateSections } from './theme.logic.js';

const STARTER = ['brand_kit'];
const GROWTH = ['brand_kit', 'site_templates_all', 'site_sections'];
const PRO = [...GROWTH, 'site_fonts'];

describe('template registry', () => {
  it('has six templates, two of them on every plan, each with valid default sections', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(['editorial', 'boutique', 'business', 'resort', 'heritage', 'essentials']);
    expect(TEMPLATES.filter((t) => t.feature === null).map((t) => t.id).sort()).toEqual(['editorial', 'essentials']);
    for (const t of TEMPLATES) {
      expect(t.defaultSections.length).toBeGreaterThan(0);
      for (const s of t.defaultSections) expect(t.sections).toContain(s.key);
      expect(validateSections(t.defaultSections, t, 'http://localhost:4000')).toEqual([]);
      expect(FONT_PAIRINGS.some((p) => p.id === t.defaultFontPairingId)).toBe(true);
    }
  });
});

describe('normaliseDraft', () => {
  it('fills a migrated row (sections null) from the template defaults', () => {
    const d = normaliseDraft({ templateId: 'editorial', brand: { primary: '#b4452a' }, sections: null });
    expect(d.brand.primary).toBe('#B4452A');
    expect(d.sections).toEqual(templateById('editorial')!.defaultSections);
    expect(d.colourMode).toBe(templateById('editorial')!.defaultColourMode);
  });

  it('falls back to Editorial and the house colour for junk input', () => {
    const d = normaliseDraft({ templateId: 'nope', brand: { primary: 'red', fontPairingId: 'comic-sans' } });
    expect(d.templateId).toBe('editorial');
    expect(d.brand.primary).toMatch(/^#[0-9A-F]{6}$/);
    expect(d.brand.fontPairingId).toBeNull();
  });
});

describe('plan gates', () => {
  it('Starter may publish Editorial and Essentials with default sections only', () => {
    expect(gateViolation(normaliseDraft({ templateId: 'essentials' }), STARTER)).toBeNull();
    expect(gateViolation(normaliseDraft({ templateId: 'editorial' }), STARTER)).toBeNull();
    expect(gateViolation(normaliseDraft({ templateId: 'boutique' }), STARTER)).toBe('site_templates_all');
    expect(gateViolation(normaliseDraft({ templateId: 'boutique' }), GROWTH)).toBeNull();
  });

  it('customised sections or colour mode need site_sections', () => {
    const d = normaliseDraft({ templateId: 'essentials' });
    const reordered = { ...d, sections: [...d.sections].reverse().map((s, i) => ({ ...s, order: i })) };
    expect(sectionsCustomised(reordered.sections, templateById('essentials')!)).toBe(true);
    expect(gateViolation(reordered, STARTER)).toBe('site_sections');
    expect(gateViolation(reordered, GROWTH)).toBeNull();
    expect(gateViolation({ ...d, colourMode: 'DARK' }, STARTER)).toBe('site_sections');
  });

  it('a non-default font pairing needs site_fonts (Pro)', () => {
    const d = normaliseDraft({ templateId: 'business', brand: { fontPairingId: 'cormorant-manrope' } });
    expect(gateViolation(d, GROWTH)).toBe('site_fonts');
    expect(gateViolation(d, PRO)).toBeNull();
    const own = normaliseDraft({ templateId: 'business', brand: { fontPairingId: templateById('business')!.defaultFontPairingId } });
    expect(gateViolation(own, GROWTH)).toBeNull();
  });

  it('without brand_kit nothing can be published', () => {
    expect(gateViolation(normaliseDraft({}), [])).toBe('brand_kit');
  });
});

describe('switchTemplate', () => {
  it('uses the new template defaults and keeps options of sections with the same id', () => {
    const d = normaliseDraft({ templateId: 'editorial' });
    const hero = d.sections.find((s) => s.key === 'hero')!;
    const edited = d.sections.map((s) => (s.id === hero.id ? { ...s, options: { headline: 'Palm wine at sundown' } } : s));
    const to = templateById('boutique')!;
    const out = switchTemplate(edited, to);
    expect(out.map((s) => s.key)).toEqual(to.defaultSections.map((s) => s.key));
    const kept = out.find((s) => s.id === hero.id);
    if (kept) expect(kept.options).toEqual({ headline: 'Palm wine at sundown' });
    expect(out.map((s) => s.order)).toEqual(out.map((_, i) => i));
  });
});

describe('validateSections', () => {
  it('rejects unknown options and oversize text', () => {
    const tpl = templateById('editorial')!;
    const d = normaliseDraft({ templateId: 'editorial' });
    const hero = d.sections.find((s) => s.key === 'hero')!;
    const bad = d.sections.map((s) => (s.id === hero.id ? { ...s, options: { headline: 'x'.repeat(200), colour: 'red' } } : s));
    expect(validateSections(bad, tpl, 'http://localhost:4000').length).toBeGreaterThan(0);
  });
});

describe('themeChanges', () => {
  it('lists template and colour changes for the publish dialog', () => {
    const a = normaliseDraft({ templateId: 'editorial', brand: { primary: '#B4452A' } });
    const b = normaliseDraft({ templateId: 'boutique', brand: { primary: '#1D3557' } });
    const changes = themeChanges(b, a);
    expect(changes.some((c) => c.startsWith('Template:'))).toBe(true);
    expect(changes.some((c) => c.startsWith('Primary colour:'))).toBe(true);
    expect(themeChanges(a, null)).toEqual(['First publication']);
  });
});
