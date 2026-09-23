import { Injectable } from '@nestjs/common';
import type { NotificationChannel } from '../../generated/prisma/enums.js';
import { humanDate, humanDateTime, lagosDate } from '../../common/time/lagos.js';
import { AppConfigService } from '../../config/app-config.service.js';
import type { Tx } from '../../prisma/db.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import type { OutgoingMessage } from '../notifications/notification.service.js';
import { renderTemplate, type BrandContext, type StayContext, type TemplateData, type TemplateName } from '../notifications/templates/templates.js';
import { BookingViewService, type StayRow } from './booking-view.service.js';

type GuestTemplate = Extract<TemplateData, { stay: StayContext }>['template'];
type Extra<T extends GuestTemplate> = Omit<Extract<TemplateData, { template: T }>, 'template' | 'stay'>;

/** Guest templates that go by email only (no SMS twin). */
const EMAIL_ONLY: TemplateName[] = ['PAYMENT_RECEIPT', 'HOTEL_NEW_BOOKING', 'HOTEL_BOOKING_CANCELLED', 'ORPHANED_PAYMENT_ALERT', 'MAGIC_LINK'];

/**
 * Builds the messages for a stay: renders each template once and fans it out
 * to the guest's email and phone (SMS, or WhatsApp for hotels with
 * `whatsapp_messaging`), or to the hotel's inbox. Booking-site stays use the
 * hotel's branding.
 */
@Injectable()
export class BookingNotifier {
  constructor(
    private readonly config: AppConfigService,
    private readonly views: BookingViewService,
    private readonly entitlements: EntitlementsService,
  ) {}

  brand(r: Pick<StayRow, 'property' | 'source'>): BrandContext {
    return {
      appName: this.config.get('APP_NAME'),
      appDomain: this.config.get('APP_DOMAIN'),
      supportEmail: this.config.get('SUPPORT_EMAIL'),
      hotel: { name: r.property.name, accentColor: r.property.accentColor, logoUrl: r.property.logoUrl, area: r.property.area, city: r.property.city },
      hotelBranded: r.source === 'BOOKING_SITE',
    };
  }

  async stayContext(tx: Tx, r: StayRow): Promise<StayContext> {
    const v = await this.views.view(tx, r);
    const until = v.freeCancellationUntil ? humanDateTime(new Date(v.freeCancellationUntil)) : null;
    return {
      guestName: v.guest.fullName,
      code: v.code,
      hotel: {
        name: v.hotel.name,
        address: v.hotel.address,
        area: v.hotel.area,
        city: v.hotel.city,
        phone: v.hotel.phone,
        email: v.hotel.email,
        checkInTime: v.hotel.checkInTime,
        checkOutTime: v.hotel.checkOutTime,
        mapUrl: v.hotel.mapUrl,
      },
      roomTypeName: v.roomType.name,
      stayType: v.stayType,
      arrivalHuman: humanDateTime(r.arrivalAt),
      departureHuman: humanDateTime(r.departureAt),
      nights: v.nights,
      hours: v.hours,
      adults: v.adults,
      children: v.children,
      lines: v.breakdown.lines.map((l) => ({ label: l.description, amountKobo: l.amountKobo })),
      taxes: v.breakdown.taxes.map((t) => ({ label: `${t.label} ${(t.rateBps / 100).toString()}%${t.inclusive ? ' (included)' : ''}`, amountKobo: t.amountKobo })),
      totalKobo: v.totalKobo,
      paidKobo: v.paidKobo,
      outstandingKobo: v.outstandingKobo,
      paymentMode: v.paymentMode,
      policySummary: v.cancellationPolicy.summary,
      freeCancellationUntilHuman: until,
      manageUrl: this.views.tokens.manageUrl(v.code, this.views.manageToken(r)),
      calendarUrl: v.calendarUrl,
      specialRequests: v.specialRequests,
    };
  }

  private async phoneChannel(tx: Tx, tenantId: string): Promise<NotificationChannel> {
    const ent = await this.entitlements.getEntitlements(tenantId, tx);
    return ent.features.includes('whatsapp_messaging') ? 'WHATSAPP' : 'SMS';
  }

  /** Messages to the guest of `r` for a stay template. */
  async guest<T extends GuestTemplate>(tx: Tx, r: StayRow, template: T, extra: Extra<T>, opts: { dedupe?: boolean; stay?: StayContext } = {}): Promise<OutgoingMessage[]> {
    const stay = opts.stay ?? (await this.stayContext(tx, r));
    const rendered = renderTemplate(this.brand(r), { template, stay, ...extra } as TemplateData);
    const email = r.contactEmail ?? r.guest.email;
    const phone = r.contactPhone ?? r.guest.phone;
    const base = { tenantId: r.tenantId, reservationId: r.id, guestAccountId: r.guestAccountId, template, audience: 'GUEST' as const, fromName: r.source === 'BOOKING_SITE' ? r.property.name : null, meta: { reservationCode: r.code, hotelName: r.property.name } };
    const out: OutgoingMessage[] = [];
    if (email) {
      out.push({ ...base, channel: 'EMAIL', to: email, subject: rendered.subject, text: rendered.text, html: rendered.html, ...(opts.dedupe && { dedupeKey: `${template}:${r.id}:EMAIL` }) });
    }
    if (phone && !EMAIL_ONLY.includes(template)) {
      const channel = await this.phoneChannel(tx, r.tenantId);
      out.push({ ...base, channel, to: phone, subject: null, text: rendered.sms, html: null, ...(opts.dedupe && { dedupeKey: `${template}:${r.id}:PHONE` }) });
    }
    return out;
  }

  /** Review request: email when we have one, otherwise a text message. */
  async reviewRequest(tx: Tx, r: StayRow, reviewUrl: string, deadline: Date): Promise<OutgoingMessage[]> {
    const rendered = renderTemplate(this.brand(r), {
      template: 'REVIEW_REQUEST',
      guestName: r.guest.fullName,
      hotelName: r.property.name,
      stayHuman: `${humanDate(lagosDate(r.arrivalAt))} to ${humanDate(lagosDate(r.departureAt))}`,
      reviewUrl,
      deadlineHuman: humanDate(lagosDate(deadline)),
    });
    const email = r.contactEmail ?? r.guest.email;
    const phone = r.contactPhone ?? r.guest.phone;
    const base = { tenantId: r.tenantId, reservationId: r.id, guestAccountId: r.guestAccountId, template: 'REVIEW_REQUEST' as const, audience: 'GUEST' as const, fromName: r.source === 'BOOKING_SITE' ? r.property.name : null, meta: { reservationCode: r.code, hotelName: r.property.name } };
    if (email) return [{ ...base, channel: 'EMAIL', to: email, subject: rendered.subject, text: rendered.text, html: rendered.html, dedupeKey: `REVIEW_REQUEST:${r.id}` }];
    if (phone) return [{ ...base, channel: await this.phoneChannel(tx, r.tenantId), to: phone, subject: null, text: rendered.sms, html: null, dedupeKey: `REVIEW_REQUEST:${r.id}` }];
    return [];
  }

  /** Hotel inbox: the property email plus active owners. */
  async hotelRecipients(tx: Tx, r: Pick<StayRow, 'tenantId' | 'property'>): Promise<string[]> {
    const owners = await tx.user.findMany({ where: { tenantId: r.tenantId, role: 'OWNER', isActive: true }, select: { email: true } });
    const all = [r.property.email, ...owners.map((o) => o.email)].filter((e): e is string => !!e && e.includes('@'));
    return [...new Set(all.map((e) => e.toLowerCase()))];
  }

  async hotel(tx: Tx, r: StayRow, data: Extract<TemplateData, { template: 'HOTEL_NEW_BOOKING' | 'HOTEL_BOOKING_CANCELLED' }>): Promise<OutgoingMessage[]> {
    const rendered = renderTemplate(this.brand(r), data);
    return (await this.hotelRecipients(tx, r)).map((to) => ({
      tenantId: r.tenantId,
      reservationId: r.id,
      template: data.template,
      channel: 'EMAIL' as const,
      audience: 'HOTEL' as const,
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      meta: { reservationCode: r.code, hotelName: r.property.name },
    }));
  }

  adminUrl(reservationId: string): string {
    return `${this.config.get('ADMIN_URL')}/reservations/${reservationId}`;
  }

  hotelUrl(slug: string): string {
    return `${this.config.get('WEB_URL')}/hotels/${slug}`;
  }
}
