/**
 * Accessible colour variants for booking-site themes (M7). Pure and unit
 * tested. Hotels choose a primary (and optional secondary) colour; the server
 * derives the tokens the web app uses in light and dark mode so that text
 * keeps 4.5:1 against its background and buttons / focus rings keep 3:1
 * (WCAG 2.1, relative luminance). A colour is only moved in HSL lightness
 * (hue and saturation kept), the smallest step that reaches the target, so
 * the brand stays recognisable.
 */

export type Hex = string;

export interface Surfaces {
  paper: Hex;
  surface: Hex;
  surface2: Hex;
  ink: Hex;
  inkMuted: Hex;
  line: Hex;
}

/** The house neutrals (BRIEF "Laterite & Adire"). */
export const HOUSE: Record<'light' | 'dark', Surfaces> = {
  light: { paper: '#F4EFE6', surface: '#FBF8F2', surface2: '#EDE6DA', ink: '#1B1A17', inkMuted: '#6B645A', line: '#E0D7C8' },
  dark: { paper: '#13110E', surface: '#1C1915', surface2: '#26221D', ink: '#EFE8DC', inkMuted: '#A69D8F', line: '#332E27' },
};

/** Secondary colour when the hotel picks none: the house brass. */
export const HOUSE_SECONDARY: Record<'light' | 'dark', Hex> = { light: '#B98A2E', dark: '#D6A94A' };

export const TEXT_RATIO = 4.5;
export const UI_RATIO = 3;

const WHITE = '#FFFFFF';
const NEAR_BLACK = '#1B1A17';

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function normaliseHex(h: string): Hex {
  if (!HEX_RE.test(h)) throw new Error(`Not a #RRGGBB colour: ${h}`);
  return h.toUpperCase();
}

function rgb(h: Hex): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): Hex {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/** WCAG relative luminance. */
export function luminance(h: Hex): number {
  const [r, g, b] = rgb(h).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Contrast ratio (1..21), unrounded. */
export function contrast(a: Hex, b: Hex): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function toHsl(h: Hex): [number, number, number] {
  const [r, g, b] = rgb(h).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let hue: number;
  if (max === r) hue = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  return [hue / 6, s, l];
}

function fromHsl([h, s, l]: [number, number, number]): Hex {
  if (s === 0) return toHex([l * 255, l * 255, l * 255]);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return toHex([f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]);
}

/**
 * The closest colour (by lightness only) that reaches `ratio` against every
 * background. `direction` says which way to move: darker for light surfaces,
 * lighter for dark ones. Falls back to near-black / white if the hue cannot
 * make it (it always can at the extremes).
 */
export function ensureContrast(colour: Hex, backgrounds: Hex[], ratio: number, direction: 'darker' | 'lighter'): Hex {
  const ok = (c: Hex) => backgrounds.every((bg) => contrast(c, bg) >= ratio);
  const start = normaliseHex(colour);
  if (ok(start)) return start;
  const [h, s, l] = toHsl(start);
  for (let i = 1; i <= 100; i++) {
    const nl = direction === 'darker' ? l - (l * i) / 100 : l + ((1 - l) * i) / 100;
    const c = fromHsl([h, s, nl]);
    if (ok(c)) return c;
  }
  return direction === 'darker' ? '#000000' : WHITE;
}

/** White or near-black, whichever reads better on `fill`. */
export function bestInk(fill: Hex): Hex {
  return contrast(WHITE, fill) >= contrast(NEAR_BLACK, fill) ? WHITE : NEAR_BLACK;
}

export interface ColourSet extends Surfaces {
  primary: Hex;
  onPrimary: Hex;
  primaryText: Hex;
  secondary: Hex;
  onSecondary: Hex;
  secondaryText: Hex;
  focusRing: Hex;
}

export interface ContrastReport {
  primaryOnSurface: number;
  onPrimary: number;
  primaryTextOnSurface: number;
  primaryTextOnPaper: number;
  secondaryOnSurface: number;
  onSecondary: number;
  secondaryTextOnSurface: number;
}

export interface Adjustment {
  mode: 'light' | 'dark';
  token: 'primary' | 'primaryText' | 'secondary' | 'secondaryText' | 'onPrimary' | 'onSecondary';
  from: Hex;
  to: Hex;
  reason: string;
}

export interface AppliedColours {
  chosen: { primary: Hex; secondary: Hex | null };
  light: ColourSet;
  dark: ColourSet;
  contrast: { light: ContrastReport; dark: ContrastReport };
  adjusted: boolean;
  adjustments: Adjustment[];
}

/** A fill colour usable for buttons, plus text that reads on it (>= 4.5:1). */
function fillWithInk(chosen: Hex, s: Surfaces, direction: 'darker' | 'lighter'): { fill: Hex; ink: Hex } {
  let fill = ensureContrast(chosen, [s.surface, s.paper], UI_RATIO, direction);
  let ink = bestInk(fill);
  if (contrast(ink, fill) < TEXT_RATIO) {
    // Mid-tone fill: push it further away from its ink until the text reads.
    const away: 'darker' | 'lighter' = ink === WHITE ? 'darker' : 'lighter';
    fill = ensureContrast(fill, [ink], TEXT_RATIO, away);
    ink = bestInk(fill);
  }
  return { fill, ink };
}

function modeSet(mode: 'light' | 'dark', primary: Hex, secondary: Hex, adjustments: Adjustment[]): { set: ColourSet; report: ContrastReport } {
  const s = HOUSE[mode];
  const direction = mode === 'light' ? 'darker' : 'lighter';
  const surfaceWord = mode === 'light' ? 'light' : 'dark';
  const note = (token: Adjustment['token'], from: Hex, to: Hex, reason: string) => {
    if (from.toUpperCase() !== to.toUpperCase()) adjustments.push({ mode, token, from: from.toUpperCase(), to, reason });
  };

  const p = fillWithInk(primary, s, direction);
  note('primary', primary, p.fill, `${direction === 'darker' ? 'Darkened' : 'Lightened'} so buttons keep 3:1 against ${surfaceWord} surfaces and their text 4.5:1`);
  const primaryText = ensureContrast(primary, [s.surface, s.paper], TEXT_RATIO, direction);
  note('primaryText', primary, primaryText, `${direction === 'darker' ? 'Darkened' : 'Lightened'} for 4.5:1 text contrast on ${surfaceWord} surfaces`);

  const sec = fillWithInk(secondary, s, direction);
  note('secondary', secondary, sec.fill, `${direction === 'darker' ? 'Darkened' : 'Lightened'} so secondary accents keep 3:1 against ${surfaceWord} surfaces`);
  const secondaryText = ensureContrast(secondary, [s.surface, s.paper], TEXT_RATIO, direction);
  note('secondaryText', secondary, secondaryText, `${direction === 'darker' ? 'Darkened' : 'Lightened'} for 4.5:1 text contrast on ${surfaceWord} surfaces`);

  const focusRing = ensureContrast(p.fill, [s.paper, s.surface], UI_RATIO, direction);
  const set: ColourSet = { ...s, primary: p.fill, onPrimary: p.ink, primaryText, secondary: sec.fill, onSecondary: sec.ink, secondaryText, focusRing };
  const report: ContrastReport = {
    primaryOnSurface: round2(contrast(p.fill, s.surface)),
    onPrimary: round2(contrast(p.ink, p.fill)),
    primaryTextOnSurface: round2(contrast(primaryText, s.surface)),
    primaryTextOnPaper: round2(contrast(primaryText, s.paper)),
    secondaryOnSurface: round2(contrast(sec.fill, s.surface)),
    onSecondary: round2(contrast(sec.ink, sec.fill)),
    secondaryTextOnSurface: round2(contrast(secondaryText, s.surface)),
  };
  return { set, report };
}

/** Applied (accessible) light and dark colour sets for a chosen primary / secondary. */
export function applyColours(primary: Hex, secondary: Hex | null): AppliedColours {
  const p = normaliseHex(primary);
  const sec = secondary ? normaliseHex(secondary) : null;
  const adjustments: Adjustment[] = [];
  const light = modeSet('light', p, sec ?? HOUSE_SECONDARY.light, adjustments);
  const dark = modeSet('dark', p, sec ?? HOUSE_SECONDARY.dark, adjustments);
  // The house brass default is not the hotel's choice: do not report it as "adjusted".
  const visible = sec ? adjustments : adjustments.filter((a) => a.token !== 'secondary' && a.token !== 'secondaryText');
  return {
    chosen: { primary: p, secondary: sec },
    light: light.set,
    dark: dark.set,
    contrast: { light: light.report, dark: dark.report },
    adjusted: visible.length > 0,
    adjustments: visible,
  };
}
