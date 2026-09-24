import { applyColours, contrast, HOUSE, luminance, TEXT_RATIO, UI_RATIO } from './contrast.js';

describe('contrast helpers', () => {
  it('computes WCAG luminance and ratios', () => {
    expect(luminance('#FFFFFF')).toBeCloseTo(1, 5);
    expect(luminance('#000000')).toBe(0);
    expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 1);
    expect(contrast('#777777', '#777777')).toBeCloseTo(1, 5);
  });
});

describe('applyColours', () => {
  it('keeps a brand colour that already passes in light mode and reports the ratios', () => {
    const a = applyColours('#1D3557', '#B4452A');
    expect(a.chosen).toEqual({ primary: '#1D3557', secondary: '#B4452A' });
    expect(a.light.primary).toBe('#1D3557');
    expect(a.contrast.light.primaryOnSurface).toBeGreaterThanOrEqual(UI_RATIO);
    expect(a.contrast.light.onPrimary).toBeGreaterThanOrEqual(TEXT_RATIO);
    expect(a.contrast.light.primaryTextOnSurface).toBeGreaterThanOrEqual(TEXT_RATIO);
  });

  it('darkens a pale primary for light surfaces and lightens a dark one for dark surfaces', () => {
    const pale = applyColours('#FFE066', null);
    expect(pale.adjusted).toBe(true);
    expect(pale.light.primary).not.toBe('#FFE066');
    expect(contrast(pale.light.primary, HOUSE.light.surface)).toBeGreaterThanOrEqual(UI_RATIO);
    expect(contrast(pale.light.primaryText, HOUSE.light.surface)).toBeGreaterThanOrEqual(TEXT_RATIO);
    expect(pale.adjustments.some((x) => x.mode === 'light' && x.token === 'primary')).toBe(true);

    const deep = applyColours('#1B1464', null);
    expect(contrast(deep.dark.primary, HOUSE.dark.surface)).toBeGreaterThanOrEqual(UI_RATIO);
    expect(contrast(deep.dark.primaryText, HOUSE.dark.surface)).toBeGreaterThanOrEqual(TEXT_RATIO);
    expect(deep.adjustments.some((x) => x.mode === 'dark')).toBe(true);
  });

  it('always yields readable text on buttons in both modes', () => {
    for (const hex of ['#B4452A', '#FFE066', '#0E7490', '#8A4B1F', '#2F5A43', '#F4A259', '#000000', '#FFFFFF', '#808080']) {
      const a = applyColours(hex, null);
      for (const mode of ['light', 'dark'] as const) {
        const set = a[mode];
        expect(contrast(set.onPrimary, set.primary)).toBeGreaterThanOrEqual(TEXT_RATIO - 0.01);
        expect(contrast(set.primary, HOUSE[mode].surface)).toBeGreaterThanOrEqual(UI_RATIO - 0.01);
        expect(contrast(set.primaryText, HOUSE[mode].surface)).toBeGreaterThanOrEqual(TEXT_RATIO - 0.01);
      }
    }
  });

  it('does not report the house secondary as an adjustment when the hotel picked none', () => {
    const a = applyColours('#1D3557', null);
    expect(a.adjustments.some((x) => x.token === 'secondary' || x.token === 'secondaryText')).toBe(false);
  });

  it('refuses a malformed colour', () => {
    expect(() => applyColours('red', null)).toThrow();
  });
});
