/**
 * Booking form engine (M7): builder rules, ID-number guard, conditions,
 * server-side answer validation and diffs. Pure (no database), unit tested.
 */
import { normalisePhone } from '../../common/utils/phone.js';
import {
  ALL_CHANNELS,
  CHANNELS,
  EXTRA_CATEGORIES,
  FIELD_TYPES,
  LIBRARY,
  LIBRARY_FIELD_BY_KEY,
  MAPS_TO,
  OPERATORS,
  presetById,
  RECOMMENDED_FIELDS,
  SYSTEM_BOUND,
  SYSTEM_FIELDS,
  SYSTEM_KEYS,
  type Channel,
  type FieldType,
  type FormField,
  type PresetId,
} from './form.catalogue.js';

export interface ValidationIssue {
  path: string;
  fieldKey: string | null;
  code: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface FormWarning {
  fieldKey: string;
  code: 'ID_LIKE' | 'PRESET_FIELD_SKIPPED';
  kind: string | null;
  message: string;
  suggestion: 'COLLECT_AT_CHECK_IN' | null;
}

export const MAX_FIELDS = 60;
export const DEFAULT_FILE_MB = 5;
export const MAX_FILE_MB = 10;
export const FILE_TYPES = ['pdf', 'jpeg', 'png', 'webp'] as const;

// ---------------------------------------------------------------------------
// ID numbers at booking: BVN blocked, others discouraged
// ---------------------------------------------------------------------------

const ID_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'NIN', re: /\bnin\b|national\s*identi(fication|ty)\s*(number|no)|\bnimc\b/i },
  { kind: 'PASSPORT', re: /passport\s*(number|no|#)|\bpassport\b/i },
  { kind: 'DRIVERS_LICENCE', re: /driver'?s?\s*licen[cs]e|driving\s*licen[cs]e/i },
  { kind: 'VOTERS_CARD', re: /voter'?s?\s*card|\bpvc\b/i },
  { kind: 'ID_NUMBER', re: /\bid\s*(number|no|#|card)\b|identity\s*(card|number)|means\s*of\s*id/i },
];
const BVN_RE = /\bbvn\b|bank\s*verification\s*(number|no)?/i;

export function idCheck(label: string, helpText?: string | null): { level: 'OK' | 'WARN' | 'BLOCK'; kind: string | null; message: string | null } {
  const text = `${label ?? ''} ${helpText ?? ''}`;
  if (BVN_RE.test(text)) {
    return { level: 'BLOCK', kind: 'BVN', message: 'A BVN cannot be collected in the booking form. Hotels have no lawful need for it, and asking for it looks like fraud to guests.' };
  }
  for (const p of ID_PATTERNS) {
    if (p.re.test(text)) {
      const name = p.kind === 'NIN' ? 'NIN' : p.kind === 'PASSPORT' ? 'passport numbers' : p.kind === 'DRIVERS_LICENCE' ? "driver's licence numbers" : p.kind === 'VOTERS_CARD' ? "voter's card numbers" : 'ID numbers';
      return { level: 'WARN', kind: p.kind, message: `Guests are asked for ID at check-in (the register card). Collecting ${name} at booking is discouraged: collect it at check-in instead.` };
    }
  }
  return { level: 'OK', kind: null, message: null };
}

// ---------------------------------------------------------------------------
// Regular expressions supplied by hotels
// ---------------------------------------------------------------------------

/** A pattern that compiles, is short and has no nested quantifiers (catastrophic backtracking). */
export function safePattern(p: string): boolean {
  if (p.length > 200) return false;
  if (/\([^)]*[+*][^)]*\)\s*[+*{]/.test(p)) return false;
  if (/\\\d/.test(p)) return false;
  try {
    new RegExp(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Normalisation (locks, keys, order, derived metadata)
// ---------------------------------------------------------------------------

function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'field';
}

function derive(f: FormField): FormField {
  const system = f.source === 'SYSTEM';
  const id = f.source === 'SYSTEM' ? { level: 'OK', kind: null } : idCheck(f.label, f.helpText);
  return {
    ...f,
    sensitive: f.sensitive || id.level === 'WARN',
    locked: { remove: system, hide: system, type: system || f.source === 'LIBRARY', channels: system },
    mapsTo: MAPS_TO[f.key] ?? null,
    boundTo: SYSTEM_BOUND[f.key] ?? null,
    idLike: id.level === 'WARN' && id.kind ? { kind: id.kind } : null,
  };
}

/** Strips server-computed props before storing. */
export function storable(f: FormField): FormField {
  const { locked: _l, mapsTo: _m, boundTo: _b, idLike: _i, ...rest } = f;
  void _l;
  void _m;
  void _b;
  void _i;
  return rest as FormField;
}

/**
 * The stored list from a builder submission: SYSTEM fields are always present
 * with their fixed key, type, source and requiredness (only label, help text,
 * placeholder, section and order are editable; email may be REQUIRED or
 * OPTIONAL). CUSTOM keys are assigned when missing. Orders are renumbered.
 */
export function normaliseFields(input: Partial<FormField>[]): FormField[] {
  const out: FormField[] = [];
  const used = new Set<string>();
  const sys = new Map(SYSTEM_FIELDS.map((f) => [f.key, f]));
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    if (key && sys.has(key)) {
      const base = sys.get(key)!;
      const f: FormField = {
        ...base,
        label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : base.label,
        helpText: raw.helpText === undefined ? base.helpText : (raw.helpText ?? null),
        placeholder: raw.placeholder === undefined ? base.placeholder : (raw.placeholder ?? null),
        section: typeof raw.section === 'string' && raw.section.trim() ? raw.section.trim() : base.section,
        order: typeof raw.order === 'number' ? raw.order : out.length,
        required: key === 'email' && (raw.required === 'REQUIRED' || raw.required === 'OPTIONAL') ? raw.required : base.required,
      };
      out.push(f);
      used.add(key);
      continue;
    }
    const source = raw.source === 'LIBRARY' || raw.source === 'CUSTOM' ? raw.source : key && LIBRARY_FIELD_BY_KEY.has(key) ? 'LIBRARY' : 'CUSTOM';
    const lib = source === 'LIBRARY' ? LIBRARY_FIELD_BY_KEY.get(key) : undefined;
    let k = key;
    if (source === 'CUSTOM' && !k) {
      const baseKey = `c_${slug(String(raw.label ?? 'field'))}`;
      k = baseKey;
      for (let i = 2; used.has(k) || sys.has(k) || LIBRARY_FIELD_BY_KEY.has(k); i++) k = `${baseKey}_${i}`;
    }
    const f: FormField = {
      key: k,
      source,
      libraryKey: lib?.libraryKey ?? (typeof raw.libraryKey === 'string' ? raw.libraryKey : null),
      recommended: lib?.recommended ?? false,
      type: (lib?.type ?? raw.type) as FieldType,
      label: typeof raw.label === 'string' ? raw.label.trim() : (lib?.label ?? ''),
      helpText: raw.helpText ?? null,
      placeholder: raw.placeholder ?? null,
      required: raw.required ?? 'OPTIONAL',
      options: Array.isArray(raw.options) ? raw.options.map((o) => ({ value: String(o?.value ?? '').trim(), label: String(o?.label ?? '').trim() })) : (lib?.options ?? []),
      validation: raw.validation && typeof raw.validation === 'object' ? { ...raw.validation } : { ...lib?.validation },
      section: typeof raw.section === 'string' && raw.section.trim() ? raw.section.trim() : (lib?.section ?? 'Your stay'),
      order: typeof raw.order === 'number' ? raw.order : out.length,
      channels: Array.isArray(raw.channels) ? [...new Set(raw.channels)] as Channel[] : [...ALL_CHANNELS],
      condition: raw.condition ?? null,
      purpose: raw.purpose ?? null,
      guestPurpose: raw.guestPurpose ?? null,
      sensitive: !!raw.sensitive,
      ...(((lib?.type ?? raw.type) === 'EXTRA') && { extra: raw.extra ?? { categories: null } }),
      ...(((lib?.type ?? raw.type) === 'PICKUP') && { pickup: raw.pickup ?? { directions: ['ARRIVAL', 'DEPARTURE'], pickupPointIds: null } }),
    };
    out.push(f);
    used.add(k);
  }
  // Compulsory SYSTEM fields can never go missing.
  for (const s of SYSTEM_FIELDS) if (!used.has(s.key)) out.push({ ...s, order: -1 + out.length });
  return out
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.order - b.f.order || a.i - b.i)
    .map(({ f }, order) => derive({ ...f, order }));
}

/** Fields of a preset for the plan; library items the plan lacks are skipped. */
export function buildPreset(presetId: PresetId, features: readonly string[], limit = -1): { fields: FormField[]; skipped: string[] } {
  const preset = presetById(presetId) ?? presetById('default')!;
  const consent = SYSTEM_FIELDS.find((f) => f.key === 'policyConsent')!;
  const list: FormField[] = [...SYSTEM_FIELDS.filter((f) => f !== consent).map((f) => ({ ...f })), ...RECOMMENDED_FIELDS.map((f) => ({ ...f }))];
  const skipped: string[] = [];
  for (const key of preset.library) {
    const item = LIBRARY.find((l) => l.libraryKey === key);
    if (!item) continue;
    if (item.feature && !features.includes(item.feature)) {
      skipped.push(key);
      continue;
    }
    list.push(...item.fields.map((f) => ({ ...f })));
  }
  list.push(...preset.custom.map((f) => ({ ...f })));
  // The consent box closes the form.
  list.push({ ...consent });
  let fields = normaliseFields(list.map((f, i) => ({ ...f, order: i })));
  // Starter keeps within its limit: the last extra fields are skipped.
  if (!features.includes('form_fields_unlimited') && limit >= 0) {
    let count = 0;
    fields = fields.filter((f) => {
      if (!countsTowardLimit(f)) return true;
      count++;
      if (count <= limit) return true;
      skipped.push(f.libraryKey ?? f.key);
      return false;
    });
    fields = fields.map((f, order) => ({ ...f, order }));
  }
  return { fields, skipped: [...new Set(skipped)] };
}

// ---------------------------------------------------------------------------
// Builder validation
// ---------------------------------------------------------------------------

export function countsTowardLimit(f: FormField): boolean {
  return (f.source === 'LIBRARY' || f.source === 'CUSTOM') && !f.recommended && f.required !== 'HIDDEN';
}

export function customFieldCount(fields: FormField[]): number {
  return fields.filter(countsTowardLimit).length;
}

export interface BuilderResult {
  issues: ValidationIssue[];
  warnings: FormWarning[];
  /** First plan feature the form needs and the tenant lacks. */
  lockedFeature: string | null;
  customCount: number;
}

function hasCycle(fields: FormField[]): string | null {
  const next = new Map(fields.filter((f) => f.condition).map((f) => [f.key, f.condition!.fieldKey]));
  for (const start of next.keys()) {
    const seen = new Set<string>([start]);
    let cur = next.get(start);
    while (cur) {
      if (seen.has(cur)) return start;
      seen.add(cur);
      cur = next.get(cur);
    }
  }
  return null;
}

/** Checks a normalised field list (draft save and publish). */
export function validateBuilder(fields: FormField[], features: readonly string[]): BuilderResult {
  const issues: ValidationIssue[] = [];
  const warnings: FormWarning[] = [];
  let lockedFeature: string | null = null;
  const lock = (f: string) => {
    if (!lockedFeature && !features.includes(f)) lockedFeature = f;
  };
  const byKey = new Map<string, FormField>();
  if (fields.length > MAX_FIELDS) issues.push({ path: 'fields', fieldKey: null, code: 'MAX', message: `A form can have at most ${MAX_FIELDS} fields`, meta: { max: MAX_FIELDS } });
  let extraCount = 0;
  let pickupCount = 0;
  fields.forEach((f, i) => {
    const at = `fields[${i}]`;
    const push = (prop: string, code: string, message: string, meta?: Record<string, unknown>) => issues.push({ path: prop ? `${at}.${prop}` : at, fieldKey: f.key, code, message, ...(meta && { meta }) });
    if (byKey.has(f.key)) push('key', 'DUPLICATE_KEY', `Two fields use the key "${f.key}"`);
    byKey.set(f.key, f);
    if (!/^[a-zA-Z][a-zA-Z0-9_]{1,40}$/.test(f.key)) push('key', 'PATTERN', 'Keys are 2-41 letters, digits or underscores, starting with a letter');
    if (f.source === 'CUSTOM' && !f.key.startsWith('c_')) push('key', 'PATTERN', 'Custom field keys start with "c_"');
    if (f.source === 'LIBRARY' && !LIBRARY_FIELD_BY_KEY.has(f.key)) push('key', 'UNKNOWN_FIELD', `"${f.key}" is not a library field`);
    if (!(FIELD_TYPES as readonly string[]).includes(f.type)) push('type', 'INVALID_OPTION', 'Unknown field type');
    if (f.source === 'CUSTOM' && (f.type === 'EXTRA' || f.type === 'PICKUP')) push('type', 'NOT_ALLOWED', 'Add the extras picker and the pickup block from the library');
    const minLabel = f.source === 'SYSTEM' ? 2 : 1;
    const maxLabel = f.source === 'SYSTEM' ? (f.key === 'policyConsent' ? 140 : 40) : 80;
    if (!f.label || f.label.length < minLabel || f.label.length > maxLabel) push('label', 'TOO_LONG', `Labels are ${minLabel} to ${maxLabel} characters`);
    if (f.helpText && f.helpText.length > 200) push('helpText', 'TOO_LONG', 'Help text is at most 200 characters');
    if (f.placeholder && f.placeholder.length > 80) push('placeholder', 'TOO_LONG', 'Placeholders are at most 80 characters');
    if (f.purpose && f.purpose.length > 300) push('purpose', 'TOO_LONG', 'The purpose note is at most 300 characters');
    if (f.guestPurpose && f.guestPurpose.length > 140) push('guestPurpose', 'TOO_LONG', 'The note to guests is at most 140 characters');
    if (!f.section || f.section.length > 40) push('section', 'TOO_LONG', 'Section names are 1 to 40 characters');
    if (!['REQUIRED', 'OPTIONAL', 'HIDDEN'].includes(f.required)) push('required', 'INVALID_OPTION', 'Choose required, optional or hidden');
    if (!f.channels.length || f.channels.some((c) => !(CHANNELS as readonly string[]).includes(c))) push('channels', 'INVALID_OPTION', 'Choose at least one channel');
    if (f.source !== 'SYSTEM') {
      const id = idCheck(f.label, f.helpText);
      if (id.level === 'BLOCK') push('label', 'BVN_BLOCKED', id.message!);
      else if (id.level === 'WARN') warnings.push({ fieldKey: f.key, code: 'ID_LIKE', kind: id.kind, message: id.message!, suggestion: 'COLLECT_AT_CHECK_IN' });
    }
    if (f.type === 'SELECT' || f.type === 'MULTI_SELECT') {
      if (!f.options.length || f.options.length > 30) push('options', 'MIN', 'Give 1 to 30 options');
      const values = new Set<string>();
      f.options.forEach((o, j) => {
        if (!o.value || o.value.length > 60 || !o.label || o.label.length > 80) push(`options[${j}]`, 'TOO_LONG', 'Options need a value (up to 60 characters) and a label (up to 80)');
        if (values.has(o.value)) push(`options[${j}].value`, 'DUPLICATE_KEY', `Option "${o.value}" appears twice`);
        values.add(o.value);
      });
    }
    const v = f.validation ?? {};
    if (v.pattern !== undefined) {
      if (f.type !== 'SHORT_TEXT') push('validation.pattern', 'NOT_ALLOWED', 'Patterns apply to short text only');
      else if (!safePattern(v.pattern)) push('validation.pattern', 'PATTERN', 'This pattern is not valid or too complex');
    }
    if (v.maxLength !== undefined) {
      const cap = f.type === 'LONG_TEXT' ? 2000 : 200;
      if (!Number.isInteger(v.maxLength) || v.maxLength < 1 || v.maxLength > cap) push('validation.maxLength', 'MAX', `Maximum length is 1 to ${cap}`, { max: cap });
    }
    if (v.min !== undefined && v.max !== undefined && v.min > v.max) push('validation.min', 'MIN', 'The minimum is above the maximum');
    if (f.type === 'FILE') {
      lock('form_file_uploads');
      if (v.maxFileMB !== undefined && (v.maxFileMB < 1 || v.maxFileMB > MAX_FILE_MB)) push('validation.maxFileMB', 'MAX', `Files can be 1 to ${MAX_FILE_MB} MB`, { max: MAX_FILE_MB });
      if (v.accept && (!v.accept.length || v.accept.some((a) => !(FILE_TYPES as readonly string[]).includes(a)))) push('validation.accept', 'INVALID_OPTION', `Accepted types: ${FILE_TYPES.join(', ')}`);
    }
    if (f.type === 'EXTRA' || f.type === 'PICKUP') {
      if (f.required !== 'HIDDEN') lock('paid_extras');
      if (f.required === 'REQUIRED') push('required', 'NOT_ALLOWED', `${f.type === 'EXTRA' ? 'Extras' : 'Pickups'} are always optional for guests`);
      if (f.type === 'EXTRA') {
        extraCount++;
        const cats = f.extra?.categories;
        if (cats && cats.some((c) => !(EXTRA_CATEGORIES as readonly string[]).includes(c))) push('extra.categories', 'INVALID_OPTION', 'Unknown extra category');
      } else {
        pickupCount++;
        const dirs = f.pickup?.directions ?? [];
        if (!dirs.length || dirs.some((d) => d !== 'ARRIVAL' && d !== 'DEPARTURE')) push('pickup.directions', 'INVALID_OPTION', 'Choose arrival pickup, departure drop-off or both');
      }
    }
    if (f.condition) {
      if (f.source === 'SYSTEM') push('condition', 'LOCKED', 'Compulsory fields are always shown');
      else {
        if (f.required !== 'HIDDEN') lock('form_conditional_logic');
        const c = f.condition;
        if (!(OPERATORS as readonly string[]).includes(c.operator)) push('condition.operator', 'INVALID_OPTION', 'Unknown condition');
        if (c.fieldKey === f.key) push('condition.fieldKey', 'BAD_CONDITION', 'A field cannot depend on itself');
        if ((c.operator === 'EQUALS' || c.operator === 'NOT_EQUALS') && (c.value === undefined || Array.isArray(c.value))) push('condition.value', 'BAD_CONDITION', 'Give one value to compare with');
        if (c.operator === 'IN' && (!Array.isArray(c.value) || !c.value.length)) push('condition.value', 'BAD_CONDITION', 'Give the list of values');
      }
    }
  });
  // References (need the whole list).
  fields.forEach((f, i) => {
    if (!f.condition || f.source === 'SYSTEM') return;
    const target = byKey.get(f.condition.fieldKey);
    if (!target) issues.push({ path: `fields[${i}].condition.fieldKey`, fieldKey: f.key, code: 'BAD_CONDITION', message: `No field "${f.condition.fieldKey}" to depend on` });
    else if (target.type === 'FILE' || target.type === 'EXTRA' || target.type === 'PICKUP' || target.key === 'dates' || target.key === 'policyConsent') {
      issues.push({ path: `fields[${i}].condition.fieldKey`, fieldKey: f.key, code: 'BAD_CONDITION', message: `A condition cannot depend on "${target.label}"` });
    }
  });
  const cyc = hasCycle(fields);
  if (cyc) issues.push({ path: 'fields', fieldKey: cyc, code: 'BAD_CONDITION', message: 'These conditions depend on each other in a loop' });
  if (extraCount > 1) issues.push({ path: 'fields', fieldKey: null, code: 'DUPLICATE_KEY', message: 'Only one extras picker per form' });
  if (pickupCount > 1) issues.push({ path: 'fields', fieldKey: null, code: 'DUPLICATE_KEY', message: 'Only one pickup block per form' });
  return { issues, warnings, lockedFeature, customCount: customFieldCount(fields) };
}

/** "Show Children's ages when Children is not empty". */
export function conditionText(f: FormField, fields: FormField[]): string | null {
  const c = f.condition;
  if (!c) return null;
  const target = fields.find((x) => x.key === c.fieldKey);
  const name = target?.label ?? c.fieldKey;
  const label = (v: unknown) => target?.options.find((o) => o.value === String(v))?.label ?? String(v);
  const what =
    c.operator === 'EQUALS' ? `is ${label(c.value)}`
      : c.operator === 'NOT_EQUALS' ? `is not ${label(c.value)}`
        : c.operator === 'IN' ? `is ${(Array.isArray(c.value) ? c.value : []).map(label).join(' or ')}`
          : c.operator === 'IS_TRUE' ? 'is yes'
            : c.operator === 'IS_FALSE' ? 'is no'
              : 'is not empty';
  return `Show ${f.label} when ${name} ${what}`;
}

// ---------------------------------------------------------------------------
// Conditions and visibility
// ---------------------------------------------------------------------------

export function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || v === false || v === 0 || (Array.isArray(v) && v.length === 0);
}

export function conditionHolds(c: FormField['condition'], values: Record<string, unknown>): boolean {
  if (!c) return true;
  const v = values[c.fieldKey];
  const s = (x: unknown) => (x === undefined || x === null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x as string | number | boolean));
  switch (c.operator) {
    case 'EQUALS':
      return Array.isArray(v) ? v.map(s).includes(s(c.value)) : s(v) === s(c.value);
    case 'NOT_EQUALS':
      return Array.isArray(v) ? !v.map(s).includes(s(c.value)) : s(v) !== s(c.value);
    case 'IN': {
      const list = (Array.isArray(c.value) ? c.value : []).map(s);
      return Array.isArray(v) ? v.some((x) => list.includes(s(x))) : list.includes(s(v));
    }
    case 'IS_TRUE':
      return v === true || v === 'true';
    case 'IS_FALSE':
      return v === false || v === 'false' || v === undefined || v === null;
    case 'NOT_EMPTY':
      return !isEmpty(v);
    default:
      return false;
  }
}

/** Keys shown on a channel for the given values (hidden and channel-less fields never are; conditions chain). */
export function visibleKeys(fields: FormField[], channel: Channel, values: Record<string, unknown>): Set<string> {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const memo = new Map<string, boolean>();
  const shown = (k: string, depth = 0): boolean => {
    if (memo.has(k)) return memo.get(k)!;
    const f = byKey.get(k);
    let ok = !!f && f.required !== 'HIDDEN' && f.channels.includes(channel);
    if (ok && f!.condition && f!.source !== 'SYSTEM') {
      const parent = f!.condition.fieldKey;
      const parentShown = SYSTEM_KEYS.has(parent) || (depth < 20 && shown(parent, depth + 1));
      ok = parentShown && conditionHolds(f!.condition, values);
    }
    memo.set(k, ok);
    return ok;
  };
  return new Set(fields.filter((f) => shown(f.key)).map((f) => f.key));
}

// ---------------------------------------------------------------------------
// Answer validation
// ---------------------------------------------------------------------------

export interface AnswerContext {
  channel: Channel;
  paymentMode?: 'ONLINE' | 'PAY_AT_HOTEL' | null;
  adults?: number;
  children?: number;
  guest?: { fullName?: string | null; phone?: string | null; email?: string | null } | null;
  consent?: boolean | null;
  /** Check the contact block too (public bookings: yes; desk: the guest record is checked elsewhere). */
  checkGuest?: boolean;
  today?: string;
  /** FILE and PICKUP need data outside the form: the caller validates them. */
  complex?: (f: FormField, value: unknown, path: string) => { value?: unknown; issues: ValidationIssue[] };
}

export interface AnswerResult {
  issues: ValidationIssue[];
  /** Cleaned values of visible, non-system fields with a value. */
  stored: Record<string, unknown>;
  visible: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addDaysIso(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function lagosToday(): string {
  return new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
}

/** Validates and cleans one simple (non FILE / PICKUP / EXTRA) value. */
export function checkValue(f: FormField, raw: unknown, path: string, today = lagosToday()): { value?: unknown; issues: ValidationIssue[] } {
  const bad = (code: string, message: string, meta?: Record<string, unknown>) => ({ issues: [{ path, fieldKey: f.key, code, message, ...(meta && { meta }) }] });
  const v = f.validation ?? {};
  switch (f.type) {
    case 'SHORT_TEXT':
    case 'LONG_TEXT': {
      if (typeof raw !== 'string') return bad('TYPE', `${f.label}: enter text`);
      const s = raw.trim();
      const max = v.maxLength ?? (f.type === 'LONG_TEXT' ? 500 : 120);
      if (s.length > max) return bad('TOO_LONG', `${f.label} can be at most ${max} characters`, { max });
      if (v.pattern && s && !new RegExp(v.pattern).test(s)) return bad('PATTERN', f.helpText ? `${f.label}: ${f.helpText}` : `${f.label} is not in the expected format${f.placeholder ? ` (e.g. ${f.placeholder.replace(/^e\.g\.\s*/i, '')})` : ''}`);
      return { value: s, issues: [] };
    }
    case 'NUMBER': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return bad('TYPE', `${f.label}: enter a number`);
      if (v.min !== undefined && n < v.min) return bad('MIN', `${f.label} must be at least ${v.min}`, { min: v.min });
      if (v.max !== undefined && n > v.max) return bad('MAX', `${f.label} can be at most ${v.max}`, { max: v.max });
      return { value: n, issues: [] };
    }
    case 'DATE': {
      if (typeof raw !== 'string' || !DATE_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) || new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) !== raw) {
        return bad('INVALID_DATE', `${f.label}: enter a date as YYYY-MM-DD`);
      }
      if (v.min !== undefined && raw < addDaysIso(today, v.min)) return bad('MIN', `${f.label} is too far in the past`, { min: addDaysIso(today, v.min) });
      if (v.max !== undefined && raw > addDaysIso(today, v.max)) return bad('MAX', v.max < 0 ? `${f.label} must be in the past` : `${f.label} is too far ahead`, { max: addDaysIso(today, v.max) });
      return { value: raw, issues: [] };
    }
    case 'TIME':
      if (typeof raw !== 'string' || !TIME_RE.test(raw)) return bad('INVALID_TIME', `${f.label}: enter a time like 14:30`);
      return { value: raw, issues: [] };
    case 'SELECT': {
      const s = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : null;
      if (s === null || !f.options.some((o) => o.value === s)) return bad('INVALID_OPTION', `${f.label}: choose one of the options`);
      return { value: s, issues: [] };
    }
    case 'MULTI_SELECT': {
      if (!Array.isArray(raw)) return bad('TYPE', `${f.label}: choose from the options`);
      const vals = [...new Set(raw.map(String))];
      if (vals.some((x) => !f.options.some((o) => o.value === x))) return bad('INVALID_OPTION', `${f.label}: choose from the options`);
      if (v.min !== undefined && vals.length < v.min) return bad('MIN', `${f.label}: choose at least ${v.min}`, { min: v.min });
      if (v.max !== undefined && vals.length > v.max) return bad('MAX', `${f.label}: choose at most ${v.max}`, { max: v.max });
      return { value: vals, issues: [] };
    }
    case 'YES_NO':
    case 'CHECKBOX':
      if (typeof raw !== 'boolean') return bad('TYPE', `${f.label}: answer yes or no`);
      return { value: raw, issues: [] };
    case 'PHONE': {
      if (typeof raw !== 'string') return bad('INVALID_PHONE', `${f.label}: enter a phone number`);
      const p = normalisePhone(raw);
      if (!p) return bad('INVALID_PHONE', `${f.label}: enter a valid phone number, e.g. 0803 123 4567`);
      return { value: p, issues: [] };
    }
    case 'EMAIL': {
      if (typeof raw !== 'string' || !EMAIL_RE.test(raw.trim()) || raw.length > 200) return bad('INVALID_EMAIL', `${f.label}: enter a valid email address`);
      return { value: raw.trim().toLowerCase(), issues: [] };
    }
    default:
      return bad('TYPE', `${f.label} cannot be answered here`);
  }
}

/**
 * Server-side validation of a booking's answers against a published version:
 * unknown keys refused; hidden, channel-less and condition-false fields
 * ignored; required checks respect conditions and channel; email is required
 * for online payment. Every issue is returned at once.
 */
export function validateAnswers(fields: FormField[], answersIn: Record<string, unknown> | null | undefined, ctx: AnswerContext): AnswerResult {
  const answers = answersIn && typeof answersIn === 'object' && !Array.isArray(answersIn) ? answersIn : {};
  const issues: ValidationIssue[] = [];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const k of Object.keys(answers)) {
    if (SYSTEM_KEYS.has(k)) {
      const where = SYSTEM_BOUND[k] === 'GUEST' ? `guest.${k}` : SYSTEM_BOUND[k] === 'CONSENT' ? 'consent' : 'the booking dates and guests';
      issues.push({ path: `answers.${k}`, fieldKey: k, code: 'NOT_ALLOWED', message: `Send ${k} in ${where}, not in answers` });
    } else if (!byKey.has(k)) {
      issues.push({ path: `answers.${k}`, fieldKey: k, code: 'UNKNOWN_FIELD', message: `"${k}" is not a question of this booking form` });
    }
  }
  const values: Record<string, unknown> = { ...answers, adults: ctx.adults ?? 1, children: ctx.children ?? 0 };
  const visible = visibleKeys(fields, ctx.channel, values);
  const stored: Record<string, unknown> = {};

  if (ctx.checkGuest) {
    const g = ctx.guest ?? {};
    const email = byKey.get('email');
    const emailRequired = email?.required === 'REQUIRED' || ctx.paymentMode === 'ONLINE';
    if (!g.fullName || g.fullName.trim().length < 2) issues.push({ path: 'guest.fullName', fieldKey: 'fullName', code: 'REQUIRED', message: 'Please enter the name the booking is for' });
    if (!g.phone) issues.push({ path: 'guest.phone', fieldKey: 'phone', code: 'REQUIRED', message: 'Please enter a phone number' });
    else if (!normalisePhone(g.phone)) issues.push({ path: 'guest.phone', fieldKey: 'phone', code: 'INVALID_PHONE', message: 'Enter a valid phone number, e.g. 0803 123 4567' });
    if (!g.email && emailRequired) {
      issues.push({ path: 'guest.email', fieldKey: 'email', code: 'REQUIRED', message: ctx.paymentMode === 'ONLINE' ? 'An email address is needed to pay online (for your receipt)' : 'Please enter your email address' });
    } else if (g.email && !EMAIL_RE.test(g.email.trim())) {
      issues.push({ path: 'guest.email', fieldKey: 'email', code: 'INVALID_EMAIL', message: 'Enter a valid email address' });
    }
    if (ctx.channel !== 'FRONT_DESK' && ctx.consent !== true) issues.push({ path: 'consent', fieldKey: 'policyConsent', code: 'REQUIRED', message: 'Please accept the hotel policies to book' });
  }

  for (const f of fields) {
    if (f.source === 'SYSTEM' || !visible.has(f.key)) continue;
    const path = `answers.${f.key}`;
    const raw = answers[f.key];
    if (f.type === 'EXTRA') continue; // the selection travels in the quote
    const empty = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0) || (f.type === 'CHECKBOX' && raw === false);
    if (empty) {
      if (f.required === 'REQUIRED') issues.push({ path, fieldKey: f.key, code: 'REQUIRED', message: `${f.label} is required` });
      if (f.type === 'PICKUP' || f.type === 'FILE') {
        const r = ctx.complex?.(f, undefined, path);
        if (r) issues.push(...r.issues);
      }
      continue;
    }
    const r = f.type === 'FILE' || f.type === 'PICKUP' ? (ctx.complex?.(f, raw, path) ?? { issues: [{ path, fieldKey: f.key, code: 'NOT_AVAILABLE', message: `${f.label} cannot be answered here` }] }) : checkValue(f, raw, path, ctx.today);
    issues.push(...r.issues);
    if (!r.issues.length && r.value !== undefined) stored[f.key] = r.value;
  }
  return { issues, stored, visible: [...visible] };
}

// ---------------------------------------------------------------------------
// Diff and display
// ---------------------------------------------------------------------------

export interface FormDiff {
  added: { key: string; label: string }[];
  removed: { key: string; label: string }[];
  changed: { key: string; label: string; changes: string[] }[];
  summary: string;
}

const CMP_PROPS: (keyof FormField)[] = ['label', 'helpText', 'placeholder', 'required', 'options', 'validation', 'section', 'channels', 'condition', 'purpose', 'guestPurpose', 'sensitive', 'extra', 'pickup'];

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function formDiff(draft: FormField[], published: FormField[] | null): FormDiff {
  const pub = new Map((published ?? []).map((f) => [f.key, f]));
  const dr = new Map(draft.map((f) => [f.key, f]));
  const added = draft.filter((f) => !pub.has(f.key)).map((f) => ({ key: f.key, label: f.label }));
  const removed = (published ?? []).filter((f) => !dr.has(f.key)).map((f) => ({ key: f.key, label: f.label }));
  const changed: FormDiff['changed'] = [];
  const pubOrder = (published ?? []).map((f) => f.key).filter((k) => dr.has(k));
  const drOrder = draft.map((f) => f.key).filter((k) => pub.has(k));
  for (const f of draft) {
    const p = pub.get(f.key);
    if (!p) continue;
    const changes: string[] = [];
    for (const prop of CMP_PROPS) {
      if (same(f[prop], p[prop])) continue;
      if (prop === 'required') changes.push(`${String(p.required).toLowerCase()} -> ${String(f.required).toLowerCase()}`);
      else if (prop === 'label') changes.push(`renamed from "${p.label}"`);
      else changes.push(`${prop} changed`);
    }
    if (changes.length) changed.push({ key: f.key, label: f.label, changes });
  }
  const moved = published && pubOrder.join('|') !== drOrder.join('|');
  const parts: string[] = [];
  if (added.length) parts.push(`${added.length} added`);
  if (removed.length) parts.push(`${removed.length} removed`);
  if (changed.length) parts.push(`${changed.length} changed`);
  if (moved) parts.push('order changed');
  return { added, removed, changed, summary: published ? (parts.length ? parts.join(', ') : 'No changes') : 'First version' };
}

const text = (v: unknown): string => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v as string | number | boolean));

/** Text shown for a stored answer ("Yes", option labels, file name ...). */
export function displayValue(f: FormField | undefined, v: unknown): string {
  if (v === null || v === undefined) return '';
  if (!f) return text(v);
  switch (f.type) {
    case 'YES_NO':
    case 'CHECKBOX':
      return v ? 'Yes' : 'No';
    case 'SELECT':
      return f.options.find((o) => o.value === v)?.label ?? text(v);
    case 'MULTI_SELECT':
      return (Array.isArray(v) ? v : []).map((x) => f.options.find((o) => o.value === x)?.label ?? text(x)).join(', ');
    case 'FILE':
      return (v as { name?: string }).name ?? 'File';
    case 'PICKUP': {
      const p = v as { wanted?: boolean; summary?: string };
      return p.wanted ? (p.summary ?? 'Pickup requested') : 'No pickup';
    }
    default:
      return text(v);
  }
}
