/**
 * Theme drafts (M7): normalisation, validation of section options, plan gates
 * and readable change lists. Pure, unit tested.
 */
import { z } from 'zod';
import { applyColours, HEX_RE, type AppliedColours } from './contrast.js';
import {
  COLOUR_MODES,
  defaultOptions,
  fontPairingById,
  isTemplateId,
  SECTION_KEYS,
  templateById,
  type ColourMode,
  type FontPairing,
  type SectionKey,
  type SiteTemplate,
  type TemplateId,
  type ThemeSection,
} from './site.registry.js';

export interface ThemeBrand {
  logoAssetId: string | null;
  faviconAssetId: string | null;
  /** Resolved logo URL (asset URL or a legacy https URL). */
  logoUrl: string | null;
  faviconUrl: string | null;
  primary: string;
  secondary: string | null;
  fontPairingId: string | null;
}

export interface ThemeDraft {
  templateId: TemplateId;
  brand: ThemeBrand;
  colourMode: ColourMode;
  sections: ThemeSection[];
}

export interface Issue {
  path: string;
  code: string;
  message: string;
}

export const DEFAULT_PRIMARY = '#B4452A';
export const MAX_CUSTOM_TEXT = 3;
export const THEME_HISTORY = 20;

/** Fills anything missing (rows written by the migration have `sections: null`). */
export function normaliseDraft(raw: unknown): ThemeDraft {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const templateId: TemplateId = typeof r.templateId === 'string' && isTemplateId(r.templateId) ? r.templateId : 'editorial';
  const tpl = templateById(templateId)!;
  const b = (r.brand && typeof r.brand === 'object' ? r.brand : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.length ? v : null);
  const primary = typeof b.primary === 'string' && HEX_RE.test(b.primary) ? b.primary.toUpperCase() : DEFAULT_PRIMARY;
  const secondary = typeof b.secondary === 'string' && HEX_RE.test(b.secondary) ? b.secondary.toUpperCase() : null;
  const colourMode = COLOUR_MODES.includes(r.colourMode as ColourMode) ? (r.colourMode as ColourMode) : tpl.defaultColourMode;
  const sections = Array.isArray(r.sections) ? normaliseSections(r.sections as ThemeSection[], tpl) : cloneSections(tpl.defaultSections);
  return {
    templateId,
    brand: {
      logoAssetId: str(b.logoAssetId),
      faviconAssetId: str(b.faviconAssetId),
      logoUrl: str(b.logoUrl),
      faviconUrl: str(b.faviconUrl),
      primary,
      secondary,
      fontPairingId: str(b.fontPairingId) && fontPairingById(str(b.fontPairingId)) ? str(b.fontPairingId) : null,
    },
    colourMode,
    sections,
  };
}

export function cloneSections(s: ThemeSection[]): ThemeSection[] {
  return s.map((x) => ({ ...x, options: structuredClone(x.options) }));
}

/** Keeps sections the template can render, sorted and renumbered 0..n-1. */
export function normaliseSections(list: ThemeSection[], tpl: SiteTemplate): ThemeSection[] {
  return [...list]
    .filter((s) => s && tpl.sections.includes(s.key))
    .sort((a, b) => a.order - b.order)
    .map((s, i) => ({ id: s.id || s.key, key: s.key, enabled: s.enabled !== false, order: i, options: s.options ?? defaultOptions(s.key) }));
}

/**
 * Sections after a template switch: the new template's defaults, carrying
 * over the content of sections both templates have (FAQ items, hero text,
 * custom text blocks when the new template allows them).
 */
export function switchTemplate(current: ThemeSection[], to: SiteTemplate): ThemeSection[] {
  const byId = new Map(current.map((s) => [s.id, s]));
  const out = cloneSections(to.defaultSections).map((s) => {
    const old = byId.get(s.id);
    return old && Object.keys(old.options ?? {}).length ? { ...s, options: structuredClone(old.options) } : s;
  });
  if (to.sections.includes('custom-text')) {
    for (const old of current.filter((s) => s.key === 'custom-text')) out.push({ ...old, order: out.length, options: structuredClone(old.options) });
  }
  return out.map((s, i) => ({ ...s, order: i }));
}

// ---------------------------------------------------------------------------
// Section options
// ---------------------------------------------------------------------------

const imageUrl = z.string().max(500).nullable().optional();
const items = (title: number, text: number, max: number) =>
  z.array(z.object({ title: z.string().trim().min(1).max(title), text: z.string().trim().max(text), imageUrl }).strict()).max(max);

const OPTION_SCHEMAS: Record<SectionKey, z.ZodType> = {
  hero: z.object({ headline: z.string().max(80).optional(), subheadline: z.string().max(160).optional(), imageUrl, ctaLabel: z.string().max(24).optional() }).strict(),
  highlights: z.object({ items: z.array(z.object({ title: z.string().trim().min(1).max(40), text: z.string().trim().max(140) }).strict()).max(6) }).strict(),
  rooms: z.object({ layout: z.enum(['GRID', 'LIST']).optional(), showRates: z.boolean().optional() }).strict(),
  'rates-calendar': z.object({ months: z.union([z.literal(1), z.literal(2)]).optional() }).strict(),
  amenities: z.object({ featured: z.array(z.string().max(60)).max(12).optional() }).strict(),
  gallery: z.object({ imageUrls: z.array(z.string().max(500)).max(24).optional(), layout: z.enum(['MOSAIC', 'CAROUSEL', 'GRID']).optional() }).strict(),
  experiences: z.object({ title: z.string().max(60).optional(), intro: z.string().max(400).optional(), items: items(60, 300, 8) }).strict(),
  dining: z.object({ title: z.string().max(60).optional(), intro: z.string().max(400).optional(), items: items(60, 300, 8) }).strict(),
  meetings: z.object({ title: z.string().max(60).optional(), intro: z.string().max(400).optional(), items: items(60, 300, 8) }).strict(),
  reviews: z.object({ limit: z.number().int().min(3).max(12).optional() }).strict(),
  'location-map': z.object({ mode: z.enum(['STATIC_IMAGE', 'LINK']).optional(), note: z.string().max(200).optional() }).strict(),
  policies: z.object({}).strict(),
  faq: z.object({ items: z.array(z.object({ question: z.string().trim().min(3).max(160), answer: z.string().trim().min(1).max(1000) }).strict()).max(20) }).strict(),
  'getting-here': z.object({ intro: z.string().max(300).optional(), pickupPointIds: z.array(z.string().uuid()).max(30).nullable().optional() }).strict(),
  contact: z.object({ showPhone: z.boolean().optional(), showEmail: z.boolean().optional(), showWhatsApp: z.boolean().optional() }).strict(),
  'custom-text': z.object({ title: z.string().trim().min(1).max(80), body: z.string().trim().min(1).max(3000) }).strict(),
};

/** Image URLs in options: https, or this API's own site-asset URLs (any scheme in development). */
export function isImageUrlAllowed(url: string, assetBase: string): boolean {
  if (url.startsWith(assetBase)) return true;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function collectUrls(key: SectionKey, o: Record<string, unknown>): { path: string; url: string }[] {
  const out: { path: string; url: string }[] = [];
  if (key === 'hero' && typeof o.imageUrl === 'string') out.push({ path: 'imageUrl', url: o.imageUrl });
  if (key === 'gallery' && Array.isArray(o.imageUrls)) (o.imageUrls as string[]).forEach((u, i) => out.push({ path: `imageUrls[${i}]`, url: u }));
  if ((key === 'experiences' || key === 'dining' || key === 'meetings') && Array.isArray(o.items)) {
    (o.items as { imageUrl?: string | null }[]).forEach((it, i) => it.imageUrl && out.push({ path: `items[${i}].imageUrl`, url: it.imageUrl }));
  }
  return out;
}

function zodPath(p: PropertyKey[]): string {
  return p.map((x, i) => (typeof x === 'number' ? `[${x}]` : `${i ? '.' : ''}${String(x)}`)).join('');
}

/** Validates the section list against the template (keys, ids, custom-text count, options). */
export function validateSections(list: ThemeSection[], tpl: SiteTemplate, assetBase: string): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();
  let custom = 0;
  list.forEach((s, i) => {
    const at = `sections[${i}]`;
    if (!s || typeof s !== 'object') {
      issues.push({ path: at, code: 'TYPE', message: 'Each section must be an object' });
      return;
    }
    if (!(SECTION_KEYS as readonly string[]).includes(s.key)) {
      issues.push({ path: `${at}.key`, code: 'INVALID_OPTION', message: `Unknown section "${String(s.key)}"` });
      return;
    }
    if (!tpl.sections.includes(s.key)) issues.push({ path: `${at}.key`, code: 'NOT_AVAILABLE', message: `The ${tpl.name} template has no ${s.key} section` });
    const id = s.id || s.key;
    if (ids.has(id)) issues.push({ path: `${at}.id`, code: 'DUPLICATE_KEY', message: `Section id "${id}" is used twice` });
    ids.add(id);
    if (s.key === 'custom-text') {
      custom++;
      if (!/^custom-text-[1-9]$/.test(id)) issues.push({ path: `${at}.id`, code: 'PATTERN', message: 'Custom text blocks are named custom-text-1 to custom-text-3' });
    } else if (id !== s.key) {
      issues.push({ path: `${at}.id`, code: 'PATTERN', message: `The id of the ${s.key} section is "${s.key}"` });
    }
    const parsed = OPTION_SCHEMAS[s.key].safeParse(s.options ?? defaultOptions(s.key));
    if (!parsed.success) {
      for (const e of parsed.error.issues) issues.push({ path: `${at}.options${e.path.length ? `.${zodPath(e.path)}` : ''}`, code: 'TYPE', message: e.message });
    } else {
      for (const u of collectUrls(s.key, (s.options ?? {}) as Record<string, unknown>)) {
        if (!isImageUrlAllowed(u.url, assetBase)) issues.push({ path: `${at}.options.${u.path}`, code: 'PATTERN', message: 'Images must be uploaded or on an https address' });
      }
    }
  });
  if (custom > MAX_CUSTOM_TEXT) issues.push({ path: 'sections', code: 'MAX', message: `At most ${MAX_CUSTOM_TEXT} custom text blocks` });
  return issues;
}

// ---------------------------------------------------------------------------
// Plan gates
// ---------------------------------------------------------------------------

/** True when the enabled set or order differs from the template default, or custom text exists. */
export function sectionsCustomised(list: ThemeSection[], tpl: SiteTemplate): boolean {
  const layout = (s: ThemeSection[]) =>
    [...s]
      .sort((a, b) => a.order - b.order)
      .filter((x) => x.enabled)
      .map((x) => x.id)
      .join('|');
  if (list.some((s) => s.key === 'custom-text')) return true;
  return layout(list) !== layout(tpl.defaultSections);
}

/** The first plan feature the draft needs and the tenant lacks, or null. */
export function gateViolation(d: ThemeDraft, features: readonly string[]): string | null {
  const tpl = templateById(d.templateId)!;
  const has = (f: string) => features.includes(f);
  if (!has('brand_kit')) return 'brand_kit';
  if (tpl.feature && !has(tpl.feature)) return tpl.feature;
  if (!has('site_sections') && (sectionsCustomised(d.sections, tpl) || d.colourMode !== tpl.defaultColourMode)) return 'site_sections';
  if (!has('site_fonts') && d.brand.fontPairingId && d.brand.fontPairingId !== tpl.defaultFontPairingId) return 'site_fonts';
  return null;
}

// ---------------------------------------------------------------------------
// Resolution and comparison
// ---------------------------------------------------------------------------

export function resolvedPairing(d: ThemeDraft): FontPairing {
  const tpl = templateById(d.templateId)!;
  return fontPairingById(d.brand.fontPairingId) ?? fontPairingById(tpl.defaultFontPairingId)!;
}

export function appliedFor(d: ThemeDraft): AppliedColours {
  return applyColours(d.brand.primary, d.brand.secondary);
}

/** Stable JSON for equality (keys sorted). */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** What makes two drafts different for the site (ignores derived URLs). */
export function draftKey(d: ThemeDraft): string {
  return stable({ ...d, brand: { ...d.brand } });
}

/** Readable list of differences, for the publish dialog. */
export function themeChanges(draft: ThemeDraft, published: ThemeDraft | null): string[] {
  if (!published) return ['First publication'];
  const out: string[] = [];
  const name = (id: TemplateId) => templateById(id)?.name ?? id;
  if (draft.templateId !== published.templateId) out.push(`Template: ${name(published.templateId)} -> ${name(draft.templateId)}`);
  if (draft.brand.primary !== published.brand.primary) out.push(`Primary colour: ${published.brand.primary} -> ${draft.brand.primary}`);
  if (draft.brand.secondary !== published.brand.secondary) out.push(`Secondary colour: ${published.brand.secondary ?? 'house brass'} -> ${draft.brand.secondary ?? 'house brass'}`);
  if (draft.brand.logoAssetId !== published.brand.logoAssetId || draft.brand.logoUrl !== published.brand.logoUrl) out.push('Logo changed');
  if (draft.brand.faviconAssetId !== published.brand.faviconAssetId || draft.brand.faviconUrl !== published.brand.faviconUrl) out.push('Favicon changed');
  if (resolvedPairing(draft).id !== resolvedPairing(published).id) out.push(`Fonts: ${resolvedPairing(published).name} -> ${resolvedPairing(draft).name}`);
  if (draft.colourMode !== published.colourMode) out.push(`Colour mode: ${published.colourMode} -> ${draft.colourMode}`);
  const pub = new Map(published.sections.map((s) => [s.id, s]));
  const dr = new Map(draft.sections.map((s) => [s.id, s]));
  for (const s of draft.sections) {
    const p = pub.get(s.id);
    if (!p) out.push(`Section added: ${s.id}`);
    else {
      if (p.enabled !== s.enabled) out.push(`${s.id} ${s.enabled ? 'shown' : 'hidden'}`);
      if (stable(p.options) !== stable(s.options)) out.push(`${s.id} content edited`);
    }
  }
  for (const s of published.sections) if (!dr.has(s.id)) out.push(`Section removed: ${s.id}`);
  const order = (l: ThemeSection[]) => l.filter((s) => s.enabled).sort((a, b) => a.order - b.order).map((s) => s.id).join('|');
  if (draft.sections.length === published.sections.length && order(draft.sections) !== order(published.sections)) out.push('Sections reordered');
  return out;
}
