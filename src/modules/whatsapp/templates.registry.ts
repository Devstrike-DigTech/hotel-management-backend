/**
 * WhatsApp message templates. Outside the 24-hour customer-service window the
 * Cloud API only delivers templates Meta has approved, so every message the
 * platform starts is one of these. `docs/whatsapp-templates.md` lists exactly
 * what to submit (name, category, language, body, examples); keep the two in
 * step (a unit test checks the placeholders).
 */
import { naira, type TemplateData } from '../notifications/templates/templates.js';

export type WhatsAppTemplateName =
  | 'owner_daily_digest'
  | 'guard_alert_high'
  | 'booking_confirmed'
  | 'pre_arrival'
  | 'review_request'
  | 'payment_receipt'
  | 'otp_code'
  | 'guest_message'
  | 'pre_arrival_confirm'
  | 'in_stay_welcome'
  | 'transfer_driver_assigned'
  | 'transfer_update'
  | 'concierge_request_received'
  | 'concierge_quote'
  | 'concierge_confirmed'
  | 'concierge_update'
  | 'concierge_completed'
  | 'concierge_vendor_job';

export interface WhatsAppTemplateDef {
  name: WhatsAppTemplateName;
  language: 'en';
  category: 'UTILITY' | 'AUTHENTICATION';
  body: string;
  params: { index: number; name: string; example: string }[];
  buttons: { type: 'URL' | 'QUICK_REPLY' | 'COPY_CODE'; text: string; url?: string }[];
  usedFor: string;
}

export const WHATSAPP_TEMPLATES: WhatsAppTemplateDef[] = [
  {
    name: 'owner_daily_digest',
    language: 'en',
    category: 'UTILITY',
    body:
      '{{1}} daily summary for {{2}}.\n' +
      'Rooms sold: {{3}} of {{4}} ({{5}} occupancy).\n' +
      'Revenue: {{6}}. Money received: {{7}}.\n' +
      'Check-ins: {{8}}. Check-outs: {{9}}. Day use: {{10}}.\n' +
      'Revenue Guard: {{11}}.\n' +
      'Reply DIGEST at any time for the latest figures.',
    params: [
      { index: 1, name: 'hotel name', example: 'The Palmwine House' },
      { index: 2, name: 'business date', example: 'Tue 22 Sep 2026' },
      { index: 3, name: 'rooms sold', example: '17' },
      { index: 4, name: 'rooms available', example: '23' },
      { index: 5, name: 'occupancy', example: '74%' },
      { index: 6, name: 'revenue', example: '₦1,845,000' },
      { index: 7, name: 'money received', example: '₦1,612,500' },
      { index: 8, name: 'check-ins', example: '6' },
      { index: 9, name: 'check-outs', example: '5' },
      { index: 10, name: 'day-use stays', example: '1' },
      { index: 11, name: 'guard summary', example: '2 open flags, top: Room 204 occupied with no stay' },
    ],
    buttons: [],
    usedFor: 'Nightly owner digest (23:00) and the DIGEST reply',
  },
  {
    name: 'guard_alert_high',
    language: 'en',
    category: 'UTILITY',
    body:
      'Revenue Guard alert at {{1}}: {{2}} high-risk flag(s).\n' +
      '{{3}}\n' +
      'Amount involved: {{4}}.\n' +
      'Review: {{5}}\n' +
      'Reply 1 to acknowledge.',
    params: [
      { index: 1, name: 'hotel name', example: 'The Palmwine House' },
      { index: 2, name: 'number of flags', example: '2' },
      { index: 3, name: 'top flag', example: 'Room 204 occupied with no checked-in stay' },
      { index: 4, name: 'amount', example: '₦85,000' },
      { index: 5, name: 'admin link', example: 'https://admin.hotelos.ng/guard' },
    ],
    buttons: [{ type: 'QUICK_REPLY', text: '1' }],
    usedFor: 'Real-time owner alert for HIGH Revenue Guard flags',
  },
  {
    name: 'booking_confirmed',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{1}}, your booking {{2}} at {{3}} is confirmed.\n' +
      'Check-in: {{4}}\n' +
      'Check-out: {{5}}\n' +
      'Room: {{6}}\n' +
      'Total: {{7}} ({{8}}).\n' +
      'Manage your booking: {{9}}',
    params: [
      { index: 1, name: 'guest first name', example: 'Adaeze' },
      { index: 2, name: 'booking code', example: 'PWH-7K3Q' },
      { index: 3, name: 'hotel name', example: 'The Palmwine House' },
      { index: 4, name: 'check-in', example: 'Fri 2 Oct 2026, 14:00' },
      { index: 5, name: 'check-out', example: 'Sun 4 Oct 2026, 12:00' },
      { index: 6, name: 'room type', example: 'Deluxe King' },
      { index: 7, name: 'total', example: '₦182,750' },
      { index: 8, name: 'payment status', example: 'paid online' },
      { index: 9, name: 'manage link', example: 'https://hotelos.ng/trips/PWH-7K3Q?t=abc' },
    ],
    buttons: [],
    usedFor: 'Guest booking confirmation (paid online or pay at hotel) for hotels with whatsapp_messaging',
  },
  {
    name: 'pre_arrival',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{1}}, we look forward to welcoming you to {{2}} on {{3}}.\n' +
      'Check-in is from {{4}}. Address: {{5}}.\n' +
      'Hotel phone: {{6}}.\n' +
      'Your booking {{7}}: {{8}}',
    params: [
      { index: 1, name: 'guest first name', example: 'Adaeze' },
      { index: 2, name: 'hotel name', example: 'The Palmwine House' },
      { index: 3, name: 'arrival date', example: 'Fri 2 Oct 2026' },
      { index: 4, name: 'check-in time', example: '14:00' },
      { index: 5, name: 'address', example: '14 Admiralty Way, Lekki Phase 1, Lagos' },
      { index: 6, name: 'hotel phone', example: '+234 803 555 0100' },
      { index: 7, name: 'booking code', example: 'PWH-7K3Q' },
      { index: 8, name: 'manage link', example: 'https://hotelos.ng/trips/PWH-7K3Q?t=abc' },
    ],
    buttons: [],
    usedFor: 'Pre-arrival message 24 hours before check-in',
  },
  {
    name: 'review_request',
    language: 'en',
    category: 'UTILITY',
    body: 'Hello {{1}}, thank you for staying at {{2}}. How was your stay? Please leave a short review by {{3}}: {{4}}',
    params: [
      { index: 1, name: 'guest first name', example: 'Adaeze' },
      { index: 2, name: 'hotel name', example: 'The Palmwine House' },
      { index: 3, name: 'deadline', example: 'Fri 23 Oct 2026' },
      { index: 4, name: 'review link', example: 'https://hotelos.ng/review?t=abc' },
    ],
    buttons: [],
    usedFor: 'Review request 4 hours after check-out (guests without an email address)',
  },
  {
    name: 'payment_receipt',
    language: 'en',
    category: 'UTILITY',
    body: 'Payment received: {{1}} for booking {{2}} at {{3}}. Receipt number {{4}}. Thank you.',
    params: [
      { index: 1, name: 'amount', example: '₦182,750' },
      { index: 2, name: 'booking code', example: 'PWH-7K3Q' },
      { index: 3, name: 'hotel name', example: 'The Palmwine House' },
      { index: 4, name: 'receipt number', example: 'RCT-2026-000456' },
    ],
    buttons: [],
    usedFor: 'Payment receipt (online payments) when the guest has no email address',
  },
  {
    name: 'otp_code',
    language: 'en',
    category: 'AUTHENTICATION',
    body: '{{1}} is your verification code. For your security, do not share this code.',
    params: [{ index: 1, name: 'code', example: '482913' }],
    buttons: [{ type: 'COPY_CODE', text: 'Copy code' }],
    usedFor: 'Guest sign-in code sent over WhatsApp',
  },
  {
    name: 'guest_message',
    language: 'en',
    category: 'UTILITY',
    body: 'Hello {{1}}, this is {{2}}. {{3}} Reply to this message to chat with us.',
    params: [
      { index: 1, name: 'guest first name', example: 'Adaeze' },
      { index: 2, name: 'hotel name', example: 'The Palmwine House' },
      { index: 3, name: 'message', example: 'Your airport pickup is confirmed for 3pm tomorrow.' },
    ],
    buttons: [],
    usedFor: 'Guest inbox: staff start or resume a conversation outside the 24-hour window',
  },
  {
    name: 'pre_arrival_confirm',
    language: 'en',
    category: 'UTILITY',
    body: 'Hello {{1}}, we look forward to welcoming you at {{2}} on {{3}}. Reply 1 to confirm your arrival time.',
    params: [
      { index: 1, name: 'guest first name', example: 'Adaeze' },
      { index: 2, name: 'hotel name', example: 'The Palmwine House' },
      { index: 3, name: 'arrival date', example: 'Fri 2 Oct 2026' },
    ],
    buttons: [{ type: 'QUICK_REPLY', text: '1' }],
    usedFor: 'Guest inbox: pre-arrival arrival-time confirmation 24 hours before check-in',
  },
  {
    name: 'in_stay_welcome',
    language: 'en',
    category: 'UTILITY',
    body: 'Welcome to {{1}}, {{2}}. You are in room {{3}}. Reply to this message with any request and our team will help.',
    params: [
      { index: 1, name: 'hotel name', example: 'The Palmwine House' },
      { index: 2, name: 'guest first name', example: 'Adaeze' },
      { index: 3, name: 'room number', example: '204' },
    ],
    buttons: [],
    usedFor: 'Guest inbox: welcome after check-in, inviting requests',
  },
  {
    name: 'transfer_driver_assigned',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{1}}, your driver for your {{2}} with {{3}} is {{4}} ({{5}}).\n' +
      'Vehicle: {{6}}.\n' +
      'Pickup point: {{7}}, {{8}}.\n' +
      'Booking {{9}}. Call the hotel on {{10}} if your plans change.',
    params: [
      { index: 1, name: 'guest first name', example: 'Adaeze' },
      { index: 2, name: 'transfer', example: 'airport pickup' },
      { index: 3, name: 'hotel name', example: 'The Palmwine House' },
      { index: 4, name: 'driver name', example: 'Musa Ibrahim' },
      { index: 5, name: 'driver phone', example: '+2348035550142' },
      { index: 6, name: 'vehicle and plate', example: 'Toyota Sienna, LSD 482 KJ' },
      { index: 7, name: 'pickup point', example: 'Murtala Muhammed International Airport (MMIA)' },
      { index: 8, name: 'date and time', example: 'Fri 2 Oct 2026, 15:40' },
      { index: 9, name: 'booking code', example: 'PWH-7K3Q' },
      { index: 10, name: 'hotel phone', example: '+234 803 555 0100' },
    ],
    buttons: [],
    usedFor: 'Arrival pickup / departure drop-off: driver, phone and plate once a driver is assigned',
  },
  {
    name: 'transfer_update',
    language: 'en',
    category: 'UTILITY',
    body: 'Hello {{1}}, an update on your {{2}} with {{3}}: {{4}} Booking {{5}}.',
    params: [
      { index: 1, name: 'guest first name', example: 'Adaeze' },
      { index: 2, name: 'transfer', example: 'arrival pickup' },
      { index: 3, name: 'hotel name', example: 'The Palmwine House' },
      { index: 4, name: 'update', example: 'Your driver is on the way and will reach Jibowu Motor Park by 19:30.' },
      { index: 5, name: 'booking code', example: 'PWH-7K3Q' },
    ],
    buttons: [],
    usedFor: 'Arrival pickup / departure drop-off: driver on the way, delays and cancellations',
  },
  // M8: concierge (lawful guest requests). Private requests use "private request" instead of the service.
  {
    name: 'concierge_request_received',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{1}}, {{2}} has your request {{3}}: {{4}}.\n' +
      'We will get back to you within {{5}}. Only the concierge team sees your request details.\n' +
      'See it here: {{6}}',
    params: [
      { index: 1, name: 'guest first name', example: 'Adaeze' },
      { index: 2, name: 'hotel name', example: 'The Palmwine House' },
      { index: 3, name: 'request number', example: 'CR-000123' },
      { index: 4, name: 'service (or "private request")', example: 'Private chef dinner' },
      { index: 5, name: 'reply target', example: '15 minutes' },
      { index: 6, name: 'request link', example: 'https://hotelos.ng/trips/PWH-7K3Q?t=abc#concierge' },
    ],
    buttons: [],
    usedFor: 'Concierge: acknowledgement of a guest request (flagged requests get the same neutral text)',
  },
  {
    name: 'concierge_quote',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{1}}, {{2}} can arrange your request {{3}} ({{4}}) for {{5}}.\n' +
      'This price is held until {{6}}. Details: {{7}}\n' +
      'Reply YES to accept or NO to decline.',
    params: [
      { index: 1, name: 'guest first name', example: 'Adaeze' },
      { index: 2, name: 'hotel name', example: 'The Palmwine House' },
      { index: 3, name: 'request number', example: 'CR-000123' },
      { index: 4, name: 'service (or "private request")', example: 'Private chef dinner' },
      { index: 5, name: 'price', example: '₦96,750' },
      { index: 6, name: 'valid until', example: 'Sat 26 Sep 2026, 18:00' },
      { index: 7, name: 'quote link', example: 'https://hotelos.ng/concierge/q/abc' },
    ],
    buttons: [{ type: 'QUICK_REPLY', text: 'YES' }, { type: 'QUICK_REPLY', text: 'NO' }],
    usedFor: 'Concierge: a quote the guest accepts or declines (reply YES / NO or open the link)',
  },
  {
    name: 'concierge_confirmed',
    language: 'en',
    category: 'UTILITY',
    body:
      'Hello {{1}}, your request {{2}} ({{3}}) with {{4}} is confirmed for {{5}}.\n' +
      'Payment: {{6}}.\n' +
      'Details: {{7}}',
    params: [
      { index: 1, name: 'guest first name', example: 'Adaeze' },
      { index: 2, name: 'request number', example: 'CR-000123' },
      { index: 3, name: 'service (or "private request")', example: 'In-room massage, 90 minutes' },
      { index: 4, name: 'hotel name', example: 'The Palmwine House' },
      { index: 5, name: 'date and time', example: 'Sat 26 Sep 2026, 19:00' },
      { index: 6, name: 'payment', example: 'added to your bill' },
      { index: 7, name: 'request link', example: 'https://hotelos.ng/trips/PWH-7K3Q?t=abc#concierge' },
    ],
    buttons: [],
    usedFor: 'Concierge: request confirmed (automatically, accepted, paid or by staff)',
  },
  {
    name: 'concierge_update',
    language: 'en',
    category: 'UTILITY',
    body: 'Hello {{1}}, an update on your request {{2}} with {{3}}: {{4}}\nDetails: {{5}}',
    params: [
      { index: 1, name: 'guest first name', example: 'Adaeze' },
      { index: 2, name: 'request number', example: 'CR-000123' },
      { index: 3, name: 'hotel name', example: 'The Palmwine House' },
      { index: 4, name: 'update', example: 'Your chef will arrive at 18:30 to set up.' },
      { index: 5, name: 'request link', example: 'https://hotelos.ng/trips/PWH-7K3Q?t=abc#concierge' },
    ],
    buttons: [],
    usedFor: 'Concierge: scheduled, payment link, declined, cancelled and other updates',
  },
  {
    name: 'concierge_completed',
    language: 'en',
    category: 'UTILITY',
    body: 'Hello {{1}}, your request {{2}} with {{3}} is complete. We hope you enjoyed it.\nTell us how it went: {{4}}',
    params: [
      { index: 1, name: 'guest first name', example: 'Adaeze' },
      { index: 2, name: 'request number', example: 'CR-000123' },
      { index: 3, name: 'hotel name', example: 'The Palmwine House' },
      { index: 4, name: 'rating link', example: 'https://hotelos.ng/trips/PWH-7K3Q?t=abc#concierge' },
    ],
    buttons: [],
    usedFor: 'Concierge: request completed, with the rating link',
  },
  {
    name: 'concierge_vendor_job',
    language: 'en',
    category: 'UTILITY',
    body:
      'New job from {{1}}: {{2}} ({{3}}).\n' +
      'When: {{4}}. Guests: {{5}}.\n' +
      'Guest: {{6}}. Where: {{7}}.\n' +
      'Notes: {{8}}\n' +
      'Please confirm with {{9}} on {{10}}.',
    params: [
      { index: 1, name: 'hotel name', example: 'The Palmwine House' },
      { index: 2, name: 'service', example: 'In-room massage, 90 minutes' },
      { index: 3, name: 'job number', example: 'CR-000123' },
      { index: 4, name: 'date and time', example: 'Sat 26 Sep 2026, 19:00' },
      { index: 5, name: 'party size', example: '2' },
      { index: 6, name: 'guest first name', example: 'Adaeze' },
      { index: 7, name: 'where', example: 'at the hotel (the front desk will take you up)' },
      { index: 8, name: 'notes', example: 'Deep tissue, female therapist preferred.' },
      { index: 9, name: 'hotel contact', example: 'Amaka Nwosu' },
      { index: 10, name: 'hotel phone', example: '+234 803 555 0100' },
    ],
    buttons: [],
    usedFor: 'Concierge: a job sent to a vendor (first name only and no room number unless the hotel allows it)',
  },
];

const BY_NAME = new Map(WHATSAPP_TEMPLATES.map((t) => [t.name, t]));

export function templateDef(name: WhatsAppTemplateName): WhatsAppTemplateDef {
  return BY_NAME.get(name)!;
}

/** What a template message looks like once its placeholders are filled (outbox, logs). */
export function fillTemplate(name: WhatsAppTemplateName, params: string[]): string {
  return templateDef(name).body.replace(/\{\{(\d+)\}\}/g, (_m, i: string) => params[Number(i) - 1] ?? '');
}

export interface WaTemplateRef {
  name: WhatsAppTemplateName;
  language: 'en';
  params: string[];
}

/** WhatsApp parameters must be non-empty single-line text (Meta rejects newlines and tabs). */
export function cleanParam(v: string | number | null | undefined): string {
  const s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
  return s.length ? s.slice(0, 1000) : '-';
}

function first(full: string): string {
  return full.trim().split(/\s+/)[0] || 'there';
}

/** The approved template (and its parameters) for a guest message, or null (then SMS-style text only). */
export function waTemplateFor(data: TemplateData): WaTemplateRef | null {
  const ref = (name: WhatsAppTemplateName, params: (string | number | null)[]): WaTemplateRef => ({ name, language: 'en', params: params.map(cleanParam) });
  switch (data.template) {
    case 'BOOKING_CONFIRMED':
    case 'PAY_AT_HOTEL_CONFIRMED': {
      const s = data.stay;
      return ref('booking_confirmed', [
        first(s.guestName),
        s.code,
        s.hotel.name,
        s.arrivalHuman,
        s.departureHuman,
        s.roomTypeName,
        naira(s.totalKobo),
        s.paymentMode === 'ONLINE' ? 'paid online' : 'pay at the hotel',
        s.manageUrl,
      ]);
    }
    case 'PRE_ARRIVAL': {
      const s = data.stay;
      return ref('pre_arrival', [first(s.guestName), s.hotel.name, s.arrivalHuman.split(',')[0], s.hotel.checkInTime, [s.hotel.address, s.hotel.area, s.hotel.city].filter(Boolean).join(', '), s.hotel.phone, s.code, s.manageUrl]);
    }
    case 'REVIEW_REQUEST':
      return ref('review_request', [first(data.guestName), data.hotelName, data.deadlineHuman, data.reviewUrl]);
    case 'PAYMENT_RECEIPT':
      return ref('payment_receipt', [naira(data.amountKobo), data.stay.code, data.stay.hotel.name, data.receiptNumber]);
    case 'OTP':
      return ref('otp_code', [data.code]);
    case 'TRANSFER_DRIVER_ASSIGNED': {
      const t = data.transfer;
      return ref('transfer_driver_assigned', [
        first(data.stay.guestName),
        t.label.toLowerCase(),
        data.stay.hotel.name,
        t.driverName,
        t.driverPhone,
        [t.vehicleDescription, t.vehiclePlate].filter(Boolean).join(', '),
        t.pointName,
        t.whenHuman,
        data.stay.code,
        data.stay.hotel.phone,
      ]);
    }
    case 'TRANSFER_UPDATE':
      return ref('transfer_update', [first(data.stay.guestName), data.transfer.label.toLowerCase(), data.stay.hotel.name, data.note, data.stay.code]);
    // M8
    case 'CONCIERGE_RECEIVED':
      return ref('concierge_request_received', [first(data.c.guestName), data.c.hotel.name, data.c.number, data.c.discreet ? 'private request' : data.c.title, data.replyWithin, data.c.url]);
    case 'CONCIERGE_QUOTE':
      return ref('concierge_quote', [first(data.c.guestName), data.c.hotel.name, data.c.number, data.c.discreet ? 'private request' : data.c.title, data.c.totalKobo !== null ? naira(data.c.totalKobo) : '-', data.validUntilHuman, data.c.url]);
    case 'CONCIERGE_CONFIRMED':
      return ref('concierge_confirmed', [first(data.c.guestName), data.c.number, data.c.discreet ? 'private request' : data.c.title, data.c.hotel.name, data.c.whenHuman ?? 'the time agreed', data.c.paymentText ?? 'nothing to pay now', data.c.url]);
    case 'CONCIERGE_UPDATE':
      return ref('concierge_update', [first(data.c.guestName), data.c.number, data.c.hotel.name, data.update, data.c.url]);
    case 'CONCIERGE_COMPLETED':
      return ref('concierge_completed', [first(data.c.guestName), data.c.number, data.c.hotel.name, data.c.url]);
    case 'CONCIERGE_VENDOR_JOB': {
      const j = data.job;
      return ref('concierge_vendor_job', [j.hotelName, j.service, j.number, j.whenHuman, j.partySize, j.guest, j.where, j.notes, j.contactName, j.contactPhone]);
    }
    default:
      return null;
  }
}
