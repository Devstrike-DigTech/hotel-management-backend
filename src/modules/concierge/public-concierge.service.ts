import { HttpStatus, Injectable } from '@nestjs/common';
import type { ConciergeService as ServiceRow, Prisma } from '../../generated/prisma/client.js';
import { AppException } from '../../common/errors/app-exception.js';
import { lagosDate } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { BookingTokens } from '../booking/booking-tokens.service.js';
import type { FormField } from '../booking-form/form.catalogue.js';
import { componentsFrom } from '../folios/tax.logic.js';
import { TaxSettingsService } from '../folios/tax-settings.service.js';
import { appError } from '../ops/ops.helpers.js';
import { ThemeService } from '../site/theme.service.js';
import { ConciergeNotifier } from './concierge-notifier.service.js';
import { ConciergePaymentsService, type ConciergePaymentInit } from './concierge-payments.service.js';
import { ConciergeService, questionsOf, requestInclude, serviceLike, variantsOf, type RequestRow } from './concierge.service.js';
import { CatalogueService } from './catalogue.service.js';
import { CATEGORIES, categoryLabel, priceLabel, priceService, PRIVACY_NOTE } from './concierge.logic.js';
import { RequestsService } from './requests.service.js';
import { issuesError } from '../booking-form/form.errors.js';
import { NotificationService } from '../notifications/notification.service.js';

export interface GuestCreateDto {
  serviceId?: string;
  variantId?: string;
  requestText?: string;
  answers?: Record<string, unknown>;
  preferredStart?: string;
  preferredEnd?: string;
  hours?: number;
  partySize?: number;
  notes?: string;
  discreet?: boolean;
  contactPreference: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'IN_APP';
  contactPhone?: string;
  contactEmail?: string;
  paymentMethod?: 'ONLINE' | 'FOLIO';
  source?: 'BOOKING_FLOW' | 'TRIP_PAGE';
}

type Channel = 'BOOKING_FLOW' | 'TRIP_PAGE';

/** M7 PublicField: no hotel-only notes or locks. */
function publicField(f: FormField) {
  const { locked: _l, purpose: _p, idLike: _i, mapsTo: _m, boundTo: _b, ...rest } = f;
  void _l;
  void _p;
  void _i;
  void _m;
  void _b;
  return { ...rest, conditionText: null };
}

/**
 * Guest-facing concierge (M8): the public catalogue on hotel pages, the
 * trip page (manage-booking token), signed quote links and payments.
 */
@Injectable()
export class PublicConciergeService {
  constructor(
    private readonly db: DbService,
    private readonly core: ConciergeService,
    private readonly catalogue: CatalogueService,
    private readonly requests: RequestsService,
    private readonly notifier: ConciergeNotifier,
    private readonly payments: ConciergePaymentsService,
    private readonly themes: ThemeService,
    private readonly tokens: BookingTokens,
    private readonly taxes: TaxSettingsService,
    private readonly notifications: NotificationService,
  ) {}

  categories() {
    return CATEGORIES.map((c) => ({ ...c }));
  }

  publicService(s: ServiceRow) {
    const like = serviceLike(s);
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      categoryLabel: categoryLabel(s.category),
      imageUrl: s.imageUrl,
      pricing: s.pricing,
      priceKobo: s.priceKobo,
      variants: variantsOf(s.variants),
      durationMinutes: s.durationMinutes,
      leadTimeHours: s.leadTimeHours,
      availability: like.availability,
      requiresSlot: s.requiresSlot,
      location: s.location,
      discreetEligible: s.discreetEligible,
      taxable: s.taxable,
      priceLabel: priceLabel(like),
      questions: questionsOf(s.questions).filter((f) => f.required !== 'HIDDEN').map((f) => publicField(f)),
      preArrival: s.channels.includes('BOOKING_FLOW'),
      duringStay: s.channels.includes('TRIP_PAGE'),
      instantConfirm: s.pricing !== 'FROM',
    };
  }

  private async catalogueTx(tx: Tx, tenantId: string, propertyId: string, channels: Channel[], category?: string) {
    const property = await tx.property.findFirstOrThrow({ where: { id: propertyId, tenantId } });
    const on = await this.catalogue.visibilityTx(tx, tenantId, propertyId);
    const settings = await this.core.settingsTx(tx, tenantId, propertyId);
    const rows = on
      ? await tx.conciergeService.findMany({
          where: { tenantId, propertyId, active: true, reviewStatus: 'LIVE', channels: { hasSome: channels }, ...(category && { category: category as ServiceRow['category'] }) },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        })
      : [];
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
    return {
      enabled: on,
      hotel: { slug: property.slug, name: property.name },
      intro: on ? settings.intro : null,
      privacyNote: PRIVACY_NOTE,
      freeFormEnabled: on && settings.freeFormEnabled,
      categories: CATEGORIES.filter((c) => counts.has(c.code)).map((c) => ({ code: c.code, label: c.label, count: counts.get(c.code)! })),
      services: rows.map((s) => this.publicService(s)),
      payments: { online: on && (await this.payments.availableTx(tx, tenantId, propertyId)), folio: on && settings.payFolio },
    };
  }

  async hotelCatalogue(slug: string, q: { channel?: Channel; category?: string }) {
    const ref = await this.themes.hotelRef(slug);
    return this.db.tenant(ref.tenantId, (tx) => this.catalogueTx(tx, ref.tenantId, ref.id, q.channel ? [q.channel] : ['BOOKING_FLOW', 'TRIP_PAGE'], q.category));
  }

  private async visibleService(tx: Tx, tenantId: string, propertyId: string, id: string): Promise<ServiceRow> {
    const on = await this.catalogue.visibilityTx(tx, tenantId, propertyId);
    const s = on ? await tx.conciergeService.findFirst({ where: { id, tenantId, propertyId, active: true, reviewStatus: 'LIVE' } }) : null;
    if (!s) throw AppException.notFound('Service');
    return s;
  }

  async hotelService(slug: string, id: string) {
    const ref = await this.themes.hotelRef(slug);
    return this.db.tenant(ref.tenantId, async (tx) => this.publicService(await this.visibleService(tx, ref.tenantId, ref.id, id)));
  }

  async slots(slug: string, id: string, date: string | undefined, variantId?: string) {
    const ref = await this.themes.hotelRef(slug);
    return this.db.tenant(ref.tenantId, async (tx) => this.catalogue.slotsTx(tx, await this.visibleService(tx, ref.tenantId, ref.id, id), date || lagosDate(), variantId));
  }

  async price(slug: string, dto: { serviceId: string; variantId?: string; partySize?: number; hours?: number }) {
    const ref = await this.themes.hotelRef(slug);
    return this.db.tenant(ref.tenantId, async (tx) => {
      const s = await this.visibleService(tx, ref.tenantId, ref.id, dto.serviceId);
      const comps = componentsFrom(await this.taxes.forProperty(tx, ref.tenantId, ref.id));
      const r = priceService(serviceLike(s), dto, comps);
      if (r.issues.length) throw issuesError(r.issues);
      return { price: r.price, requiresQuote: r.requiresQuote };
    });
  }

  // ---------------------------------------------------------------------------
  // Trip page
  // ---------------------------------------------------------------------------

  private guestView(r: RequestRow, authorizationUrl: string | null = null) {
    const q = this.notifier.quoteLink(r);
    return this.core.guestView(r, { quoteToken: q?.token ?? null, quoteUrl: q?.url ?? null, authorizationUrl });
  }

  private async pendingUrls(tx: Tx, rows: RequestRow[]): Promise<Map<string, string>> {
    const refs = rows.filter((r) => r.paymentStatus === 'PENDING' && r.paymentReference).map((r) => r.paymentReference!);
    if (!refs.length) return new Map();
    const pays = await tx.conciergePayment.findMany({ where: { reference: { in: refs } }, select: { requestId: true, authorizationUrl: true } });
    return new Map(pays.filter((p) => p.authorizationUrl).map((p) => [p.requestId, p.authorizationUrl!]));
  }

  private async stay(tx: Tx, tenantId: string, reservationId: string) {
    const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId }, include: { room: { select: { number: true } }, folio: { select: { id: true, status: true } }, guest: true } });
    if (!r) throw AppException.notFound('Booking');
    return r;
  }

  async trip(code: string, t: string | undefined) {
    const { tenantId, reservationId } = this.tokens.verifyTrip(t, code);
    return this.db.tenant(tenantId, async (tx) => {
      const r = await this.stay(tx, tenantId, reservationId);
      const beforeArrival = ['PENDING', 'CONFIRMED'].includes(r.status);
      const channels: Channel[] = beforeArrival ? ['TRIP_PAGE', 'BOOKING_FLOW'] : ['TRIP_PAGE'];
      const catalogue = await this.catalogueTx(tx, tenantId, r.propertyId, channels);
      const rows = await tx.conciergeRequest.findMany({ where: { tenantId, reservationId }, include: requestInclude, orderBy: { createdAt: 'desc' } });
      const urls = await this.pendingUrls(tx, rows);
      const ent = await this.core.entitlements.getEntitlements(tenantId, tx);
      return {
        catalogue,
        requests: rows.map((x) => this.guestView(x, urls.get(x.id) ?? null)),
        stay: { status: r.status, arrivalAt: r.arrivalAt.toISOString(), departureAt: r.departureAt.toISOString(), roomNumber: r.room?.number ?? null, folioOpen: r.folio?.status === 'OPEN' },
        contactDefaults: { phone: r.contactPhone ?? r.guest.phone, email: r.contactEmail ?? r.guest.email, whatsapp: ent.features.includes('whatsapp_messaging') },
      };
    });
  }

  async create(code: string, t: string | undefined, dto: GuestCreateDto): Promise<{ request: ReturnType<ConciergeService['guestView']>; payment: ConciergePaymentInit | null }> {
    const { tenantId, reservationId } = this.tokens.verifyTrip(t, code);
    const res = await this.db.tenant(tenantId, async (tx) => {
      const r = await this.stay(tx, tenantId, reservationId);
      const recentlyLeft = r.status === 'CHECKED_OUT' && r.checkedOutAt && Date.now() - r.checkedOutAt.getTime() < 2 * 3_600_000;
      if (!['PENDING', 'CONFIRMED', 'CHECKED_IN'].includes(r.status) && !recentlyLeft) throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'Requests can be made for upcoming and current stays only', { status: r.status, allowed: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] });
      return this.requests.createTx(tx, {
        tenantId,
        propertyId: r.propertyId,
        guestId: r.guestId,
        reservationId: r.id,
        source: dto.source ?? 'TRIP_PAGE',
        staff: null,
        serviceId: dto.serviceId ?? null,
        variantId: dto.variantId ?? null,
        requestText: dto.requestText ?? null,
        answers: dto.answers ?? null,
        preferredStart: dto.preferredStart ?? null,
        preferredEnd: dto.preferredEnd ?? null,
        hours: dto.hours ?? null,
        partySize: dto.partySize ?? null,
        notes: dto.notes ?? null,
        discreet: !!dto.discreet,
        contactPreference: dto.contactPreference,
        contactPhone: dto.contactPhone ?? null,
        contactEmail: dto.contactEmail ?? null,
        paymentMethod: dto.paymentMethod ?? null,
      });
    });
    await this.dispatch(res.messageIds);
    const payment = res.paymentId ? await this.payments.initialize(tenantId, res.paymentId) : null;
    return { request: await this.db.tenant(tenantId, async (tx) => this.guestView(await this.requests.loadTx(tx, tenantId, res.id), payment?.authorizationUrl ?? null)), payment };
  }

  private async dispatch(ids: string[]) {
    await this.notifications.dispatch(ids);
  }

  private async ownRequest(tx: Tx, tenantId: string, reservationId: string, id: string) {
    const r = await tx.conciergeRequest.findFirst({ where: { id, tenantId, reservationId }, include: requestInclude });
    if (!r) throw AppException.notFound('Request');
    return r;
  }

  async getRequest(code: string, t: string | undefined, id: string) {
    const { tenantId, reservationId } = this.tokens.verifyTrip(t, code);
    return this.db.tenant(tenantId, async (tx) => {
      const r = await this.ownRequest(tx, tenantId, reservationId, id);
      return this.guestView(r, (await this.pendingUrls(tx, [r])).get(r.id) ?? null);
    });
  }

  async cancel(code: string, t: string | undefined, id: string, reason: string | undefined) {
    const { tenantId, reservationId } = this.tokens.verifyTrip(t, code);
    const out = await this.db.tenant(tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM concierge_requests WHERE id = ${id}::uuid FOR UPDATE`;
      return this.requests.guestCancelTx(tx, await this.ownRequest(tx, tenantId, reservationId, id), reason ?? null);
    });
    await out.after();
    return this.getRequest(code, t, id);
  }

  async rate(code: string, t: string | undefined, id: string, dto: { rating: number; comment?: string }) {
    const { tenantId, reservationId } = this.tokens.verifyTrip(t, code);
    await this.db.tenant(tenantId, async (tx) => this.requests.guestRateTx(tx, await this.ownRequest(tx, tenantId, reservationId, id), dto.rating, dto.comment ?? null));
    return this.getRequest(code, t, id);
  }

  // ---------------------------------------------------------------------------
  // Quote links
  // ---------------------------------------------------------------------------

  private quoteState(r: RequestRow, version: number, now = new Date()): 'OPEN' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'REPLACED' {
    if (version !== r.quoteVersion) return 'REPLACED';
    if (r.quoteAnswer === 'ACCEPTED') return 'ACCEPTED';
    if (r.quoteAnswer === 'DECLINED' || (r.status === 'CANCELLED' && !r.quoteAnswer)) return 'DECLINED';
    if (r.status !== 'QUOTED') return r.status === 'AWAITING_GUEST' ? 'ACCEPTED' : 'DECLINED';
    if (r.quoteValidUntil && r.quoteValidUntil < now) return 'EXPIRED';
    return 'OPEN';
  }

  async quote(token: string) {
    const { tenantId, requestId, version } = this.notifier.verifyQuote(token);
    return this.db.tenant(tenantId, async (tx) => {
      const r = await tx.conciergeRequest.findFirst({ where: { id: requestId, tenantId }, include: requestInclude });
      if (!r) throw AppException.notFound('Quote');
      const property = await tx.property.findFirstOrThrow({ where: { id: r.propertyId } });
      const settings = await this.core.settingsTx(tx, tenantId, r.propertyId);
      const folioOpen = settings.payFolio && r.reservation?.folio?.status === 'OPEN';
      return {
        request: this.guestView(r, (await this.pendingUrls(tx, [r])).get(r.id) ?? null),
        hotel: { slug: property.slug, name: property.name, phone: property.phone || null, logoUrl: property.logoUrl, accentColor: property.accentColor },
        paymentOptions: {
          online: await this.payments.availableTx(tx, tenantId, r.propertyId),
          folio: folioOpen,
          folioLabel: folioOpen ? (r.reservation?.room?.number ? `Add to your bill for room ${r.reservation.room.number}` : 'Add to your bill') : null,
        },
        state: this.quoteState(r, version),
      };
    });
  }

  async accept(token: string, dto: { paymentMethod: 'ONLINE' | 'FOLIO'; email?: string }) {
    const { tenantId, requestId, version } = this.notifier.verifyQuote(token);
    const res = await this.db.tenant(tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM concierge_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
      const r = await this.requests.loadTx(tx, tenantId, requestId);
      const out = await this.requests.acceptTx(tx, r, { version, via: 'LINK', paymentMethod: dto.paymentMethod, email: dto.email ?? null, by: 'Guest' });
      if (!r.firstResponseAt) await tx.conciergeRequest.update({ where: { id: r.id }, data: { firstResponseAt: new Date() } satisfies Prisma.ConciergeRequestUpdateInput });
      return out;
    });
    await this.dispatch(res.ids);
    const payment = res.paymentId ? await this.payments.initialize(tenantId, res.paymentId) : null;
    const view = await this.db.tenant(tenantId, async (tx) => this.guestView(await this.requests.loadTx(tx, tenantId, requestId), payment?.authorizationUrl ?? null));
    return { request: view, payment };
  }

  async decline(token: string, reason?: string) {
    const { tenantId, requestId, version } = this.notifier.verifyQuote(token);
    const view = await this.db.tenant(tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM concierge_requests WHERE id = ${requestId}::uuid FOR UPDATE`;
      const r = await this.requests.loadTx(tx, tenantId, requestId);
      await this.requests.declineQuoteTx(tx, r, { version, via: 'LINK', reason: reason ?? null, by: 'Guest' });
      return this.guestView(await this.requests.loadTx(tx, tenantId, requestId));
    });
    return { request: view };
  }
}
