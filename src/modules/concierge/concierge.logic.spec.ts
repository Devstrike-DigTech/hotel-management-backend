import type { TaxComponent } from '../folios/tax.logic.js';
import {
  canTransition,
  commissionOf,
  dueForEscalation,
  folioDescription,
  formatNumber,
  normaliseQuestions,
  parseQuoteReply,
  priceLabel,
  priceService,
  quotePrice,
  requestLabel,
  serviceIssues,
  slaDueAt,
  slaView,
  slotsFor,
  timeIssue,
  validateQuestions,
  validateServiceAnswers,
  withinHours,
  type ServiceLike,
} from './concierge.logic.js';

const VAT: TaxComponent[] = [{ code: 'VAT', label: 'VAT', rateBps: 750, inclusive: false }];
const base: ServiceLike = {
  id: 's1',
  name: 'In-room massage',
  pricing: 'FIXED',
  priceKobo: null,
  variants: [
    { id: '60', name: '60 minutes', priceKobo: 3_500_000, durationMinutes: 60 },
    { id: '90', name: '90 minutes', priceKobo: 4_800_000, durationMinutes: 90 },
  ],
  durationMinutes: null,
  leadTimeHours: 2,
  availability: { days: [0, 1, 2, 3, 4, 5, 6], from: '10:00', to: '22:00' },
  requiresSlot: true,
  slotCapacity: 1,
  taxable: true,
};

describe('concierge pricing', () => {
  it('prices a variant with VAT on top (the M2 tax model)', () => {
    const r = priceService(base, { variantId: '90' }, VAT);
    expect(r.issues).toEqual([]);
    expect(r.price).toMatchObject({ amountKobo: 4_800_000, netKobo: 4_800_000, taxKobo: 360_000, totalKobo: 5_160_000, description: 'In-room massage, 90 minutes' });
  });

  it('needs a variant when the service has options', () => {
    expect(priceService(base, {}, VAT).issues[0]).toMatchObject({ path: 'variantId', code: 'REQUIRED' });
    expect(priceService(base, { variantId: 'x' }, VAT).issues[0]).toMatchObject({ path: 'variantId', code: 'INVALID_OPTION' });
  });

  it('prices per hour and per person', () => {
    const sitter: ServiceLike = { ...base, name: 'Babysitting', pricing: 'PER_HOUR', priceKobo: 600_000, variants: [], durationMinutes: 180 };
    expect(priceService(sitter, { hours: 4 }, []).price).toMatchObject({ amountKobo: 2_400_000, description: 'Babysitting x 4 hours' });
    expect(priceService(sitter, {}, []).price?.amountKobo).toBe(1_800_000); // 180 minutes = 3 hours
    const tour: ServiceLike = { ...base, name: 'City tour', pricing: 'PER_PERSON', priceKobo: 2_500_000, variants: [] };
    expect(priceService(tour, { partySize: 3 }, []).price).toMatchObject({ amountKobo: 7_500_000, description: 'City tour x 3 people' });
    expect(priceService(tour, {}, []).issues[0]).toMatchObject({ path: 'partySize', code: 'REQUIRED' });
  });

  it('FROM services need a quote; FREE ones cost nothing', () => {
    expect(priceService({ ...base, pricing: 'FROM', variants: [], priceKobo: 12_000_000 }, {}, VAT)).toMatchObject({ price: null, requiresQuote: true, issues: [] });
    expect(priceService({ ...base, pricing: 'FREE', variants: [], priceKobo: null }, {}, VAT).price).toMatchObject({ amountKobo: 0, totalKobo: 0, taxes: [] });
  });

  it('quotes go through the tax model, inclusive components carved out', () => {
    expect(quotePrice(18_000_000, true, VAT, 'Chef')).toMatchObject({ netKobo: 18_000_000, taxKobo: 1_350_000, totalKobo: 19_350_000 });
    const inclusive: TaxComponent[] = [{ code: 'VAT', label: 'VAT', rateBps: 750, inclusive: true }];
    const q = quotePrice(10_750_000, true, inclusive, 'Chef');
    expect(q.netKobo + q.taxKobo).toBe(10_750_000);
    expect(quotePrice(10_000_000, false, VAT, 'Chef').taxKobo).toBe(0);
  });

  it('labels prices for the catalogue', () => {
    expect(priceLabel(base)).toBe('From ₦35,000');
    expect(priceLabel({ pricing: 'PER_HOUR', priceKobo: 600_000, variants: [] })).toBe('₦6,000 per hour');
    expect(priceLabel({ pricing: 'FREE', priceKobo: null, variants: [] })).toBe('Free');
    expect(priceLabel({ pricing: 'FROM', priceKobo: null, variants: [] })).toBe('Price on request');
  });

  it('checks service definitions', () => {
    expect(serviceIssues({ ...base, pricing: 'FIXED', variants: [], priceKobo: null })[0]).toMatchObject({ path: 'priceKobo', code: 'REQUIRED' });
    expect(serviceIssues({ ...base, availability: null })[0]).toMatchObject({ path: 'availability', code: 'REQUIRED' });
    expect(serviceIssues(base)).toEqual([]);
  });
});

describe('concierge availability and slots', () => {
  // 2026-09-26 is a Saturday; Lagos is UTC+1.
  const now = new Date('2026-09-26T09:00:00Z'); // 10:00 Lagos
  it('checks lead time and opening hours', () => {
    expect(timeIssue(base, new Date('2026-09-26T10:00:00Z'), now, { enforceLeadTime: true })).toMatchObject({ code: 'LEAD_TIME' });
    expect(timeIssue(base, new Date('2026-09-26T22:00:00Z'), now, { enforceLeadTime: true })).toMatchObject({ code: 'OUTSIDE_HOURS' });
    expect(timeIssue(base, new Date('2026-09-26T15:00:00Z'), now, { enforceLeadTime: true })).toBeNull();
    expect(timeIssue(base, new Date('2026-09-26T09:30:00Z'), now, { enforceLeadTime: false })).toBeNull();
  });

  it('handles windows past midnight', () => {
    const late = { days: [5], from: '18:00', to: '02:00' }; // Friday evening
    expect(withinHours(late, new Date('2026-09-25T20:00:00Z'))).toBe(true); // Fri 21:00
    expect(withinHours(late, new Date('2026-09-26T00:30:00Z'))).toBe(true); // Sat 01:30 (Friday night)
    expect(withinHours(late, new Date('2026-09-26T02:30:00Z'))).toBe(false); // Sat 03:30
  });

  it('builds 30-minute slots inside the hours, full ones and lead time marked', () => {
    const busy = [{ start: new Date('2026-09-26T14:00:00Z'), end: new Date('2026-09-26T15:00:00Z') }];
    const slots = slotsFor(base, '2026-09-26', now, busy, 60);
    expect(slots[0]!.start).toBe('2026-09-26T09:00:00.000Z'); // 10:00 Lagos
    expect(slots.at(-1)!.start).toBe('2026-09-26T20:00:00.000Z'); // 21:00 Lagos, ends at 22:00
    expect(slots.find((s) => s.start === '2026-09-26T09:30:00.000Z')!.reason).toBe('LEAD_TIME');
    expect(slots.find((s) => s.start === '2026-09-26T14:00:00.000Z')!.reason).toBe('FULL');
    expect(slots.find((s) => s.start === '2026-09-26T13:30:00.000Z')!.reason).toBe('FULL'); // overlaps 15:00 Lagos
    expect(slots.find((s) => s.start === '2026-09-26T16:00:00.000Z')!.available).toBe(true);
  });
});

describe('concierge status machine, SLA and money', () => {
  it('allows only the documented transitions', () => {
    expect(canTransition('NEW', 'QUOTED')).toBe(true);
    expect(canTransition('QUOTED', 'QUOTED')).toBe(true);
    expect(canTransition('QUOTED', 'SCHEDULED')).toBe(false);
    expect(canTransition('CONFIRMED', 'COMPLETED')).toBe(true);
    expect(canTransition('COMPLETED', 'CANCELLED')).toBe(false);
    expect(canTransition('SCHEDULED', 'DECLINED')).toBe(false);
  });

  it('computes SLA due times, overdue and escalation', () => {
    const created = new Date('2026-09-26T10:00:00Z');
    const s = { slaInStayMinutes: 15, slaPreArrivalMinutes: 120, escalateAfterMinutes: 5 };
    expect(slaDueAt(created, 'IN_STAY', s).toISOString()).toBe('2026-09-26T10:15:00.000Z');
    expect(slaDueAt(created, 'PRE_ARRIVAL', s).toISOString()).toBe('2026-09-26T12:00:00.000Z');
    const r = { slaDueAt: new Date('2026-09-26T10:15:00Z'), firstResponseAt: null, escalatedAt: null, slaTarget: 'IN_STAY', status: 'NEW' };
    expect(slaView(r, new Date('2026-09-26T10:20:00Z'))).toMatchObject({ overdue: true, minutesLeft: -5 });
    expect(slaView({ ...r, firstResponseAt: new Date('2026-09-26T10:05:00Z') }, new Date('2026-09-26T10:20:00Z'))).toMatchObject({ overdue: false, minutesLeft: null });
    expect(dueForEscalation(r, 5, new Date('2026-09-26T10:19:00Z'))).toBe(false);
    expect(dueForEscalation(r, 5, new Date('2026-09-26T10:21:00Z'))).toBe(true);
    expect(dueForEscalation({ ...r, escalatedAt: new Date() }, 0, new Date('2026-09-26T11:00:00Z'))).toBe(false);
    expect(dueForEscalation({ ...r, status: 'CANCELLED' }, 0, new Date('2026-09-26T11:00:00Z'))).toBe(false);
  });

  it('computes vendor commission as a percentage or a fixed amount', () => {
    expect(commissionOf('PERCENT', 1500, 4_800_000)).toEqual({ commissionKobo: 720_000, vendorPayableKobo: 4_080_000 });
    expect(commissionOf('FIXED', 500_000, 9_500_000)).toEqual({ commissionKobo: 500_000, vendorPayableKobo: 9_000_000 });
    expect(commissionOf('FIXED', 500_000, 300_000)).toEqual({ commissionKobo: 300_000, vendorPayableKobo: 0 });
    expect(commissionOf('NONE', 0, 1_000)).toBeNull();
  });

  it('uses neutral folio wording for private requests', () => {
    const labels = { inRoom: 'In-room service', other: 'Guest service' };
    expect(folioDescription({ discreet: true, serviceName: 'In-room massage', location: 'IN_ROOM', number: 'CR-000002' }, labels)).toBe('In-room service (CR-000002)');
    expect(folioDescription({ discreet: true, serviceName: 'Private chef dinner', location: 'ON_PROPERTY', number: 'CR-000009' }, labels)).toBe('Guest service (CR-000009)');
    expect(folioDescription({ discreet: false, serviceName: 'In-room massage', variantName: '90 minutes', location: 'IN_ROOM', number: 'CR-000002' }, labels)).toBe('In-room massage, 90 minutes (CR-000002)');
  });

  it('labels masked requests without the service or the guest', () => {
    expect(requestLabel({ masked: true, title: 'In-room massage', roomNumber: '204', assigneeName: 'Amaka Nwosu', guestName: 'Adaeze Okafor' })).toBe('Private request · Room 204 · assigned to Amaka Nwosu');
    expect(requestLabel({ masked: false, title: 'In-room massage', roomNumber: '204', assigneeName: null, guestName: 'Adaeze Okafor' })).toBe('In-room massage · Room 204 · Adaeze O.');
    expect(formatNumber(123)).toBe('CR-000123');
  });
});

describe('WhatsApp replies to quotes', () => {
  it.each([
    ['YES', { answer: 'YES', seq: null }],
    ['yes please', { answer: 'YES', seq: null }],
    ['Ok.', { answer: 'YES', seq: null }],
    ['YES CR-000123', { answer: 'YES', seq: 123 }],
    ['yes 45', { answer: 'YES', seq: 45 }],
    ['No thanks', { answer: 'NO', seq: null }],
    ['NO cr-000007', { answer: 'NO', seq: 7 }],
    ['n', { answer: 'NO', seq: null }],
  ])('parses %s', (text, want) => {
    expect(parseQuoteReply(text)).toEqual(want);
  });

  it.each(['yes but can we make it 8pm instead?', 'Nothing yet', 'Yesterday was lovely', 'I need towels', ''])('ignores %s', (text) => {
    expect(parseQuoteReply(text)).toBeNull();
  });
});

describe('service questions (M7 form-field engine)', () => {
  it('normalises questions with c_ keys and validates answers server-side', () => {
    const q = normaliseQuestions([
      { type: 'SELECT', label: 'Massage type', required: 'REQUIRED', options: [{ value: 'SWEDISH', label: 'Swedish' }, { value: 'DEEP', label: 'Deep tissue' }] },
      { type: 'NUMBER', label: 'Number of guests', required: 'OPTIONAL', validation: { min: 1, max: 4 } },
    ]);
    expect(q.map((f) => f.key)).toEqual(['c_massage_type', 'c_number_of_guests']);
    expect(validateQuestions(q, []).issues).toEqual([]);
    expect(validateServiceAnswers(q, {}).issues[0]).toMatchObject({ path: 'answers.c_massage_type', code: 'REQUIRED' });
    expect(validateServiceAnswers(q, { c_massage_type: 'HOT' }).issues[0]).toMatchObject({ code: 'INVALID_OPTION' });
    expect(validateServiceAnswers(q, { c_massage_type: 'DEEP', c_number_of_guests: 9 }).issues[0]).toMatchObject({ code: 'MAX' });
    expect(validateServiceAnswers(q, { c_massage_type: 'DEEP', extra: 'x' }).issues[0]).toMatchObject({ code: 'UNKNOWN_FIELD' });
    expect(validateServiceAnswers(q, { c_massage_type: 'DEEP' })).toEqual({ issues: [], stored: { c_massage_type: 'DEEP' } });
  });

  it('refuses FILE / PICKUP questions, BVN labels and more than 12 questions', () => {
    const bad = normaliseQuestions([{ type: 'FILE', label: 'Upload' }, { type: 'SHORT_TEXT', label: 'Your BVN' }]);
    const codes = validateQuestions(bad, ['form_file_uploads']).issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['NOT_ALLOWED', 'BVN_BLOCKED']));
    const many = normaliseQuestions(Array.from({ length: 13 }, (_v, i) => ({ type: 'SHORT_TEXT' as const, label: `Question ${i}` })));
    expect(validateQuestions(many, []).issues.some((i) => i.code === 'MAX')).toBe(true);
  });

  it('gates conditional questions behind form_conditional_logic', () => {
    const q = normaliseQuestions([
      { key: 'c_occasion', type: 'SELECT', label: 'Occasion', options: [{ value: 'B', label: 'Birthday' }] },
      { key: 'c_cake', type: 'SHORT_TEXT', label: 'Cake message', condition: { fieldKey: 'c_occasion', operator: 'EQUALS', value: 'B' } },
    ]);
    expect(validateQuestions(q, []).lockedFeature).toBe('form_conditional_logic');
    expect(validateQuestions(q, ['form_conditional_logic']).lockedFeature).toBeNull();
  });
});
