import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { ConciergeRequest, ConciergeService as ServiceRow, ConciergeSettings, Prisma, Property } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { emitDomainEvent } from '../../common/domain-events.js';
import { AppException } from '../../common/errors/app-exception.js';
import { assertCan, can } from '../../common/permissions/can.js';
import { permissionsFor } from '../../common/permissions/catalogue.js';
import { addDays, humanDateTime, lagosDate, lagosDateTime, lagosStartOfDay } from '../../common/time/lagos.js';
import { normalisePhone } from '../../common/utils/phone.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, csvCell, userActor, type AuditActor } from '../audit/audit.service.js';
import { issuesError } from '../booking-form/form.errors.js';
import type { ValidationIssue } from '../booking-form/form.logic.js';
import { actorOf, LedgerService, type Actor } from '../folios/ledger.service.js';
import { componentsFrom, type TaxComponent } from '../folios/tax.logic.js';
import { TaxSettingsService } from '../folios/tax-settings.service.js';
import { DocumentsService } from '../invoices/documents.service.js';
import { NotificationService, type OutgoingMessage } from '../notifications/notification.service.js';
import { appError, Err, paginate, parseClientCreatedAt, primaryProperty } from '../ops/ops.helpers.js';
import { ConciergeNotifier, paymentText } from './concierge-notifier.service.js';
import { ConciergePaymentsService, type ConciergePaymentInit } from './concierge-payments.service.js';
import {
  chargeOf,
  ConciergeService,
  NEUTRAL_AUDIT,
  questionsOf,
  requestInclude,
  serviceLike,
  timelineOf,
  type RequestRow,
  type TimelineEvent,
  type Viewer,
} from './concierge.service.js';
import {
  answerTexts,
  canTransition,
  categoryLabel,
  commissionOf,
  dueForEscalation,
  durationOf,
  FINAL_STATUSES,
  firstName,
  folioDescription,
  formatNumber,
  OPEN_STATUSES,
  parseQuoteReply,
  priceService,
  PRIVATE_TITLE,
  quotePrice,
  slaDueAt,
  slaView,
  timeIssue,
  TRANSITIONS,
  validateServiceAnswers,
  type RequestStatus,
} from './concierge.logic.js';
import { CatalogueService } from './catalogue.service.js';
import { screen } from './denylist.js';

export interface CreateInput {
  tenantId: string;
  propertyId: string;
  guestId: string;
  reservationId: string | null;
  source: 'BOOKING_FLOW' | 'TRIP_PAGE' | 'WHATSAPP' | 'FRONT_DESK';
  staff: AuthUser | null;
  serviceId?: string | null;
  variantId?: string | null;
  requestText?: string | null;
  answers?: Record<string, unknown> | null;
  preferredStart?: string | null;
  preferredEnd?: string | null;
  hours?: number | null;
  partySize?: number | null;
  notes?: string | null;
  internalNotes?: string | null;
  discreet?: boolean;
  contactPreference?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  paymentMethod?: 'ONLINE' | 'FOLIO' | 'NONE' | null;
  notifyGuest?: boolean;
  assigneeId?: string | null;
  vendorId?: string | null;
  clientCreatedAt?: Date | null;
  timelineNote?: string | null;
}

export interface CreateResult {
  id: string;
  paymentId: string | null;
  messageIds: string[];
}

const SYSTEM: Actor = { userId: null, fullName: 'System' };
const REPLY_WITHIN = (minutes: number) => (minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`);

/**
 * Concierge requests (M8): creation from every channel, the status machine,
 * quotes and their acceptance, vendors, folio posting and commission, the
 * content-screen review, the board, reports and exports, SLA escalation and
 * retention. Private requests are masked for staff without
 * `concierge.discreet`, and every view of one by a holder is audited.
 */
@Injectable()
export class RequestsService {
  private readonly logger = new Logger(RequestsService.name);

  constructor(
    private readonly db: DbService,
    private readonly core: ConciergeService,
    private readonly catalogue: CatalogueService,
    private readonly notifier: ConciergeNotifier,
    private readonly payments: ConciergePaymentsService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly taxes: TaxSettingsService,
    private readonly docs: DocumentsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async loadTx(tx: Tx, tenantId: string, id: string): Promise<RequestRow> {
    const r = await tx.conciergeRequest.findFirst({ where: { id, tenantId }, include: requestInclude });
    if (!r) throw AppException.notFound('Request');
    return r;
  }

  private event(type: string, status: string | null, note: string | null, by: string | null, guestVisible: boolean, at = new Date()): TimelineEvent {
    return { at: at.toISOString(), type, status, note, by, guestVisible };
  }

  private stayLink(r: RequestRow) {
    return r.reservation ? { tenantId: r.tenantId, id: r.reservation.id, code: r.reservation.code, departureAt: r.reservation.departureAt } : null;
  }

  /** The best link for the guest: the quote page while a quote is open, else the trip page. */
  guestUrl(r: RequestRow): string {
    if (r.status === 'QUOTED' || r.status === 'AWAITING_GUEST') {
      const q = this.notifier.quoteLink(r);
      if (q) return q.url;
    }
    return this.notifier.tripUrl(this.stayLink(r));
  }

  private auditActor(u: AuthUser | null): AuditActor {
    return u ? userActor(u) : { kind: 'system', name: 'Guest' };
  }

  /** Staff may act on a private request only with concierge.discreet (or as its assignee for progress). */
  private assertActable(u: AuthUser, r: RequestRow, opts: { assigneeProgress?: boolean } = {}) {
    if (!r.discreet || can(u, 'concierge.discreet')) return;
    if (opts.assigneeProgress && r.assigneeId === u.userId) return;
    throw new AppException(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Only the concierge team can work on private requests', { permission: 'concierge.discreet' });
  }

  private async emit(tx: Tx, r: ConciergeRequest, type: 'concierge.request_created' | 'concierge.request_updated') {
    if (r.discreet) return; // private requests never leave the hotel
    await emitDomainEvent(tx, { tenantId: r.tenantId, propertyId: r.propertyId, type, object: partnerRequest(r) });
  }

  private async property(tx: Tx, r: { tenantId: string; propertyId: string }): Promise<Property> {
    return tx.property.findFirstOrThrow({ where: { id: r.propertyId, tenantId: r.tenantId } });
  }

  private async guestMessages(tx: Tx, r: RequestRow, data: Parameters<ConciergeNotifier['guest']>[3] | Omit<Parameters<ConciergeNotifier['guest']>[3], 'url'>): Promise<string[]> {
    const msgs = await this.notifier.guest(tx, r, await this.property(tx, r), { url: this.guestUrl(r), ...data } as Parameters<ConciergeNotifier['guest']>[3]);
    return this.notifications.queueTx(tx, msgs);
  }

  private async after(ids: string[], paymentId: string | null, tenantId: string): Promise<ConciergePaymentInit | null> {
    await this.notifications.dispatch(ids);
    if (!paymentId) return null;
    return this.payments.initialize(tenantId, paymentId);
  }

  // ---------------------------------------------------------------------------
  // Creation (every channel)
  // ---------------------------------------------------------------------------

  /**
   * Validates and creates a request inside the caller's tenant transaction.
   * Guests (staff = null) are held to the catalogue, channels, lead times and
   * the stay window; staff are not. Flagged text never auto-confirms.
   */
  async createTx(tx: Tx, input: CreateInput): Promise<CreateResult> {
    const now = new Date();
    const staff = input.staff;
    const issues: ValidationIssue[] = [];
    const add = (path: string, code: string, message: string, meta?: Record<string, unknown>) => issues.push({ path, fieldKey: null, code, message, ...(meta && { meta }) });
    const settings = await this.core.settingsTx(tx, input.tenantId, input.propertyId);
    const account = await this.core.accountTx(tx, input.tenantId);
    if (staff) {
      this.core.assertNotSuspended(account);
    } else if (!settings.enabled || account?.suspendedAt || !this.core.aupAccepted(account)) {
      throw appError(HttpStatus.CONFLICT, 'CONCIERGE_DISABLED', 'This hotel is not taking concierge requests online right now. Please call the hotel.');
    }
    const ent = await this.core.entitlements.getEntitlements(input.tenantId, tx);
    const reservation = input.reservationId
      ? await tx.reservation.findFirst({ where: { id: input.reservationId, tenantId: input.tenantId }, include: { folio: { select: { id: true, status: true } }, guest: true } })
      : null;
    if (input.reservationId && !reservation) throw AppException.notFound('Reservation');
    const guest = await tx.guest.findFirst({ where: { id: input.guestId, tenantId: input.tenantId } });
    if (!guest) throw AppException.notFound('Guest');
    if (guest.anonymisedAt) throw appError(HttpStatus.CONFLICT, 'GUEST_ANONYMISED', 'This guest record was anonymised on request and cannot be used');

    // Service or free-form.
    let service: ServiceRow | null = null;
    if (input.serviceId) {
      service = await tx.conciergeService.findFirst({ where: { id: input.serviceId, tenantId: input.tenantId, propertyId: input.propertyId } });
      const channel = staff ? 'FRONT_DESK' : input.source === 'BOOKING_FLOW' ? 'BOOKING_FLOW' : 'TRIP_PAGE';
      if (!service || !service.active || service.reviewStatus !== 'LIVE') add('serviceId', 'INACTIVE', 'This service is not available');
      else if (!staff && !service.channels.includes(channel)) add('serviceId', 'NOT_AVAILABLE', `${service.name} cannot be requested here`);
    } else {
      const text = input.requestText?.trim() ?? '';
      if (!staff && !settings.freeFormEnabled) add('requestText', 'NOT_AVAILABLE', 'Please choose one of the services offered');
      if (!text) add('requestText', 'REQUIRED', 'Tell us what you would like us to arrange');
      else if (text.length < (staff ? 3 : 5)) add('requestText', 'TOO_SHORT', 'Tell us a little more');
      else if (text.length > 1000) add('requestText', 'TOO_LONG', 'At most 1000 characters');
    }
    if (input.discreet && service && !service.discreetEligible) add('discreet', 'NOT_ALLOWED', `${service.name} cannot be marked private`);
    if (input.notes && input.notes.length > 1000) add('notes', 'TOO_LONG', 'At most 1000 characters');

    // Answers to the service's questions (M7 engine).
    const questions = service ? questionsOf(service.questions) : [];
    let stored: Record<string, unknown> = {};
    if (service) {
      const a = validateServiceAnswers(questions, input.answers);
      issues.push(...a.issues);
      stored = a.stored;
    } else if (input.answers && Object.keys(input.answers).length) {
      add('answers', 'UNKNOWN_FIELD', 'Free-form requests have no questions');
    }

    // Price (automatic services).
    const comps = componentsFrom(await this.taxes.forProperty(tx, input.tenantId, input.propertyId));
    const like = service ? serviceLike(service) : null;
    let price: ReturnType<typeof priceService>['price'] = null;
    let requiresQuote = !service;
    if (service && like) {
      const p = priceService(like, { variantId: input.variantId, partySize: input.partySize, hours: input.hours }, comps);
      issues.push(...p.issues);
      price = p.price;
      requiresQuote = p.requiresQuote;
    }
    if (input.partySize !== undefined && input.partySize !== null && (input.partySize < 1 || input.partySize > 50)) add('partySize', input.partySize < 1 ? 'MIN' : 'MAX', 'Between 1 and 50 people', { min: 1, max: 50 });

    // Time.
    const start = input.preferredStart ? new Date(input.preferredStart) : null;
    const end = input.preferredEnd ? new Date(input.preferredEnd) : null;
    if (start && Number.isNaN(start.getTime())) add('preferredStart', 'INVALID_DATE', 'Choose a date and time');
    if (end && (Number.isNaN(end.getTime()) || (start && end <= start))) add('preferredEnd', 'INVALID_DATE', 'The end must be after the start');
    const duration = like ? durationOf(like, input.variantId) : 60;
    if (service && like && service.requiresSlot && !start) add('preferredStart', 'REQUIRED', 'Choose a time');
    if (service && like && start && !Number.isNaN(start.getTime())) {
      const t = timeIssue(like, start, now, { enforceLeadTime: !staff, durationMinutes: duration });
      if (t) add('preferredStart', t.code, t.message, t.meta);
      else if (service.requiresSlot || service.slotCapacity) {
        const capacity = service.slotCapacity ?? 1;
        const slotEnd = end ?? new Date(start.getTime() + duration * 60_000);
        const busy = (await this.catalogue.busyTx(tx, service, lagosDate(start))).filter((b) => b.start < slotEnd && start < b.end).length;
        if (busy >= capacity) add('preferredStart', 'SOLD_OUT', 'This time is fully booked. Please choose another.');
      }
    }
    if (!staff && reservation && start && !Number.isNaN(start.getTime())) {
      const from = lagosStartOfDay(lagosDate(reservation.arrivalAt));
      if (start < from || start > reservation.departureAt) add('preferredStart', 'OUT_OF_WINDOW', 'Choose a time during your stay', { from: from.toISOString(), to: reservation.departureAt.toISOString() });
    }
    if (!staff && input.source === 'BOOKING_FLOW' && reservation && reservation.status === 'CHECKED_IN') add('source', 'NOT_ALLOWED', 'Ask from your trip page during your stay');

    // Contact.
    let pref = input.contactPreference ?? (ent.features.includes('whatsapp_messaging') ? 'WHATSAPP' : 'SMS');
    const phoneRaw = input.contactPhone ?? reservation?.contactPhone ?? guest.phone;
    const phone = phoneRaw ? normalisePhone(phoneRaw) : null;
    if (input.contactPhone && !phone) add('contactPhone', 'INVALID_PHONE', 'Enter a valid phone number, e.g. 0803 123 4567');
    const email = (input.contactEmail ?? reservation?.contactEmail ?? guest.email ?? null)?.trim().toLowerCase() || null;
    if (pref === 'WHATSAPP' && !ent.features.includes('whatsapp_messaging')) {
      if (staff) pref = 'SMS';
      else add('contactPreference', 'NOT_ALLOWED', 'This hotel does not message guests on WhatsApp. Choose SMS instead.');
    }
    if ((pref === 'WHATSAPP' || pref === 'SMS') && !phone) add('contactPhone', 'REQUIRED', 'A phone number is needed for messages');
    if (pref === 'EMAIL' && !email) add('contactEmail', 'REQUIRED', 'Give an email address');

    // Payment method (automatic prices only).
    const folioOpen = reservation?.folio?.status === 'OPEN';
    const charge = price?.totalKobo ?? 0;
    const onlineOk = await this.payments.availableTx(tx, input.tenantId, input.propertyId);
    let method: 'ONLINE' | 'FOLIO' | 'NONE' | null = null;
    if (price && !requiresQuote) {
      if (charge === 0) method = 'NONE';
      else if (input.paymentMethod === 'FOLIO') {
        if (!settings.payFolio || !folioOpen) add('paymentMethod', 'NOT_AVAILABLE', 'This cannot be added to your bill. Pay online instead.');
        else method = 'FOLIO';
      } else if (input.paymentMethod === 'ONLINE') {
        if (!onlineOk) add('paymentMethod', 'NOT_AVAILABLE', 'Online payment is not available at this hotel.');
        else if (!email) add('contactEmail', 'REQUIRED', 'An email address is needed to pay online (for your receipt)');
        else method = 'ONLINE';
      } else if (input.paymentMethod === 'NONE') {
        add('paymentMethod', 'NOT_AVAILABLE', 'This service has a price');
      } else {
        method = settings.payFolio && folioOpen ? 'FOLIO' : onlineOk && email && !staff ? 'ONLINE' : null;
      }
    } else if (input.paymentMethod === 'NONE' && staff) {
      method = 'NONE';
    }
    if (issues.length) throw issuesError(issues);

    // Content screen.
    const hit = screen([input.requestText, input.notes, ...answerTexts(questions, stored)]);

    // Status.
    let status: RequestStatus = 'NEW';
    if (!hit.flagged && !requiresQuote && price) {
      if (method === 'NONE' || method === 'FOLIO') status = 'CONFIRMED';
      else if (method === 'ONLINE') status = 'AWAITING_GUEST';
    }
    const target = reservation?.status === 'CHECKED_IN' ? 'IN_STAY' : 'PRE_ARRIVAL';
    const created = input.clientCreatedAt ?? now;
    const by = staff ? staff.fullName : 'Guest';
    const events: TimelineEvent[] = [this.event('created', 'NEW', input.timelineNote ?? (input.source === 'WHATSAPP' ? 'From a WhatsApp message' : null), by, true, created)];
    if (hit.flagged) events.push(this.event('flagged', null, `Held for review: ${hit.terms.join(', ')}`, 'Content screen', false, created));
    if (status !== 'NEW') events.push(this.event('status', status, method === 'ONLINE' ? 'Pay online to confirm' : null, staff ? by : 'Automatic', true, created));

    const { seq } = await this.docs.nextNumber(tx, input.tenantId, 'CONCIERGE_REQUEST', 0, { propertyId: input.propertyId, prefix: null });
    const vendorId = hit.flagged ? null : (input.vendorId ?? service?.vendorId ?? null);
    const vendor = vendorId ? await tx.conciergeVendor.findFirst({ where: { id: vendorId, tenantId: input.tenantId, propertyId: input.propertyId, active: true } }) : null;
    if (input.vendorId && !vendor) throw Err.validation('vendorId', 'This vendor is not in the directory');
    const assignee = input.assigneeId ? await this.assigneeTx(tx, input.tenantId, input.propertyId, input.assigneeId, !!input.discreet) : null;
    const vendorsFeature = ent.features.includes('concierge_vendors');
    const firstResponse = staff || status !== 'NEW' ? created : null;
    const row = await tx.conciergeRequest.create({
      data: {
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        seq,
        number: formatNumber(seq),
        reservationId: reservation?.id ?? null,
        guestId: guest.id,
        serviceId: service?.id ?? null,
        serviceName: service?.name ?? 'Something else',
        category: service?.category ?? 'OTHER',
        pricing: service?.pricing ?? null,
        location: service?.location ?? null,
        variantId: input.variantId ?? null,
        variantName: input.variantId ? (like?.variants.find((v) => v.id === input.variantId)?.name ?? null) : null,
        hours: input.hours ?? null,
        questions: questions as unknown as Prisma.InputJsonValue,
        answers: stored as Prisma.InputJsonValue,
        requestText: service ? null : (input.requestText?.trim() ?? null),
        preferredStart: start,
        preferredEnd: end ?? (start && service ? new Date(start.getTime() + duration * 60_000) : null),
        partySize: input.partySize ?? null,
        notes: input.notes?.trim() || null,
        internalNotes: staff ? (input.internalNotes?.trim() || null) : null,
        discreet: !!input.discreet,
        contactPreference: pref,
        contactPhone: phone,
        contactEmail: email,
        status,
        source: input.source,
        flagged: hit.flagged,
        flagTerms: hit.terms,
        flagCategories: hit.categories,
        flagStatus: hit.flagged ? 'PENDING' : null,
        ...(price && {
          priceAmountKobo: price.amountKobo,
          priceNetKobo: price.netKobo,
          priceTaxKobo: price.taxKobo,
          priceTaxes: price.taxes as unknown as Prisma.InputJsonValue,
          priceDescription: price.description,
        }),
        taxComponents: ((service ? service.taxable : true) ? comps : []) as unknown as Prisma.InputJsonValue,
        paymentMethod: method === 'ONLINE' ? null : method,
        paymentStatus: 'NONE',
        assigneeId: assignee?.id ?? null,
        assigneeName: assignee?.fullName ?? null,
        vendorId: vendor?.id ?? null,
        vendorName: vendor?.name ?? null,
        ...(vendor && vendorsFeature && vendor.commissionType !== 'NONE' && { commissionType: vendor.commissionType, commissionValue: vendor.commissionValue }),
        slaTarget: target,
        slaDueAt: slaDueAt(created, target, settings),
        firstResponseAt: firstResponse,
        createdById: staff?.userId ?? null,
        createdByName: staff?.fullName ?? null,
        clientCreatedAt: input.clientCreatedAt ?? null,
        timeline: events as unknown as Prisma.InputJsonValue,
        createdAt: created,
      },
      include: requestInclude,
    });
    let paymentId: string | null = null;
    if (method === 'ONLINE' && status === 'AWAITING_GUEST') paymentId = (await this.payments.createTx(tx, row, email)).id;
    await this.audit.record(tx, {
      tenantId: input.tenantId, actor: this.auditActor(staff), action: 'concierge_request.created', entityType: 'concierge_request', entityId: row.id, propertyId: input.propertyId,
      metadata: { number: row.number, title: NEUTRAL_AUDIT(row), source: input.source, discreet: row.discreet, flagged: hit.flagged, status },
    });
    await this.emit(tx, row, 'concierge.request_created');
    const fresh = await this.loadTx(tx, input.tenantId, row.id);
    let messageIds: string[] = [];
    if (input.notifyGuest !== false) {
      if (status === 'CONFIRMED') messageIds = await this.guestMessages(tx, fresh, { template: 'CONCIERGE_CONFIRMED' });
      else if (status === 'AWAITING_GUEST') messageIds = await this.guestMessages(tx, fresh, { template: 'CONCIERGE_UPDATE', update: 'Pay online to confirm your request.' });
      else if (!staff || input.source === 'WHATSAPP') messageIds = await this.guestMessages(tx, fresh, { template: 'CONCIERGE_RECEIVED', replyWithin: REPLY_WITHIN(target === 'IN_STAY' ? settings.slaInStayMinutes : settings.slaPreArrivalMinutes) });
    }
    return { id: row.id, paymentId, messageIds };
  }

  // ---------------------------------------------------------------------------
  // Staff: create, list, board, detail
  // ---------------------------------------------------------------------------

  async createForGuest(u: AuthUser, dto: StaffCreateDto, ip?: string) {
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    const res = await this.db.tenant(u.tenantId, async (tx) => {
      const p = await primaryProperty(tx, u.tenantId);
      let guestId = dto.guestId ?? null;
      if (dto.reservationId) {
        const r = await tx.reservation.findFirst({ where: { id: dto.reservationId, tenantId: u.tenantId, propertyId: p.id }, select: { guestId: true } });
        if (!r) throw AppException.notFound('Reservation');
        guestId = guestId ?? r.guestId;
      }
      if (!guestId) throw Err.validation('reservationId', 'Choose the guest or their reservation');
      if (dto.discreet) assertCan(u, 'concierge.discreet', 'Only the concierge team can create private requests');
      const out = await this.createTx(tx, { ...dto, tenantId: u.tenantId, propertyId: p.id, guestId, reservationId: dto.reservationId ?? null, source: 'FRONT_DESK', staff: u, clientCreatedAt });
      void ip;
      return out;
    });
    await this.after(res.messageIds, res.paymentId, u.tenantId);
    return this.detail(u, res.id, { audit: false });
  }

  async fromMessage(u: AuthUser, dto: { conversationId: string; messageId?: string; serviceId?: string; variantId?: string; discreet?: boolean; notes?: string }) {
    const res = await this.db.tenant(u.tenantId, async (tx) => {
      const c = await tx.conversation.findFirst({ where: { id: dto.conversationId, tenantId: u.tenantId } });
      if (!c) throw AppException.notFound('Conversation');
      const msg = dto.messageId
        ? await tx.conversationMessage.findFirst({ where: { id: dto.messageId, conversationId: c.id } })
        : await tx.conversationMessage.findFirst({ where: { conversationId: c.id, direction: 'INBOUND' }, orderBy: { createdAt: 'desc' } });
      if (!msg) throw AppException.notFound('Message');
      if (dto.discreet) assertCan(u, 'concierge.discreet', 'Only the concierge team can create private requests');
      let guestId = c.guestId;
      if (!guestId && c.reservationId) guestId = (await tx.reservation.findFirst({ where: { id: c.reservationId }, select: { guestId: true } }))?.guestId ?? null;
      if (!guestId) throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'This conversation is not linked to a guest yet', { status: 'UNLINKED', allowed: [] });
      const out = await this.createTx(tx, {
        tenantId: u.tenantId,
        propertyId: c.propertyId,
        guestId,
        reservationId: c.reservationId,
        source: 'WHATSAPP',
        staff: u,
        serviceId: dto.serviceId ?? null,
        variantId: dto.variantId ?? null,
        requestText: dto.serviceId ? null : msg.body.slice(0, 1000),
        notes: dto.serviceId ? msg.body.slice(0, 1000) : (dto.notes ?? null),
        discreet: dto.discreet,
        contactPreference: 'WHATSAPP',
        contactPhone: c.guestPhone,
        notifyGuest: false,
      });
      const r = await tx.conciergeRequest.findUniqueOrThrow({ where: { id: out.id } });
      await tx.conversation.update({ where: { id: c.id }, data: { notes: `${c.notes ? `${c.notes}\n` : ''}Converted to concierge request ${r.number}`.slice(0, 2000) } });
      return out;
    });
    await this.after(res.messageIds, res.paymentId, u.tenantId);
    return this.detail(u, res.id, { audit: false });
  }

  private listWhere(u: AuthUser, v: Viewer, propertyId: string, q: ListQuery): Prisma.ConciergeRequestWhereInput {
    const statuses = q.status ? q.status.split(',').filter((s) => (Object.keys(TRANSITIONS) as string[]).includes(s)) : null;
    const where: Prisma.ConciergeRequestWhereInput = {
      tenantId: u.tenantId,
      propertyId,
      ...this.core.hiddenWhere(v),
      ...(statuses?.length && { status: { in: statuses as RequestStatus[] } }),
      ...(q.source && { source: q.source }),
      ...(q.assigneeId && { assigneeId: q.assigneeId }),
      ...(q.vendorId && { vendorId: q.vendorId }),
      ...(q.serviceId && { serviceId: q.serviceId }),
      ...(q.reservationId && { reservationId: q.reservationId }),
      ...(q.discreet !== undefined && { discreet: q.discreet }),
      ...(q.flagged !== undefined && (q.flagged ? { flagged: true, flagStatus: 'PENDING' } : { NOT: { flagStatus: 'PENDING' } })),
      ...(q.overdue && { firstResponseAt: null, slaDueAt: { lt: new Date() }, status: { notIn: [...FINAL_STATUSES] } }),
      ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: lagosStartOfDay(q.from) }), ...(q.to && { lt: lagosStartOfDay(addDays(q.to, 1)) }) } }),
    };
    if (q.q) {
      const term = q.q.trim();
      const or: Prisma.ConciergeRequestWhereInput[] = [
        { number: { contains: term, mode: 'insensitive' } },
        { reservation: { room: { number: term } } },
      ];
      const visible: Prisma.ConciergeRequestWhereInput[] = [
        { guest: { fullName: { contains: term, mode: 'insensitive' } } },
        { serviceName: { contains: term, mode: 'insensitive' } },
        { reservation: { code: { contains: term, mode: 'insensitive' } } },
      ];
      // Masked requests are found by number and room only.
      or.push(...visible.map((x) => (v.holder ? x : { AND: [x, { discreet: false }] })));
      where.OR = or;
    }
    return where;
  }

  list(u: AuthUser, q: ListQuery) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const p = await primaryProperty(tx, u.tenantId);
      const v = await this.core.viewer(tx, u, p.id);
      const where = this.listWhere(u, v, p.id, q);
      const { page, pageSize, skip, take } = paginate(q.page, q.pageSize);
      const total = await tx.conciergeRequest.count({ where });
      const rows = await tx.conciergeRequest.findMany({ where, include: requestInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take });
      const hiddenDiscreet = !v.holder && v.visibility === 'HIDDEN' ? await tx.conciergeRequest.count({ where: { tenantId: u.tenantId, propertyId: p.id, discreet: true, status: { in: [...OPEN_STATUSES] } } }) : 0;
      return { items: rows.map((r) => this.core.listItem(r, v)), total, page, pageSize, hiddenDiscreet };
    });
  }

  board(u: AuthUser, now = new Date()) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const p = await primaryProperty(tx, u.tenantId);
      const v = await this.core.viewer(tx, u, p.id);
      const today = lagosDate(now);
      const doneSince = new Date(now.getTime() - 48 * 3_600_000);
      const rows = await tx.conciergeRequest.findMany({
        where: {
          tenantId: u.tenantId,
          propertyId: p.id,
          ...this.core.hiddenWhere(v),
          OR: [{ status: { in: [...OPEN_STATUSES] } }, { status: { in: [...FINAL_STATUSES] }, updatedAt: { gte: doneSince } }],
        },
        include: requestInclude,
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      const startDay = (r: RequestRow) => {
        const at = r.scheduledAt ?? r.preferredStart;
        return at ? lagosDate(at) : null;
      };
      const cols: Record<'NEW' | 'QUOTED' | 'CONFIRMED' | 'TODAY' | 'DONE', RequestRow[]> = { NEW: [], QUOTED: [], CONFIRMED: [], TODAY: [], DONE: [] };
      for (const r of rows) {
        if (r.status === 'NEW') cols.NEW.push(r);
        else if (r.status === 'QUOTED' || r.status === 'AWAITING_GUEST') cols.QUOTED.push(r);
        else if (r.status === 'IN_PROGRESS' || ((r.status === 'CONFIRMED' || r.status === 'SCHEDULED') && startDay(r) === today)) cols.TODAY.push(r);
        else if (r.status === 'CONFIRMED' || r.status === 'SCHEDULED') cols.CONFIRMED.push(r);
        else cols.DONE.push(r);
      }
      const items = (list: RequestRow[], byStart = false) =>
        list
          .map((r) => this.core.listItem(r, v, now))
          .sort((a, b) => Number(b.sla.overdue) - Number(a.sla.overdue) || (byStart ? (a.preferredStart ?? '').localeCompare(b.preferredStart ?? '') : a.sla.dueAt.localeCompare(b.sla.dueAt)));
      const all = rows.map((r) => this.core.listItem(r, v, now));
      const hiddenDiscreet = !v.holder && v.visibility === 'HIDDEN' ? await tx.conciergeRequest.count({ where: { tenantId: u.tenantId, propertyId: p.id, discreet: true, status: { in: [...OPEN_STATUSES] } } }) : 0;
      return {
        generatedAt: now.toISOString(),
        businessDate: today,
        columns: [
          { key: 'NEW' as const, label: 'New', items: items(cols.NEW) },
          { key: 'QUOTED' as const, label: 'Quoted', items: items(cols.QUOTED) },
          { key: 'CONFIRMED' as const, label: 'Confirmed', items: items(cols.CONFIRMED, true) },
          { key: 'TODAY' as const, label: 'Today', items: items(cols.TODAY, true) },
          { key: 'DONE' as const, label: 'Done', items: cols.DONE.map((r) => this.core.listItem(r, v, now)) },
        ],
        counts: {
          new: cols.NEW.length,
          quoted: cols.QUOTED.length,
          confirmed: cols.CONFIRMED.length,
          today: cols.TODAY.length,
          done: cols.DONE.length,
          overdue: all.filter((x) => x.sla.overdue).length,
          flagged: rows.filter((r) => r.flagged && r.flagStatus === 'PENDING' && !this.core.masked(r, v)).length,
        },
        hiddenDiscreet,
      };
    });
  }

  /** Detail for staff; masked or 404 per the discretion rules; a holder's view of a private request is audited. */
  detailTx(tx: Tx, u: AuthUser, r: RequestRow, v: Viewer) {
    if (r.discreet && !v.holder && v.visibility === 'HIDDEN') throw AppException.notFound('Request');
    const q = this.notifier.quoteLink(r);
    const d = this.core.detail(r, v, { acceptUrl: q?.url ?? null });
    return d;
  }

  async detail(u: AuthUser, id: string, opts: { audit?: boolean; ip?: string } = {}) {
    const res = await this.db.tenant(u.tenantId, async (tx) => {
      const r = await this.loadTx(tx, u.tenantId, id);
      const v = await this.core.viewer(tx, u, r.propertyId);
      const d = this.detailTx(tx, u, r, v);
      if (r.discreet && v.holder && opts.audit !== false) {
        await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'concierge_request.discreet_viewed', entityType: 'concierge_request', entityId: r.id, propertyId: r.propertyId, metadata: { number: r.number }, ip: opts.ip });
      }
      const pay = r.paymentStatus === 'PENDING' && r.paymentReference && !d.masked ? await tx.conciergePayment.findUnique({ where: { reference: r.paymentReference }, select: { authorizationUrl: true } }) : null;
      return { ...d, payment: { ...d.payment, authorizationUrl: pay?.authorizationUrl ?? null } };
    });
    return res;
  }

  // ---------------------------------------------------------------------------
  // Staff actions
  // ---------------------------------------------------------------------------

  private async write(u: AuthUser, id: string, fn: (tx: Tx, r: RequestRow) => Promise<{ ids?: string[]; paymentId?: string | null; after?: () => Promise<void> } | void>) {
    const out = await this.db.tenant(u.tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM concierge_requests WHERE id = ${id}::uuid FOR UPDATE`;
      const r = await this.loadTx(tx, u.tenantId, id);
      return (await fn(tx, r)) ?? {};
    });
    await this.after(out.ids ?? [], out.paymentId ?? null, u.tenantId);
    if (out.after) await out.after().catch((e: Error) => this.logger.error(`Concierge follow-up failed: ${e.message}`));
    return this.detail(u, id, { audit: false });
  }

  private assertStatus(r: RequestRow, to: RequestStatus) {
    if (!canTransition(r.status as RequestStatus, to)) throw Err.invalidState(r.status, OPEN_STATUSES.filter((s) => canTransition(s, to)), `Request ${r.number}`);
  }

  private assertNotHeld(r: RequestRow) {
    if (r.flagged && r.flagStatus === 'PENDING') throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'This request is held by the content screen. A manager must clear it first.', { status: 'HELD', allowed: ['CLEAR', 'DECLINE'] });
  }

  update(u: AuthUser, id: string, dto: { preferredStart?: string | null; preferredEnd?: string | null; partySize?: number | null; hours?: number | null; notes?: string | null; internalNotes?: string | null; contactPreference?: string; discreet?: boolean }, ip?: string) {
    return this.write(u, id, async (tx, r) => {
      this.assertActable(u, r);
      if ((FINAL_STATUSES as readonly string[]).includes(r.status)) throw Err.invalidState(r.status, [...OPEN_STATUSES], `Request ${r.number}`);
      if (dto.discreet === false && r.discreet) assertCan(u, 'concierge.discreet');
      if (dto.discreet === true && !r.discreet) assertCan(u, 'concierge.discreet', 'Only the concierge team can make a request private');
      const hit = screen([dto.notes, dto.internalNotes]);
      await tx.conciergeRequest.update({
        where: { id },
        data: {
          ...(dto.preferredStart !== undefined && { preferredStart: dto.preferredStart ? new Date(dto.preferredStart) : null }),
          ...(dto.preferredEnd !== undefined && { preferredEnd: dto.preferredEnd ? new Date(dto.preferredEnd) : null }),
          ...(dto.partySize !== undefined && { partySize: dto.partySize }),
          ...(dto.hours !== undefined && { hours: dto.hours }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
          ...(dto.internalNotes !== undefined && { internalNotes: dto.internalNotes }),
          ...(dto.contactPreference !== undefined && { contactPreference: dto.contactPreference }),
          ...(dto.discreet !== undefined && { discreet: dto.discreet }),
          ...(hit.flagged && !r.flagged && { flagged: true, flagTerms: hit.terms, flagCategories: hit.categories, flagStatus: 'PENDING' }),
          timeline: [...timelineOf(r), this.event('updated', null, `Changed: ${Object.keys(dto).join(', ')}`, u.fullName, false)] as Prisma.InputJsonValue,
        },
      });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'concierge_request.updated', entityType: 'concierge_request', entityId: id, metadata: { number: r.number, changes: Object.keys(dto) }, ip });
      await this.emit(tx, await tx.conciergeRequest.findUniqueOrThrow({ where: { id } }), 'concierge.request_updated');
    });
  }

  quote(u: AuthUser, id: string, dto: { amountKobo: number; taxable?: boolean; validHours?: number; validUntil?: string; note?: string; notify?: boolean }, ip?: string) {
    return this.write(u, id, async (tx, r) => {
      this.assertActable(u, r);
      this.assertNotHeld(r);
      this.core.assertNotSuspended(await this.core.accountTx(tx, u.tenantId));
      if (!['NEW', 'QUOTED', 'AWAITING_GUEST'].includes(r.status) || r.paymentStatus === 'PAID') throw Err.invalidState(r.status, ['NEW', 'QUOTED', 'AWAITING_GUEST'], `Request ${r.number}`);
      if (!Number.isInteger(dto.amountKobo) || dto.amountKobo <= 0 || dto.amountKobo > 1_000_000_000) throw Err.validation('amountKobo', 'Give a price between ₦0.01 and ₦10,000,000');
      const settings = await this.core.settingsTx(tx, u.tenantId, r.propertyId);
      const now = new Date();
      const validUntil = dto.validUntil ? new Date(dto.validUntil) : new Date(now.getTime() + (dto.validHours ?? settings.quoteValidityHours) * 3_600_000);
      if (Number.isNaN(validUntil.getTime()) || validUntil <= now || validUntil.getTime() > now.getTime() + 7 * 86_400_000) throw Err.validation('validUntil', 'A quote is valid for 1 hour to 7 days');
      if (dto.note) {
        const hit = screen([dto.note]);
        if (hit.flagged) throw Err.validation('note', `"${hit.terms[0]}" is not allowed (acceptable-use policy)`);
      }
      const comps = componentsFrom(await this.taxes.forProperty(tx, u.tenantId, r.propertyId));
      const svc = r.serviceId ? await tx.conciergeService.findFirst({ where: { id: r.serviceId }, select: { taxable: true } }) : null;
      const taxable = dto.taxable ?? svc?.taxable ?? true;
      const q = quotePrice(dto.amountKobo, taxable, comps, r.serviceName);
      const channel = await this.notifier.channelFor(tx, u.tenantId, r.contactPreference);
      await tx.conciergePayment.updateMany({ where: { requestId: r.id, status: 'INITIALIZED' }, data: { status: 'FAILED' } });
      const updated = await tx.conciergeRequest.update({
        where: { id },
        data: {
          status: 'QUOTED',
          quoteVersion: r.quoteVersion + 1,
          quoteAmountKobo: q.amountKobo,
          quoteNetKobo: q.netKobo,
          quoteTaxKobo: q.taxKobo,
          quoteTaxes: q.taxes as unknown as Prisma.InputJsonValue,
          quoteValidUntil: validUntil,
          quoteNote: dto.note ?? null,
          quoteSentAt: now,
          quoteSentById: u.userId,
          quoteSentByName: u.fullName,
          quoteChannel: channel,
          quoteAnswer: null,
          quoteAnsweredAt: null,
          quoteAnsweredVia: null,
          taxComponents: (taxable ? comps : []) as unknown as Prisma.InputJsonValue,
          paymentMethod: null,
          paymentStatus: 'NONE',
          paymentReference: null,
          firstResponseAt: r.firstResponseAt ?? now,
          timeline: [...timelineOf(r), this.event('quote_sent', 'QUOTED', `Your price: ${nairaText(q.totalKobo)}, held until ${humanDateTime(validUntil)}`, u.fullName, true, now)] as Prisma.InputJsonValue,
        },
        include: requestInclude,
      });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'concierge_request.quoted', entityType: 'concierge_request', entityId: id, metadata: { number: r.number, totalKobo: q.totalKobo, version: updated.quoteVersion }, ip });
      await this.emit(tx, updated, 'concierge.request_updated');
      const ids = dto.notify === false ? [] : await this.guestMessages(tx, updated, { template: 'CONCIERGE_QUOTE', validUntilHuman: humanDateTime(validUntil) });
      return { ids };
    });
  }

  /**
   * Accepts the open quote (link, trip page, WhatsApp YES, staff). FOLIO
   * confirms at once; ONLINE waits for the payment (AWAITING_GUEST).
   */
  async acceptTx(tx: Tx, r: RequestRow, input: { version: number | null; via: 'LINK' | 'WHATSAPP' | 'TRIP_PAGE' | 'STAFF'; paymentMethod: 'ONLINE' | 'FOLIO' | 'NONE'; email?: string | null; by: string }, now = new Date()): Promise<{ ids: string[]; paymentId: string | null }> {
    if (r.status !== 'QUOTED') throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', r.quoteAnswer ? 'This quote has already been answered' : `Request ${r.number} has no open quote`, { status: r.status, allowed: ['QUOTED'] });
    if (input.version !== null && input.version !== r.quoteVersion) throw appError(HttpStatus.GONE, 'QUOTE_EXPIRED', 'This price has been replaced by a newer one. Open the latest link.', { expiredAt: r.quoteSentAt?.toISOString() ?? null, state: 'REPLACED' });
    if (r.quoteValidUntil && r.quoteValidUntil < now) throw appError(HttpStatus.GONE, 'QUOTE_EXPIRED', 'This price has expired. Ask the hotel for a new one.', { expiredAt: r.quoteValidUntil.toISOString(), state: 'EXPIRED' });
    const settings = await this.core.settingsTx(tx, r.tenantId, r.propertyId);
    const answered = { quoteAnswer: 'ACCEPTED', quoteAnsweredAt: now, quoteAnsweredVia: input.via };
    if (input.paymentMethod === 'FOLIO') {
      if (!settings.payFolio || r.reservation?.folio?.status !== 'OPEN') throw appError(HttpStatus.CONFLICT, 'FOLIO_UNAVAILABLE', 'This cannot be added to your bill right now. Please pay online or call the hotel.');
      const updated = await tx.conciergeRequest.update({
        where: { id: r.id },
        data: { ...answered, status: 'CONFIRMED', paymentMethod: 'FOLIO', timeline: [...timelineOf(r), this.event('quote_accepted', 'CONFIRMED', 'Added to your bill', input.by, true, now)] as Prisma.InputJsonValue },
        include: requestInclude,
      });
      await this.emit(tx, updated, 'concierge.request_updated');
      return { ids: await this.guestMessages(tx, updated, { template: 'CONCIERGE_CONFIRMED' }), paymentId: null };
    }
    if (input.paymentMethod === 'NONE') {
      const updated = await tx.conciergeRequest.update({
        where: { id: r.id },
        data: { ...answered, status: 'CONFIRMED', paymentMethod: 'NONE', timeline: [...timelineOf(r), this.event('quote_accepted', 'CONFIRMED', null, input.by, true, now)] as Prisma.InputJsonValue },
        include: requestInclude,
      });
      return { ids: await this.guestMessages(tx, updated, { template: 'CONCIERGE_CONFIRMED' }), paymentId: null };
    }
    const pay = await this.payments.createTx(tx, r, input.email ?? null);
    const updated = await tx.conciergeRequest.update({
      where: { id: r.id },
      data: { ...answered, status: 'AWAITING_GUEST', timeline: [...timelineOf(r), this.event('quote_accepted', 'AWAITING_GUEST', 'Pay online to confirm', input.by, true, now)] as Prisma.InputJsonValue },
      include: requestInclude,
    });
    await this.emit(tx, updated, 'concierge.request_updated');
    return { ids: [], paymentId: pay.id };
  }

  async declineQuoteTx(tx: Tx, r: RequestRow, input: { version: number | null; via: 'LINK' | 'WHATSAPP' | 'TRIP_PAGE' | 'STAFF'; reason?: string | null; by: string }, now = new Date()) {
    if (r.status !== 'QUOTED') throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'This quote has already been answered', { status: r.status, allowed: ['QUOTED'] });
    if (input.version !== null && input.version !== r.quoteVersion) throw appError(HttpStatus.GONE, 'QUOTE_EXPIRED', 'This price has been replaced by a newer one.', { expiredAt: r.quoteSentAt?.toISOString() ?? null, state: 'REPLACED' });
    const updated = await tx.conciergeRequest.update({
      where: { id: r.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: now,
        cancelReason: input.reason?.trim() || 'You declined the quote',
        quoteAnswer: 'DECLINED',
        quoteAnsweredAt: now,
        quoteAnsweredVia: input.via,
        timeline: [...timelineOf(r), this.event('quote_declined', 'CANCELLED', 'You declined the quote', input.by, true, now)] as Prisma.InputJsonValue,
      },
      include: requestInclude,
    });
    await this.audit.record(tx, { tenantId: r.tenantId, actor: { kind: 'system', name: 'Guest' }, action: 'concierge_request.quote_declined', entityType: 'concierge_request', entityId: r.id, propertyId: r.propertyId, metadata: { number: r.number, via: input.via } });
    await this.emit(tx, updated, 'concierge.request_updated');
    return updated;
  }

  confirm(u: AuthUser, id: string, dto: { paymentMethod: 'ONLINE' | 'FOLIO' | 'NONE'; note?: string }, ip?: string) {
    return this.write(u, id, async (tx, r) => {
      this.assertActable(u, r);
      this.assertNotHeld(r);
      const now = new Date();
      if (r.status === 'QUOTED') {
        const res = await this.acceptTx(tx, r, { version: null, via: 'STAFF', paymentMethod: dto.paymentMethod, by: u.fullName }, now);
        await tx.conciergeRequest.update({ where: { id }, data: { firstResponseAt: r.firstResponseAt ?? now } });
        await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'concierge_request.confirmed', entityType: 'concierge_request', entityId: id, metadata: { number: r.number, paymentMethod: dto.paymentMethod }, ip });
        return res;
      }
      const reopen = r.status === 'CONFIRMED' && dto.paymentMethod === 'ONLINE' && r.paymentStatus === 'NONE';
      if (!['NEW', 'AWAITING_GUEST'].includes(r.status) && !reopen) throw Err.invalidState(r.status, ['NEW', 'QUOTED', 'AWAITING_GUEST'], `Request ${r.number}`);
      const charge = chargeOf(r);
      if (dto.paymentMethod === 'NONE' && charge && charge.totalKobo > 0) throw Err.validation('paymentMethod', 'This request has a price: choose online payment or the folio');
      if (dto.paymentMethod !== 'NONE' && !charge) throw Err.validation('paymentMethod', 'Send a quote first');
      if (dto.paymentMethod === 'FOLIO') {
        const settings = await this.core.settingsTx(tx, u.tenantId, r.propertyId);
        if (!settings.payFolio || r.reservation?.folio?.status !== 'OPEN') throw appError(HttpStatus.CONFLICT, 'FOLIO_UNAVAILABLE', 'The guest has no open folio. Send a payment link instead.');
      }
      let paymentId: string | null = null;
      let status: RequestStatus = 'CONFIRMED';
      if (dto.paymentMethod === 'ONLINE') {
        paymentId = (await this.payments.createTx(tx, r, null)).id;
        status = 'AWAITING_GUEST';
      }
      const updated = await tx.conciergeRequest.update({
        where: { id },
        data: {
          status,
          ...(dto.paymentMethod !== 'ONLINE' && { paymentMethod: dto.paymentMethod }),
          firstResponseAt: r.firstResponseAt ?? now,
          timeline: [...timelineOf(r), this.event('status', status, dto.note ?? (status === 'AWAITING_GUEST' ? 'Pay online to confirm' : null), u.fullName, true, now)] as Prisma.InputJsonValue,
        },
        include: requestInclude,
      });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'concierge_request.confirmed', entityType: 'concierge_request', entityId: id, metadata: { number: r.number, paymentMethod: dto.paymentMethod }, ip });
      await this.emit(tx, updated, 'concierge.request_updated');
      const ids = status === 'CONFIRMED' ? await this.guestMessages(tx, updated, { template: 'CONCIERGE_CONFIRMED' }) : await this.guestMessages(tx, updated, { template: 'CONCIERGE_UPDATE', update: 'Pay online to confirm your request.' });
      return { ids, paymentId };
    });
  }

  private async assigneeTx(tx: Tx, tenantId: string, propertyId: string, userId: string, discreet: boolean) {
    const user = await tx.user.findFirst({ where: { id: userId, tenantId, isActive: true }, include: { customRole: { select: { permissions: true } }, propertyAccess: { select: { propertyId: true } } } });
    if (!user) throw Err.validation('assigneeId', 'Choose an active member of staff');
    const perms = permissionsFor(user.role, user.customRole?.permissions);
    if (!perms.has('concierge.work')) throw Err.validation('assigneeId', `${user.fullName} cannot work concierge requests`);
    if (discreet && !perms.has('concierge.discreet')) throw Err.validation('assigneeId', `${user.fullName} cannot see private requests`);
    const all = user.role === 'OWNER' || user.allProperties !== false;
    if (!all && !user.propertyAccess.some((a) => a.propertyId === propertyId)) throw Err.validation('assigneeId', `${user.fullName} does not work at this property`);
    return user;
  }

  assign(u: AuthUser, id: string, dto: { assigneeId?: string | null; vendorId?: string | null }, ip?: string) {
    return this.write(u, id, async (tx, r) => {
      this.assertActable(u, r);
      if ((FINAL_STATUSES as readonly string[]).includes(r.status)) throw Err.invalidState(r.status, [...OPEN_STATUSES], `Request ${r.number}`);
      const data: Prisma.ConciergeRequestUpdateInput = {};
      const notes: string[] = [];
      if (dto.assigneeId !== undefined) {
        if (dto.assigneeId === null) {
          Object.assign(data, { assigneeId: null, assigneeName: null });
          notes.push('Unassigned');
        } else {
          const a = await this.assigneeTx(tx, u.tenantId, r.propertyId, dto.assigneeId, r.discreet);
          Object.assign(data, { assigneeId: a.id, assigneeName: a.fullName });
          notes.push(`Assigned to ${a.fullName}`);
        }
      }
      if (dto.vendorId !== undefined) {
        if (dto.vendorId === null) {
          Object.assign(data, { vendor: { disconnect: true }, vendorName: null, commissionType: null, commissionValue: null });
          notes.push('Vendor removed');
        } else {
          this.assertNotHeld(r);
          const v = await tx.conciergeVendor.findFirst({ where: { id: dto.vendorId, tenantId: u.tenantId, propertyId: r.propertyId, active: true } });
          if (!v) throw Err.validation('vendorId', 'This vendor is not in the directory');
          const ent = await this.core.entitlements.getEntitlements(u.tenantId, tx);
          const tracked = ent.features.includes('concierge_vendors') && v.commissionType !== 'NONE';
          Object.assign(data, { vendor: { connect: { id: v.id } }, vendorName: v.name, commissionType: tracked ? v.commissionType : null, commissionValue: tracked ? v.commissionValue : null });
          notes.push(`Vendor: ${v.name}`);
        }
      }
      const updated = await tx.conciergeRequest.update({ where: { id }, data: { ...data, timeline: [...timelineOf(r), this.event('assigned', null, notes.join('; '), u.fullName, false)] as Prisma.InputJsonValue } });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'concierge_request.assigned', entityType: 'concierge_request', entityId: id, metadata: { number: r.number, assigneeId: dto.assigneeId ?? undefined, vendorId: dto.vendorId ?? undefined }, ip });
      await this.emit(tx, updated, 'concierge.request_updated');
    });
  }

  async sendToVendor(u: AuthUser, id: string, dto: { channel?: 'WHATSAPP' | 'SMS'; note?: string; includeGuestSurname?: boolean; includeRoom?: boolean }, ip?: string) {
    let sent: { channel: string; to: string; status: string } | null = null;
    const d = await this.write(u, id, async (tx, r) => {
      this.assertActable(u, r);
      this.assertNotHeld(r);
      if (!r.vendorId) throw Err.validation('vendorId', 'Assign a vendor first');
      if ((FINAL_STATUSES as readonly string[]).includes(r.status)) throw Err.invalidState(r.status, [...OPEN_STATUSES], `Request ${r.number}`);
      const v = await tx.conciergeVendor.findFirstOrThrow({ where: { id: r.vendorId } });
      const channel = dto.channel ?? (v.whatsapp ? 'WHATSAPP' : 'SMS');
      const to = channel === 'WHATSAPP' ? (v.whatsapp ?? v.phone) : (v.phone ?? v.whatsapp);
      if (!to) throw Err.validation('channel', `${v.name} has no phone number in the directory`);
      if (dto.note) {
        const hit = screen([dto.note]);
        if (hit.flagged) throw Err.validation('note', `"${hit.terms[0]}" is not allowed (acceptable-use policy)`);
      }
      const settings = await this.core.settingsTx(tx, u.tenantId, r.propertyId);
      const property = await this.property(tx, r);
      const surname = !!dto.includeGuestSurname && settings.vendorShareSurname;
      const room = !!dto.includeRoom && settings.vendorShareRoom && r.reservation?.room?.number;
      const where =
        r.location === 'IN_ROOM'
          ? room ? `Room ${r.reservation!.room!.number}, ${property.name}` : `at ${property.name} (the front desk will take you up)`
          : r.location === 'OFF_PROPERTY' ? 'as agreed with the hotel' : `at ${property.name}`;
      const when = r.scheduledAt ?? r.preferredStart;
      const job = {
        hotelName: property.name,
        service: r.variantName ? `${r.serviceName}, ${r.variantName}` : r.serviceId ? r.serviceName : (r.requestText ?? 'Guest request').slice(0, 120),
        number: r.number,
        whenHuman: when ? humanDateTime(when) : 'to be agreed',
        partySize: String(r.partySize ?? 1),
        guest: surname ? r.guest.fullName : firstName(r.guest.fullName),
        where,
        notes: dto.note?.trim() || '-',
        contactName: u.fullName,
        contactPhone: property.phone || '-',
      };
      const msg = this.notifier.vendorJob(u.tenantId, property, job, to, channel, r.id);
      const ids = await this.notifications.queueTx(tx, [msg]);
      const now = new Date();
      await tx.conciergeRequest.update({
        where: { id },
        data: { vendorSentAt: now, vendorSentVia: channel, timeline: [...timelineOf(r), this.event('vendor_sent', null, `Job sent to ${v.name} by ${channel === 'WHATSAPP' ? 'WhatsApp' : 'SMS'}`, u.fullName, false, now)] as Prisma.InputJsonValue },
      });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'concierge_request.sent_to_vendor', entityType: 'concierge_request', entityId: id, metadata: { number: r.number, vendor: v.name, channel, surname, room: !!room }, ip });
      sent = { channel, to, status: 'QUEUED' };
      return { ids };
    });
    return { ...d, sent: sent! };
  }

  status(u: AuthUser, id: string, dto: { status: RequestStatus; note?: string; scheduledAt?: string; notifyGuest?: boolean; vendorRating?: number; clientCreatedAt?: string }, ip?: string) {
    const clientAt = parseClientCreatedAt(dto.clientCreatedAt);
    let refund: { reference: string; amountKobo: number } | null = null;
    return this.write(u, id, async (tx, r) => {
      this.assertActable(u, r, { assigneeProgress: dto.status === 'IN_PROGRESS' || dto.status === 'COMPLETED' });
      const to = dto.status;
      if (r.flagged && r.flagStatus === 'PENDING' && to !== 'DECLINED' && to !== 'CANCELLED') this.assertNotHeld(r);
      if (to === 'CONFIRMED') {
        if (!r.paymentMethod && (chargeOf(r)?.totalKobo ?? 0) > 0) throw Err.validation('status', 'Choose how the guest pays first (POST /confirm)');
      }
      this.assertStatus(r, to);
      if ((to === 'DECLINED' || to === 'CANCELLED') && !dto.note?.trim()) throw Err.validation('note', 'Give the reason (the guest sees it)');
      const now = clientAt ?? new Date();
      const data: Prisma.ConciergeRequestUpdateInput = { status: to, firstResponseAt: r.firstResponseAt ?? now };
      let guestNote: string | null = dto.note?.trim() || null;
      if (to === 'SCHEDULED') {
        const at = dto.scheduledAt ? new Date(dto.scheduledAt) : (r.preferredStart ?? null);
        if (at && Number.isNaN(at.getTime())) throw Err.validation('scheduledAt', 'Give a date and time');
        data.scheduledAt = at;
        guestNote = guestNote ?? (at ? `Booked in for ${humanDateTime(at)}` : 'Booked in');
      }
      if (to === 'IN_PROGRESS') data.startedAt = now;
      if (to === 'DECLINED') data.declineReason = dto.note!.trim();
      if (to === 'CANCELLED') {
        data.cancelReason = dto.note!.trim();
        data.cancelledAt = now;
      }
      if (to === 'COMPLETED') {
        data.completedAt = now;
        if (dto.vendorRating !== undefined) {
          if (!r.vendorId) throw Err.validation('vendorRating', 'There is no vendor to rate');
          data.vendorRating = dto.vendorRating;
          await tx.conciergeVendor.update({ where: { id: r.vendorId }, data: { ratingSum: { increment: dto.vendorRating }, ratingCount: { increment: 1 } } });
        }
        const charge = chargeOf(r);
        const settings = await this.core.settingsTx(tx, u.tenantId, r.propertyId);
        if (r.paymentMethod === 'FOLIO' && charge && charge.amountKobo > 0 && !r.folioEntryId) {
          const folioId = r.reservation?.folio?.status === 'OPEN' ? r.reservation.folio.id : null;
          if (!folioId) throw appError(HttpStatus.CONFLICT, 'FOLIO_UNAVAILABLE', "The guest's folio is closed. Send a payment link instead (confirm with ONLINE).");
          const description = folioDescription(r, { inRoom: settings.folioLabelInRoom, other: settings.folioLabelOther });
          const folio = await this.docs.loadFolio(tx, u.tenantId, folioId);
          const entry = await this.ledger.postExtra(tx, u.tenantId, folio, { description, enteredKobo: charge.amountKobo, comps: (r.taxComponents as unknown as TaxComponent[]) ?? [], clientCreatedAt: clientAt }, actorOf(u));
          Object.assign(data, { folioId, folioEntryId: entry.id, postedAt: now, folioDescription: description, paymentStatus: 'POSTED' });
        }
        const ent = await this.core.entitlements.getEntitlements(u.tenantId, tx);
        const c = ent.features.includes('concierge_vendors') && r.vendorId ? commissionOf(r.commissionType, r.commissionValue, charge?.netKobo ?? 0) : null;
        if (c) Object.assign(data, c);
      }
      if (to === 'CANCELLED' || to === 'DECLINED') {
        if (r.paymentStatus === 'PAID' && r.paymentReference) {
          assertCan(u, 'folio.refund', 'Refunding an online payment needs the folio.refund permission');
          const pay = await tx.conciergePayment.findUnique({ where: { reference: r.paymentReference } });
          if (pay) {
            if (r.folioId && r.folioEntryId) {
              const folio = await tx.folio.findFirst({ where: { id: r.folioId } });
              if (folio?.status === 'OPEN') {
                await this.ledger.voidChargeTx(tx, u.tenantId, folio.id, r.folioEntryId, actorOf(u), `Concierge ${r.number} cancelled`);
                await this.ledger.postOnlineRefund(tx, u.tenantId, folio, { amountKobo: pay.amountKobo, reference: pay.reference, reason: `Concierge ${r.number} cancelled` }, actorOf(u));
              }
            }
            data.paymentStatus = 'REFUNDED';
            refund = { reference: pay.reference, amountKobo: pay.amountKobo };
          }
        }
        await tx.conciergePayment.updateMany({ where: { requestId: r.id, status: 'INITIALIZED' }, data: { status: 'FAILED' } });
      }
      data.timeline = [...timelineOf(r), this.event('status', to, guestNote, u.fullName, true, now)] as Prisma.InputJsonValue;
      const updated = await tx.conciergeRequest.update({ where: { id }, data, include: requestInclude });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: `concierge_request.${to.toLowerCase()}`, entityType: 'concierge_request', entityId: id, metadata: { number: r.number, from: r.status, to, clientCreatedAt: clientAt?.toISOString() ?? null }, ip });
      await this.emit(tx, updated, 'concierge.request_updated');
      const notify = dto.notifyGuest ?? ['SCHEDULED', 'DECLINED', 'CANCELLED', 'COMPLETED'].includes(to);
      let ids: string[] = [];
      if (notify) {
        if (to === 'COMPLETED') ids = await this.guestMessages(tx, updated, { template: 'CONCIERGE_COMPLETED' });
        else if (to === 'CONFIRMED') ids = await this.guestMessages(tx, updated, { template: 'CONCIERGE_CONFIRMED' });
        else {
          const update =
            to === 'DECLINED' ? (r.flagged ? "We're sorry, we can't arrange this request." : `We're sorry, we can't arrange this: ${dto.note!.trim()}`)
              : to === 'CANCELLED' ? `Your request has been cancelled: ${dto.note!.trim()}${refund ? ' Your payment will be refunded in full.' : ''}`
                : to === 'IN_PROGRESS' ? 'Your request is under way.'
                  : (guestNote ?? 'Your request is booked in.');
          ids = await this.guestMessages(tx, updated, { template: 'CONCIERGE_UPDATE', update });
        }
      }
      return {
        ids,
        after: async () => {
          if (refund) await this.payments.refundProvider(refund.reference, refund.amountKobo, `Concierge ${r.number} cancelled`);
        },
      };
    });
  }

  note(u: AuthUser, id: string, note: string, ip?: string) {
    return this.write(u, id, async (tx, r) => {
      this.assertActable(u, r);
      await tx.conciergeRequest.update({ where: { id }, data: { timeline: [...timelineOf(r), this.event('note', null, note.trim(), u.fullName, false)] as Prisma.InputJsonValue } });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'concierge_request.noted', entityType: 'concierge_request', entityId: id, metadata: { number: r.number }, ip });
    });
  }

  flagReview(u: AuthUser, id: string, dto: { decision: 'CLEAR' | 'DECLINE'; note: string }, ip?: string) {
    return this.write(u, id, async (tx, r) => {
      this.assertActable(u, r);
      if (!r.flagged || r.flagStatus !== 'PENDING') throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'This request is not waiting for review', { status: r.flagStatus ?? 'NONE', allowed: ['PENDING'] });
      const now = new Date();
      const review = { flagStatus: dto.decision === 'CLEAR' ? 'CLEARED' : 'DECLINED', flagNote: dto.note.trim(), flagReviewedById: u.userId, flagReviewedByName: u.fullName, flagReviewedAt: now, firstResponseAt: r.firstResponseAt ?? now };
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: dto.decision === 'CLEAR' ? 'concierge_request.flag_cleared' : 'concierge_request.flag_declined', entityType: 'concierge_request', entityId: id, metadata: { number: r.number, terms: r.flagTerms }, ip });
      if (dto.decision === 'DECLINE') {
        if (!canTransition(r.status as RequestStatus, 'DECLINED')) throw Err.invalidState(r.status, ['NEW'], `Request ${r.number}`);
        const updated = await tx.conciergeRequest.update({
          where: { id },
          data: { ...review, status: 'DECLINED', declineReason: 'Not something we can arrange (acceptable-use policy)', timeline: [...timelineOf(r), this.event('status', 'DECLINED', "We're sorry, we can't arrange this request.", u.fullName, true, now)] as Prisma.InputJsonValue },
          include: requestInclude,
        });
        return { ids: await this.guestMessages(tx, updated, { template: 'CONCIERGE_UPDATE', update: "We're sorry, we can't arrange this request." }) };
      }
      // Cleared: continue as a normal request (automatic confirmation when it applies).
      const charge = chargeOf(r);
      let status: RequestStatus = r.status as RequestStatus;
      let paymentId: string | null = null;
      if (r.status === 'NEW' && r.priceAmountKobo !== null && r.pricing !== 'FROM') {
        const settings = await this.core.settingsTx(tx, u.tenantId, r.propertyId);
        if (!charge || charge.totalKobo === 0) status = 'CONFIRMED';
        else if (settings.payFolio && r.reservation?.folio?.status === 'OPEN') status = 'CONFIRMED';
      }
      const method = status === 'CONFIRMED' ? (!charge || charge.totalKobo === 0 ? 'NONE' : 'FOLIO') : r.paymentMethod;
      const updated = await tx.conciergeRequest.update({
        where: { id },
        data: { ...review, status, paymentMethod: method, timeline: [...timelineOf(r), this.event('flag_cleared', status !== r.status ? status : null, status !== r.status ? null : 'We are arranging your request', u.fullName, status !== r.status)] as Prisma.InputJsonValue },
        include: requestInclude,
      });
      if (status === 'NEW' && charge && charge.totalKobo > 0 && r.pricing !== 'FROM' && r.priceAmountKobo !== null && (await this.payments.availableTx(tx, u.tenantId, r.propertyId)) && (r.contactEmail ?? r.guest.email)) {
        paymentId = (await this.payments.createTx(tx, updated, null)).id;
        await tx.conciergeRequest.update({ where: { id }, data: { status: 'AWAITING_GUEST' } });
        status = 'AWAITING_GUEST';
      }
      await this.emit(tx, updated, 'concierge.request_updated');
      const ids = status === 'CONFIRMED' ? await this.guestMessages(tx, updated, { template: 'CONCIERGE_CONFIRMED' }) : [];
      return { ids, paymentId };
    });
  }

  rateVendor(u: AuthUser, id: string, rating: number, ip?: string) {
    return this.write(u, id, async (tx, r) => {
      this.assertActable(u, r);
      if (r.status !== 'COMPLETED' || !r.vendorId) throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'Rate the vendor after the job is completed', { status: r.status, allowed: ['COMPLETED'] });
      const delta = rating - (r.vendorRating ?? 0);
      await tx.conciergeVendor.update({ where: { id: r.vendorId }, data: { ratingSum: { increment: delta }, ...(r.vendorRating === null && { ratingCount: { increment: 1 } }) } });
      await tx.conciergeRequest.update({ where: { id }, data: { vendorRating: rating } });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'concierge_request.vendor_rated', entityType: 'concierge_request', entityId: id, metadata: { number: r.number, rating }, ip });
    });
  }

  // ---------------------------------------------------------------------------
  // Guest actions (trip page)
  // ---------------------------------------------------------------------------

  /** The guest cancels: free before it is booked in; online payments refunded in full. */
  async guestCancelTx(tx: Tx, r: RequestRow, reason: string | null, now = new Date()): Promise<{ ids: string[]; after: () => Promise<void> }> {
    const ok = ['NEW', 'QUOTED', 'AWAITING_GUEST', 'CONFIRMED'].includes(r.status);
    if (!ok) throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'This request is already booked in. Please call the hotel to change it.', { status: r.status, allowed: ['NEW', 'QUOTED', 'AWAITING_GUEST', 'CONFIRMED'] });
    let refund: { reference: string; amountKobo: number } | null = null;
    const data: Prisma.ConciergeRequestUpdateInput = { status: 'CANCELLED', cancelledAt: now, cancelReason: reason?.trim() || 'Cancelled by the guest' };
    if (r.status === 'QUOTED') Object.assign(data, { quoteAnswer: 'DECLINED', quoteAnsweredAt: now, quoteAnsweredVia: 'TRIP_PAGE' });
    if (r.paymentStatus === 'PAID' && r.paymentReference) {
      const pay = await tx.conciergePayment.findUnique({ where: { reference: r.paymentReference } });
      if (pay) {
        if (r.folioId && r.folioEntryId) {
          const folio = await tx.folio.findFirst({ where: { id: r.folioId } });
          if (folio?.status === 'OPEN') {
            await this.ledger.voidChargeTx(tx, r.tenantId, folio.id, r.folioEntryId, SYSTEM, `Concierge ${r.number} cancelled by the guest`);
            await this.ledger.postOnlineRefund(tx, r.tenantId, folio, { amountKobo: pay.amountKobo, reference: pay.reference, reason: `Concierge ${r.number} cancelled by the guest` }, SYSTEM);
          }
        }
        data.paymentStatus = 'REFUNDED';
        refund = { reference: pay.reference, amountKobo: pay.amountKobo };
      }
    }
    await tx.conciergePayment.updateMany({ where: { requestId: r.id, status: 'INITIALIZED' }, data: { status: 'FAILED' } });
    data.timeline = [...timelineOf(r), this.event('status', 'CANCELLED', refund ? 'You cancelled; your payment will be refunded in full' : 'You cancelled this request', 'Guest', true, now)] as Prisma.InputJsonValue;
    const updated = await tx.conciergeRequest.update({ where: { id: r.id }, data, include: requestInclude });
    await this.audit.record(tx, { tenantId: r.tenantId, actor: { kind: 'system', name: 'Guest' }, action: 'concierge_request.cancelled', entityType: 'concierge_request', entityId: r.id, propertyId: r.propertyId, metadata: { number: r.number, by: 'GUEST', refunded: !!refund } });
    await this.emit(tx, updated, 'concierge.request_updated');
    return {
      ids: [],
      after: async () => {
        if (refund) await this.payments.refundProvider(refund.reference, refund.amountKobo, `Concierge ${r.number} cancelled by the guest`);
      },
    };
  }

  async guestRateTx(tx: Tx, r: RequestRow, rating: number, comment: string | null, now = new Date()) {
    if (r.status !== 'COMPLETED' || !r.completedAt) throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'You can rate a request once it is completed', { status: r.status, allowed: ['COMPLETED'] });
    if (r.rating) throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'You have already rated this request', { status: 'RATED', allowed: [] });
    if (now.getTime() - r.completedAt.getTime() > 30 * 86_400_000) throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'Ratings close 30 days after completion', { status: 'CLOSED', allowed: [] });
    const hit = comment ? screen([comment]) : null;
    await tx.conciergeRequest.update({
      where: { id: r.id },
      data: { rating, ratingComment: comment?.trim() || null, ratedAt: now, timeline: [...timelineOf(r), this.event('rated', null, `Rated ${rating} of 5${hit?.flagged ? ' (comment held)' : ''}`, 'Guest', false, now)] as Prisma.InputJsonValue },
    });
    await this.audit.record(tx, { tenantId: r.tenantId, actor: { kind: 'system', name: 'Guest' }, action: 'concierge_request.rated', entityType: 'concierge_request', entityId: r.id, propertyId: r.propertyId, metadata: { number: r.number, rating } });
  }

  // ---------------------------------------------------------------------------
  // Today card, exports, reports
  // ---------------------------------------------------------------------------

  async todayTx(tx: Tx, u: AuthUser, now = new Date()) {
    const p = await primaryProperty(tx, u.tenantId);
    const v = await this.core.viewer(tx, u, p.id);
    const today = lagosDate(now);
    const rows = await tx.conciergeRequest.findMany({ where: { tenantId: u.tenantId, propertyId: p.id, status: { in: [...OPEN_STATUSES] } }, include: requestInclude, orderBy: { slaDueAt: 'asc' }, take: 300 });
    const isToday = (r: RequestRow) => {
      const at = r.scheduledAt ?? r.preferredStart;
      return !!at && lagosDate(at) === today;
    };
    // A shared screen: private requests are counted, never named (holders too).
    const shared: Viewer = { ...v, holder: false, visibility: 'MASKED' };
    const next = rows
      .filter((r) => !r.discreet || v.holder)
      .slice(0, 5)
      .map((r) => this.core.listItem(r, shared, now));
    return {
      new: rows.filter((r) => r.status === 'NEW').length,
      overdue: rows.filter((r) => slaView(r, now).overdue).length,
      quoted: rows.filter((r) => r.status === 'QUOTED' || r.status === 'AWAITING_GUEST').length,
      today: rows.filter((r) => isToday(r) && ['CONFIRMED', 'SCHEDULED', 'IN_PROGRESS'].includes(r.status)).length,
      inProgress: rows.filter((r) => r.status === 'IN_PROGRESS').length,
      flagged: rows.filter((r) => r.flagged && r.flagStatus === 'PENDING').length,
      discreet: rows.filter((r) => r.discreet).length,
      next,
    };
  }

  today(u: AuthUser) {
    return this.db.tenant(u.tenantId, (tx) => this.todayTx(tx, u));
  }

  async export(u: AuthUser, q: { from: string; to: string; format?: 'csv' | 'json' }, ip?: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const p = await primaryProperty(tx, u.tenantId);
      const holder = can(u, 'concierge.discreet');
      const rows = await tx.conciergeRequest.findMany({
        where: { tenantId: u.tenantId, propertyId: p.id, createdAt: { gte: lagosStartOfDay(q.from), lt: lagosStartOfDay(addDays(q.to, 1)) }, ...(!holder && { discreet: false }) },
        include: requestInclude,
        orderBy: { createdAt: 'asc' },
      });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'concierge.exported', entityType: 'concierge', entityId: null, metadata: { from: q.from, to: q.to, count: rows.length, includesDiscreet: holder && rows.some((r) => r.discreet) }, ip });
      const data = rows.map((r) => {
        const charge = chargeOf(r);
        return {
          number: r.number,
          created: r.createdAt.toISOString(),
          status: r.status,
          source: r.source,
          service: r.serviceId ? r.serviceName : 'Something else',
          category: categoryLabel(r.category),
          private: r.discreet ? 'yes' : 'no',
          guest: r.guest.fullName,
          room: r.reservation?.room?.number ?? '',
          reservation: r.reservation?.code ?? '',
          partySize: r.partySize ?? '',
          preferredStart: r.preferredStart?.toISOString() ?? '',
          totalKobo: charge?.totalKobo ?? '',
          payment: [r.paymentMethod, r.paymentStatus].filter(Boolean).join(' '),
          vendor: r.vendorName ?? '',
          commissionKobo: r.commissionKobo ?? '',
          assignee: r.assigneeName ?? '',
          firstResponseMinutes: r.firstResponseAt ? Math.round((r.firstResponseAt.getTime() - r.createdAt.getTime()) / 60_000) : '',
          completed: r.completedAt?.toISOString() ?? '',
          rating: r.rating ?? '',
        };
      });
      const filename = `concierge-${q.from}-to-${q.to}.${q.format === 'json' ? 'json' : 'csv'}`;
      if (q.format === 'json') return { filename, contentType: 'application/json', body: JSON.stringify({ from: q.from, to: q.to, items: data }) };
      const cols = Object.keys(data[0] ?? { number: '' });
      const csv = `﻿${[cols.join(','), ...data.map((d) => cols.map((c) => csvCell(String((d as Record<string, string | number>)[c] ?? ''))).join(','))].join('\r\n')}\r\n`;
      return { filename, contentType: 'text/csv; charset=utf-8', body: csv };
    });
  }

  reports(u: AuthUser, q: { from?: string; to?: string }) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const p = await primaryProperty(tx, u.tenantId);
      const to = q.to ?? lagosDate();
      const from = q.from ?? addDays(to, -29);
      const rows = await tx.conciergeRequest.findMany({ where: { tenantId: u.tenantId, propertyId: p.id, createdAt: { gte: lagosStartOfDay(from), lt: lagosStartOfDay(addDays(to, 1)) } }, orderBy: { createdAt: 'asc' } });
      const ent = await this.core.entitlements.getEntitlements(u.tenantId, tx);
      const vendorsFeature = ent.features.includes('concierge_vendors');
      const byCat = new Map<string, { requests: number; completed: number; revenueNetKobo: number }>();
      let net = 0;
      let tax = 0;
      let online = 0;
      let folio = 0;
      const responses: number[] = [];
      let within = 0;
      let answered = 0;
      const dist: Record<'1' | '2' | '3' | '4' | '5', number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
      const vendors = new Map<string, { name: string; jobs: number; netKobo: number; commissionKobo: number; payableKobo: number; settledKobo: number; ratingSum: number; ratingCount: number }>();
      const byDay = new Map<string, { requests: number; completed: number }>();
      for (const r of rows) {
        const c = byCat.get(r.category) ?? { requests: 0, completed: 0, revenueNetKobo: 0 };
        c.requests++;
        const day = lagosDate(r.createdAt);
        const d = byDay.get(day) ?? { requests: 0, completed: 0 };
        d.requests++;
        const charge = chargeOf(r);
        const earned = r.status === 'COMPLETED' || r.paymentStatus === 'PAID' || r.paymentStatus === 'POSTED';
        if (r.status === 'COMPLETED') {
          c.completed++;
          d.completed++;
        }
        if (earned && charge && r.paymentStatus !== 'REFUNDED') {
          c.revenueNetKobo += charge.netKobo;
          net += charge.netKobo;
          tax += charge.taxKobo;
          if (r.paymentMethod === 'ONLINE') online += charge.totalKobo;
          if (r.paymentMethod === 'FOLIO') folio += charge.totalKobo;
        }
        byCat.set(r.category, c);
        byDay.set(day, d);
        if (r.firstResponseAt) {
          const m = (r.firstResponseAt.getTime() - r.createdAt.getTime()) / 60_000;
          responses.push(m);
          answered++;
          if (r.firstResponseAt <= r.slaDueAt) within++;
        }
        if (r.rating) dist[String(r.rating) as '1'] = (dist[String(r.rating) as '1'] ?? 0) + 1;
        if (r.vendorId) {
          const v = vendors.get(r.vendorId) ?? { name: r.vendorName ?? '', jobs: 0, netKobo: 0, commissionKobo: 0, payableKobo: 0, settledKobo: 0, ratingSum: 0, ratingCount: 0 };
          v.jobs++;
          if (r.status === 'COMPLETED') {
            v.netKobo += charge?.netKobo ?? 0;
            v.commissionKobo += r.commissionKobo ?? 0;
            v.payableKobo += r.vendorPayableKobo ?? 0;
            if (r.vendorSettledAt) v.settledKobo += r.vendorPayableKobo ?? 0;
          }
          if (r.vendorRating) {
            v.ratingSum += r.vendorRating;
            v.ratingCount++;
          }
          vendors.set(r.vendorId, v);
        }
      }
      const sorted = [...responses].sort((a, b) => a - b);
      const pct = (x: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(x * sorted.length))]!) : null);
      const ratings = rows.filter((r) => r.rating).map((r) => r.rating!);
      const now = new Date();
      return {
        range: { from, to },
        totals: {
          requests: rows.length,
          completed: rows.filter((r) => r.status === 'COMPLETED').length,
          declined: rows.filter((r) => r.status === 'DECLINED').length,
          cancelled: rows.filter((r) => r.status === 'CANCELLED').length,
          flagged: rows.filter((r) => r.flagged).length,
          discreet: rows.filter((r) => r.discreet).length,
        },
        byCategory: [...byCat.entries()].map(([category, v]) => ({ category, label: categoryLabel(category), ...v })).sort((a, b) => b.requests - a.requests),
        responseTimes: {
          medianMinutes: pct(0.5),
          p90Minutes: pct(0.9),
          withinSlaPct: answered ? Math.round((within / answered) * 1000) / 10 : null,
          overdueNow: await tx.conciergeRequest.count({ where: { tenantId: u.tenantId, propertyId: p.id, firstResponseAt: null, slaDueAt: { lt: now }, status: { notIn: [...FINAL_STATUSES] } } }),
          escalated: rows.filter((r) => r.escalatedAt).length,
        },
        revenue: { netKobo: net, taxKobo: tax, totalKobo: net + tax, online, folio },
        vendorCommission: vendorsFeature ? [...vendors.entries()].map(([vendorId, v]) => ({ vendorId, name: v.name, jobs: v.jobs, netKobo: v.netKobo, commissionKobo: v.commissionKobo, payableKobo: v.payableKobo, settledKobo: v.settledKobo })) : null,
        ratings: { average: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100 : null, count: ratings.length, distribution: dist },
        vendorRatings: [...vendors.entries()].map(([vendorId, v]) => ({ vendorId, name: v.name, average: v.ratingCount ? Math.round((v.ratingSum / v.ratingCount) * 100) / 100 : null, count: v.ratingCount })),
        byDay: [...byDay.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date)),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // WhatsApp YES / NO
  // ---------------------------------------------------------------------------

  /**
   * A guest's WhatsApp message: when it is a YES / NO and the phone has an
   * open quote sent on WhatsApp, answer it and reply. Returns null when the
   * message is not for the concierge (it then goes to the inbox).
   */
  async handleWhatsAppReply(digits: string, text: string, now = new Date()): Promise<{ tenantId: string; reply: string } | null> {
    const parsed = parseQuoteReply(text);
    if (!parsed) return null;
    const phone = `+${digits.replace(/\D/g, '')}`;
    const open = (
      await this.db.systemAll((tx, t) =>
        tx.conciergeRequest.findMany({ where: { ...t.tenants, status: 'QUOTED', quoteChannel: 'WHATSAPP', contactPhone: phone, quoteValidUntil: { gt: now } }, select: { id: true, tenantId: true, seq: true, number: true, quoteSentAt: true }, orderBy: { quoteSentAt: 'desc' } }),
      )
    ).flat();
    if (!open.length) return null;
    let target = open[0]!;
    if (parsed.seq !== null) {
      const m = open.find((o) => o.seq === parsed.seq);
      if (!m) return { tenantId: open[0]!.tenantId, reply: `We could not find an open price for request ${formatNumber(parsed.seq)}. Your open requests: ${open.map((o) => o.number).join(', ')}.` };
      target = m;
    } else if (open.length > 1) {
      return { tenantId: open[0]!.tenantId, reply: `You have ${open.length} prices waiting: ${open.map((o) => o.number).join(', ')}. Reply ${parsed.answer} ${open[0]!.number} to answer one.` };
    }
    const res = await this.db.tenant(target.tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM concierge_requests WHERE id = ${target.id}::uuid FOR UPDATE`;
      const r = await this.loadTx(tx, target.tenantId, target.id);
      if (parsed.answer === 'NO') {
        await this.declineQuoteTx(tx, r, { version: null, via: 'WHATSAPP', by: 'Guest (WhatsApp)' }, now);
        return { reply: `No problem, request ${r.number} is cancelled. If you change your mind, just ask again.`, ids: [] as string[], paymentId: null as string | null };
      }
      const settings = await this.core.settingsTx(tx, r.tenantId, r.propertyId);
      const folio = settings.payFolio && r.reservation?.folio?.status === 'OPEN';
      const out = await this.acceptTx(tx, r, { version: null, via: 'WHATSAPP', paymentMethod: folio ? 'FOLIO' : 'ONLINE', by: 'Guest (WhatsApp)' }, now);
      return { reply: folio ? `Thank you. Request ${r.number} is confirmed and will be added to your bill.` : `Thank you. Pay online to confirm request ${r.number}:`, ...out };
    }).catch((e: AppException) => ({ reply: `We could not confirm this: ${e.message}`, ids: [] as string[], paymentId: null as string | null }));
    const init = await this.after(res.ids, res.paymentId, target.tenantId);
    return { tenantId: target.tenantId, reply: init ? `${res.reply} ${init.authorizationUrl}` : res.reply };
  }

  // ---------------------------------------------------------------------------
  // Jobs: SLA escalation, retention
  // ---------------------------------------------------------------------------

  async escalateAll(now = new Date()): Promise<{ escalated: number }> {
    const due = (
      await this.db.systemAll((tx, t) =>
        tx.conciergeRequest.findMany({ where: { ...t.tenants, firstResponseAt: null, escalatedAt: null, status: { notIn: [...FINAL_STATUSES] }, slaDueAt: { lt: now } }, select: { tenantId: true } }),
      )
    ).flat();
    let escalated = 0;
    for (const tenantId of new Set(due.map((d) => d.tenantId))) {
      try {
        escalated += await this.escalateTenant(tenantId, now);
      } catch (e) {
        this.logger.error(`Concierge escalation for ${tenantId} failed: ${(e as Error).message}`);
      }
    }
    return { escalated };
  }

  async escalateTenant(tenantId: string, now = new Date()): Promise<number> {
    const { n, ids } = await this.db.tenant(tenantId, async (tx) => {
      const rows = await tx.conciergeRequest.findMany({ where: { tenantId, firstResponseAt: null, escalatedAt: null, status: { notIn: [...FINAL_STATUSES] }, slaDueAt: { lt: now } }, include: requestInclude });
      const settingsBy = new Map<string, ConciergeSettings>();
      const queued: OutgoingMessage[] = [];
      let n = 0;
      for (const r of rows) {
        const s = settingsBy.get(r.propertyId) ?? (await this.core.settingsTx(tx, tenantId, r.propertyId));
        settingsBy.set(r.propertyId, s);
        if (!dueForEscalation(r, s.escalateAfterMinutes, now)) continue;
        await tx.conciergeRequest.update({ where: { id: r.id }, data: { escalatedAt: now, timeline: [...timelineOf(r), this.event('escalated', null, 'Escalated to the manager: no reply within the target time', 'System', false, now)] as Prisma.InputJsonValue } });
        const property = await this.property(tx, r);
        const title = r.discreet ? `${PRIVATE_TITLE} ${r.number}` : `${r.serviceId ? r.serviceName : 'A guest request'}`;
        for (const to of await this.escalationRecipients(tx, tenantId, r.propertyId)) {
          queued.push(this.notifier.hotelEmail(tenantId, property, { template: 'CONCIERGE_ESCALATION', hotelName: property.name, number: r.number, title, overdueMinutes: Math.max(1, Math.round((now.getTime() - r.slaDueAt.getTime()) / 60_000)), adminUrl: this.notifier.adminUrl(r.id) }, to, { conciergeRequestId: r.id }));
        }
        await this.audit.record(tx, { tenantId, actor: { kind: 'system', name: 'System' }, action: 'concierge_request.escalated', entityType: 'concierge_request', entityId: r.id, propertyId: r.propertyId, metadata: { number: r.number } });
        n++;
      }
      return { n, ids: await this.notifications.queueTx(tx, queued) };
    });
    await this.notifications.dispatch(ids);
    return n;
  }

  /** Active staff with concierge.review and access to the property. */
  private async escalationRecipients(tx: Tx, tenantId: string, propertyId: string): Promise<string[]> {
    const users = await tx.user.findMany({ where: { tenantId, isActive: true }, include: { customRole: { select: { permissions: true } }, propertyAccess: { select: { propertyId: true } } } });
    return [
      ...new Set(
        users
          .filter((u) => permissionsFor(u.role, u.customRole?.permissions).has('concierge.review'))
          .filter((u) => u.role === 'OWNER' || u.allProperties !== false || u.propertyAccess.some((a) => a.propertyId === propertyId))
          .map((u) => u.email.toLowerCase()),
      ),
    ];
  }

  async redactAll(now = new Date()): Promise<{ redacted: number }> {
    const tenants = (await this.db.systemAll((tx, t) => tx.conciergeRequest.findMany({ where: { ...t.tenants, redactedAt: null, status: { in: [...FINAL_STATUSES] } }, distinct: ['tenantId'], select: { tenantId: true } }))).flat();
    let redacted = 0;
    for (const { tenantId } of tenants) {
      try {
        redacted += await this.redactTenant(tenantId, now);
      } catch (e) {
        this.logger.error(`Concierge redaction for ${tenantId} failed: ${(e as Error).message}`);
      }
    }
    return { redacted };
  }

  async redactTenant(tenantId: string, now = new Date()): Promise<number> {
    return this.db.tenant(tenantId, async (tx) => {
      const settings = await tx.conciergeSettings.findMany({ where: { tenantId } });
      const days = new Map(settings.map((s) => [s.propertyId, s.redactAfterDays]));
      const rows = await tx.conciergeRequest.findMany({ where: { tenantId, redactedAt: null, status: { in: [...FINAL_STATUSES] } } });
      let n = 0;
      for (const r of rows) {
        const endedAt = r.completedAt ?? r.cancelledAt ?? r.updatedAt;
        const keep = days.get(r.propertyId) ?? 90;
        if (now.getTime() - endedAt.getTime() < keep * 86_400_000) continue;
        await tx.conciergeRequest.update({ where: { id: r.id }, data: redactedData(r, now) });
        n++;
      }
      if (n) await this.audit.record(tx, { tenantId, actor: { kind: 'system', name: 'System' }, action: 'concierge.redacted', entityType: 'concierge', entityId: null, propertyId: null, metadata: { count: n } });
      return n;
    });
  }

  /** Runs a scheduled job (ProJobsService). */
  async runScheduled(job: string) {
    if (job === 'concierge-sla') return this.escalateAll();
    if (job === 'concierge-redaction') return this.redactAll();
    return undefined;
  }
}

/** Notes, texts, answers and comments removed; amounts, statuses and ratings kept. */
export function redactedData(r: ConciergeRequest, now: Date, opts: { contact?: boolean } = {}): Prisma.ConciergeRequestUpdateInput {
  const answers = Object.fromEntries(Object.entries((r.answers ?? {}) as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? '[redacted]' : v]));
  return {
    notes: r.notes ? '[redacted]' : null,
    internalNotes: r.internalNotes ? '[redacted]' : null,
    requestText: r.requestText ? '[redacted]' : null,
    answers: answers as Prisma.InputJsonValue,
    quoteNote: r.quoteNote ? '[redacted]' : null,
    ratingComment: r.ratingComment ? '[redacted]' : null,
    flagNote: r.flagNote ? '[redacted]' : null,
    timeline: (Array.isArray(r.timeline) ? (r.timeline as TimelineEvent[]) : []).map((e) => ({ ...e, note: e.note ? '[redacted]' : null })) as Prisma.InputJsonValue,
    ...(opts.contact && { contactPhone: null, contactEmail: null }),
    redactedAt: now,
  };
}

/** Partner API / webhook shape (never used for private requests). */
export function partnerRequest(r: ConciergeRequest) {
  const charge = chargeOf(r);
  return {
    id: r.id,
    number: r.number,
    propertyId: r.propertyId,
    reservationId: r.reservationId,
    status: r.status,
    source: r.source,
    category: r.category,
    serviceId: r.serviceId,
    serviceName: r.serviceId ? r.serviceName : 'Something else',
    partySize: r.partySize,
    preferredStart: r.preferredStart?.toISOString() ?? null,
    preferredEnd: r.preferredEnd?.toISOString() ?? null,
    totalKobo: charge?.totalKobo ?? null,
    paymentMethod: r.paymentMethod,
    paymentStatus: r.paymentStatus,
    completedAt: r.completedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function nairaText(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

export { paymentText, lagosDateTime };

export interface ListQuery {
  status?: string;
  source?: string;
  from?: string;
  to?: string;
  q?: string;
  assigneeId?: string;
  vendorId?: string;
  serviceId?: string;
  reservationId?: string;
  discreet?: boolean;
  flagged?: boolean;
  overdue?: boolean;
  page?: number;
  pageSize?: number;
}

export interface StaffCreateDto {
  reservationId?: string;
  guestId?: string;
  serviceId?: string;
  variantId?: string;
  requestText?: string;
  answers?: Record<string, unknown>;
  preferredStart?: string;
  preferredEnd?: string;
  hours?: number;
  partySize?: number;
  notes?: string;
  internalNotes?: string;
  discreet?: boolean;
  contactPreference?: string;
  paymentMethod?: 'ONLINE' | 'FOLIO' | 'NONE';
  notifyGuest?: boolean;
  assigneeId?: string;
  vendorId?: string;
  clientCreatedAt?: string;
}
