import { otpMeta } from '../notification.service.js';
import { fullAddress, naira, renderTemplate, TEMPLATES, type BrandContext, type StayContext, type TemplateData, type TransferContext, type ConciergeContext } from './templates.js';

const brand: BrandContext = {
  appName: 'Stayline',
  appDomain: 'stayline.ng',
  supportEmail: 'help@stayline.ng',
  hotel: { name: 'The Palmwine House', accentColor: '#2F5A43', logoUrl: 'https://cdn.example/logo.png', area: 'Lekki Phase 1', city: 'Lagos' },
  hotelBranded: false,
};

const concierge: ConciergeContext = {
  guestName: 'Adaeze Okafor',
  number: 'CR-000123',
  title: 'Private chef dinner',
  discreet: false,
  hotel: { name: 'The Palmwine House', phone: '+234 802 555 0141' },
  url: 'https://stayline.ng/concierge/q/t',
  whenHuman: 'Sun 27 Sep 2026, 19:30',
  totalKobo: 19_350_000,
  paymentText: null,
  note: null,
};

const stay: StayContext = {
  guestName: 'Adaeze Okafor',
  code: 'PWH-7K3Q',
  hotel: { name: 'The Palmwine House', address: '14 Fola Osibo Road', area: 'Lekki Phase 1', city: 'Lagos', phone: '+234 802 555 0141', email: 'stay@palmwine.ng', checkInTime: '14:00', checkOutTime: '12:00', mapUrl: 'https://www.google.com/maps/search/?api=1&query=x' },
  roomTypeName: 'Deluxe King',
  stayType: 'NIGHTLY',
  arrivalHuman: 'Thu 1 Oct 2026, 14:00',
  departureHuman: 'Sat 3 Oct 2026, 12:00',
  nights: 2,
  hours: null,
  adults: 2,
  children: 0,
  lines: [
    { label: 'Deluxe King, night of Thu 1 Oct 2026', amountKobo: 8_500_000 },
    { label: 'Deluxe King, night of Fri 2 Oct 2026', amountKobo: 8_500_000 },
  ],
  taxes: [{ label: 'VAT 7.5%', amountKobo: 1_275_000 }],
  totalKobo: 18_275_000,
  paidKobo: 18_275_000,
  outstandingKobo: 0,
  paymentMode: 'ONLINE',
  policySummary: 'Free cancellation until 48 hours before check-in. After that, the first night is charged.',
  freeCancellationUntilHuman: 'Tue 29 Sep 2026, 14:00',
  manageUrl: 'https://stayline.ng/trips/PWH-7K3Q?t=abc',
  calendarUrl: 'https://api.stayline.ng/api/v1/public/trips/PWH-7K3Q/calendar.ics?t=abc',
  specialRequests: '',
};

const transfer: TransferContext = {
  label: 'Airport pickup',
  direction: 'ARRIVAL',
  pointName: 'Murtala Muhammed International Airport',
  whenHuman: 'Thu 1 Oct 2026, 11:20',
  driverName: 'Sunday Okon',
  driverPhone: '+2348031234567',
  vehiclePlate: 'LSD 482 KJ',
  vehicleDescription: 'Silver Toyota Corolla',
  meetingNote: 'Your driver waits at the arrivals exit holding a board with your name.',
  detailsSummary: 'Air Peace P4 7121, Terminal 2',
  status: 'DRIVER_ASSIGNED',
};

const samples: TemplateData[] = [
  { template: 'OTP', code: '482913', minutes: 5 },
  { template: 'MAGIC_LINK', url: 'https://stayline.ng/account/verify?token=t', minutes: 15, fullName: 'Adaeze Okafor' },
  { template: 'BOOKING_CONFIRMED', stay },
  { template: 'PAYMENT_RECEIPT', stay, receiptNumber: 'RCT-2026-000001', amountKobo: 18_275_000, amountInWords: 'One hundred and eighty-two thousand, seven hundred and fifty naira only', channel: 'card', reference: 'BKG_1', paidAtHuman: 'Wed 23 Sep 2026, 10:00' },
  { template: 'PAY_AT_HOTEL_CONFIRMED', stay: { ...stay, paidKobo: 0, outstandingKobo: stay.totalKobo, paymentMode: 'PAY_AT_HOTEL' } },
  { template: 'HOLD_EXPIRED', stay, hotelUrl: 'https://stayline.ng/hotels/palmwine-house' },
  { template: 'BOOKING_CANCELLED', stay, cancelledBy: 'GUEST', feeKobo: 9_137_500, refundKobo: 9_137_500, reason: null },
  { template: 'PRE_ARRIVAL', stay, message: 'Security will ask for your booking code.' },
  { template: 'REVIEW_REQUEST', guestName: 'Adaeze Okafor', hotelName: 'The Palmwine House', stayHuman: 'Thu 1 Oct 2026 to Sat 3 Oct 2026', reviewUrl: 'https://stayline.ng/review?t=r', deadlineHuman: 'Mon 2 Nov 2026' },
  { template: 'PAYMENT_ORPHANED_REFUND', stay, amountKobo: 18_275_000, reason: 'The payment arrived after the hold ended.' },
  { template: 'HOTEL_NEW_BOOKING', stay, channelLabel: 'Marketplace', adminUrl: 'https://admin/reservations/1', commissionKobo: 1_462_000, guestPhone: '+2348030000001', guestEmail: 'ada@example.ng' },
  { template: 'HOTEL_BOOKING_CANCELLED', stay, adminUrl: 'https://admin/reservations/1', feeKobo: 0, refundKobo: 18_275_000, reason: 'Plans changed' },
  { template: 'ORPHANED_PAYMENT_ALERT', hotelName: 'The Palmwine House', code: 'PWH-7K3Q', reference: 'BKG_1', amountKobo: 18_275_000, reason: 'Late payment.', guestName: 'Adaeze Okafor', guestPhone: '+234803•••0001', refundStatus: 'PENDING' },
  {
    template: 'CITY_LEDGER_REMINDER',
    hotelName: 'The Palmwine House',
    accountName: 'Deltaline Oilfield Services Ltd',
    contactName: 'Mrs Ifeoma Nwachukwu',
    invoiceNumber: 'CL-2026-000004',
    issueHuman: 'Mon 3 Aug 2026',
    dueHuman: 'Wed 2 Sep 2026',
    totalKobo: 184_000_000,
    balanceKobo: 84_000_000,
    daysOverdue: 21,
    message: null,
    statementUrl: 'https://admin.hotelos.ng/share/x',
    hotelPhone: '+2348031234567',
    hotelEmail: 'stay@palmwine.ng',
  },
  { template: 'GUARD_ALERT', hotelName: 'The Palmwine House', flags: [{ title: 'Room 204 occupied with no stay', amountKobo: null }], adminUrl: 'https://admin.hotelos.ng/guard', urgent: true },
  { template: 'WHATSAPP_REPLY', text: 'Acknowledged 2 alerts for The Palmwine House.' },
  // M6
  { template: 'SUPPORT_NEW', number: 'SR-000042', hotelName: 'Harmattan Hotels & Suites', subject: 'Night audit did not run', category: 'TECHNICAL', priority: 'HIGH', openedBy: 'Musa Danjuma (Manager)', excerpt: 'The night audit for Abuja did not post room charges last night.', slaHours: 2, consoleUrl: 'https://console.stayline.ng/support/1' },
  { template: 'SUPPORT_REPLY', number: 'SR-000042', subject: 'Night audit did not run', fromName: 'Ifeanyi from Stayline support', excerpt: 'We re-ran the audit for Tuesday; charges are now posted.', adminUrl: 'https://admin.stayline.ng/support/1' },
  { template: 'ANNOUNCEMENT', title: 'Planned maintenance on Sunday', body: 'The console will be read-only for 20 minutes.\n\nBookings keep working.', severity: 'MAINTENANCE', link: { label: 'Status page', url: 'https://status.stayline.ng' }, whenHuman: 'Sun 4 Oct 2026, 02:00 to 02:20' },
  { template: 'WEBHOOK_DISABLED', hotelName: 'Harmattan Hotels & Suites', url: 'https://hooks.example.ng/pms', failingSinceHuman: 'Tue 22 Sep 2026, 09:00', attempts: 14, lastError: 'HTTP 503', adminUrl: 'https://admin.stayline.ng/settings/webhooks' },
  { template: 'OWNER_SETUP', fullName: 'Aisha Bello', hotelName: 'Harmattan Hotels & Suites', url: 'https://admin.stayline.ng/setup-password?token=t', expiresHuman: 'Thu 1 Oct 2026' },
  { template: 'PLATFORM_INVITE', fullName: 'Zainab Bello', role: 'Support', url: 'https://console.stayline.ng/invite/t', invitedBy: 'Devstrike Admin', expiresHuman: 'Thu 1 Oct 2026' },
  { template: 'OFFBOARDING_NOTICE', hotelName: 'Coal City Retreat', deleteAfterHuman: 'Sat 24 Oct 2026', exportReady: true },
  // M7
  { template: 'TRANSFER_DRIVER_ASSIGNED', stay, transfer },
  { template: 'TRANSFER_UPDATE', stay, transfer: { ...transfer, status: 'EN_ROUTE' }, note: 'Your driver is on the way to MMIA.' },
  // M8
  { template: 'CONCIERGE_RECEIVED', c: concierge, replyWithin: '15 minutes' },
  { template: 'CONCIERGE_QUOTE', c: { ...concierge, note: 'Three courses with pepper soup to start.' }, validUntilHuman: 'Sun 27 Sep 2026, 18:00', whatsappReply: true },
  { template: 'CONCIERGE_CONFIRMED', c: { ...concierge, paymentText: 'added to your bill' } },
  { template: 'CONCIERGE_UPDATE', c: concierge, update: 'Your chef will arrive at 17:30 to set up.' },
  { template: 'CONCIERGE_COMPLETED', c: concierge },
  { template: 'CONCIERGE_VENDOR_JOB', job: { hotelName: 'The Palmwine House', service: 'In-room massage, 90 minutes', number: 'CR-000123', whenHuman: 'Sat 26 Sep 2026, 19:00', partySize: '1', guest: 'Adaeze', where: 'at The Palmwine House (the front desk will take you up)', notes: 'Female therapist preferred.', contactName: 'Amaka Nwosu', contactPhone: '+234 802 555 0141' } },
  { template: 'CONCIERGE_ESCALATION', hotelName: 'The Palmwine House', number: 'CR-000123', title: 'Private request CR-000123', overdueMinutes: 12, adminUrl: 'https://admin.stayline.ng/concierge/requests/1' },
  { template: 'CONCIERGE_SUSPENDED', hotelName: 'The Palmwine House', reason: 'A service breached the acceptable-use policy.' },
];

// Emoji and pictographs (the brand forbids them in every channel).
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;

describe('notification templates', () => {
  it('covers every template', () => {
    expect(samples.map((s) => s.template).sort()).toEqual([...TEMPLATES].sort());
  });

  it.each(samples.map((s) => [s.template, s] as const))('%s renders HTML, text and SMS without emoji', (_name, data) => {
    const r = renderTemplate(brand, data);
    expect(r.subject.length).toBeGreaterThan(5);
    expect(r.html).toContain('<!DOCTYPE html>');
    expect(r.html).toContain('prefers-color-scheme: dark');
    expect(r.html).toContain("'Fraunces', Georgia");
    expect(r.html).not.toMatch(/<script/i);
    expect(r.text).toContain('help@stayline.ng');
    for (const s of [r.subject, r.html, r.text, r.sms]) expect(s).not.toMatch(EMOJI);
  });

  it('keeps the everyday SMS within 160 characters and uses N for naira', () => {
    for (const t of ['OTP', 'BOOKING_CONFIRMED', 'PAY_AT_HOTEL_CONFIRMED', 'HOLD_EXPIRED', 'BOOKING_CANCELLED', 'PRE_ARRIVAL'] as const) {
      const sms = renderTemplate(brand, samples.find((s) => s.template === t)!).sms;
      expect(sms.length).toBeLessThanOrEqual(160);
      expect(sms).not.toContain('₦');
    }
  });

  it('puts the OTP code first in the SMS and never in the subject of other mail', () => {
    const r = renderTemplate(brand, samples[0]);
    expect(r.sms.startsWith('482913 is your Stayline sign-in code')).toBe(true);
    expect(r.html).toContain('482913');
  });

  it('uses the app name on marketplace mail and the hotel branding on booking-site mail', () => {
    const market = renderTemplate(brand, { template: 'BOOKING_CONFIRMED', stay });
    expect(market.html).toContain('Stayline');
    expect(market.html).toContain('#B4452A');
    const site = renderTemplate({ ...brand, hotelBranded: true }, { template: 'BOOKING_CONFIRMED', stay });
    expect(site.html).toContain('#2F5A43');
    expect(site.html).toContain('https://cdn.example/logo.png');
    expect(site.html).toContain('Sent by Stayline on behalf of The Palmwine House.');
  });

  it('M6: white-labelled mail carries only the hotel brand', () => {
    const r = renderTemplate({ ...brand, hotelBranded: true, whiteLabel: { brandName: 'Palmwine Collection', supportEmail: 'stay@palmwine.ng' } }, { template: 'BOOKING_CONFIRMED', stay });
    expect(r.html).toContain('Palmwine Collection');
    expect(r.html).not.toContain('Stayline');
    expect(r.text).toContain('stay@palmwine.ng');
    expect(r.text).not.toContain('help@stayline.ng');
  });

  it('escapes guest-supplied text in HTML', () => {
    const r = renderTemplate(brand, { template: 'BOOKING_CONFIRMED', stay: { ...stay, guestName: '<img src=x onerror=alert(1)>', specialRequests: '<b>late</b>' } });
    expect(r.html).not.toContain('<img src=x');
    expect(r.html).toContain('&lt;b&gt;late&lt;/b&gt;');
  });

  it('formats naira and addresses', () => {
    expect(naira(18_275_000)).toBe('₦182,750');
    expect(naira(12_345)).toBe('₦123.45');
    expect(fullAddress({ address: '14 Fola Osibo Road, Lekki Phase 1', area: 'Lekki Phase 1', city: 'Lagos' })).toBe('14 Fola Osibo Road, Lekki Phase 1, Lagos');
  });
});

describe('OTP outbox meta', () => {
  it('is the same on every channel, from meta or from the WhatsApp template', () => {
    const expected = { otpCode: '482913', waTemplate: 'otp_code', waParams: ['482913'] };
    expect(otpMeta({ template: 'OTP', meta: { otpCode: '482913' }, waTemplate: null })).toEqual(expected);
    expect(otpMeta({ template: 'OTP', meta: {}, waTemplate: { name: 'otp_code', language: 'en', params: ['482913'] } })).toEqual(expected);
    expect(otpMeta({ template: 'BOOKING_CONFIRMED', meta: { otpCode: 'x' }, waTemplate: null })).toEqual({});
  });
});

describe('transfer notifications (M7)', () => {
  it('the driver message carries the driver, the plate, the point and the time, in every channel', () => {
    const r = renderTemplate(brand, samples.find((s) => s.template === 'TRANSFER_DRIVER_ASSIGNED')!);
    for (const s of [r.html, r.text, r.sms]) {
      expect(s).toContain('Sunday Okon');
      expect(s).toContain('LSD 482 KJ');
    }
    expect(r.text).toContain('11:20');
    expect(r.text).toContain('PWH-7K3Q');
    expect(r.sms.length).toBeLessThanOrEqual(320);
  });
});

describe('concierge messages (M8)', () => {
  it('never names the service of a private request', () => {
    const c: ConciergeContext = { ...concierge, discreet: true, title: 'your private request' };
    for (const template of ['CONCIERGE_RECEIVED', 'CONCIERGE_QUOTE', 'CONFIRMED', 'CONCIERGE_UPDATE', 'CONCIERGE_COMPLETED'] as const) {
      const data = (template === 'CONFIRMED' ? { template: 'CONCIERGE_CONFIRMED', c } : template === 'CONCIERGE_QUOTE' ? { template, c, validUntilHuman: 'x', whatsappReply: false } : template === 'CONCIERGE_UPDATE' ? { template, c, update: 'Booked in.' } : template === 'CONCIERGE_RECEIVED' ? { template, c, replyWithin: '15 minutes' } : { template, c }) as TemplateData;
      const r = renderTemplate(brand, data);
      expect(`${r.subject} ${r.text} ${r.sms}`).not.toContain('Private chef dinner');
    }
  });

  it('asks for YES / NO on WhatsApp quotes only', () => {
    const wa = renderTemplate(brand, { template: 'CONCIERGE_QUOTE', c: concierge, validUntilHuman: 'x', whatsappReply: true });
    const mail = renderTemplate(brand, { template: 'CONCIERGE_QUOTE', c: concierge, validUntilHuman: 'x', whatsappReply: false });
    expect(wa.text).toContain('reply YES');
    expect(mail.text).not.toContain('reply YES');
  });
});
