import { Injectable, OnModuleInit } from '@nestjs/common';
import { registerStayHooks } from '../../common/stay-hooks.js';
import type { Tx } from '../../prisma/db.service.js';
import { BookingFormService } from '../booking-form/booking-form.service.js';
import { FormUploadsService } from '../booking-form/form-uploads.service.js';
import { ThemeService } from '../site/theme.service.js';
import { AddOnsService } from './addons.service.js';
import { TransfersService } from './transfers.service.js';

/**
 * M7 wiring into the stay lifecycle (without the reservations module
 * depending on it): extras and pickups are posted at check-in, cancelled and
 * voided when a stay is released, and shown in the reservation detail, the
 * guest's trip view and the partner API / webhooks.
 */
@Injectable()
export class M7HooksService implements OnModuleInit {
  constructor(
    private readonly addOns: AddOnsService,
    private readonly transfers: TransfersService,
    private readonly forms: BookingFormService,
    private readonly themes: ThemeService,
    private readonly uploads: FormUploadsService,
  ) {}

  onModuleInit(): void {
    registerStayHooks({
      name: 'm7-addons',
      checkedInTx: async (tx, tenantId, reservationId, opts) => {
        await this.addOns.postPending(tx, tenantId, reservationId, { userId: typeof opts.userId === 'string' ? opts.userId : null, fullName: 'Check-in' });
      },
      releasedTx: async (tx, tenantId, reservationId, opts) => {
        await this.addOns.release(tx, tenantId, reservationId, typeof opts.why === 'string' ? opts.why : 'Booking cancelled');
      },
      detailTx: (tx, tenantId, reservationId) => this.detail(tx, tenantId, reservationId),
      guestViewTx: (tx, tenantId, reservationId) => this.guestView(tx, tenantId, reservationId),
      partnerTx: (tx, tenantId, ids, opts) => this.partner(tx, tenantId, ids, opts.includeSensitive),
      guestExportTx: (tx, tenantId, ids) => this.guestExport(tx, tenantId, ids),
      guestErasedTx: async (tx, tenantId, ids) => {
        await tx.reservation.updateMany({ where: { tenantId, id: { in: ids } }, data: { formAnswers: {} } });
        await tx.transfer.updateMany({ where: { tenantId, reservationId: { in: ids } }, data: { contactPhone: null, details: {}, notes: null, delayNote: null } });
        const keys = await this.uploads.deleteForReservations(tx, tenantId, ids);
        return () => this.uploads.deleteFiles(keys);
      },
    });
  }

  private async detail(tx: Tx, tenantId: string, reservationId: string) {
    const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId } });
    if (!r) return {};
    const lines = await this.addOns.linesOf(tx, tenantId, [r.id]);
    const extras = (lines.extras.get(r.id) ?? []).map((e) => this.addOns.extraView(e));
    const transfers = ((await this.transfers.forReservations(tx, tenantId, [r.id])).get(r.id) ?? []).map((t) => this.transfers.view(t));
    const answers = (r.formAnswers ?? null) as Record<string, unknown> | null;
    return {
      bookingForm: await this.forms.answersTx(tx, r, { staff: true, includeSensitive: true }),
      extras,
      transfers,
      addOnsTotalKobo:
        extras.filter((e) => e.status === 'ACTIVE').reduce((a, e) => a + e.totalKobo, 0) +
        transfers.filter((t) => t.status !== 'CANCELLED' && t.status !== 'NO_SHOW').reduce((a, t) => a + t.totalKobo, 0),
      registerPrefill: BookingFormService.registerPrefill(answers),
      billTo: BookingFormService.billTo(answers),
    };
  }

  private async guestView(tx: Tx, tenantId: string, reservationId: string) {
    const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId } });
    if (!r) return {};
    const lines = await this.addOns.linesOf(tx, tenantId, [r.id]);
    const form = await this.forms.answersTx(tx, r, { staff: false, includeSensitive: false });
    return {
      answers: form?.answers.map((a) => ({ ...a, ...(a.file && { file: { name: a.file.name, contentType: a.file.contentType, size: a.file.size } }) })) ?? [],
      extras: (lines.extras.get(r.id) ?? []).map((e) => {
        const v = this.addOns.extraView(e);
        return { extraId: v.extraId, name: v.name, category: v.category, pricing: v.pricing, quantity: v.quantity, persons: v.persons, nights: v.nights, unitPriceKobo: v.unitPriceKobo, amountKobo: v.amountKobo, netKobo: v.netKobo, taxKobo: v.taxKobo, totalKobo: v.totalKobo, description: v.description, serviceDates: v.serviceDates, status: v.status };
      }),
      transfers: ((await this.transfers.forReservations(tx, tenantId, [r.id])).get(r.id) ?? []).map((t) => this.transfers.guestView(t)),
      hotelTheme: await this.themes.tripThemeTx(tx, tenantId, r.propertyId).catch(() => null),
    };
  }

  private async guestExport(tx: Tx, tenantId: string, ids: string[]) {
    const out = new Map<string, Record<string, unknown>>();
    const rows = await tx.reservation.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, tenantId: true, formVersionId: true, formAnswers: true, formChannel: true, formSubmittedAt: true } });
    const lines = await this.addOns.linesOf(tx, tenantId, ids);
    const transfers = await this.transfers.forReservations(tx, tenantId, ids);
    for (const r of rows) {
      out.set(r.id, {
        bookingForm: await this.forms.exportForGuest(tx, tenantId, r),
        extras: (lines.extras.get(r.id) ?? []).map((e) => this.addOns.extraView(e)),
        transfers: (transfers.get(r.id) ?? []).map((t) => this.transfers.view(t)),
      });
    }
    return out;
  }

  private async partner(tx: Tx, tenantId: string, ids: string[], includeSensitive: boolean) {
    const out = new Map<string, Record<string, unknown>>();
    const rows = await tx.reservation.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, tenantId: true, formVersionId: true, formAnswers: true, formChannel: true, formSubmittedAt: true } });
    const lines = await this.addOns.linesOf(tx, tenantId, ids);
    for (const r of rows) {
      const form = await this.forms.answersTx(tx, r, { staff: false, includeSensitive });
      out.set(r.id, {
        bookingForm: form
          ? { formVersionId: form.formVersionId, version: form.version, channel: form.channel, answers: form.answers.map((a) => ({ key: a.key, label: a.label, type: a.type, section: a.section, value: a.type === 'FILE' ? { name: a.file?.name, contentType: a.file?.contentType, size: a.file?.size } : a.value, display: a.display, sensitive: a.sensitive })) }
          : null,
        extras: (lines.extras.get(r.id) ?? []).map((e) => ({ id: e.id, extraId: e.extraId, name: e.name, category: e.category, pricing: e.pricing, quantity: e.quantity, unitPriceKobo: e.unitPriceKobo, netKobo: e.netKobo, taxKobo: e.taxKobo, totalKobo: e.netKobo + e.taxKobo, status: e.status, posted: !!e.folioEntryId, createdAt: e.createdAt.toISOString() })),
        transfers: await this.partnerTransfers(tx, lines.transfers.get(r.id) ?? []),
      });
    }
    return out;
  }

  private async partnerTransfers(tx: Tx, list: Parameters<AddOnsService['partnerTransfer']>[1][]) {
    const out = [];
    for (const t of list) out.push(await this.addOns.partnerTransfer(tx, t));
    return out;
  }
}
