import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception.js';
import { humanDate, lagosDate } from '../../common/time/lagos.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService } from '../../prisma/db.service.js';
import { DocumentsService } from '../invoices/documents.service.js';
import { runAfter } from './booking-payments.service.js';
import { BookingTokens } from './booking-tokens.service.js';
import { BookingViewService } from './booking-view.service.js';
import { CancellationService } from './cancellation.service.js';
import { buildIcs } from './ics.js';

/**
 * Manage-booking links. The trip token carries the tenant and reservation
 * ids (signed by this API), so each call runs in that hotel's tenant context.
 */
@Injectable()
export class TripsService {
  private readonly logger = new Logger(TripsService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: AppConfigService,
    private readonly tokens: BookingTokens,
    private readonly views: BookingViewService,
    private readonly cancellation: CancellationService,
    private readonly docs: DocumentsService,
  ) {}

  view(code: string, t: string | undefined) {
    const { tenantId, reservationId } = this.tokens.verifyTrip(t, code);
    return this.db.tenant(tenantId, async (tx) => this.views.view(tx, await this.views.load(tx, tenantId, reservationId)));
  }

  preview(code: string, t: string | undefined) {
    const { tenantId, reservationId } = this.tokens.verifyTrip(t, code);
    return this.db.tenant(tenantId, async (tx) => {
      const r = await this.views.load(tx, tenantId, reservationId);
      const p = this.cancellation.preview(r);
      return {
        canCancel: p.canCancel,
        reason: p.reason,
        free: p.free,
        freeCancellationUntil: p.freeCancellationUntil,
        paidKobo: p.paidKobo,
        feeKobo: p.feeKobo,
        refundKobo: p.refundKobo,
        policy: (await this.views.view(tx, r)).cancellationPolicy,
        currency: 'NGN' as const,
      };
    });
  }

  async cancel(code: string, t: string | undefined, reason: string | undefined, ip?: string) {
    const { tenantId, reservationId } = this.tokens.verifyTrip(t, code);
    const res = await this.db.tenant(tenantId, async (tx) => {
      const r = await this.views.load(tx, tenantId, reservationId);
      const name = r.contactPhone ? `Guest (${r.guest.fullName})` : 'Guest';
      return this.cancellation.cancelTx(tx, tenantId, reservationId, {
        by: 'GUEST',
        reason: reason?.trim() || null,
        actor: { kind: 'system', name },
        ledgerActor: { userId: null, fullName: name },
        ip,
      });
    });
    await runAfter(res.after, this.logger);
    return this.db.tenant(tenantId, async (tx) => {
      const r = await this.views.load(tx, tenantId, reservationId);
      const booking = await this.views.view(tx, r);
      return {
        booking,
        cancellation: {
          canCancel: false,
          reason: null,
          free: res.outcome.free,
          freeCancellationUntil: res.outcome.freeCancellationUntil,
          paidKobo: res.outcome.paidKobo,
          feeKobo: res.outcome.feeKobo,
          refundKobo: res.outcome.refundKobo,
          policy: booking.cancellationPolicy,
          currency: 'NGN' as const,
          refundStatus: booking.cancellation?.refundStatus ?? null,
        },
      };
    });
  }

  async calendar(code: string, t: string | undefined): Promise<{ filename: string; body: string }> {
    const { tenantId, reservationId } = this.tokens.verifyTrip(t, code);
    return this.db.tenant(tenantId, async (tx) => {
      const r = await this.views.load(tx, tenantId, reservationId);
      const token = this.views.manageToken(r);
      const p = r.property;
      const where = [p.address, p.area, p.city, p.state].filter(Boolean).join(', ');
      const body = buildIcs(
        {
          uid: `${r.code}.${r.id}@${this.config.get('APP_DOMAIN')}`,
          start: r.arrivalAt,
          end: r.departureAt,
          summary: `Stay at ${p.name} (${r.code})`,
          location: where,
          description: [
            `Booking ${r.code}, ${r.roomType.name}.`,
            `Check-in from ${p.checkInTime} on ${humanDate(lagosDate(r.arrivalAt))}; check-out by ${p.checkOutTime}.`,
            p.phone ? `Hotel phone: ${p.phone}.` : '',
            `Manage your booking: ${this.tokens.manageUrl(r.code, token)}`,
          ]
            .filter(Boolean)
            .join('\n'),
          url: this.tokens.manageUrl(r.code, token),
        },
        this.config.get('APP_NAME'),
      );
      return { filename: `${r.code}.ics`, body };
    });
  }

  document(code: string, t: string | undefined, kind: 'invoice' | 'receipt', id: string) {
    const { tenantId, reservationId } = this.tokens.verifyTrip(t, code);
    return this.db.tenant(tenantId, async (tx) => {
      const folio = await tx.folio.findFirst({ where: { tenantId, reservationId }, select: { id: true } });
      if (!folio) throw AppException.notFound('Document');
      if (kind === 'invoice') {
        const inv = await tx.guestInvoice.findFirst({ where: { id, tenantId, folioId: folio.id } });
        if (!inv) throw AppException.notFound('Document');
        return { type: 'INVOICE' as const, document: { ...(inv.document as Record<string, unknown>), id: inv.id } };
      }
      const rc = await tx.receipt.findFirst({ where: { id, tenantId, folioId: folio.id } });
      if (!rc) throw AppException.notFound('Document');
      const voided = await tx.folioEntry.count({ where: { refEntryId: rc.entryId } });
      return { type: 'RECEIPT' as const, document: { ...(rc.document as Record<string, unknown>), id: rc.id, voided: voided > 0 } };
    });
  }

  proforma(code: string, t: string | undefined) {
    const { tenantId, reservationId } = this.tokens.verifyTrip(t, code);
    return this.db.tenant(tenantId, async (tx) => {
      const folio = await tx.folio.findFirst({ where: { tenantId, reservationId }, select: { id: true } });
      if (!folio) throw AppException.notFound('Booking');
      return this.docs.issueInvoice(tx, tenantId, folio.id, 'PROFORMA', null);
    });
  }
}
