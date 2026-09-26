import { HttpStatus, Injectable } from '@nestjs/common';
import type { ConciergeAccount, ConciergeRequest, ConciergeService as ServiceRow, ConciergeSettings, ConciergeVendor, Prisma } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { can } from '../../common/permissions/can.js';
import { AppException } from '../../common/errors/app-exception.js';
import { lagosDate } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { displayValue } from '../booking-form/form.logic.js';
import type { FormField } from '../booking-form/form.catalogue.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { requiredPlanFor } from '../entitlements/entitlements.logic.js';
import { appError, primaryProperty } from '../ops/ops.helpers.js';
import { AUP_PROHIBITED, AUP_SUMMARY, AUP_TEXT, AUP_TITLE, AUP_VERSION } from './aup.js';
import {
  categoryLabel,
  FREE_FORM_TITLE,
  GUEST_STATUS_LABELS,
  priceLabel,
  PRIVACY_NOTE,
  PRIVATE_TITLE,
  requestLabel,
  shortName,
  slaView,
  type Availability,
  type QuotedPrice,
  type RequestStatus,
  type ServiceLike,
  type ServiceVariant,
} from './concierge.logic.js';
import { screen } from './denylist.js';

export const requestInclude = {
  guest: { select: { id: true, fullName: true, phone: true, email: true, vip: true, anonymisedAt: true } },
  reservation: { select: { id: true, code: true, status: true, arrivalAt: true, departureAt: true, room: { select: { number: true } }, folio: { select: { id: true, status: true } } } },
  service: { select: { fulfilledBy: true, discreetEligible: true, imageUrl: true } },
} satisfies Prisma.ConciergeRequestInclude;
export type RequestRow = Prisma.ConciergeRequestGetPayload<{ include: typeof requestInclude }>;

export type TimelineEvent = { at: string; type: string; status: string | null; note: string | null; by: string | null; guestVisible: boolean };

/** Who is looking at a request (staff). */
export interface Viewer {
  holder: boolean;
  visibility: 'MASKED' | 'HIDDEN';
  userId: string | null;
  vendorsFeature: boolean;
}

export const NEUTRAL_AUDIT = (r: { discreet: boolean; number: string; serviceName: string }) => (r.discreet ? PRIVATE_TITLE : r.serviceName);

export function timelineOf(r: { timeline: unknown }): TimelineEvent[] {
  return Array.isArray(r.timeline) ? (r.timeline as TimelineEvent[]) : [];
}

export function questionsOf(v: unknown): FormField[] {
  return Array.isArray(v) ? (v as FormField[]) : [];
}

export function variantsOf(v: unknown): ServiceVariant[] {
  return Array.isArray(v) ? (v as ServiceVariant[]) : [];
}

export function serviceLike(s: ServiceRow): ServiceLike {
  return {
    id: s.id,
    name: s.name,
    pricing: s.pricing,
    priceKobo: s.priceKobo,
    variants: variantsOf(s.variants),
    durationMinutes: s.durationMinutes,
    leadTimeHours: s.leadTimeHours,
    availability: (s.availability as Availability) ?? null,
    requiresSlot: s.requiresSlot,
    slotCapacity: s.slotCapacity,
    taxable: s.taxable,
  };
}

/** The effective charge: the accepted (or latest) quote, else the automatic price. */
export function chargeOf(r: ConciergeRequest): { amountKobo: number; netKobo: number; taxKobo: number; totalKobo: number } | null {
  if (r.quoteAmountKobo !== null && r.quoteVersion > 0) {
    return { amountKobo: r.quoteAmountKobo, netKobo: r.quoteNetKobo ?? 0, taxKobo: r.quoteTaxKobo ?? 0, totalKobo: (r.quoteNetKobo ?? 0) + (r.quoteTaxKobo ?? 0) };
  }
  if (r.priceAmountKobo !== null) {
    return { amountKobo: r.priceAmountKobo, netKobo: r.priceNetKobo ?? 0, taxKobo: r.priceTaxKobo ?? 0, totalKobo: (r.priceNetKobo ?? 0) + (r.priceTaxKobo ?? 0) };
  }
  return null;
}

export function priceOf(r: ConciergeRequest): QuotedPrice | null {
  if (r.priceAmountKobo === null) return null;
  return {
    amountKobo: r.priceAmountKobo,
    netKobo: r.priceNetKobo ?? 0,
    taxKobo: r.priceTaxKobo ?? 0,
    totalKobo: (r.priceNetKobo ?? 0) + (r.priceTaxKobo ?? 0),
    taxes: (r.priceTaxes as QuotedPrice['taxes']) ?? [],
    description: r.priceDescription ?? r.serviceName,
  };
}

/**
 * The concierge core (M8): acceptable use, suspension, per-property settings,
 * gates, discretion (who sees what) and the views every other concierge
 * service shares.
 */
@Injectable()
export class ConciergeService {
  constructor(
    readonly db: DbService,
    private readonly audit: AuditService,
    readonly entitlements: EntitlementsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Account (AUP, suspension) and settings
  // ---------------------------------------------------------------------------

  async accountTx(tx: Tx, tenantId: string): Promise<ConciergeAccount | null> {
    return tx.conciergeAccount.findUnique({ where: { tenantId } });
  }

  aupAccepted(a: ConciergeAccount | null): boolean {
    return !!a?.aupAcceptedAt && a.aupVersion === AUP_VERSION;
  }

  suspension(a: ConciergeAccount | null): { since: string; reason: string } | null {
    return a?.suspendedAt ? { since: a.suspendedAt.toISOString(), reason: a.suspendedReason ?? '' } : null;
  }

  async settingsTx(tx: Tx, tenantId: string, propertyId: string): Promise<ConciergeSettings> {
    const s = await tx.conciergeSettings.findUnique({ where: { propertyId } });
    if (s) return s;
    await tx.$executeRaw`INSERT INTO concierge_settings (id, tenant_id, property_id, updated_at) VALUES (gen_random_uuid(), ${tenantId}::uuid, ${propertyId}::uuid, now()) ON CONFLICT (property_id) DO NOTHING`;
    return tx.conciergeSettings.findUniqueOrThrow({ where: { propertyId } });
  }

  settingsView(s: ConciergeSettings) {
    return {
      propertyId: s.propertyId,
      enabled: s.enabled,
      sla: { inStayMinutes: s.slaInStayMinutes, preArrivalMinutes: s.slaPreArrivalMinutes, escalateAfterMinutes: s.escalateAfterMinutes },
      folioLabels: { inRoom: s.folioLabelInRoom, other: s.folioLabelOther },
      redactAfterDays: s.redactAfterDays,
      discreetVisibility: s.discreetVisibility as 'MASKED' | 'HIDDEN',
      vendorSharing: { guestSurname: s.vendorShareSurname, roomNumber: s.vendorShareRoom },
      payments: { online: s.payOnline, folio: s.payFolio },
      freeFormEnabled: s.freeFormEnabled,
      quoteValidityHours: s.quoteValidityHours,
      intro: s.intro,
      updatedAt: s.updatedAt.toISOString(),
      updatedBy: s.updatedById ? { id: s.updatedById, fullName: s.updatedByName ?? 'Former staff member' } : null,
    };
  }

  /** 403 CONCIERGE_SUSPENDED while the platform has suspended the hotel's concierge. */
  assertNotSuspended(a: ConciergeAccount | null): void {
    const s = this.suspension(a);
    if (s) {
      throw new AppException(HttpStatus.FORBIDDEN, 'CONCIERGE_SUSPENDED', 'The platform has suspended the concierge of this hotel. You can still finish requests already under way.', s);
    }
  }

  assertAup(a: ConciergeAccount | null): void {
    if (!this.aupAccepted(a)) {
      throw new AppException(HttpStatus.CONFLICT, 'AUP_REQUIRED', 'Accept the concierge acceptable-use policy first.', { version: AUP_VERSION });
    }
  }

  async viewer(tx: Tx, u: AuthUser, propertyId: string): Promise<Viewer> {
    const s = await this.settingsTx(tx, u.tenantId, propertyId);
    const ent = await this.entitlements.getEntitlements(u.tenantId, tx);
    return { holder: can(u, 'concierge.discreet'), visibility: s.discreetVisibility as 'MASKED' | 'HIDDEN', userId: u.userId, vendorsFeature: ent.features.includes('concierge_vendors') };
  }

  // ---------------------------------------------------------------------------
  // Gates and AUP
  // ---------------------------------------------------------------------------

  async gates(u: AuthUser) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const ent = await this.entitlements.getEntitlements(u.tenantId, tx);
      const plans = await this.entitlements.listPlans();
      const a = await this.accountTx(tx, u.tenantId);
      const p = await primaryProperty(tx, u.tenantId);
      const s = await this.settingsTx(tx, u.tenantId, p.id);
      const feature = ent.features.includes('concierge');
      const vendorsFeature = ent.features.includes('concierge_vendors');
      return {
        feature,
        vendorsFeature,
        requiredPlan: feature ? null : (requiredPlanFor('concierge', plans) ?? 'growth'),
        vendorsRequiredPlan: vendorsFeature ? null : (requiredPlanFor('concierge_vendors', plans) ?? 'pro'),
        aup: this.aupState(a),
        suspended: this.suspension(a),
        enabled: feature && s.enabled && !a?.suspendedAt,
        canSeeDiscreet: can(u, 'concierge.discreet'),
        discreetVisibility: s.discreetVisibility as 'MASKED' | 'HIDDEN',
      };
    });
  }

  private aupState(a: ConciergeAccount | null) {
    return {
      version: AUP_VERSION,
      accepted: this.aupAccepted(a),
      acceptedAt: this.aupAccepted(a) ? (a!.aupAcceptedAt?.toISOString() ?? null) : null,
      acceptedBy: this.aupAccepted(a) && a!.aupAcceptedById ? { id: a!.aupAcceptedById, fullName: a!.aupAcceptedByName ?? 'Former staff member' } : null,
    };
  }

  aupDocument(a: ConciergeAccount | null) {
    return {
      version: AUP_VERSION,
      title: AUP_TITLE,
      summary: AUP_SUMMARY,
      text: AUP_TEXT,
      prohibited: AUP_PROHIBITED.map((p) => ({ ...p })),
      accepted: this.aupAccepted(a),
      acceptedVersion: a?.aupVersion ?? null,
      acceptedAt: a?.aupAcceptedAt?.toISOString() ?? null,
      acceptedBy: a?.aupAcceptedById ? { id: a.aupAcceptedById, fullName: a.aupAcceptedByName ?? 'Former staff member' } : null,
    };
  }

  aup(u: AuthUser) {
    return this.db.tenant(u.tenantId, async (tx) => this.aupDocument(await this.accountTx(tx, u.tenantId)));
  }

  acceptAup(u: AuthUser, version: string, ip?: string) {
    if (version !== AUP_VERSION) throw new AppException(HttpStatus.CONFLICT, 'AUP_VERSION_MISMATCH', 'This is not the current version of the policy. Reload and read it again.', { version: AUP_VERSION });
    return this.db.tenant(u.tenantId, async (tx) => {
      const now = new Date();
      const a = await tx.conciergeAccount.upsert({
        where: { tenantId: u.tenantId },
        create: { tenantId: u.tenantId, aupVersion: AUP_VERSION, aupAcceptedAt: now, aupAcceptedById: u.userId, aupAcceptedByName: u.fullName, aupAcceptedIp: ip ?? null },
        update: { aupVersion: AUP_VERSION, aupAcceptedAt: now, aupAcceptedById: u.userId, aupAcceptedByName: u.fullName, aupAcceptedIp: ip ?? null },
      });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'concierge.aup_accepted', entityType: 'concierge', entityId: null, propertyId: null, metadata: { version: AUP_VERSION }, ip });
      return this.aupDocument(a);
    });
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  getSettings(u: AuthUser) {
    return this.db.tenant(u.tenantId, async (tx) => this.settingsView(await this.settingsTx(tx, u.tenantId, (await primaryProperty(tx, u.tenantId)).id)));
  }

  updateSettings(u: AuthUser, dto: SettingsInput, ip?: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const p = await primaryProperty(tx, u.tenantId);
      const cur = await this.settingsTx(tx, u.tenantId, p.id);
      const a = await this.accountTx(tx, u.tenantId);
      if (dto.enabled === true && !cur.enabled) {
        this.assertAup(a);
        this.assertNotSuspended(a);
      }
      const texts = [dto.folioLabels?.inRoom, dto.folioLabels?.other, dto.intro];
      const hit = screen(texts);
      if (hit.flagged) {
        throw appError(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'This wording is not allowed (acceptable-use policy)', {
          fields: { intro: ['This wording is not allowed (acceptable-use policy)'] },
          issues: hit.matches.map((m) => ({ path: 'intro', fieldKey: null, code: 'NOT_ALLOWED', message: `"${m.term}" is not allowed`, meta: { term: m.term, category: m.category } })),
        });
      }
      const s = await tx.conciergeSettings.update({
        where: { id: cur.id },
        data: {
          ...(dto.enabled !== undefined && { enabled: dto.enabled }),
          ...(dto.sla?.inStayMinutes !== undefined && { slaInStayMinutes: dto.sla.inStayMinutes }),
          ...(dto.sla?.preArrivalMinutes !== undefined && { slaPreArrivalMinutes: dto.sla.preArrivalMinutes }),
          ...(dto.sla?.escalateAfterMinutes !== undefined && { escalateAfterMinutes: dto.sla.escalateAfterMinutes }),
          ...(dto.folioLabels?.inRoom !== undefined && { folioLabelInRoom: dto.folioLabels.inRoom.trim() }),
          ...(dto.folioLabels?.other !== undefined && { folioLabelOther: dto.folioLabels.other.trim() }),
          ...(dto.redactAfterDays !== undefined && { redactAfterDays: dto.redactAfterDays }),
          ...(dto.discreetVisibility !== undefined && { discreetVisibility: dto.discreetVisibility }),
          ...(dto.vendorSharing?.guestSurname !== undefined && { vendorShareSurname: dto.vendorSharing.guestSurname }),
          ...(dto.vendorSharing?.roomNumber !== undefined && { vendorShareRoom: dto.vendorSharing.roomNumber }),
          ...(dto.payments?.online !== undefined && { payOnline: dto.payments.online }),
          ...(dto.payments?.folio !== undefined && { payFolio: dto.payments.folio }),
          ...(dto.freeFormEnabled !== undefined && { freeFormEnabled: dto.freeFormEnabled }),
          ...(dto.quoteValidityHours !== undefined && { quoteValidityHours: dto.quoteValidityHours }),
          ...(dto.intro !== undefined && { intro: dto.intro?.trim() || null }),
          updatedById: u.userId,
          updatedByName: u.fullName,
        },
      });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'concierge.settings_updated', entityType: 'concierge_settings', entityId: s.id, metadata: { changes: Object.keys(dto) }, ip });
      return this.settingsView(s);
    });
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  serviceView(s: ServiceRow & { vendor?: Pick<ConciergeVendor, 'id' | 'name'> | null }, extras: { guestVisible: boolean; requestsLast30Days?: number }) {
    const like = serviceLike(s);
    return {
      id: s.id,
      propertyId: s.propertyId,
      name: s.name,
      description: s.description,
      category: s.category,
      categoryLabel: categoryLabel(s.category),
      imageUrl: s.imageUrl,
      pricing: s.pricing,
      priceKobo: s.priceKobo,
      variants: like.variants,
      durationMinutes: s.durationMinutes,
      leadTimeHours: s.leadTimeHours,
      availability: like.availability,
      requiresSlot: s.requiresSlot,
      slotCapacity: s.slotCapacity,
      location: s.location,
      fulfilledBy: s.fulfilledBy as 'STAFF' | 'VENDOR',
      vendor: s.vendor ? { id: s.vendor.id, name: s.vendor.name } : null,
      discreetEligible: s.discreetEligible,
      questions: questionsOf(s.questions),
      taxable: s.taxable,
      channels: s.channels,
      active: s.active,
      sortOrder: s.sortOrder,
      reviewStatus: s.reviewStatus,
      review: {
        flaggedTerms: s.flaggedTerms,
        reason: s.reviewReason,
        submittedAt: s.submittedAt?.toISOString() ?? null,
        reviewedAt: s.reviewedAt?.toISOString() ?? null,
        reviewedBy: s.reviewedByName,
      },
      guestVisible: extras.guestVisible,
      priceLabel: priceLabel(like),
      requestsLast30Days: extras.requestsLast30Days ?? 0,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  /** True when a staff viewer must not see this request's contents. */
  masked(r: { discreet: boolean }, v: Viewer): boolean {
    return r.discreet && !v.holder;
  }

  /** HIDDEN visibility: non-holders do not see private requests at all. */
  hiddenWhere(v: Viewer): Prisma.ConciergeRequestWhereInput {
    return !v.holder && v.visibility === 'HIDDEN' ? { discreet: false } : {};
  }

  listItem(r: RequestRow, v: Viewer, now = new Date()) {
    const masked = this.masked(r, v);
    const title = r.serviceId ? r.serviceName : FREE_FORM_TITLE;
    const roomNumber = r.reservation?.room?.number ?? null;
    const charge = chargeOf(r);
    return {
      id: r.id,
      number: r.number,
      propertyId: r.propertyId,
      status: r.status,
      source: r.source,
      discreet: r.discreet,
      masked,
      title: masked ? PRIVATE_TITLE : title,
      label: requestLabel({ masked, title, roomNumber, assigneeName: r.assigneeName, guestName: r.guest.fullName }),
      category: masked ? null : r.category,
      guestName: masked ? null : r.guest.fullName,
      roomNumber,
      reservationCode: masked ? null : (r.reservation?.code ?? null),
      preferredStart: r.preferredStart?.toISOString() ?? null,
      preferredEnd: r.preferredEnd?.toISOString() ?? null,
      partySize: masked ? null : r.partySize,
      assignee: r.assigneeId ? { id: r.assigneeId, fullName: r.assigneeName ?? 'Former staff member' } : null,
      vendor: masked || !r.vendorId ? null : { id: r.vendorId, name: r.vendorName ?? '' },
      flagged: masked ? false : r.flagged && r.flagStatus === 'PENDING',
      totalKobo: masked ? null : (charge?.totalKobo ?? null),
      paymentStatus: r.paymentStatus as 'NONE' | 'PENDING' | 'PAID' | 'POSTED' | 'REFUNDED',
      sla: slaView(r, now),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  answerViews(r: ConciergeRequest) {
    const fields = questionsOf(r.questions);
    const answers = (r.answers ?? {}) as Record<string, unknown>;
    return fields
      .filter((f) => answers[f.key] !== undefined)
      .map((f) => ({ key: f.key, label: f.label, type: f.type, section: f.section, source: f.source, value: answers[f.key], display: displayValue(f, answers[f.key]), sensitive: f.sensitive, mapsTo: null }));
  }

  detail(r: RequestRow, v: Viewer, extras: { acceptUrl: string | null }, now = new Date()) {
    const base = this.listItem(r, v, now);
    const masked = base.masked;
    const hide = <T>(x: T): T | null => (masked ? null : x);
    const quote =
      r.quoteVersion > 0 && r.quoteAmountKobo !== null
        ? {
            version: r.quoteVersion,
            amountKobo: r.quoteAmountKobo,
            netKobo: r.quoteNetKobo ?? 0,
            taxKobo: r.quoteTaxKobo ?? 0,
            totalKobo: (r.quoteNetKobo ?? 0) + (r.quoteTaxKobo ?? 0),
            taxes: (r.quoteTaxes as QuotedPrice['taxes']) ?? [],
            validUntil: r.quoteValidUntil?.toISOString() ?? '',
            note: r.quoteNote,
            sentAt: r.quoteSentAt?.toISOString() ?? '',
            sentBy: r.quoteSentById ? { id: r.quoteSentById, fullName: r.quoteSentByName ?? '' } : null,
            acceptUrl: extras.acceptUrl ?? '',
            expired: !!r.quoteValidUntil && r.quoteValidUntil < now,
            answer: r.quoteAnswer as 'ACCEPTED' | 'DECLINED' | null,
            answeredAt: r.quoteAnsweredAt?.toISOString() ?? null,
            answeredVia: r.quoteAnsweredVia as 'LINK' | 'WHATSAPP' | 'TRIP_PAGE' | 'STAFF' | null,
          }
        : null;
    return {
      ...base,
      service: hide(r.serviceId ? { id: r.serviceId, name: r.serviceName, category: r.category, pricing: r.pricing, location: r.location, fulfilledBy: (r.service?.fulfilledBy ?? 'STAFF') as 'STAFF' | 'VENDOR', discreetEligible: r.service?.discreetEligible ?? false } : null),
      variant: hide(r.variantId ? { id: r.variantId, name: r.variantName ?? '' } : null),
      hours: hide(r.hours),
      requestText: hide(r.requestText),
      answers: masked ? [] : this.answerViews(r),
      notes: hide(r.notes),
      internalNotes: hide(r.internalNotes),
      guest: masked || r.guest.anonymisedAt ? (masked ? null : { id: r.guest.id, fullName: r.guest.fullName, phone: null, email: null, vip: false }) : { id: r.guest.id, fullName: r.guest.fullName, phone: r.guest.phone, email: r.guest.email, vip: r.guest.vip },
      reservation: r.reservation
        ? masked
          ? null
          : {
              id: r.reservation.id,
              code: r.reservation.code,
              status: r.reservation.status,
              roomNumber: r.reservation.room?.number ?? null,
              arrivalDate: lagosDate(r.reservation.arrivalAt),
              departureDate: lagosDate(r.reservation.departureAt),
              folioOpen: r.reservation.folio?.status === 'OPEN',
            }
        : null,
      contactPreference: r.contactPreference,
      contact: masked ? { phone: null, email: null } : { phone: r.contactPhone, email: r.contactEmail },
      doNotCallRoom: r.discreet,
      flag: masked || !r.flagged ? null : {
        terms: r.flagTerms,
        categories: r.flagCategories,
        status: (r.flagStatus ?? 'PENDING') as 'PENDING' | 'CLEARED' | 'DECLINED',
        reviewedBy: r.flagReviewedById ? { id: r.flagReviewedById, fullName: r.flagReviewedByName ?? '' } : null,
        reviewedAt: r.flagReviewedAt?.toISOString() ?? null,
        note: r.flagNote,
      },
      price: hide(priceOf(r)),
      quote: hide(quote),
      payment: masked
        ? { method: null, status: r.paymentStatus, reference: null, authorizationUrl: null, paidAt: null, folioEntryId: null, postedAt: null, folioDescription: null }
        : {
            method: r.paymentMethod as 'ONLINE' | 'FOLIO' | 'NONE' | null,
            status: r.paymentStatus,
            reference: r.paymentReference,
            authorizationUrl: null as string | null,
            paidAt: r.paidAt?.toISOString() ?? null,
            folioEntryId: r.folioEntryId,
            postedAt: r.postedAt?.toISOString() ?? null,
            folioDescription: r.folioDescription,
          },
      commission:
        masked || !v.vendorsFeature || !r.vendorId
          ? null
          : { type: (r.commissionType ?? 'NONE') as 'NONE' | 'PERCENT' | 'FIXED', value: r.commissionValue ?? 0, commissionKobo: r.commissionKobo, vendorPayableKobo: r.vendorPayableKobo, settledAt: r.vendorSettledAt?.toISOString() ?? null },
      vendorSentAt: hide(r.vendorSentAt?.toISOString() ?? null),
      vendorSentVia: hide(r.vendorSentVia as 'WHATSAPP' | 'SMS' | null),
      scheduledAt: r.scheduledAt?.toISOString() ?? null,
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
      declineReason: hide(r.declineReason),
      cancelReason: hide(r.cancelReason),
      rating: masked || !r.rating ? null : { rating: r.rating, comment: r.ratingComment, ratedAt: r.ratedAt?.toISOString() ?? '' },
      vendorRating: hide(r.vendorRating),
      timeline: timelineOf(r).map((e) => (masked ? { ...e, note: null } : e)),
      redactedAt: r.redactedAt?.toISOString() ?? null,
      createdBy: r.createdById ? { id: r.createdById, fullName: r.createdByName ?? '' } : null,
    };
  }

  /** The guest's own view (trip page, quote page): the real service even when private. */
  guestView(r: ConciergeRequest & { service?: Pick<ServiceRow, 'imageUrl'> | null }, extras: { quoteToken: string | null; quoteUrl: string | null; authorizationUrl: string | null }, now = new Date()) {
    const flaggedHold = r.flagged && r.flagStatus === 'PENDING';
    const status = r.status as RequestStatus;
    const quote =
      !flaggedHold && r.quoteVersion > 0 && r.quoteAmountKobo !== null && extras.quoteToken
        ? {
            totalKobo: (r.quoteNetKobo ?? 0) + (r.quoteTaxKobo ?? 0),
            netKobo: r.quoteNetKobo ?? 0,
            taxKobo: r.quoteTaxKobo ?? 0,
            taxes: (r.quoteTaxes as QuotedPrice['taxes']) ?? [],
            validUntil: r.quoteValidUntil?.toISOString() ?? '',
            note: r.quoteNote,
            token: extras.quoteToken,
            url: extras.quoteUrl ?? '',
            expired: !!r.quoteValidUntil && r.quoteValidUntil < now,
          }
        : null;
    const paidOnline = r.paymentStatus === 'PAID';
    return {
      id: r.id,
      number: r.number,
      status,
      statusLabel: flaggedHold ? GUEST_STATUS_LABELS.NEW : status === 'DECLINED' && r.flagged ? "We couldn't arrange this request" : GUEST_STATUS_LABELS[status],
      title: r.serviceId ? r.serviceName : FREE_FORM_TITLE,
      discreet: r.discreet,
      service: r.serviceId ? { id: r.serviceId, name: r.serviceName, category: r.category, imageUrl: r.service?.imageUrl ?? null, location: r.location } : null,
      variant: r.variantId ? { id: r.variantId, name: r.variantName ?? '' } : null,
      hours: r.hours,
      requestText: r.requestText,
      answers: this.answerViews(r).map((a) => ({ key: a.key, label: a.label, display: a.display })),
      preferredStart: r.preferredStart?.toISOString() ?? null,
      preferredEnd: r.preferredEnd?.toISOString() ?? null,
      partySize: r.partySize,
      notes: r.notes,
      contactPreference: r.contactPreference,
      price: flaggedHold ? null : priceOf(r),
      quote,
      payment: { method: r.paymentMethod as 'ONLINE' | 'FOLIO' | 'NONE' | null, status: r.paymentStatus, authorizationUrl: r.paymentStatus === 'PENDING' ? extras.authorizationUrl : null },
      canCancel: ['NEW', 'QUOTED', 'AWAITING_GUEST', 'CONFIRMED'].includes(status) && !(paidOnline && status !== 'CONFIRMED'),
      canRate: status === 'COMPLETED' && !r.rating && !!r.completedAt && now.getTime() - r.completedAt.getTime() < 30 * 86_400_000,
      rating: r.rating ? { rating: r.rating, comment: r.ratingComment } : null,
      timeline: timelineOf(r)
        .filter((e) => e.guestVisible)
        .map((e) => ({ at: e.at, status: e.status as RequestStatus | null, text: e.note ?? (e.status ? GUEST_STATUS_LABELS[e.status as RequestStatus] : '') })),
      privacyNote: PRIVACY_NOTE,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  guestNameShort(full: string) {
    return shortName(full);
  }
}

export interface SettingsInput {
  enabled?: boolean;
  sla?: { inStayMinutes?: number; preArrivalMinutes?: number; escalateAfterMinutes?: number };
  folioLabels?: { inRoom?: string; other?: string };
  redactAfterDays?: number;
  discreetVisibility?: 'MASKED' | 'HIDDEN';
  vendorSharing?: { guestSurname?: boolean; roomNumber?: boolean };
  payments?: { online?: boolean; folio?: boolean };
  freeFormEnabled?: boolean;
  quoteValidityHours?: number;
  intro?: string | null;
}
