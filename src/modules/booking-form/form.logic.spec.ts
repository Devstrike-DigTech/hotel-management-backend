import { PRESETS, SYSTEM_FIELDS, type FormField } from './form.catalogue.js';
import { buildPreset, customFieldCount, formDiff, idCheck, normaliseFields, safePattern, validateAnswers, validateBuilder, visibleKeys } from './form.logic.js';

const ALL = ['paid_extras', 'form_fields_unlimited', 'form_conditional_logic', 'form_file_uploads'];

function custom(f: Partial<FormField> & Pick<FormField, 'key' | 'type' | 'label'>): FormField {
  return {
    source: 'CUSTOM', libraryKey: null, recommended: false, helpText: null, placeholder: null, required: 'OPTIONAL', options: [], validation: {},
    section: 'Your stay', order: 99, channels: ['MARKETPLACE', 'BOOKING_SITE', 'FRONT_DESK'], condition: null, purpose: null, guestPurpose: null, sensitive: false, ...f,
  };
}

/** A preset with extra custom fields, the consent box kept last. */
function formWith(...extra: FormField[]): FormField[] {
  const base = buildPreset('default', ALL).fields;
  const consent = base.find((f) => f.key === 'policyConsent')!;
  return normaliseFields([...base.filter((f) => f !== consent), ...extra, consent].map((f, order) => ({ ...f, order })));
}

const occasion = custom({
  key: 'c_occasion', type: 'SELECT', label: 'Occasion', channels: ['MARKETPLACE', 'BOOKING_SITE'],
  options: [{ value: 'BIRTHDAY', label: 'Birthday' }, { value: 'NONE', label: 'No' }],
});
const cakeName = custom({ key: 'c_cake_name', type: 'SHORT_TEXT', label: 'Name on the cake', required: 'REQUIRED', validation: { maxLength: 30 }, condition: { fieldKey: 'c_occasion', operator: 'EQUALS', value: 'BIRTHDAY' } });
const deskOnly = custom({ key: 'c_room_note', type: 'SHORT_TEXT', label: 'Desk note', channels: ['FRONT_DESK'], required: 'REQUIRED' });
const hidden = custom({ key: 'c_hidden', type: 'SHORT_TEXT', label: 'Hidden', required: 'HIDDEN' });

const guest = { fullName: 'Adaeze Okafor', phone: '08031234567', email: 'ada@example.com' };

describe('idCheck (BVN blocked, ID numbers discouraged)', () => {
  it('blocks BVN in the label or the help text', () => {
    expect(idCheck('BVN').level).toBe('BLOCK');
    expect(idCheck('Bank verification number').level).toBe('BLOCK');
    expect(idCheck('Your number', 'We need your BVN for verification').level).toBe('BLOCK');
  });
  it('warns on NIN, passport and other ID numbers', () => {
    expect(idCheck('NIN')).toMatchObject({ level: 'WARN', kind: 'NIN' });
    expect(idCheck('Passport number')).toMatchObject({ level: 'WARN', kind: 'PASSPORT' });
    expect(idCheck("Driver's licence")).toMatchObject({ level: 'WARN', kind: 'DRIVERS_LICENCE' });
    expect(idCheck('Means of ID')).toMatchObject({ level: 'WARN', kind: 'ID_NUMBER' });
  });
  it('lets ordinary labels through', () => {
    expect(idCheck('Name on the cake').level).toBe('OK');
    expect(idCheck('Company name (for the invoice)').level).toBe('OK');
  });
});

describe('safePattern', () => {
  it('accepts simple patterns and refuses nested quantifiers and backreferences', () => {
    expect(safePattern('^[A-Z]{3}-\\d{3}$')).toBe(true);
    expect(safePattern('^(a+)+$')).toBe(false);
    expect(safePattern('(\\w*)*x')).toBe(false);
    expect(safePattern('(a)\\1')).toBe(false);
    expect(safePattern('[')).toBe(false);
  });
});

describe('presets', () => {
  it('every preset builds a form the builder accepts (all features), consent last', () => {
    for (const p of PRESETS) {
      const { fields, skipped } = buildPreset(p.id, ALL);
      expect(skipped).toEqual([]);
      expect(validateBuilder(fields, ALL).issues).toEqual([]);
      expect(fields[fields.length - 1]!.key).toBe('policyConsent');
      for (const s of SYSTEM_FIELDS) expect(fields.some((f) => f.key === s.key)).toBe(true);
    }
  });

  it('Starter keeps within 3 custom fields and skips paid extras', () => {
    const { fields, skipped } = buildPreset('resort', [], 3);
    expect(customFieldCount(fields)).toBeLessThanOrEqual(3);
    expect(skipped).toEqual(expect.arrayContaining(['pickup', 'extras']));
    expect(fields.some((f) => f.type === 'PICKUP' || f.type === 'EXTRA')).toBe(false);
  });
});

describe('validateBuilder', () => {
  it('blocks a BVN question and warns on an NIN question', () => {
    const r = validateBuilder(formWith(custom({ key: 'c_bvn', type: 'SHORT_TEXT', label: 'Your BVN' }), custom({ key: 'c_nin', type: 'SHORT_TEXT', label: 'NIN' })), ALL);
    expect(r.issues).toEqual(expect.arrayContaining([expect.objectContaining({ fieldKey: 'c_bvn', code: 'BVN_BLOCKED' })]));
    expect(r.warnings).toEqual([expect.objectContaining({ fieldKey: 'c_nin', code: 'ID_LIKE', kind: 'NIN' })]);
  });

  it('reports the plan feature a form needs (conditions, file uploads)', () => {
    expect(validateBuilder(formWith(occasion, cakeName), ['form_fields_unlimited']).lockedFeature).toBe('form_conditional_logic');
    const file = custom({ key: 'c_letter', type: 'FILE', label: 'Company letter', validation: { maxFileMB: 5, accept: ['pdf'] } });
    expect(validateBuilder(formWith(file), ['form_fields_unlimited']).lockedFeature).toBe('form_file_uploads');
    expect(validateBuilder(formWith(occasion, cakeName, file), ALL).lockedFeature).toBeNull();
  });

  it('refuses bad conditions, duplicate keys and custom pickup blocks', () => {
    const self = custom({ key: 'c_self', type: 'SHORT_TEXT', label: 'Self', condition: { fieldKey: 'c_self', operator: 'NOT_EMPTY' } });
    const missing = custom({ key: 'c_orphan', type: 'SHORT_TEXT', label: 'Orphan', condition: { fieldKey: 'c_nothing', operator: 'NOT_EMPTY' } });
    const pickup = custom({ key: 'c_pickup', type: 'PICKUP', label: 'Pickup' });
    const r = validateBuilder(formWith(self, missing, occasion, { ...occasion }, pickup), ALL);
    const codes = r.issues.map((i) => `${i.fieldKey}:${i.code}`);
    expect(codes).toEqual(expect.arrayContaining(['c_self:BAD_CONDITION', 'c_orphan:BAD_CONDITION', 'c_occasion:DUPLICATE_KEY', 'c_pickup:NOT_ALLOWED']));
  });

  it('counts custom and library fields toward the Starter limit (recommended and hidden ones do not)', () => {
    const f = formWith(occasion, hidden, custom({ key: 'c_a', type: 'SHORT_TEXT', label: 'A' }));
    expect(customFieldCount(f)).toBe(2);
  });
});

describe('visibleKeys and validateAnswers', () => {
  const fields = formWith(occasion, cakeName, deskOnly, hidden);

  it('shows a conditional field only when its condition holds, and per channel', () => {
    expect(visibleKeys(fields, 'BOOKING_SITE', { c_occasion: 'NONE' }).has('c_cake_name')).toBe(false);
    expect(visibleKeys(fields, 'BOOKING_SITE', { c_occasion: 'BIRTHDAY' }).has('c_cake_name')).toBe(true);
    // The parent is not on the desk channel, so the child is not either.
    expect(visibleKeys(fields, 'FRONT_DESK', { c_occasion: 'BIRTHDAY' }).has('c_cake_name')).toBe(false);
    expect(visibleKeys(fields, 'FRONT_DESK', {}).has('c_room_note')).toBe(true);
    expect(visibleKeys(fields, 'BOOKING_SITE', {}).has('c_room_note')).toBe(false);
    expect(visibleKeys(fields, 'BOOKING_SITE', {}).has('c_hidden')).toBe(false);
  });

  it('requires a visible required field and ignores hidden / other-channel ones', () => {
    const ok = validateAnswers(fields, { c_occasion: 'NONE' }, { channel: 'BOOKING_SITE', checkGuest: true, guest, consent: true, paymentMode: 'PAY_AT_HOTEL' });
    expect(ok.issues).toEqual([]);
    expect(ok.stored).toEqual({ c_occasion: 'NONE' });
    const missing = validateAnswers(fields, { c_occasion: 'BIRTHDAY' }, { channel: 'BOOKING_SITE', checkGuest: true, guest, consent: true });
    expect(missing.issues).toEqual([expect.objectContaining({ path: 'answers.c_cake_name', code: 'REQUIRED' })]);
    const desk = validateAnswers(fields, {}, { channel: 'FRONT_DESK' });
    expect(desk.issues).toEqual([expect.objectContaining({ fieldKey: 'c_room_note', code: 'REQUIRED' })]);
  });

  it('does not store answers of fields that are not shown', () => {
    const r = validateAnswers(fields, { c_occasion: 'NONE', c_cake_name: 'Ada' }, { channel: 'BOOKING_SITE' });
    expect(r.issues).toEqual([]);
    expect(r.stored).toEqual({ c_occasion: 'NONE' });
  });

  it('refuses unknown keys, system keys and invalid options', () => {
    const r = validateAnswers(fields, { nope: 1, fullName: 'X', c_occasion: 'WEDDING' }, { channel: 'BOOKING_SITE' });
    const codes = r.issues.map((i) => `${i.fieldKey}:${i.code}`);
    expect(codes).toEqual(expect.arrayContaining(['nope:UNKNOWN_FIELD', 'fullName:NOT_ALLOWED', 'c_occasion:INVALID_OPTION']));
  });

  it('needs an email only when paying online (unless the hotel makes it required)', () => {
    const noEmail = { ...guest, email: '' };
    const online = validateAnswers(fields, {}, { channel: 'BOOKING_SITE', checkGuest: true, guest: noEmail, consent: true, paymentMode: 'ONLINE' });
    expect(online.issues).toEqual([expect.objectContaining({ path: 'guest.email', code: 'REQUIRED' })]);
    const atHotel = validateAnswers(fields, {}, { channel: 'BOOKING_SITE', checkGuest: true, guest: noEmail, consent: true, paymentMode: 'PAY_AT_HOTEL' });
    expect(atHotel.issues).toEqual([]);
    const required = fields.map((f) => (f.key === 'email' ? { ...f, required: 'REQUIRED' as const } : f));
    expect(validateAnswers(required, {}, { channel: 'BOOKING_SITE', checkGuest: true, guest: noEmail, consent: true, paymentMode: 'PAY_AT_HOTEL' }).issues).toEqual([
      expect.objectContaining({ path: 'guest.email', code: 'REQUIRED' }),
    ]);
  });

  it('needs policy consent online but not at the desk', () => {
    expect(validateAnswers(fields, {}, { channel: 'BOOKING_SITE', checkGuest: true, guest, consent: false }).issues).toEqual([expect.objectContaining({ path: 'consent', code: 'REQUIRED' })]);
    expect(validateAnswers(fields, { c_room_note: 'Ground floor' }, { channel: 'FRONT_DESK', checkGuest: true, guest }).issues).toEqual([]);
  });

  it('children ages show only when children are booked', () => {
    const resort = buildPreset('resort', ALL).fields;
    expect(visibleKeys(resort, 'BOOKING_SITE', { children: 0 }).has('childrenAges')).toBe(false);
    expect(visibleKeys(resort, 'BOOKING_SITE', { children: 2 }).has('childrenAges')).toBe(true);
    const r = validateAnswers(resort, { childrenAges: '4, 9' }, { channel: 'BOOKING_SITE', children: 2 });
    expect(r.issues).toEqual([]);
    expect(validateAnswers(resort, { childrenAges: 'four' }, { channel: 'BOOKING_SITE', children: 2 }).issues).toEqual([expect.objectContaining({ fieldKey: 'childrenAges', code: 'PATTERN' })]);
  });
});

describe('formDiff', () => {
  it('lists added, removed and changed fields between versions', () => {
    const v1 = formWith(occasion);
    const v2 = formWith({ ...occasion, label: 'Special occasion?' }, cakeName);
    const d = formDiff(v2, v1);
    expect(JSON.stringify(d)).toContain('c_cake_name');
    expect(JSON.stringify(d)).toContain('c_occasion');
  });
});
