import { HttpStatus, Injectable } from '@nestjs/common';
import type { FolioEntry, Prisma } from '../../generated/prisma/client.js';
import type { DocumentCounterKind, GuestInvoiceKind, PaymentMethod } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { signToken, verifyToken } from '../../common/crypto/signed-token.js';
import { AppException } from '../../common/errors/app-exception.js';
import { lagosDate, lagosYear, dbDate, lagosStartOfDay, addDays } from '../../common/time/lagos.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { buildInvoiceDocument, buildReceiptDocument, type Issuer } from './document.builder.js';
import { appError, k, paginate, primaryProperty } from '../ops/ops.helpers.js';

export const folioDocInclude = {
  reservation: { include: { room: true, roomType: true } },
  guest: true,
  entries: true,
} satisfies Prisma.FolioInclude;

export type FolioForDoc = Prisma.FolioGetPayload<{ include: typeof folioDocInclude }>;


const PREFIX: Record<DocumentCounterKind, string> = { INVOICE: 'INV', PROFORMA: 'PRO', RECEIPT: 'RCT' };

export function formatDocNumber(kind: DocumentCounterKind, year: number, seq: number): string {
  return `${PREFIX[kind]}-${year}-${String(seq).padStart(6, '0')}`;
}

interface SharePayload {
  t: 'INVOICE' | 'RECEIPT';
  id: string;
  tid: string;
  exp: number;
}

/**
 * Guest invoices and receipts: gapless numbering, immutable snapshots of the
 * printable document, and signed share links for the guest.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly db: DbService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Next number in a gapless per-tenant, per-year sequence. The upsert takes a
   * row lock that is held until the surrounding transaction ends, so
   * concurrent issuers queue up, and a rolled-back transaction gives its
   * number back.
   */
  async nextNumber(tx: Tx, tenantId: string, kind: DocumentCounterKind, year: number) {
    const rows = await tx.$queryRaw<{ last_value: number }[]>`
      INSERT INTO document_counters (tenant_id, kind, year, last_value)
      VALUES (${tenantId}::uuid, ${kind}::"DocumentCounterKind", ${year}, 1)
      ON CONFLICT (tenant_id, kind, year)
      DO UPDATE SET last_value = document_counters.last_value + 1
      RETURNING last_value`;
    const seq = Number(rows[0].last_value);
    return { seq, number: formatDocNumber(kind, year, seq) };
  }

  private async hotelHeader(tx: Tx, tenantId: string) {
    const p = await primaryProperty(tx, tenantId);
    return {
      name: p.name,
      address: p.address,
      area: p.area,
      city: p.city,
      state: p.state,
      phone: p.phone,
      email: p.email,
      logoUrl: p.logoUrl,
      accentColor: p.accentColor,
      appName: this.config.get('APP_NAME'),
    };
  }

  async loadFolio(tx: Tx, tenantId: string, folioId: string): Promise<FolioForDoc> {
    const f = await tx.folio.findFirst({ where: { id: folioId, tenantId }, include: folioDocInclude });
    if (!f) throw AppException.notFound('Folio');
    return f;
  }

  // ---------------------------------------------------------------------------
  // Receipts
  // ---------------------------------------------------------------------------

  async issueReceipt(tx: Tx, tenantId: string, folio: FolioForDoc, entry: FolioEntry, balanceAfterKobo: number, issuer: Issuer) {
    const now = new Date();
    const year = lagosYear(now);
    const { seq, number } = await this.nextNumber(tx, tenantId, 'RECEIPT', year);
    const document = buildReceiptDocument({
      folio,
      entry,
      hotel: await this.hotelHeader(tx, tenantId),
      number,
      issuedAt: now,
      balanceAfterKobo,
      issuer,
    });
    const amount = document.amountKobo;
    const receipt = await tx.receipt.create({
      data: {
        tenantId,
        folioId: folio.id,
        entryId: entry.id,
        number,
        year,
        seq,
        issuedAt: now,
        method: entry.paymentMethod as PaymentMethod,
        amountKobo: amount,
        guestName: document.guestName,
        reservationCode: document.reservationCode,
        document: document as unknown as Prisma.InputJsonValue,
        issuedById: issuer?.id ?? null,
      },
    });
    return { ...document, id: receipt.id };
  }

  private async receiptView(tx: Tx, tenantId: string, id: string) {
    const r = await tx.receipt.findFirst({ where: { id, tenantId } });
    if (!r) throw AppException.notFound('Receipt');
    const voided = await tx.folioEntry.count({ where: { refEntryId: r.entryId } });
    return { ...(r.document as Record<string, unknown>), id: r.id, voided: voided > 0 };
  }

  // ---------------------------------------------------------------------------
  // Invoices
  // ---------------------------------------------------------------------------

  async issueInvoice(tx: Tx, tenantId: string, folioId: string, kind: GuestInvoiceKind, issuer: Issuer) {
    const folio = await this.loadFolio(tx, tenantId, folioId);
    const now = new Date();
    const year = lagosYear(now);
    const { seq, number } = await this.nextNumber(tx, tenantId, kind === 'FINAL' ? 'INVOICE' : 'PROFORMA', year);
    const doc = await this.buildInvoiceDocument(tx, tenantId, folio, { number, kind, issuedAt: now, issuer });
    const inv = await tx.guestInvoice.create({
      data: {
        tenantId,
        folioId,
        kind,
        number,
        year,
        seq,
        issuedAt: now,
        businessDate: dbDate(lagosDate(now)),
        totalKobo: doc.totals.totalKobo,
        balanceKobo: doc.totals.balanceKobo,
        guestName: doc.guest?.fullName ?? folio.name,
        reservationCode: folio.reservation?.code ?? null,
        document: doc as unknown as Prisma.InputJsonValue,
        issuedById: issuer?.id ?? null,
      },
    });
    return { ...doc, id: inv.id };
  }

  async buildInvoiceDocument(
    tx: Tx,
    tenantId: string,
    folio: FolioForDoc,
    meta: { number: string; kind: GuestInvoiceKind; issuedAt: Date; issuer: Issuer },
  ) {
    const receipts = await tx.receipt.findMany({ where: { folioId: folio.id }, select: { entryId: true, number: true } });
    return buildInvoiceDocument({
      folio,
      receiptNumbers: new Map(receipts.map((r) => [r.entryId, r.number])),
      hotel: await this.hotelHeader(tx, tenantId),
      ...meta,
    });
  }

  // ---------------------------------------------------------------------------
  // Read API
  // ---------------------------------------------------------------------------

  createProforma(user: AuthUser, folioId: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const doc = await this.issueInvoice(tx, user.tenantId, folioId, 'PROFORMA', { id: user.userId, fullName: user.fullName });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'invoice.proforma_issued',
        entityType: 'guest_invoice',
        entityId: doc.id,
        metadata: { number: doc.number, folioId },
        ip,
      });
      return doc;
    });
  }

  listInvoices(user: AuthUser, q: { kind?: GuestInvoiceKind; from?: string; to?: string; q?: string; page?: number; pageSize?: number }) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const where: Prisma.GuestInvoiceWhereInput = {
        tenantId: user.tenantId,
        ...(q.kind && { kind: q.kind }),
        ...((q.from || q.to) && {
          issuedAt: {
            ...(q.from && { gte: lagosStartOfDay(q.from) }),
            ...(q.to && { lt: lagosStartOfDay(addDays(q.to, 1)) }),
          },
        }),
        ...(q.q && {
          OR: [
            { number: { contains: q.q, mode: 'insensitive' } },
            { guestName: { contains: q.q, mode: 'insensitive' } },
            { reservationCode: { contains: q.q, mode: 'insensitive' } },
          ],
        }),
      };
      const rows = await tx.guestInvoice.findMany({ where, orderBy: { issuedAt: 'desc' }, skip: pg.skip, take: pg.take });
      const total = await tx.guestInvoice.count({ where });
      return {
        items: rows.map((r) => ({
          id: r.id,
          number: r.number,
          kind: r.kind,
          issuedAt: r.issuedAt.toISOString(),
          guestName: r.guestName,
          reservationCode: r.reservationCode,
          totalKobo: k(r.totalKobo),
          balanceKobo: k(r.balanceKobo),
        })),
        total,
        page: pg.page,
        pageSize: pg.pageSize,
      };
    });
  }

  getInvoice(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const r = await tx.guestInvoice.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!r) throw AppException.notFound('Invoice');
      return { ...(r.document as Record<string, unknown>), id: r.id };
    });
  }

  listReceipts(user: AuthUser, q: { from?: string; to?: string; method?: PaymentMethod; q?: string; page?: number; pageSize?: number }) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const where: Prisma.ReceiptWhereInput = {
        tenantId: user.tenantId,
        ...(q.method && { method: q.method }),
        ...((q.from || q.to) && {
          issuedAt: {
            ...(q.from && { gte: lagosStartOfDay(q.from) }),
            ...(q.to && { lt: lagosStartOfDay(addDays(q.to, 1)) }),
          },
        }),
        ...(q.q && {
          OR: [
            { number: { contains: q.q, mode: 'insensitive' } },
            { guestName: { contains: q.q, mode: 'insensitive' } },
            { reservationCode: { contains: q.q, mode: 'insensitive' } },
          ],
        }),
      };
      const rows = await tx.receipt.findMany({ where, orderBy: { issuedAt: 'desc' }, skip: pg.skip, take: pg.take });
      const total = await tx.receipt.count({ where });
      const voided = new Set(
        (await tx.folioEntry.findMany({ where: { refEntryId: { in: rows.map((r) => r.entryId) } }, select: { refEntryId: true } })).map(
          (v) => v.refEntryId,
        ),
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          number: r.number,
          issuedAt: r.issuedAt.toISOString(),
          guestName: r.guestName,
          reservationCode: r.reservationCode,
          method: r.method,
          amountKobo: k(r.amountKobo),
          voided: voided.has(r.entryId),
        })),
        total,
        page: pg.page,
        pageSize: pg.pageSize,
      };
    });
  }

  getReceipt(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, (tx) => this.receiptView(tx, user.tenantId, id));
  }

  // ---------------------------------------------------------------------------
  // Share links
  // ---------------------------------------------------------------------------

  share(user: AuthUser, type: 'INVOICE' | 'RECEIPT', id: string, expiresInHours = 168, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      let phone: string | null = null;
      let number: string;
      if (type === 'INVOICE') {
        const inv = await tx.guestInvoice.findFirst({ where: { id, tenantId: user.tenantId }, include: { folio: { include: { guest: true } } } });
        if (!inv) throw AppException.notFound('Invoice');
        phone = inv.folio.guest?.phone ?? null;
        number = inv.number;
      } else {
        const rc = await tx.receipt.findFirst({ where: { id, tenantId: user.tenantId }, include: { folio: { include: { guest: true } } } });
        if (!rc) throw AppException.notFound('Receipt');
        phone = rc.folio.guest?.phone ?? null;
        number = rc.number;
      }
      const exp = Math.floor(Date.now() / 1000) + expiresInHours * 3600;
      const token = signToken<SharePayload>(this.config.get('SHARE_TOKEN_SECRET'), 'doc', { t: type, id, tid: user.tenantId, exp });
      const url = `${this.config.get('ADMIN_URL').replace(/\/$/, '')}/share/${token}`;
      const hotel = await primaryProperty(tx, user.tenantId);
      const text = `${hotel.name}: your ${type === 'INVOICE' ? 'invoice' : 'receipt'} ${number} is ready. View or print it here: ${url}`;
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: `${type.toLowerCase()}.shared`,
        entityType: type === 'INVOICE' ? 'guest_invoice' : 'receipt',
        entityId: id,
        metadata: { number, expiresInHours },
        ip,
      });
      return {
        token,
        url,
        expiresAt: new Date(exp * 1000).toISOString(),
        whatsappUrl: phone ? `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}` : null,
      };
    });
  }

  async publicDocument(token: string) {
    const res = verifyToken<SharePayload>(this.config.get('SHARE_TOKEN_SECRET'), 'doc', token);
    if (!res.ok) {
      if (res.reason === 'expired') throw appError(HttpStatus.GONE, 'LINK_EXPIRED', 'This link has expired. Ask the hotel for a new one.');
      throw AppException.notFound('Document');
    }
    const { t, id, tid } = res.payload;
    // The tenant comes from a token signed by this API, never from user input.
    return this.db.tenant(tid, async (tx) => {
      if (t === 'INVOICE') {
        const r = await tx.guestInvoice.findFirst({ where: { id, tenantId: tid } });
        if (!r) throw AppException.notFound('Document');
        return { type: 'INVOICE' as const, document: { ...(r.document as Record<string, unknown>), id: r.id } };
      }
      return { type: 'RECEIPT' as const, document: await this.receiptView(tx, tid, id) };
    });
  }
}
