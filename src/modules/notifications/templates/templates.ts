import { renderEmail, renderEmailText, safeAccent, type EmailBlock, type EmailBrand, type EmailSpec } from './email-layout.js';

export const TEMPLATES = [
  'OTP',
  'MAGIC_LINK',
  'BOOKING_CONFIRMED',
  'PAYMENT_RECEIPT',
  'PAY_AT_HOTEL_CONFIRMED',
  'HOLD_EXPIRED',
  'BOOKING_CANCELLED',
  'PRE_ARRIVAL',
  'REVIEW_REQUEST',
  'PAYMENT_ORPHANED_REFUND',
  'HOTEL_NEW_BOOKING',
  'HOTEL_BOOKING_CANCELLED',
  'ORPHANED_PAYMENT_ALERT',
  'CITY_LEDGER_REMINDER',
  'GUARD_ALERT',
  'WHATSAPP_REPLY',
  // M6
  'SUPPORT_NEW',
  'SUPPORT_REPLY',
  'ANNOUNCEMENT',
  'WEBHOOK_DISABLED',
  'OWNER_SETUP',
  'PLATFORM_INVITE',
  'OFFBOARDING_NOTICE',
] as const;
export type TemplateName = (typeof TEMPLATES)[number];

/** Identity used in every message. `hotel` switches to hotel branding (booking-site mail). */
export interface BrandContext {
  appName: string;
  appDomain: string;
  supportEmail: string;
  hotel?: { name: string; accentColor: string | null; logoUrl: string | null; area: string; city: string } | null;
  /** Use the hotel's look (BOOKING_SITE). Marketplace mail keeps the platform look. */
  hotelBranded?: boolean;
  /** M6 white-label: only the hotel's brand, no platform footer; replies go to the hotel. */
  whiteLabel?: { brandName: string; supportEmail: string | null } | null;
}

export interface StayContext {
  guestName: string;
  code: string;
  hotel: { name: string; address: string; area: string; city: string; phone: string; email: string; checkInTime: string; checkOutTime: string; mapUrl: string };
  roomTypeName: string;
  stayType: 'NIGHTLY' | 'DAY_USE';
  arrivalHuman: string;
  departureHuman: string;
  nights: number | null;
  hours: number | null;
  adults: number;
  children: number;
  lines: { label: string; amountKobo: number }[];
  taxes: { label: string; amountKobo: number }[];
  totalKobo: number;
  paidKobo: number;
  outstandingKobo: number;
  paymentMode: 'ONLINE' | 'PAY_AT_HOTEL';
  policySummary: string;
  freeCancellationUntilHuman: string | null;
  manageUrl: string;
  calendarUrl: string;
  specialRequests: string;
}

export type TemplateData =
  | { template: 'OTP'; code: string; minutes: number }
  | { template: 'MAGIC_LINK'; url: string; minutes: number; fullName: string }
  | { template: 'BOOKING_CONFIRMED'; stay: StayContext }
  | { template: 'PAYMENT_RECEIPT'; stay: StayContext; receiptNumber: string; amountKobo: number; amountInWords: string; channel: string | null; reference: string; paidAtHuman: string }
  | { template: 'PAY_AT_HOTEL_CONFIRMED'; stay: StayContext }
  | { template: 'HOLD_EXPIRED'; stay: StayContext; hotelUrl: string }
  | { template: 'BOOKING_CANCELLED'; stay: StayContext; cancelledBy: 'GUEST' | 'HOTEL' | 'SYSTEM'; feeKobo: number; refundKobo: number; reason: string | null }
  | { template: 'PRE_ARRIVAL'; stay: StayContext; message: string }
  | { template: 'REVIEW_REQUEST'; guestName: string; hotelName: string; stayHuman: string; reviewUrl: string; deadlineHuman: string }
  | { template: 'PAYMENT_ORPHANED_REFUND'; stay: StayContext; amountKobo: number; reason: string }
  | { template: 'HOTEL_NEW_BOOKING'; stay: StayContext; channelLabel: string; adminUrl: string; commissionKobo: number; guestPhone: string; guestEmail: string | null }
  | { template: 'HOTEL_BOOKING_CANCELLED'; stay: StayContext; adminUrl: string; feeKobo: number; refundKobo: number; reason: string | null }
  | { template: 'ORPHANED_PAYMENT_ALERT'; hotelName: string; code: string; reference: string; amountKobo: number; reason: string; guestName: string; guestPhone: string; refundStatus: string }
  | {
      template: 'CITY_LEDGER_REMINDER';
      hotelName: string;
      accountName: string;
      contactName: string;
      invoiceNumber: string;
      issueHuman: string;
      dueHuman: string;
      totalKobo: number;
      balanceKobo: number;
      daysOverdue: number;
      message: string | null;
      statementUrl: string | null;
      hotelPhone: string;
      hotelEmail: string;
    }
  | { template: 'GUARD_ALERT'; hotelName: string; flags: { title: string; amountKobo: number | null }[]; adminUrl: string; urgent: boolean }
  | { template: 'WHATSAPP_REPLY'; text: string }
  // M6
  | { template: 'SUPPORT_NEW'; number: string; hotelName: string; subject: string; category: string; priority: string; openedBy: string; excerpt: string; slaHours: number; consoleUrl: string }
  | { template: 'SUPPORT_REPLY'; number: string; subject: string; fromName: string; excerpt: string; adminUrl: string }
  | { template: 'ANNOUNCEMENT'; title: string; body: string; severity: string; link: { label: string; url: string } | null; whenHuman: string | null }
  | { template: 'WEBHOOK_DISABLED'; hotelName: string; url: string; failingSinceHuman: string; attempts: number; lastError: string | null; adminUrl: string }
  | { template: 'OWNER_SETUP'; fullName: string; hotelName: string; url: string; expiresHuman: string }
  | { template: 'PLATFORM_INVITE'; fullName: string; role: string; url: string; invitedBy: string; expiresHuman: string }
  | { template: 'OFFBOARDING_NOTICE'; hotelName: string; deleteAfterHuman: string; exportReady: boolean };

export interface Rendered {
  subject: string;
  /** Plain-text email part. */
  text: string;
  html: string;
  /** SMS / WhatsApp body (aim: <= 160 characters). */
  sms: string;
}

/** "₦12,500" (kobo shown only when not whole naira). */
export function naira(kobo: number): string {
  const n = kobo / 100;
  const whole = kobo % 100 === 0;
  return `₦${n.toLocaleString('en-NG', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** "N12,500" for SMS (the naira sign is not in the GSM-7 alphabet and would halve the SMS length). */
export function nairaSms(kobo: number): string {
  return naira(kobo).replace('₦', 'N');
}

function brand(ctx: BrandContext): EmailBrand {
  const h = ctx.hotel;
  if (h && ctx.whiteLabel) {
    // M6 white-label: the hotel's brand only.
    return {
      wordmark: ctx.whiteLabel.brandName || h.name,
      tagline: [h.area, h.city].filter(Boolean).join(', '),
      accent: safeAccent(h.accentColor),
      logoUrl: h.logoUrl,
      footerNote: `Sent by ${ctx.whiteLabel.brandName || h.name}.`,
      supportEmail: ctx.whiteLabel.supportEmail || ctx.supportEmail,
      appName: ctx.whiteLabel.brandName || h.name,
    };
  }
  if (h && ctx.hotelBranded) {
    return {
      wordmark: h.name,
      tagline: [h.area, h.city].filter(Boolean).join(', '),
      accent: safeAccent(h.accentColor),
      logoUrl: h.logoUrl,
      footerNote: `Sent by ${ctx.appName} on behalf of ${h.name}.`,
      supportEmail: ctx.supportEmail,
      appName: ctx.appName,
    };
  }
  return {
    wordmark: ctx.appName,
    tagline: h ? `On behalf of ${h.name}` : 'Hotels across Nigeria',
    accent: '#B4452A',
    logoUrl: null,
    footerNote: `${ctx.appName} (${ctx.appDomain}), a Devstrike Digital Limited service.`,
    supportEmail: ctx.supportEmail,
    appName: ctx.appName,
  };
}

function guests(s: StayContext): string {
  const a = `${s.adults} adult${s.adults === 1 ? '' : 's'}`;
  return s.children ? `${a}, ${s.children} child${s.children === 1 ? '' : 'ren'}` : a;
}

function stayRows(s: StayContext): EmailBlock {
  return {
    kind: 'rows',
    title: 'Your stay',
    rows: [
      { label: 'Hotel', value: s.hotel.name },
      { label: 'Check-in', value: s.arrivalHuman },
      { label: 'Check-out', value: s.departureHuman },
      { label: 'Room', value: s.roomTypeName },
      { label: s.stayType === 'NIGHTLY' ? 'Nights' : 'Hours', value: String(s.stayType === 'NIGHTLY' ? s.nights : s.hours), mono: true },
      { label: 'Guests', value: guests(s) },
    ],
  };
}

function moneyRows(s: StayContext, title = 'Price'): EmailBlock {
  const rows: { label: string; value: string; strong?: boolean; muted?: boolean }[] = [
    ...s.lines.map((l) => ({ label: l.label, value: naira(l.amountKobo) })),
    ...s.taxes.map((t) => ({ label: t.label, value: naira(t.amountKobo), muted: true })),
    { label: 'Total', value: naira(s.totalKobo), strong: true },
  ];
  if (s.paidKobo > 0) rows.push({ label: 'Paid online', value: naira(s.paidKobo) });
  rows.push({ label: s.outstandingKobo > 0 ? 'To pay at the hotel' : 'Balance', value: naira(s.outstandingKobo), strong: s.outstandingKobo > 0 });
  return { kind: 'money', title, rows };
}

/** Collapses a long nightly list into a single "n nights x rate" line for the email. */
function compactLines(s: StayContext): StayContext {
  if (s.lines.length <= 3) return s;
  const each = s.lines[0].amountKobo;
  if (s.lines.every((l) => l.amountKobo === each)) {
    return { ...s, lines: [{ label: `${s.roomTypeName}, ${s.lines.length} nights x ${naira(each)}`, amountKobo: each * s.lines.length }] };
  }
  return s;
}

function hotelFooterRows(s: StayContext): EmailBlock {
  return {
    kind: 'rows',
    title: 'Getting there',
    rows: [
      { label: 'Address', value: fullAddress(s.hotel) },
      { label: 'Hotel phone', value: s.hotel.phone || 'See the hotel page', mono: true },
      { label: 'Check-in from', value: s.hotel.checkInTime, mono: true },
      { label: 'Check-out by', value: s.hotel.checkOutTime, mono: true },
    ],
  };
}

function spec(ctx: BrandContext, preheader: string, eyebrow: string, heading: string, blocks: EmailBlock[]): EmailSpec {
  return { brand: brand(ctx), preheader, eyebrow, heading, blocks };
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] || 'there';
}

function build(ctx: BrandContext, d: TemplateData): { subject: string; spec: EmailSpec; sms: string } {
  const app = ctx.appName;
  switch (d.template) {
    case 'OTP':
      return {
        subject: `${d.code} is your ${app} sign-in code`,
        spec: spec(ctx, `Your code expires in ${d.minutes} minutes.`, 'Sign in', 'Your sign-in code', [
          { kind: 'paragraph', text: `Enter this code to sign in to ${app}. It expires in ${d.minutes} minutes.` },
          { kind: 'otp', code: d.code },
          { kind: 'paragraph', text: 'If you did not ask for it, you can ignore this message. Never share this code with anyone, including hotel staff.', muted: true },
        ]),
        sms: `${d.code} is your ${app} sign-in code. It expires in ${d.minutes} minutes. Do not share it with anyone.`,
      };
    case 'MAGIC_LINK':
      return {
        subject: `Sign in to ${app}`,
        spec: spec(ctx, `This link works once and expires in ${d.minutes} minutes.`, 'Sign in', `Welcome back, ${firstName(d.fullName)}`, [
          { kind: 'paragraph', text: `Use the button below to sign in to your ${app} account and see your trips. The link works once and expires in ${d.minutes} minutes.` },
          { kind: 'button', label: 'Sign in', url: d.url },
          { kind: 'paragraph', text: 'If you did not ask for this, ignore this email. Nobody can sign in without the link.', muted: true },
        ]),
        sms: `Sign in to ${app}: ${d.url}`,
      };
    case 'BOOKING_CONFIRMED': {
      const s = compactLines(d.stay);
      return {
        subject: `Booking confirmed: ${s.hotel.name}, ${s.arrivalHuman.split(',')[0]} (${s.code})`,
        spec: spec(ctx, `${s.hotel.name}, ${s.arrivalHuman}. Your room is confirmed and paid.`, 'Booking confirmed', `Your room at ${s.hotel.name} is confirmed`, [
          { kind: 'paragraph', text: `Thank you, ${firstName(s.guestName)}. Your payment went through and the room is yours. Show this code at the front desk.` },
          { kind: 'code', label: 'Booking code', value: s.code },
          stayRows(s),
          moneyRows(s),
          { kind: 'button', label: 'Manage your booking', url: s.manageUrl },
          { kind: 'links', links: [{ label: 'Add to calendar', url: s.calendarUrl }, { label: 'Directions', url: s.hotel.mapUrl }] },
          ...(s.specialRequests ? [{ kind: 'quote' as const, text: `Your note to the hotel: ${s.specialRequests}` }] : []),
          { kind: 'callout', title: 'Cancellation', text: cancellationText(s) },
          hotelFooterRows(s),
        ]),
        sms: `${s.hotel.name}: booking ${s.code} confirmed, ${short(s.arrivalHuman)} to ${short(s.departureHuman)}. Paid ${nairaSms(s.paidKobo)}. Show ${s.code} at check-in.`,
      };
    }
    case 'PAYMENT_RECEIPT': {
      const s = d.stay;
      return {
        subject: `Receipt ${d.receiptNumber}: ${naira(d.amountKobo)} to ${s.hotel.name}`,
        spec: spec(ctx, `We received ${naira(d.amountKobo)} for booking ${s.code}.`, 'Payment receipt', `Payment received: ${naira(d.amountKobo)}`, [
          { kind: 'paragraph', text: `This is your receipt for booking ${s.code} at ${s.hotel.name}. Keep it for your records.` },
          {
            kind: 'rows',
            rows: [
              { label: 'Receipt number', value: d.receiptNumber, mono: true },
              { label: 'Booking code', value: s.code, mono: true },
              { label: 'Paid on', value: d.paidAtHuman },
              { label: 'Method', value: channelLabel(d.channel) },
              { label: 'Payment reference', value: d.reference, mono: true },
            ],
          },
          { kind: 'money', rows: [{ label: 'Amount received', value: naira(d.amountKobo), strong: true }] },
          { kind: 'paragraph', text: d.amountInWords, muted: true },
          { kind: 'links', links: [{ label: 'View booking and download invoice', url: s.manageUrl }] },
        ]),
        sms: `${s.hotel.name}: received ${nairaSms(d.amountKobo)} for booking ${s.code}. Receipt ${d.receiptNumber}.`,
      };
    }
    case 'PAY_AT_HOTEL_CONFIRMED': {
      const s = compactLines(d.stay);
      return {
        subject: `Booking confirmed: ${s.hotel.name} (${s.code}), pay at the hotel`,
        spec: spec(ctx, `${s.hotel.name}, ${s.arrivalHuman}. You pay at the hotel.`, 'Booking confirmed', `See you at ${s.hotel.name}`, [
          { kind: 'paragraph', text: `Thank you, ${firstName(s.guestName)}. Your booking is confirmed. Nothing has been charged: you pay at the hotel when you arrive.` },
          { kind: 'code', label: 'Booking code', value: s.code },
          stayRows(s),
          moneyRows(s, 'To pay at the hotel'),
          { kind: 'button', label: 'Manage your booking', url: s.manageUrl },
          { kind: 'links', links: [{ label: 'Add to calendar', url: s.calendarUrl }, { label: 'Directions', url: s.hotel.mapUrl }] },
          { kind: 'callout', title: 'Change of plans?', text: `Please cancel from your booking page so the room can go to someone else. ${s.policySummary}` },
          hotelFooterRows(s),
        ]),
        sms: `${s.hotel.name}: booking ${s.code} confirmed, ${short(s.arrivalHuman)} to ${short(s.departureHuman)}. Pay ${nairaSms(s.totalKobo)} at the hotel.`,
      };
    }
    case 'HOLD_EXPIRED': {
      const s = d.stay;
      return {
        subject: `Your hold at ${s.hotel.name} has expired`,
        spec: spec(ctx, 'We released the room because payment was not completed in time.', 'Hold expired', 'We released your room', [
          { kind: 'paragraph', text: `We held a ${s.roomTypeName} at ${s.hotel.name} for you for 20 minutes, but the payment was not completed, so the room has gone back on sale. You have not been charged.` },
          stayRows(s),
          { kind: 'button', label: 'Check availability again', url: d.hotelUrl },
          { kind: 'paragraph', text: 'If money left your account, it will be refunded automatically. Reply to this email if you need help.', muted: true },
        ]),
        sms: `${s.hotel.name}: your hold ${s.code} expired and the room was released. You were not charged.`,
      };
    }
    case 'BOOKING_CANCELLED': {
      const s = d.stay;
      const who = d.cancelledBy === 'HOTEL' ? `${s.hotel.name} cancelled your booking` : 'Your booking is cancelled';
      const refundText = d.refundKobo > 0 ? `${naira(d.refundKobo)} is on its way back to your card or account. Banks usually take 3 to 10 working days.` : 'No payment was taken for this booking.';
      return {
        subject: `Cancelled: ${s.hotel.name} (${s.code})`,
        spec: spec(ctx, refundText, 'Booking cancelled', who, [
          { kind: 'paragraph', text: d.cancelledBy === 'HOTEL' ? `We are sorry: ${s.hotel.name} had to cancel booking ${s.code}. You get a full refund.` : `Booking ${s.code} at ${s.hotel.name} has been cancelled as you asked.` },
          stayRows(s),
          {
            kind: 'money',
            title: 'Refund',
            rows: [
              { label: 'Paid', value: naira(s.paidKobo) },
              ...(d.feeKobo > 0 ? [{ label: 'Cancellation fee', value: naira(d.feeKobo), muted: true }] : []),
              { label: 'Refund', value: naira(d.refundKobo), strong: true },
            ],
          },
          { kind: 'callout', title: d.refundKobo > 0 ? 'Refund on its way' : 'Nothing to refund', text: refundText, tone: 'palm' },
        ]),
        sms: d.refundKobo > 0
          ? `${s.hotel.name}: booking ${s.code} cancelled. Refund of ${nairaSms(d.refundKobo)} is on its way (3-10 working days).`
          : `${s.hotel.name}: booking ${s.code} is cancelled. No payment was taken.`,
      };
    }
    case 'PRE_ARRIVAL': {
      const s = d.stay;
      return {
        subject: `Tomorrow at ${s.hotel.name}: check-in from ${s.hotel.checkInTime}`,
        spec: spec(ctx, `Directions, check-in time and the hotel phone number for ${s.code}.`, 'Your stay is tomorrow', `We look forward to welcoming you, ${firstName(s.guestName)}`, [
          { kind: 'paragraph', text: `Your room at ${s.hotel.name} is ready for you from ${s.hotel.checkInTime}. Here is everything you need for arrival.` },
          { kind: 'code', label: 'Booking code', value: s.code },
          hotelFooterRows(s),
          ...(d.message ? [{ kind: 'quote' as const, text: d.message }] : []),
          ...(s.outstandingKobo > 0 ? [{ kind: 'callout' as const, title: 'Payment at the hotel', text: `Please bring ${naira(s.outstandingKobo)} (cash, card or transfer) for your stay.`, tone: 'ochre' as const }] : []),
          { kind: 'button', label: 'Get directions', url: s.hotel.mapUrl },
          { kind: 'links', links: [{ label: 'Manage booking', url: s.manageUrl }, { label: 'Add to calendar', url: s.calendarUrl }] },
        ]),
        sms: `${s.hotel.name}: see you tomorrow! Check-in from ${s.hotel.checkInTime}, code ${s.code}. Hotel phone ${s.hotel.phone || 'on your booking page'}.`,
      };
    }
    case 'REVIEW_REQUEST':
      return {
        subject: `How was ${d.hotelName}?`,
        spec: spec(ctx, 'Two minutes of your time helps other travellers choose well.', 'Your stay', `How was ${d.hotelName}, ${firstName(d.guestName)}?`, [
          { kind: 'paragraph', text: `Thank you for staying at ${d.hotelName} (${d.stayHuman}). Would you rate your stay? Reviews on ${app} come only from guests who really stayed, so yours carries weight.` },
          { kind: 'button', label: 'Rate your stay', url: d.reviewUrl },
          { kind: 'paragraph', text: `The link works until ${d.deadlineHuman}. Only your first name and last initial are shown.`, muted: true },
        ]),
        sms: `How was ${d.hotelName}? Rate your stay in 2 minutes: ${d.reviewUrl}`,
      };
    case 'PAYMENT_ORPHANED_REFUND': {
      const s = d.stay;
      return {
        subject: `Refund on its way: ${naira(d.amountKobo)} (${s.hotel.name})`,
        spec: spec(ctx, 'Your payment arrived after the room was released, so we are refunding it in full.', 'Payment refunded', 'We are refunding your payment', [
          { kind: 'paragraph', text: `Your payment of ${naira(d.amountKobo)} for ${s.hotel.name} reached us after your 20-minute hold had ended, and the room had already gone to another guest. ${d.reason}` },
          { kind: 'callout', title: 'Full refund', text: `${naira(d.amountKobo)} is on its way back to you. Banks usually take 3 to 10 working days.`, tone: 'palm' },
          { kind: 'paragraph', text: 'We are sorry for the trouble. You can check availability again for other rooms or dates.', muted: true },
        ]),
        sms: `${s.hotel.name}: your payment of ${nairaSms(d.amountKobo)} came after the hold ended and the room was taken. Full refund on its way.`,
      };
    }
    case 'HOTEL_NEW_BOOKING': {
      const s = compactLines(d.stay);
      return {
        subject: `New ${d.channelLabel.toLowerCase()} booking ${s.code}: ${s.guestName}, ${short(s.arrivalHuman)}`,
        spec: spec({ ...ctx, hotelBranded: false }, `${s.guestName} booked ${s.roomTypeName} for ${s.arrivalHuman}.`, `New booking, ${d.channelLabel}`, `${s.guestName} booked a ${s.roomTypeName}`, [
          { kind: 'code', label: 'Booking code', value: s.code },
          stayRows(s),
          {
            kind: 'rows',
            title: 'Guest',
            rows: [
              { label: 'Name', value: s.guestName },
              { label: 'Phone', value: d.guestPhone, mono: true },
              { label: 'Email', value: d.guestEmail ?? 'Not given' },
            ],
          },
          moneyRows(s, s.paymentMode === 'ONLINE' ? 'Paid online' : 'Pay at the hotel'),
          ...(d.commissionKobo > 0 ? [{ kind: 'paragraph' as const, text: `Marketplace commission: ${naira(d.commissionKobo)}.`, muted: true }] : []),
          ...(s.specialRequests ? [{ kind: 'quote' as const, text: s.specialRequests }] : []),
          { kind: 'button', label: 'Open the reservation', url: d.adminUrl },
        ]),
        sms: `New booking ${s.code}: ${s.guestName}, ${short(s.arrivalHuman)}, ${s.roomTypeName}. ${s.paymentMode === 'ONLINE' ? 'Paid online' : 'Pay at hotel'}.`,
      };
    }
    case 'HOTEL_BOOKING_CANCELLED': {
      const s = d.stay;
      return {
        subject: `Cancelled by guest: ${s.code} (${s.guestName})`,
        spec: spec({ ...ctx, hotelBranded: false }, `${s.guestName} cancelled ${s.code}; the room is back on sale.`, 'Booking cancelled', `${s.guestName} cancelled ${s.code}`, [
          stayRows(s),
          {
            kind: 'money',
            rows: [
              { label: 'Paid online', value: naira(s.paidKobo) },
              { label: 'Cancellation fee kept', value: naira(d.feeKobo) },
              { label: 'Refunded to guest', value: naira(d.refundKobo), strong: true },
            ],
          },
          ...(d.reason ? [{ kind: 'quote' as const, text: d.reason }] : []),
          { kind: 'button', label: 'Open the reservation', url: d.adminUrl },
        ]),
        sms: `${s.code} cancelled by ${s.guestName}. Room back on sale.`,
      };
    }
    case 'CITY_LEDGER_REMINDER': {
      const overdue = d.daysOverdue > 0;
      return {
        subject: `${overdue ? 'Overdue' : 'Statement'}: ${d.invoiceNumber} from ${d.hotelName} (${naira(d.balanceKobo)} outstanding)`,
        spec: spec(
          { ...ctx, hotelBranded: true },
          `${naira(d.balanceKobo)} is outstanding on ${d.invoiceNumber}${overdue ? `, ${d.daysOverdue} days past due` : ''}.`,
          'City ledger',
          `Statement ${d.invoiceNumber}`,
          [
            { kind: 'paragraph', text: `Dear ${d.contactName || d.accountName}, this is a reminder about the account of ${d.accountName} with ${d.hotelName}.` },
            ...(d.message ? [{ kind: 'quote' as const, text: d.message }] : []),
            {
              kind: 'rows',
              rows: [
                { label: 'Statement', value: d.invoiceNumber, mono: true },
                { label: 'Issued', value: d.issueHuman },
                { label: 'Due', value: d.dueHuman },
                ...(overdue ? [{ label: 'Days overdue', value: String(d.daysOverdue), mono: true }] : []),
              ],
            },
            {
              kind: 'money',
              rows: [
                { label: 'Statement total', value: naira(d.totalKobo) },
                { label: 'Outstanding', value: naira(d.balanceKobo), strong: true },
              ],
            },
            ...(d.statementUrl ? [{ kind: 'button' as const, label: 'View the statement', url: d.statementUrl }] : []),
            { kind: 'paragraph', text: `Please pay by bank transfer quoting ${d.invoiceNumber}. Questions: ${[d.hotelPhone, d.hotelEmail].filter(Boolean).join(' or ')}.`, muted: true },
          ],
        ),
        sms: `${d.hotelName}: ${d.invoiceNumber} has ${nairaSms(d.balanceKobo)} outstanding${overdue ? `, ${d.daysOverdue} days overdue` : ''}. Please pay quoting ${d.invoiceNumber}.`,
      };
    }
    case 'GUARD_ALERT': {
      const top = d.flags[0];
      const more = d.flags.length > 1 ? ` and ${d.flags.length - 1} more` : '';
      return {
        subject: `${d.urgent ? 'Urgent: ' : ''}Revenue Guard alert at ${d.hotelName}`,
        spec: spec({ ...ctx, hotelBranded: false }, `${top?.title ?? 'A high-risk flag'}${more}.`, 'Revenue Guard', `${d.flags.length} high-risk flag${d.flags.length === 1 ? '' : 's'}`, [
          {
            kind: 'rows',
            rows: d.flags.slice(0, 5).map((f) => ({ label: f.title, value: f.amountKobo ? naira(f.amountKobo) : '', mono: true })),
          },
          { kind: 'button', label: 'Open Revenue Guard', url: d.adminUrl },
        ]),
        sms: `${d.hotelName}: ${d.flags.length} high-risk flag${d.flags.length === 1 ? '' : 's'}. ${top?.title ?? ''}${more}. Reply 1 to acknowledge.`,
      };
    }
    case 'WHATSAPP_REPLY':
      return { subject: 'WhatsApp reply', spec: spec(ctx, d.text, 'Reply', 'Reply', [{ kind: 'paragraph', text: d.text }]), sms: d.text };
    case 'ORPHANED_PAYMENT_ALERT':
      return {
        subject: `Orphaned payment ${d.reference} (${d.hotelName}): refund ${d.refundStatus.toLowerCase()}`,
        spec: spec({ ...ctx, hotelBranded: false }, `${naira(d.amountKobo)} could not be applied to ${d.code}.`, 'Payment alert', 'A payment could not be applied', [
          { kind: 'paragraph', text: `A guest payment arrived that could not be applied to a booking, so it is being refunded in full. ${d.reason}` },
          {
            kind: 'rows',
            rows: [
              { label: 'Hotel', value: d.hotelName },
              { label: 'Booking', value: d.code, mono: true },
              { label: 'Reference', value: d.reference, mono: true },
              { label: 'Amount', value: naira(d.amountKobo), mono: true },
              { label: 'Guest', value: `${d.guestName} (${d.guestPhone})` },
              { label: 'Refund status', value: d.refundStatus },
            ],
          },
        ]),
        sms: `Orphaned payment ${d.reference} at ${d.hotelName}: ${nairaSms(d.amountKobo)}, refund ${d.refundStatus.toLowerCase()}.`,
      };
    // -------------------------------------------------------------------- M6
    case 'SUPPORT_NEW':
      return {
        subject: `[${d.number}] ${d.subject} (${d.hotelName})`,
        spec: spec({ ...ctx, hotelBranded: false }, `${d.hotelName} needs help: ${d.subject}`, 'Support request', d.subject, [
          { kind: 'rows', rows: [
            { label: 'Request', value: d.number, mono: true },
            { label: 'Hotel', value: d.hotelName },
            { label: 'Opened by', value: d.openedBy },
            { label: 'Category', value: d.category },
            { label: 'Priority', value: d.priority },
            { label: 'First response due in', value: `${d.slaHours} hours` },
          ] },
          { kind: 'quote', text: d.excerpt },
          { kind: 'button', label: 'Open in the console', url: d.consoleUrl },
        ]),
        sms: `${app} support ${d.number} from ${d.hotelName}: ${d.subject}`,
      };
    case 'SUPPORT_REPLY':
      return {
        subject: `Re: [${d.number}] ${d.subject}`,
        spec: spec({ ...ctx, hotelBranded: false }, `${d.fromName} replied to your support request.`, 'Support', `${app} support replied`, [
          { kind: 'paragraph', text: `${d.fromName} replied to your request ${d.number} (${d.subject}).` },
          { kind: 'quote', text: d.excerpt },
          { kind: 'button', label: 'Read and reply', url: d.adminUrl },
        ]),
        sms: `${app} support replied to ${d.number}. Open your admin to read it.`,
      };
    case 'ANNOUNCEMENT':
      return {
        subject: `${d.severity === 'CRITICAL' ? 'Important: ' : d.severity === 'MAINTENANCE' ? 'Planned maintenance: ' : ''}${d.title}`,
        spec: spec({ ...ctx, hotelBranded: false }, d.body.slice(0, 120), d.severity === 'MAINTENANCE' ? 'Planned maintenance' : 'Announcement', d.title, [
          ...d.body.split(/\n{2,}/).map((t) => ({ kind: 'paragraph' as const, text: t.trim() })),
          ...(d.whenHuman ? [{ kind: 'callout' as const, title: 'When', text: d.whenHuman, tone: 'ochre' as const }] : []),
          ...(d.link ? [{ kind: 'button' as const, label: d.link.label, url: d.link.url }] : []),
        ]),
        sms: `${app}: ${d.title}`,
      };
    case 'WEBHOOK_DISABLED':
      return {
        subject: `Webhook endpoint disabled at ${d.hotelName}`,
        spec: spec({ ...ctx, hotelBranded: false }, `Deliveries to ${d.url} kept failing, so we paused it.`, 'Integrations', 'A webhook endpoint was disabled', [
          { kind: 'paragraph', text: `Every delivery to this endpoint has failed since ${d.failingSinceHuman} (${d.attempts} attempts), so we stopped sending to it. Events are kept: fix the endpoint and switch it back on to resume.` },
          { kind: 'rows', rows: [{ label: 'Endpoint', value: d.url, mono: true }, { label: 'Last error', value: d.lastError ?? 'No response' }] },
          { kind: 'button', label: 'Open webhooks', url: d.adminUrl },
        ]),
        sms: `${d.hotelName}: webhook ${d.url} was disabled after 24 hours of failures.`,
      };
    case 'OWNER_SETUP':
      return {
        subject: `Your ${app} account for ${d.hotelName} is ready`,
        spec: spec({ ...ctx, hotelBranded: false }, `Set your password to start using ${app}.`, 'Welcome', `Welcome, ${firstName(d.fullName)}`, [
          { kind: 'paragraph', text: `${d.hotelName} is set up on ${app}. Choose your password to sign in as the owner.` },
          { kind: 'button', label: 'Set your password', url: d.url },
          { kind: 'paragraph', text: `This link works until ${d.expiresHuman}.`, muted: true },
        ]),
        sms: `${app}: ${d.hotelName} is ready. Check your email to set your password.`,
      };
    case 'PLATFORM_INVITE':
      return {
        subject: `You have been invited to the ${app} console`,
        spec: spec({ ...ctx, hotelBranded: false }, `${d.invitedBy} invited you as ${d.role}.`, 'Console invitation', `Hello ${firstName(d.fullName)}`, [
          { kind: 'paragraph', text: `${d.invitedBy} invited you to the ${app} platform console as ${d.role}. Choose a password, then set up two-factor sign-in with an authenticator app.` },
          { kind: 'button', label: 'Accept the invitation', url: d.url },
          { kind: 'paragraph', text: `This invitation expires on ${d.expiresHuman}.`, muted: true },
        ]),
        sms: `${app}: you have been invited to the console. Check your email.`,
      };
    case 'OFFBOARDING_NOTICE':
      return {
        subject: `${d.hotelName}: your account is closing`,
        spec: spec({ ...ctx, hotelBranded: false }, `Your data will be deleted on ${d.deleteAfterHuman}.`, 'Account closure', 'Your account is closing', [
          { kind: 'paragraph', text: `As agreed, ${app} is closing the account of ${d.hotelName}. ${d.exportReady ? 'A full export of your data is ready for you.' : 'A full export of your data is being prepared.'}` },
          { kind: 'callout', title: 'Deletion date', text: `Every record will be deleted permanently on ${d.deleteAfterHuman}, as the Nigeria Data Protection Act requires. Contact us before then if this is a mistake.`, tone: 'ochre' },
        ]),
        sms: `${app}: ${d.hotelName} account closes; data deleted on ${d.deleteAfterHuman}.`,
      };
  }
}

/** Address plus area and city, without repeating parts the address already has. */
export function fullAddress(h: { address: string; area: string; city: string }): string {
  const parts = [h.address.trim()];
  for (const extra of [h.area, h.city]) {
    if (extra && !parts.join(', ').toLowerCase().includes(extra.toLowerCase())) parts.push(extra);
  }
  return parts.filter(Boolean).join(', ');
}

function cancellationText(s: StayContext): string {
  if (!s.freeCancellationUntilHuman) return s.policySummary.replace(/^Free cancellation until [^.]*\.\s*/, 'The free cancellation period has passed. ');
  const after = s.policySummary.replace(/^Free cancellation until [^.]*\.\s*/, '');
  return `Free cancellation until ${s.freeCancellationUntilHuman}.${after ? ` ${after}` : ''}`;
}

function short(human: string): string {
  // "Tue 22 Sep 2026, 14:00" -> "Tue 22 Sep"
  return human.split(',')[0].split(' ').slice(0, 3).join(' ');
}

function channelLabel(channel: string | null): string {
  switch (channel) {
    case 'card':
      return 'Card';
    case 'bank_transfer':
      return 'Bank transfer';
    case 'ussd':
      return 'USSD';
    case 'bank':
      return 'Bank account';
    default:
      return 'Online payment';
  }
}

export function renderTemplate(ctx: BrandContext, data: TemplateData): Rendered {
  const { subject, spec: s, sms } = build(ctx, data);
  return { subject, html: renderEmail(s), text: renderEmailText(s), sms };
}
