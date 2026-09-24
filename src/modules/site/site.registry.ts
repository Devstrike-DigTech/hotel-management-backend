/**
 * Booking-site template registry and curated font pairings (M7). The web app
 * implements the layouts; the API owns what exists, which sections each
 * template can render, their defaults and which plans may use them.
 */
import { googleFontsUrl } from '../enterprise/white-label/white-label.logic.js';

export const TEMPLATE_IDS = ['editorial', 'boutique', 'business', 'resort', 'heritage', 'essentials'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const SECTION_KEYS = [
  'hero', 'highlights', 'rooms', 'rates-calendar', 'amenities', 'gallery', 'experiences', 'dining', 'meetings',
  'reviews', 'location-map', 'policies', 'faq', 'getting-here', 'contact', 'custom-text',
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export type ColourMode = 'LIGHT' | 'DARK' | 'SYSTEM';
export const COLOUR_MODES: ColourMode[] = ['LIGHT', 'DARK', 'SYSTEM'];

export interface ThemeSection {
  id: string;
  key: SectionKey;
  enabled: boolean;
  order: number;
  options: Record<string, unknown>;
}

export interface SiteTemplate {
  id: TemplateId;
  name: string;
  description: string;
  bestFor: string[];
  availableOn: string[];
  feature: 'site_templates_all' | null;
  sections: SectionKey[];
  defaultSections: ThemeSection[];
  defaultFontPairingId: string;
  defaultColourMode: ColourMode;
  traits: {
    hero: 'FULL_BLEED' | 'SPLIT' | 'TEXT_FIRST' | 'GALLERY' | 'ORNAMENTAL' | 'NONE';
    density: 'AIRY' | 'BALANCED' | 'DENSE';
    corners: 'SQUARE' | 'SOFT' | 'ROUNDED';
    imageWeight: 'LOW' | 'MEDIUM' | 'HIGH';
  };
  performance: { maxJsKb: number | null; imagesAboveFold: boolean };
  previewImages: { thumb: string; desktop: string; mobile: string };
}

/** Sections every template can render besides its own emphasis. */
const COMMON: SectionKey[] = ['rooms', 'amenities', 'reviews', 'location-map', 'policies', 'faq', 'getting-here', 'contact', 'custom-text'];

/** Default options of a freshly enabled section. */
export function defaultOptions(key: SectionKey): Record<string, unknown> {
  switch (key) {
    case 'hero':
      return {};
    case 'highlights':
      return { items: [] };
    case 'rooms':
      return { layout: 'GRID', showRates: true };
    case 'rates-calendar':
      return { months: 1 };
    case 'gallery':
      return { layout: 'MOSAIC' };
    case 'experiences':
    case 'dining':
    case 'meetings':
      return { items: [] };
    case 'reviews':
      return { limit: 6 };
    case 'location-map':
      return { mode: 'STATIC_IMAGE' };
    case 'faq':
      return { items: [] };
    case 'getting-here':
      return { pickupPointIds: null };
    case 'contact':
      return { showPhone: true, showEmail: true, showWhatsApp: true };
    case 'custom-text':
      return { title: '', body: '' };
    default:
      return {};
  }
}

function sections(keys: SectionKey[], disabled: SectionKey[] = []): ThemeSection[] {
  return keys.map((key, order) => ({ id: key, key, enabled: !disabled.includes(key), order, options: defaultOptions(key) }));
}

const ALL_PLANS = ['starter', 'growth', 'pro', 'enterprise'];
const GROWTH_UP = ['growth', 'pro', 'enterprise'];

const preview = (id: TemplateId) => ({ thumb: `/templates/${id}/thumb.jpg`, desktop: `/templates/${id}/desktop.jpg`, mobile: `/templates/${id}/mobile.jpg` });

export const TEMPLATES: SiteTemplate[] = [
  {
    id: 'editorial',
    name: 'Editorial',
    description: 'The house look: a magazine layout with a big serif headline, generous type and photographs set like a feature story.',
    bestFor: ['City hotels', 'Hotels with a story to tell', 'Any hotel starting out'],
    availableOn: ALL_PLANS,
    feature: null,
    sections: ['hero', 'highlights', 'gallery', 'rates-calendar', 'experiences', 'dining', ...COMMON],
    defaultSections: sections(
      ['hero', 'highlights', 'rooms', 'gallery', 'amenities', 'reviews', 'getting-here', 'location-map', 'policies', 'faq', 'contact'],
    ),
    defaultFontPairingId: 'fraunces-schibsted',
    defaultColourMode: 'SYSTEM',
    traits: { hero: 'SPLIT', density: 'BALANCED', corners: 'SOFT', imageWeight: 'MEDIUM' },
    performance: { maxJsKb: null, imagesAboveFold: true },
    previewImages: preview('editorial'),
  },
  {
    id: 'boutique',
    name: 'Boutique',
    description: 'Image-led: a full-bleed hero, few words and a lot of air. The rooms and the photographs do the talking.',
    bestFor: ['Boutique hotels', 'Design-led properties', 'Short-let apartments with great photography'],
    availableOn: GROWTH_UP,
    feature: 'site_templates_all',
    sections: ['hero', 'gallery', 'highlights', 'experiences', 'dining', ...COMMON],
    defaultSections: sections(['hero', 'gallery', 'rooms', 'highlights', 'reviews', 'getting-here', 'location-map', 'contact', 'amenities', 'policies', 'faq'], ['amenities', 'faq']),
    defaultFontPairingId: 'cormorant-manrope',
    defaultColourMode: 'LIGHT',
    traits: { hero: 'FULL_BLEED', density: 'AIRY', corners: 'SQUARE', imageWeight: 'HIGH' },
    performance: { maxJsKb: null, imagesAboveFold: true },
    previewImages: preview('boutique'),
  },
  {
    id: 'business',
    name: 'Business',
    description: 'Availability and rates above the fold, dense and efficient, with a corporate-rates call to action and the meeting rooms up front.',
    bestFor: ['Business hotels', 'Airport and CBD hotels', 'Serviced apartments'],
    availableOn: GROWTH_UP,
    feature: 'site_templates_all',
    sections: ['hero', 'rates-calendar', 'meetings', 'highlights', 'dining', ...COMMON],
    defaultSections: sections(['rates-calendar', 'rooms', 'meetings', 'amenities', 'highlights', 'reviews', 'getting-here', 'location-map', 'policies', 'faq', 'contact', 'hero'], ['hero']),
    defaultFontPairingId: 'bricolage-instrument',
    defaultColourMode: 'LIGHT',
    traits: { hero: 'NONE', density: 'DENSE', corners: 'SQUARE', imageWeight: 'LOW' },
    performance: { maxJsKb: null, imagesAboveFold: false },
    previewImages: preview('business'),
  },
  {
    id: 'resort',
    name: 'Resort',
    description: 'Immersive: a large gallery, experiences, dining and the pool, with a softer, rounded feel.',
    bestFor: ['Resorts and beach hotels', 'Weekend getaways', 'Hotels with a pool, spa or restaurant'],
    availableOn: GROWTH_UP,
    feature: 'site_templates_all',
    sections: ['hero', 'gallery', 'experiences', 'dining', 'highlights', 'rates-calendar', ...COMMON],
    defaultSections: sections(['hero', 'gallery', 'experiences', 'rooms', 'dining', 'amenities', 'reviews', 'getting-here', 'location-map', 'faq', 'policies', 'contact']),
    defaultFontPairingId: 'playfair-worksans',
    defaultColourMode: 'LIGHT',
    traits: { hero: 'GALLERY', density: 'AIRY', corners: 'ROUNDED', imageWeight: 'HIGH' },
    performance: { maxJsKb: null, imagesAboveFold: true },
    previewImages: preview('resort'),
  },
  {
    id: 'heritage',
    name: 'Heritage',
    description: 'Formal and classic: stately typography, ornamental rules and a crest-like logo lockup.',
    bestFor: ['Grand and historic hotels', 'Wedding and event venues', 'Hotel groups'],
    availableOn: GROWTH_UP,
    feature: 'site_templates_all',
    sections: ['hero', 'highlights', 'gallery', 'dining', 'meetings', 'experiences', ...COMMON],
    defaultSections: sections(['hero', 'highlights', 'rooms', 'dining', 'meetings', 'gallery', 'reviews', 'getting-here', 'location-map', 'policies', 'faq', 'contact']),
    defaultFontPairingId: 'marcellus-karla',
    defaultColourMode: 'LIGHT',
    traits: { hero: 'ORNAMENTAL', density: 'BALANCED', corners: 'SQUARE', imageWeight: 'MEDIUM' },
    performance: { maxJsKb: null, imagesAboveFold: true },
    previewImages: preview('heritage'),
  },
  {
    id: 'essentials',
    name: 'Essentials',
    description: 'Ultra-light and text-first for guesthouses and patchy networks: no large images above the fold, tiny JavaScript, fast on 3G and small Android phones.',
    bestFor: ['Guesthouses', 'Budget hotels', 'Guests on slow mobile data'],
    availableOn: ALL_PLANS,
    feature: null,
    sections: ['hero', 'highlights', ...COMMON],
    defaultSections: sections(['hero', 'rooms', 'amenities', 'policies', 'getting-here', 'contact', 'reviews', 'location-map', 'faq'], ['location-map']),
    defaultFontPairingId: 'system-stack',
    defaultColourMode: 'LIGHT',
    traits: { hero: 'TEXT_FIRST', density: 'BALANCED', corners: 'SOFT', imageWeight: 'LOW' },
    performance: { maxJsKb: 120, imagesAboveFold: false },
    previewImages: preview('essentials'),
  },
];

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

export function templateById(id: string): SiteTemplate | null {
  return BY_ID.get(id as TemplateId) ?? null;
}

export function isTemplateId(id: string): id is TemplateId {
  return BY_ID.has(id as TemplateId);
}

// ---------------------------------------------------------------------------
// Font pairings
// ---------------------------------------------------------------------------

export interface FontFace {
  family: string;
  category: 'serif' | 'sans' | 'display' | 'system';
  weights: number[];
  italicWeights: number[];
  googleFontsUrl: string | null;
  cssStack: string;
}

export interface FontPairing {
  id: string;
  name: string;
  heading: FontFace;
  body: FontFace;
  mood: string;
  isHouseDefault: boolean;
  templateDefaults: TemplateId[];
  googleFontsUrl: string | null;
}

const SERIF_STACK = 'Georgia, "Times New Roman", serif';
const SANS_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function face(family: string, category: FontFace['category'], weights: number[], italicWeights: number[] = []): FontFace {
  const fallback = category === 'serif' || category === 'display' ? SERIF_STACK : SANS_STACK;
  return { family, category, weights, italicWeights, googleFontsUrl: googleFontsUrl(family, weights, italicWeights), cssStack: `"${family}", ${fallback}` };
}

/** One CSS2 request for both families (italics where they exist). */
export function pairingUrl(a: FontFace, b: FontFace): string | null {
  const part = (f: FontFace) => {
    const name = f.family.replace(/ /g, '+');
    if (!f.italicWeights.length) return `family=${name}:wght@${f.weights.join(';')}`;
    return `family=${name}:ital,wght@${[...f.weights.map((w) => `0,${w}`), ...f.italicWeights.map((w) => `1,${w}`)].join(';')}`;
  };
  const parts = [a, b].filter((f) => f.googleFontsUrl).map(part);
  return parts.length ? `https://fonts.googleapis.com/css2?${parts.join('&')}&display=swap` : null;
}

function pairing(id: string, name: string, heading: FontFace, body: FontFace, mood: string, templateDefaults: TemplateId[] = [], isHouseDefault = false): FontPairing {
  return { id, name, heading, body, mood, isHouseDefault, templateDefaults, googleFontsUrl: pairingUrl(heading, body) };
}

const SYSTEM_SERIF: FontFace = { family: 'System serif', category: 'system', weights: [400, 700], italicWeights: [400], googleFontsUrl: null, cssStack: SERIF_STACK };
const SYSTEM_SANS: FontFace = { family: 'System sans', category: 'system', weights: [400, 700], italicWeights: [400], googleFontsUrl: null, cssStack: SANS_STACK };

export const FONT_PAIRINGS: FontPairing[] = [
  pairing('fraunces-schibsted', 'Fraunces + Schibsted Grotesk', face('Fraunces', 'serif', [400, 600, 700], [400, 600]), face('Schibsted Grotesk', 'sans', [400, 500, 600], [400]), 'Warm editorial, the house style', ['editorial'], true),
  pairing('cormorant-manrope', 'Cormorant Garamond + Manrope', face('Cormorant Garamond', 'serif', [400, 500, 600], [400, 500]), face('Manrope', 'sans', [400, 500, 600]), 'Refined and quiet, for image-led pages', ['boutique']),
  pairing('bricolage-instrument', 'Bricolage Grotesque + Instrument Sans', face('Bricolage Grotesque', 'sans', [500, 600, 700]), face('Instrument Sans', 'sans', [400, 500, 600], [400]), 'Crisp and efficient, made for tables of rates', ['business']),
  pairing('playfair-worksans', 'Playfair Display + Work Sans', face('Playfair Display', 'serif', [400, 600, 700], [400, 600]), face('Work Sans', 'sans', [400, 500, 600], [400]), 'Relaxed luxury for resorts and restaurants', ['resort']),
  pairing('marcellus-karla', 'Marcellus + Karla', face('Marcellus', 'display', [400]), face('Karla', 'sans', [400, 500, 600], [400]), 'Classical capitals with a friendly body', ['heritage']),
  pairing('system-stack', 'System fonts (fastest)', SYSTEM_SERIF, SYSTEM_SANS, 'No download at all: the phone\'s own fonts, best on slow networks', ['essentials']),
  pairing('dmserif-dmsans', 'DM Serif Display + DM Sans', face('DM Serif Display', 'display', [400], [400]), face('DM Sans', 'sans', [400, 500, 700], [400]), 'Confident headlines, neutral text'),
  pairing('youngserif-figtree', 'Young Serif + Figtree', face('Young Serif', 'serif', [400]), face('Figtree', 'sans', [400, 500, 600], [400]), 'Friendly and modern'),
  pairing('spacegrotesk-plexsans', 'Space Grotesk + IBM Plex Sans', face('Space Grotesk', 'sans', [500, 600, 700]), face('IBM Plex Sans', 'sans', [400, 500, 600], [400]), 'Technical and contemporary'),
  pairing('baskerville-sourcesans', 'Libre Baskerville + Source Sans 3', face('Libre Baskerville', 'serif', [400, 700], [400]), face('Source Sans 3', 'sans', [400, 600], [400]), 'Traditional and very readable'),
];

const PAIRING_BY_ID = new Map(FONT_PAIRINGS.map((p) => [p.id, p]));

export function fontPairingById(id: string | null | undefined): FontPairing | null {
  return id ? (PAIRING_BY_ID.get(id) ?? null) : null;
}
