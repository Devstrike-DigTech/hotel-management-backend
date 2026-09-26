import { HttpStatus, Injectable } from '@nestjs/common';
import type { ConciergeRequest, NotificationChannel, Property } from '../../generated/prisma/client.js';
import { signToken, verifyToken } from '../../common/crypto/signed-token.js';
import { humanDateTime } from '../../common/time/lagos.js';
import { AppConfigService } from '../../config/app-config.service.js';
import type { Tx } from '../../prisma/db.service.js';
import { BookingNotifier } from '../booking/booking-notifier.service.js';
import { BookingTokens } from '../booking/booking-tokens.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import type { OutgoingMessage } from '../notifications/notification.service.js';
import { renderTemplate, type ConciergeContext, type TemplateData, type VendorJobContext } from '../notifications/templates/templates.js';
import { appError } from '../ops/ops.helpers.js';
import { waTemplateFor } from '../whatsapp/templates.registry.js';
import { chargeOf } from './concierge.service.js';
import { FREE_FORM_TITLE } from './concierge.logic.js';

interface QuotePayload {
  tid: string;
  rid: string;
  v: number;
  exp: number;
}

/** Days a quote link stays readable after the quote expires (to say so). */
const QUOTE_LINK_GRACE_DAYS = 7;

type GuestTemplate = 'CONCIERGE_RECEIVED' | 'CONCIERGE_QUOTE' | 'CONCIERGE_CONFIRMED' | 'CONCIERGE_UPDATE' | 'CONCIERGE_COMPLETED';

export interface StayLink {
  tenantId: string;
  id: string;
  code: string;
  departureAt: Date;
}

/**
 * Concierge messages (M8): signed quote links, the guest's messages on the
 * channel they chose (WhatsApp for hotels with `whatsapp_messaging`, else
 * SMS; email; in-app sends nothing), vendor jobs and escalation emails.
 * Private requests never name the service in a message.
 */
@Injectable()
export class ConciergeNotifier {
  constructor(
    private readonly config: AppConfigService,
    private readonly bookingNotifier: BookingNotifier,
    private readonly tokens: BookingTokens,
    private readonly entitlements: EntitlementsService,
  ) {}

  private get secret() {
    return this.config.get('GUEST_TOKEN_SECRET');
  }

  // ---------------------------------------------------------------------------
  // Links
  // ---------------------------------------------------------------------------

  signQuote(tenantId: string, requestId: string, version: number, validUntil: Date): string {
    const exp = Math.floor(validUntil.getTime() / 1000) + QUOTE_LINK_GRACE_DAYS * 86_400;
    return signToken<QuotePayload>(this.secret, 'concierge-quote', { tid: tenantId, rid: requestId, v: version, exp });
  }

  /** 404 for a bad token, 410 LINK_EXPIRED past the grace period. */
  verifyQuote(token: string): { tenantId: string; requestId: string; version: number } {
    const res = verifyToken<QuotePayload>(this.secret, 'concierge-quote', token);
    if (!res.ok) {
      if (res.reason === 'expired') throw appError(HttpStatus.GONE, 'LINK_EXPIRED', 'This link has expired. Ask the hotel for a new price.');
      throw appError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Quote not found');
    }
    return { tenantId: res.payload.tid, requestId: res.payload.rid, version: res.payload.v };
  }

  quoteUrl(token: string): string {
    return `${this.config.get('WEB_URL')}/concierge/q/${encodeURIComponent(token)}`;
  }

  quoteLink(r: Pick<ConciergeRequest, 'tenantId' | 'id' | 'quoteVersion' | 'quoteValidUntil'>): { token: string; url: string } | null {
    if (!r.quoteVersion || !r.quoteValidUntil) return null;
    const token = this.signQuote(r.tenantId, r.id, r.quoteVersion, r.quoteValidUntil);
    return { token, url: this.quoteUrl(token) };
  }

  tripUrl(stay: StayLink | null): string {
    if (!stay) return this.config.get('WEB_URL');
    return `${this.tokens.manageUrl(stay.code, this.tokens.signTrip(stay.tenantId, stay.id, stay.code, stay.departureAt))}#concierge`;
  }

  adminUrl(requestId: string): string {
    return `${this.config.get('ADMIN_URL')}/concierge/requests/${requestId}`;
  }

  mockCheckoutUrl(reference: string): string {
    return `${this.config.get('WEB_URL')}/pay/mock?reference=${encodeURIComponent(reference)}&kind=concierge`;
  }

  // ---------------------------------------------------------------------------
  // Guest messages
  // ---------------------------------------------------------------------------

  async channelFor(tx: Tx, tenantId: string, pref: string): Promise<NotificationChannel | null> {
    if (pref === 'IN_APP') return null;
    if (pref === 'EMAIL') return 'EMAIL';
    if (pref === 'WHATSAPP') {
      const ent = await this.entitlements.getEntitlements(tenantId, tx);
      return ent.features.includes('whatsapp_messaging') ? 'WHATSAPP' : 'SMS';
    }
    return 'SMS';
  }

  context(r: ConciergeRequest & { guest: { fullName: string } }, property: Pick<Property, 'name' | 'phone'>, url: string, extra: { note?: string | null; paymentText?: string | null } = {}): ConciergeContext {
    const charge = chargeOf(r);
    const title = r.serviceId ? (r.variantName ? `${r.serviceName}, ${r.variantName}` : r.serviceName) : FREE_FORM_TITLE.toLowerCase();
    const when = r.scheduledAt ?? r.preferredStart;
    return {
      guestName: r.guest.fullName,
      number: r.number,
      title: r.discreet ? 'your private request' : title,
      discreet: r.discreet,
      hotel: { name: property.name, phone: property.phone ?? '' },
      url,
      whenHuman: when ? humanDateTime(when) : null,
      totalKobo: r.flagged && r.flagStatus === 'PENDING' ? null : (charge?.totalKobo ?? null),
      paymentText: extra.paymentText ?? paymentText(r),
      note: extra.note ?? null,
    };
  }

  /** Renders a guest template and addresses it to the request's contact channel ([] for IN_APP). */
  async guest(
    tx: Tx,
    r: ConciergeRequest & { guest: { fullName: string } },
    property: Property,
    data: { template: GuestTemplate; url: string; note?: string | null; replyWithin?: string; validUntilHuman?: string; whatsappReply?: boolean; update?: string; paymentText?: string | null },
  ): Promise<OutgoingMessage[]> {
    const channel = await this.channelFor(tx, r.tenantId, r.contactPreference);
    if (!channel) return [];
    const to = channel === 'EMAIL' ? r.contactEmail : r.contactPhone;
    if (!to) return [];
    const c = this.context(r, property, data.url, { note: data.note, paymentText: data.paymentText });
    let td: TemplateData;
    switch (data.template) {
      case 'CONCIERGE_RECEIVED':
        td = { template: 'CONCIERGE_RECEIVED', c, replyWithin: data.replyWithin ?? '2 hours' };
        break;
      case 'CONCIERGE_QUOTE':
        td = { template: 'CONCIERGE_QUOTE', c, validUntilHuman: data.validUntilHuman ?? '', whatsappReply: channel === 'WHATSAPP' };
        break;
      case 'CONCIERGE_CONFIRMED':
        td = { template: 'CONCIERGE_CONFIRMED', c };
        break;
      case 'CONCIERGE_UPDATE':
        td = { template: 'CONCIERGE_UPDATE', c, update: data.update ?? '' };
        break;
      default:
        td = { template: 'CONCIERGE_COMPLETED', c };
    }
    const brand = this.bookingNotifier.brand({ property, source: 'BOOKING_SITE' });
    const rendered = renderTemplate(brand, td);
    const base = {
      tenantId: r.tenantId,
      reservationId: r.reservationId,
      template: data.template,
      audience: 'GUEST' as const,
      fromName: property.name,
      meta: { conciergeRequestId: r.id, requestNumber: r.number, hotelName: property.name },
    };
    if (channel === 'EMAIL') return [{ ...base, channel, to, subject: rendered.subject, text: rendered.text, html: rendered.html }];
    const wa = channel === 'WHATSAPP' ? waTemplateFor(td) : null;
    return [{ ...base, channel, to, subject: null, text: rendered.sms, html: null, waTemplate: wa, meta: { ...base.meta, ...(wa && { waTemplate: wa.name, waParams: wa.params }) } }];
  }

  // ---------------------------------------------------------------------------
  // Vendor and hotel messages
  // ---------------------------------------------------------------------------

  vendorJob(tenantId: string, property: Property, job: VendorJobContext, to: string, channel: 'WHATSAPP' | 'SMS', requestId: string): OutgoingMessage {
    const td: TemplateData = { template: 'CONCIERGE_VENDOR_JOB', job };
    const rendered = renderTemplate(this.bookingNotifier.brand({ property, source: 'MARKETPLACE' }), td);
    const wa = channel === 'WHATSAPP' ? waTemplateFor(td) : null;
    return {
      tenantId,
      template: 'CONCIERGE_VENDOR_JOB',
      channel,
      audience: 'HOTEL',
      to,
      subject: null,
      text: rendered.sms,
      html: null,
      waTemplate: wa,
      meta: { conciergeRequestId: requestId, requestNumber: job.number, ...(wa && { waTemplate: wa.name, waParams: wa.params }) },
    };
  }

  hotelEmail(tenantId: string, property: Property, td: Extract<TemplateData, { template: 'CONCIERGE_ESCALATION' | 'CONCIERGE_SUSPENDED' }>, to: string, meta: Record<string, unknown> = {}): OutgoingMessage {
    const rendered = renderTemplate(this.bookingNotifier.brand({ property, source: 'MARKETPLACE' }), td);
    return { tenantId, template: td.template, channel: 'EMAIL', audience: 'HOTEL', to, subject: rendered.subject, text: rendered.text, html: rendered.html, meta };
  }
}

export function paymentText(r: Pick<ConciergeRequest, 'paymentMethod' | 'paymentStatus'>): string | null {
  switch (r.paymentMethod) {
    case 'FOLIO':
      return 'added to your bill';
    case 'ONLINE':
      return r.paymentStatus === 'PAID' ? 'paid online' : 'pay online to confirm';
    case 'NONE':
      return 'nothing to pay';
    default:
      return null;
  }
}
