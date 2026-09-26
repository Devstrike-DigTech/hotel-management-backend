import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { registerInboundReplyHook } from '../../common/inbound-hooks.js';
import { currentViewer } from '../../common/property-scope.js';
import { registerStayHooks } from '../../common/stay-hooks.js';
import type { Tx } from '../../prisma/db.service.js';
import { OPS_JOBS } from '../jobs/jobs.constants.js';
import { ProJobsService } from '../jobs/pro-jobs.service.js';
import { CatalogueService } from './catalogue.service.js';
import { chargeOf, ConciergeService, requestInclude, timelineOf, type TimelineEvent, type Viewer } from './concierge.service.js';
import { OPEN_STATUSES } from './concierge.logic.js';
import { redactedData, RequestsService } from './requests.service.js';

/**
 * M8 wiring without the rest of the app depending on the concierge: the
 * reservation detail (masked per the viewer), the guest's trip view, stays
 * that will not happen, NDPA export and erasure per guest, the WhatsApp
 * YES / NO replies and the scheduled jobs.
 */
@Injectable()
export class ConciergeHooksService implements OnModuleInit {
  constructor(
    private readonly core: ConciergeService,
    private readonly catalogue: CatalogueService,
    private readonly requests: RequestsService,
  ) {}

  onModuleInit(): void {
    ProJobsService.register(OPS_JOBS.conciergeSla.name, RequestsService);
    ProJobsService.register(OPS_JOBS.conciergeRedaction.name, RequestsService);
    registerInboundReplyHook('concierge', (m) => this.requests.handleWhatsAppReply(m.digits, m.text));
    registerStayHooks({
      name: 'm8-concierge',
      detailTx: (tx, tenantId, reservationId) => this.detail(tx, tenantId, reservationId),
      guestViewTx: (tx, tenantId, reservationId) => this.guestView(tx, tenantId, reservationId),
      releasedTx: (tx, tenantId, reservationId, opts) => this.released(tx, tenantId, reservationId, typeof opts.why === 'string' ? opts.why : 'The stay was cancelled'),
      guestRecordExportTx: (tx, tenantId, guestId) => this.guestExport(tx, tenantId, guestId),
      guestRecordErasedTx: (tx, tenantId, guestId) => this.guestErased(tx, tenantId, guestId),
    });
  }

  /** ReservationDetail.concierge: masked or hidden per the viewer (no viewer = masked). */
  private async detail(tx: Tx, tenantId: string, reservationId: string) {
    const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId }, select: { propertyId: true } });
    if (!r) return {};
    const viewerRef = currentViewer(tenantId);
    const settings = await this.core.settingsTx(tx, tenantId, r.propertyId);
    const ent = await this.core.entitlements.getEntitlements(tenantId, tx);
    const v: Viewer = {
      holder: !!viewerRef?.permissions.has('concierge.discreet'),
      visibility: settings.discreetVisibility as 'MASKED' | 'HIDDEN',
      userId: viewerRef?.userId ?? null,
      vendorsFeature: ent.features.includes('concierge_vendors'),
    };
    const rows = await tx.conciergeRequest.findMany({ where: { tenantId, reservationId, ...this.core.hiddenWhere(v) }, include: requestInclude, orderBy: { createdAt: 'desc' } });
    return { concierge: rows.map((x) => this.core.listItem(x, v)) };
  }

  private async guestView(tx: Tx, tenantId: string, reservationId: string) {
    const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId }, select: { propertyId: true } });
    if (!r) return {};
    const enabled = await this.catalogue.visibilityTx(tx, tenantId, r.propertyId);
    const openRequests = await tx.conciergeRequest.count({ where: { tenantId, reservationId, status: { in: [...OPEN_STATUSES] } } });
    const offerAfterBooking = enabled ? (await tx.conciergeService.count({ where: { tenantId, propertyId: r.propertyId, active: true, reviewStatus: 'LIVE', channels: { has: 'BOOKING_FLOW' } } })) > 0 : false;
    return { concierge: { enabled, openRequests, offerAfterBooking } };
  }

  /** A stay that will not happen: open requests not paid online are cancelled. */
  private async released(tx: Tx, tenantId: string, reservationId: string, why: string) {
    const rows = await tx.conciergeRequest.findMany({ where: { tenantId, reservationId, status: { in: [...OPEN_STATUSES] }, NOT: { paymentStatus: 'PAID' } } });
    const now = new Date();
    for (const r of rows) {
      const ev: TimelineEvent = { at: now.toISOString(), type: 'status', status: 'CANCELLED', note: why, by: 'System', guestVisible: true };
      await tx.conciergeRequest.update({ where: { id: r.id }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: why, timeline: [...timelineOf(r), ev] as Prisma.InputJsonValue } });
      await tx.conciergePayment.updateMany({ where: { requestId: r.id, status: 'INITIALIZED' }, data: { status: 'FAILED' } });
    }
  }

  /** NDPA: everything held about the guest's concierge requests (private ones by name: it is their own data). */
  private async guestExport(tx: Tx, tenantId: string, guestId: string) {
    const rows = await tx.conciergeRequest.findMany({ where: { tenantId, guestId }, orderBy: { createdAt: 'asc' } });
    return {
      conciergeRequests: rows.map((r) => {
        const charge = chargeOf(r);
        return {
          number: r.number,
          createdAt: r.createdAt.toISOString(),
          status: r.status,
          service: r.serviceId ? (r.variantName ? `${r.serviceName}, ${r.variantName}` : r.serviceName) : 'Something else',
          category: r.category,
          discreet: r.discreet,
          requestText: r.requestText,
          answers: this.core.answerViews(r).map((a) => ({ label: a.label, display: a.display })),
          notes: r.notes,
          preferredStart: r.preferredStart?.toISOString() ?? null,
          preferredEnd: r.preferredEnd?.toISOString() ?? null,
          partySize: r.partySize,
          contact: { preference: r.contactPreference, phone: r.contactPhone, email: r.contactEmail },
          totalKobo: charge?.totalKobo ?? null,
          quote: r.quoteVersion ? { totalKobo: (r.quoteNetKobo ?? 0) + (r.quoteTaxKobo ?? 0), note: r.quoteNote, validUntil: r.quoteValidUntil?.toISOString() ?? null, answer: r.quoteAnswer } : null,
          payment: { method: r.paymentMethod, status: r.paymentStatus, folioDescription: r.folioDescription },
          rating: r.rating ? { rating: r.rating, comment: r.ratingComment } : null,
          timeline: timelineOf(r).filter((e) => e.guestVisible).map((e) => ({ at: e.at, status: e.status, note: e.note })),
          redactedAt: r.redactedAt?.toISOString() ?? null,
        };
      }),
    };
  }

  /** NDPA erasure: texts, answers, contact details and comments wiped; amounts and folio lines stay. */
  private async guestErased(tx: Tx, tenantId: string, guestId: string) {
    const rows = await tx.conciergeRequest.findMany({ where: { tenantId, guestId } });
    const now = new Date();
    for (const r of rows) await tx.conciergeRequest.update({ where: { id: r.id }, data: redactedData(r, now, { contact: true }) });
  }
}
