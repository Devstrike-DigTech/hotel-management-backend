import { HttpStatus, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { FolioEntry, Prisma } from '../../generated/prisma/client.js';
import type { FolioEntryType, PaymentMethod, TaxCode } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { dbDate, lagosDate } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { GuardService } from '../guard/guard.service.js';
import { voidedPaymentSeverity } from '../guard/guard.logic.js';
import { DocumentsService, folioDocInclude, type FolioForDoc } from '../invoices/documents.service.js';
import { appError, Err, isManager, k, paginate, parseClientCreatedAt, primaryProperty, userNames } from '../ops/ops.helpers.js';
import { discountBase, entryViews, folioTotals, CHARGE_TYPES } from './folio.logic.js';
import { componentsFrom, computeCharge, type TaxComponent } from './tax.logic.js';
import { TaxSettingsService } from './tax-settings.service.js';
import type {
  AddChargeDto,
  AddDiscountDto,
  AddPaymentDto,
  AddRefundDto,
  CreateFolioDto,
  FolioQueryDto,
} from './folios.dto.js';

export const SHIFT_METHODS: PaymentMethod[] = ['CASH', 'TRANSFER', 'POS'];
export const MANAGER_METHODS: PaymentMethod[] = ['CARD_ONLINE', 'COMPLIMENTARY', 'CITY_LEDGER'];

export interface Actor {
  userId: string | null;
  fullName: string;
}

export const actorOf = (u: AuthUser): Actor => ({ userId: u.userId, fullName: u.fullName });
export const SYSTEM: Actor = { userId: null, fullName: 'Night audit' };

export interface ChargeInput {
  type: 'ROOM' | 'DAY_USE' | 'EXTRA';
  description: string;
  amountKobo: number;
  businessDate?: string;
  taxable?: boolean;
  clientCreatedAt?: Date | null;
}

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MS = 15 * 60_000;

/**
 * The folio ledger. Every money movement is an immutable FolioEntry; the
 * balance is the sum of the entries; corrections are VOID entries.
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly guard: GuardService,
    private readonly docs: DocumentsService,
    private readonly taxes: TaxSettingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  async folioView(tx: Tx, tenantId: string, folioId: string) {
    const f = await this.docs.loadFolio(tx, tenantId, folioId);
    return this.toView(tx, f);
  }

  async toView(tx: Tx, f: FolioForDoc) {
    const names = await userNames(tx, f.entries.flatMap((e) => [e.createdById, e.approvedById]));
    const receipts = await tx.receipt.findMany({ where: { folioId: f.id }, select: { id: true, number: true, entryId: true } });
    const invoices = await tx.guestInvoice.findMany({
      where: { folioId: f.id },
      orderBy: { issuedAt: 'asc' },
      select: { id: true, number: true, kind: true, issuedAt: true, totalKobo: true },
    });
    const r = f.reservation;
    return {
      id: f.id,
      kind: f.kind,
      status: f.status,
      name: f.name,
      reservation: r
        ? {
            id: r.id,
            code: r.code,
            status: r.status,
            room: r.room ? { id: r.room.id, number: r.room.number, floor: r.room.floor, status: r.room.status } : null,
            arrivalAt: r.arrivalAt.toISOString(),
            departureAt: r.departureAt.toISOString(),
            stayType: r.stayType,
          }
        : null,
      guest: f.guest ? { id: f.guest.id, fullName: f.guest.fullName, phone: f.guest.phone } : null,
      entries: entryViews(f.entries, { names, receipts: new Map(receipts.map((x) => [x.entryId, x])) }),
      totals: folioTotals(f.entries),
      invoices: invoices.map((i) => ({ id: i.id, number: i.number, kind: i.kind, issuedAt: i.issuedAt.toISOString(), totalKobo: k(i.totalKobo) })),
      openedAt: f.createdAt.toISOString(),
      closedAt: f.closedAt?.toISOString() ?? null,
    };
  }

  async balance(tx: Tx, folioId: string): Promise<number> {
    const agg = await tx.folioEntry.aggregate({ where: { folioId }, _sum: { amountKobo: true } });
    return k(agg._sum.amountKobo);
  }

  /** folioId -> balance for many folios at once. */
  async balances(tx: Tx, folioIds: string[]): Promise<Map<string, number>> {
    if (!folioIds.length) return new Map();
    const rows = await tx.folioEntry.groupBy({ by: ['folioId'], where: { folioId: { in: folioIds } }, _sum: { amountKobo: true } });
    return new Map(rows.map((r) => [r.folioId, k(r._sum.amountKobo)]));
  }

  // ---------------------------------------------------------------------------
  // Posting primitives (called inside an open tenant transaction)
  // ---------------------------------------------------------------------------

  private assertOpen(folio: { status: string }) {
    if (folio.status !== 'OPEN') throw Err.invalidState(folio.status, ['OPEN'], 'This folio');
  }

  private async insert(tx: Tx, data: Prisma.FolioEntryUncheckedCreateInput): Promise<FolioEntry> {
    return tx.folioEntry.create({ data });
  }

  /** Posts a charge and its tax lines. Returns the charge entry. */
  async postCharge(tx: Tx, tenantId: string, folio: { id: string; propertyId: string; status: string }, input: ChargeInput, actor: Actor): Promise<FolioEntry> {
    this.assertOpen(folio);
    const settings = await this.taxes.forProperty(tx, tenantId, folio.propertyId);
    const comps = input.taxable === false ? [] : componentsFrom(settings);
    return this.postWithTaxes(tx, tenantId, folio.id, input.type, input.description, input.amountKobo, comps, {
      businessDate: input.businessDate ?? lagosDate(),
      actor,
      clientCreatedAt: input.clientCreatedAt ?? null,
    });
  }

  private async postWithTaxes(
    tx: Tx,
    tenantId: string,
    folioId: string,
    type: FolioEntryType,
    description: string,
    enteredKobo: number,
    comps: TaxComponent[],
    o: { businessDate: string; actor: Actor; clientCreatedAt: Date | null; parentEntryId?: string | null; reason?: string | null; approvedById?: string | null },
  ): Promise<FolioEntry> {
    const b = computeCharge(enteredKobo, comps);
    const base = {
      tenantId,
      folioId,
      businessDate: dbDate(o.businessDate),
      createdById: o.actor.userId,
      clientCreatedAt: o.clientCreatedAt,
    };
    const main = await this.insert(tx, {
      ...base,
      type,
      amountKobo: b.netKobo,
      description,
      parentEntryId: o.parentEntryId ?? null,
      reason: o.reason ?? null,
      approvedById: o.approvedById ?? null,
    });
    for (const line of b.lines) {
      await this.insert(tx, {
        ...base,
        type: line.code === 'SERVICE_CHARGE' ? 'SERVICE_CHARGE' : 'TAX',
        amountKobo: line.amountKobo,
        description: line.label,
        parentEntryId: main.id,
        taxCode: line.code,
        rateBps: line.rateBps,
        inclusive: line.inclusive,
      });
    }
    return main;
  }

  /** Records a payment (and its receipt). Enforces the open-shift rule. */
  async postPayment(
    tx: Tx,
    tenantId: string,
    folio: FolioForDoc,
    input: { method: PaymentMethod; amountKobo: number; reference?: string | null; note?: string | null; clientCreatedAt?: Date | null; receipt?: boolean },
    actor: Actor,
  ) {
    this.assertOpen(folio);
    let shiftId: string | null = null;
    if (SHIFT_METHODS.includes(input.method)) {
      const shift = actor.userId
        ? await tx.cashierShift.findFirst({ where: { tenantId, userId: actor.userId, status: 'OPEN' } })
        : null;
      if (!shift) {
        throw appError(HttpStatus.CONFLICT, 'SHIFT_REQUIRED', 'Open a cashier shift before taking cash, transfer or POS payments', {
          method: input.method,
        });
      }
      shiftId = shift.id;
    }
    const entry = await this.insert(tx, {
      tenantId,
      folioId: folio.id,
      type: 'PAYMENT',
      amountKobo: -input.amountKobo,
      description: paymentLabel(input.method, input.note),
      businessDate: dbDate(lagosDate()),
      paymentMethod: input.method,
      paymentRef: input.reference || null,
      shiftId,
      reason: input.note || null,
      createdById: actor.userId,
      clientCreatedAt: input.clientCreatedAt ?? null,
    });
    let receipt = null;
    if (input.receipt !== false) {
      const balance = await this.balance(tx, folio.id);
      receipt = await this.docs.issueReceipt(tx, tenantId, folio, entry, balance, actor.userId ? { id: actor.userId, fullName: actor.fullName } : null);
    }
    return { entry, receipt };
  }

  /**
   * Money returned to a guest through the payment provider (online refunds of
   * card / transfer / USSD payments). No cashier shift is involved. Allowed on
   * open folios only, like every posting.
   */
  async postOnlineRefund(
    tx: Tx,
    tenantId: string,
    folio: { id: string; status: string },
    input: { amountKobo: number; reference: string | null; reason: string },
    actor: Actor,
  ): Promise<FolioEntry> {
    this.assertOpen(folio);
    return this.insert(tx, {
      tenantId,
      folioId: folio.id,
      type: 'REFUND',
      amountKobo: input.amountKobo,
      description: 'Refund (online payment)',
      businessDate: dbDate(lagosDate()),
      paymentMethod: 'CARD_ONLINE',
      paymentRef: input.reference,
      reason: input.reason,
      createdById: actor.userId,
    });
  }

  // ---------------------------------------------------------------------------
  // API operations
  // ---------------------------------------------------------------------------

  list(user: AuthUser, q: FolioQueryDto) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const where: Prisma.FolioWhereInput = {
        tenantId: user.tenantId,
        ...(q.status && { status: q.status }),
        ...(q.kind && { kind: q.kind }),
        ...(q.q && {
          OR: [
            { name: { contains: q.q, mode: 'insensitive' } },
            { reservation: { code: { contains: q.q, mode: 'insensitive' } } },
          ],
        }),
      };
      const rows = await tx.folio.findMany({
        where,
        include: { reservation: { include: { room: true } } },
        orderBy: { createdAt: 'desc' },
        skip: pg.skip,
        take: pg.take,
      });
      const total = await tx.folio.count({ where });
      const sums = await tx.folioEntry.findMany({ where: { folioId: { in: rows.map((r) => r.id) } } });
      const byFolio = new Map<string, FolioEntry[]>();
      for (const e of sums) byFolio.set(e.folioId, [...(byFolio.get(e.folioId) ?? []), e]);
      return {
        items: rows.map((f) => {
          const t = folioTotals(byFolio.get(f.id) ?? []);
          return {
            id: f.id,
            kind: f.kind,
            status: f.status,
            name: f.name,
            reservationCode: f.reservation?.code ?? null,
            roomNumber: f.reservation?.room?.number ?? null,
            balanceKobo: t.balanceKobo,
            chargesKobo: t.chargesKobo,
            paymentsKobo: t.paymentsKobo,
            openedAt: f.createdAt.toISOString(),
            closedAt: f.closedAt?.toISOString() ?? null,
          };
        }),
        total,
        page: pg.page,
        pageSize: pg.pageSize,
      };
    });
  }

  createWalkIn(user: AuthUser, dto: CreateFolioDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const property = await primaryProperty(tx, user.tenantId);
      if (dto.guestId) {
        const g = await tx.guest.findFirst({ where: { id: dto.guestId, tenantId: user.tenantId } });
        if (!g) throw AppException.notFound('Guest');
      }
      const folio = await tx.folio.create({
        data: {
          tenantId: user.tenantId,
          propertyId: property.id,
          kind: 'WALK_IN',
          name: dto.name,
          guestId: dto.guestId ?? null,
          notes: dto.notes ?? '',
          createdById: user.userId,
        },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'folio.created',
        entityType: 'folio',
        entityId: folio.id,
        metadata: { name: folio.name, kind: 'WALK_IN' },
        ip,
      });
      return this.folioView(tx, user.tenantId, folio.id);
    });
  }

  get(user: AuthUser, folioId: string) {
    return this.db.tenant(user.tenantId, (tx) => this.folioView(tx, user.tenantId, folioId));
  }

  getByReservation(user: AuthUser, reservationId: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const f = await tx.folio.findFirst({ where: { reservationId, tenantId: user.tenantId }, select: { id: true } });
      if (!f) throw AppException.notFound('Folio');
      return this.folioView(tx, user.tenantId, f.id);
    });
  }

  addCharge(user: AuthUser, folioId: string, dto: AddChargeDto, ip?: string) {
    const type = dto.type ?? 'EXTRA';
    if (type !== 'EXTRA' && !isManager(user.role)) {
      throw AppException.forbidden('Only a manager can post room or day-use charges by hand');
    }
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    return this.db.tenant(user.tenantId, async (tx) => {
      const folio = await this.docs.loadFolio(tx, user.tenantId, folioId);
      const qty = dto.quantity ?? 1;
      const entry = await this.postCharge(
        tx,
        user.tenantId,
        folio,
        {
          type,
          description: qty > 1 ? `${dto.description} x${qty}` : dto.description,
          amountKobo: dto.amountKobo * qty,
          taxable: dto.taxable,
          clientCreatedAt,
        },
        actorOf(user),
      );
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'folio.charge_posted',
        entityType: 'folio',
        entityId: folio.id,
        metadata: { entryId: entry.id, type, amountKobo: dto.amountKobo * qty, description: dto.description, ...(clientCreatedAt && { clientCreatedAt: clientCreatedAt.toISOString() }) },
        ip,
      });
      return this.folioView(tx, user.tenantId, folio.id);
    });
  }

  /**
   * Second-key check for a discount, in its own committed transaction so
   * failed PIN attempts count even though the discount itself is refused.
   */
  private async verifyApproval(user: AuthUser, approval: { approverId: string; pin: string }) {
    const result = await this.db.tenant(user.tenantId, async (tx) => {
      const approver = await tx.user.findFirst({ where: { id: approval.approverId, tenantId: user.tenantId } });
      if (!approver || !approver.isActive || !isManager(approver.role) || !approver.approvalPinHash) {
        return { ok: false as const, error: appError(HttpStatus.FORBIDDEN, 'APPROVAL_INVALID', 'The approver must be an active manager or owner with an approval PIN') };
      }
      if (approver.id === user.userId && !isManager(user.role)) {
        return { ok: false as const, error: appError(HttpStatus.FORBIDDEN, 'APPROVAL_INVALID', 'A second person must approve this discount') };
      }
      const now = new Date();
      if (approver.pinLockedUntil && approver.pinLockedUntil > now) {
        return {
          ok: false as const,
          error: appError(HttpStatus.FORBIDDEN, 'APPROVAL_LOCKED', 'Too many wrong PINs. Try again later.', { lockedUntil: approver.pinLockedUntil.toISOString() }),
        };
      }
      const good = await argon2.verify(approver.approvalPinHash, approval.pin).catch(() => false);
      if (!good) {
        const failed = approver.pinFailedCount + 1;
        const lock = failed >= PIN_MAX_ATTEMPTS;
        await tx.user.update({
          where: { id: approver.id },
          data: lock ? { pinFailedCount: 0, pinLockedUntil: new Date(now.getTime() + PIN_LOCK_MS) } : { pinFailedCount: failed },
        });
        await this.audit.record(tx, {
          tenantId: user.tenantId,
          actor: userActor(user),
          action: 'approval.pin_failed',
          entityType: 'user',
          entityId: approver.id,
          metadata: { approver: approver.fullName, locked: lock },
        });
        return {
          ok: false as const,
          error: lock
            ? appError(HttpStatus.FORBIDDEN, 'APPROVAL_LOCKED', 'Too many wrong PINs. Try again later.', {
                lockedUntil: new Date(now.getTime() + PIN_LOCK_MS).toISOString(),
              })
            : appError(HttpStatus.FORBIDDEN, 'APPROVAL_INVALID', 'Wrong approval PIN', { attemptsLeft: PIN_MAX_ATTEMPTS - failed }),
        };
      }
      if (approver.pinFailedCount > 0) {
        await tx.user.update({ where: { id: approver.id }, data: { pinFailedCount: 0 } });
      }
      return { ok: true as const, approver: { id: approver.id, fullName: approver.fullName } };
    });
    if (!result.ok) throw result.error;
    return result.approver;
  }

  async addDiscount(user: AuthUser, folioId: string, dto: AddDiscountDto, ip?: string) {
    // Pass 1: compute the discount against the current folio (read only).
    const pre = await this.db.tenant(user.tenantId, async (tx) => {
      const folio = await this.docs.loadFolio(tx, user.tenantId, folioId);
      this.assertOpen(folio);
      const settings = await this.taxes.forProperty(tx, user.tenantId, folio.propertyId);
      const features = await this.guard.features(tx, user.tenantId);
      return { calc: this.calcDiscount(folio.entries, dto), threshold: settings.discountApprovalThresholdBps, features };
    });
    const over = pre.calc.discountBps > pre.threshold;
    const full = pre.features.includes('revenue_guard_full');
    let approver: { id: string; fullName: string } | null = null;
    if (over && full) {
      if (!dto.approval) {
        throw appError(HttpStatus.FORBIDDEN, 'APPROVAL_REQUIRED', 'This discount needs a manager to approve it with their PIN', {
          thresholdBps: pre.threshold,
          discountBps: pre.calc.discountBps,
        });
      }
      approver = await this.verifyApproval(user, dto.approval);
    }

    // Pass 2: post it.
    return this.db.tenant(user.tenantId, async (tx) => {
      const folio = await this.docs.loadFolio(tx, user.tenantId, folioId);
      this.assertOpen(folio);
      const calc = this.calcDiscount(folio.entries, dto);
      const comps = await this.discountComponents(tx, user.tenantId, folio, dto.targetEntryId);
      const target = dto.targetEntryId ? folio.entries.find((e) => e.id === dto.targetEntryId) : null;
      const entry = await this.postWithTaxes(
        tx,
        user.tenantId,
        folio.id,
        'DISCOUNT',
        target ? `Discount on ${target.description}` : dto.mode === 'PERCENT' ? `Discount ${dto.value / 100}%` : 'Discount',
        -calc.discountKobo,
        comps,
        { businessDate: lagosDate(), actor: actorOf(user), clientCreatedAt: null, parentEntryId: target?.id ?? null, reason: dto.reason, approvedById: approver?.id ?? null },
      );
      if (over && !approver) {
        await this.guard.raise(tx, user.tenantId, pre.features, {
          rule: 'DISCOUNT_OVER_THRESHOLD',
          title: `Discount of ${(calc.discountBps / 100).toFixed(1)}% on ${folio.reservation?.code ?? folio.name}`,
          detail: `${user.fullName} posted a discount above the ${(pre.threshold / 100).toFixed(1)}% threshold without approval. Reason given: ${dto.reason}`,
          dedupeKey: `DISCOUNT_OVER_THRESHOLD:${entry.id}`,
          amountKobo: calc.discountKobo,
          reservationId: folio.reservationId,
          roomId: folio.reservation?.roomId ?? null,
          userId: user.userId,
          userName: user.fullName,
          evidence: { entryId: entry.id, discountKobo: calc.discountKobo, baseKobo: calc.baseKobo, discountBps: calc.discountBps, thresholdBps: pre.threshold },
        });
      }
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'folio.discount_posted',
        entityType: 'folio',
        entityId: folio.id,
        metadata: {
          entryId: entry.id,
          discountKobo: calc.discountKobo,
          discountBps: calc.discountBps,
          reason: dto.reason,
          ...(approver && { approvedBy: approver.fullName, approvedById: approver.id }),
        },
        ip,
      });
      return this.folioView(tx, user.tenantId, folio.id);
    });
  }

  private calcDiscount(entries: FolioEntry[], dto: AddDiscountDto) {
    if (dto.targetEntryId) {
      const t = entries.find((e) => e.id === dto.targetEntryId);
      if (!t || !(CHARGE_TYPES as readonly string[]).includes(t.type)) {
        throw AppException.badRequest('targetEntryId must be a room, day-use or extra charge on this folio');
      }
      if (entries.some((e) => e.refEntryId === t.id)) throw AppException.badRequest('That charge has been voided');
    }
    const baseKobo = discountBase(entries, dto.targetEntryId);
    if (baseKobo <= 0) throw AppException.badRequest('There is nothing left to discount');
    const discountKobo = dto.mode === 'PERCENT' ? Math.round((baseKobo * dto.value) / 10_000) : dto.value;
    if (discountKobo <= 0) throw AppException.badRequest('The discount rounds to zero');
    if (discountKobo > baseKobo) throw AppException.badRequest('The discount is larger than the charges it applies to', { baseKobo });
    return { baseKobo, discountKobo, discountBps: Math.round((discountKobo * 10_000) / baseKobo) };
  }

  /** Tax lines for a discount mirror the target's rates, or current settings; always computed on the net. */
  private async discountComponents(tx: Tx, tenantId: string, folio: FolioForDoc, targetEntryId?: string): Promise<TaxComponent[]> {
    if (targetEntryId) {
      return folio.entries
        .filter((e) => e.parentEntryId === targetEntryId && (e.type === 'TAX' || e.type === 'SERVICE_CHARGE') && e.taxCode)
        .map((e) => ({ code: e.taxCode as TaxCode, label: e.description, rateBps: e.rateBps ?? 0, inclusive: false }));
    }
    const settings = await this.taxes.forProperty(tx, tenantId, folio.propertyId);
    return componentsFrom(settings).map((c) => ({ ...c, inclusive: false }));
  }

  addPayment(user: AuthUser, folioId: string, dto: AddPaymentDto, ip?: string) {
    if (MANAGER_METHODS.includes(dto.method) && !isManager(user.role)) {
      throw AppException.forbidden(`Only a manager can record ${dto.method.replace('_', ' ').toLowerCase()} payments`);
    }
    const clientCreatedAt = parseClientCreatedAt(dto.clientCreatedAt);
    return this.db.tenant(user.tenantId, async (tx) => {
      const folio = await this.docs.loadFolio(tx, user.tenantId, folioId);
      const { entry, receipt } = await this.postPayment(
        tx,
        user.tenantId,
        folio,
        { method: dto.method, amountKobo: dto.amountKobo, reference: dto.reference, note: dto.note, clientCreatedAt },
        actorOf(user),
      );
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'folio.payment_recorded',
        entityType: 'folio',
        entityId: folio.id,
        metadata: {
          entryId: entry.id,
          method: dto.method,
          amountKobo: dto.amountKobo,
          reference: dto.reference ?? null,
          receiptNumber: receipt?.number ?? null,
          ...(clientCreatedAt && { clientCreatedAt: clientCreatedAt.toISOString() }),
        },
        ip,
      });
      return { folio: await this.folioView(tx, user.tenantId, folio.id), receipt };
    });
  }

  addRefund(user: AuthUser, folioId: string, dto: AddRefundDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const folio = await this.docs.loadFolio(tx, user.tenantId, folioId);
      this.assertOpen(folio);
      const shift = await tx.cashierShift.findFirst({ where: { tenantId: user.tenantId, userId: user.userId, status: 'OPEN' } });
      if (!shift) {
        throw appError(HttpStatus.CONFLICT, 'SHIFT_REQUIRED', 'Open a cashier shift before paying out a refund', { method: dto.method });
      }
      const entry = await this.insert(tx, {
        tenantId: user.tenantId,
        folioId: folio.id,
        type: 'REFUND',
        amountKobo: dto.amountKobo,
        description: `Refund (${dto.method.toLowerCase()})`,
        businessDate: dbDate(lagosDate()),
        paymentMethod: dto.method,
        paymentRef: dto.reference || null,
        shiftId: shift.id,
        reason: dto.reason,
        createdById: user.userId,
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'folio.refund_recorded',
        entityType: 'folio',
        entityId: folio.id,
        metadata: { entryId: entry.id, method: dto.method, amountKobo: dto.amountKobo, reason: dto.reason },
        ip,
      });
      return this.folioView(tx, user.tenantId, folio.id);
    });
  }

  voidEntry(user: AuthUser, folioId: string, entryId: string, reason: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const folio = await this.docs.loadFolio(tx, user.tenantId, folioId);
      const entry = folio.entries.find((e) => e.id === entryId);
      if (!entry) throw AppException.notFound('Folio entry');
      const voided = new Set(folio.entries.filter((e) => e.type === 'VOID').map((e) => e.refEntryId));
      if (entry.type === 'VOID' || voided.has(entry.id)) {
        throw appError(HttpStatus.CONFLICT, 'ALREADY_VOIDED', 'This entry is already voided', { entryId });
      }
      if (entry.type === 'TAX' || entry.type === 'SERVICE_CHARGE') {
        throw AppException.badRequest('Tax lines cannot be voided on their own; void the charge they belong to');
      }
      // The entry, its tax lines, discounts on it and their tax lines.
      const targets: FolioEntry[] = [];
      const collect = (e: FolioEntry) => {
        if (voided.has(e.id)) return;
        targets.push(e);
        for (const child of folio.entries.filter((c) => c.parentEntryId === e.id && c.type !== 'VOID')) collect(child);
      };
      collect(entry);
      const today = lagosDate();
      for (const t of targets) {
        await this.insert(tx, {
          tenantId: user.tenantId,
          folioId: folio.id,
          type: 'VOID',
          amountKobo: -k(t.amountKobo),
          description: `Void: ${t.description}`,
          businessDate: dbDate(today),
          refEntryId: t.id,
          paymentMethod: t.paymentMethod,
          shiftId: t.shiftId,
          taxCode: t.taxCode,
          reason,
          createdById: user.userId,
        });
      }
      const features = await this.guard.features(tx, user.tenantId);
      if (entry.type === 'PAYMENT') {
        const amount = -k(entry.amountKobo);
        await this.guard.raise(tx, user.tenantId, features, {
          rule: 'VOIDED_PAYMENT',
          severity: voidedPaymentSeverity(amount),
          title: `Payment of ₦${(amount / 100).toLocaleString('en-NG')} voided on ${folio.reservation?.code ?? folio.name}`,
          detail: `${user.fullName} voided a ${entry.paymentMethod?.toLowerCase()} payment. Reason: ${reason}`,
          dedupeKey: `VOIDED_PAYMENT:${entry.id}`,
          amountKobo: amount,
          reservationId: folio.reservationId,
          roomId: folio.reservation?.roomId ?? null,
          shiftId: entry.shiftId,
          userId: user.userId,
          userName: user.fullName,
          evidence: { entryId: entry.id, method: entry.paymentMethod, reference: entry.paymentRef, recordedById: entry.createdById, recordedAt: entry.createdAt.toISOString(), reason },
        });
      }
      await this.guard.checkRepeatedVoids(tx, user.tenantId, features, user.userId, user.fullName);
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'folio.entry_voided',
        entityType: 'folio',
        entityId: folio.id,
        metadata: { entryId, type: entry.type, amountKobo: k(entry.amountKobo), reason, lines: targets.length },
        ip,
      });
      return this.folioView(tx, user.tenantId, folio.id);
    });
  }

  closeWalkIn(user: AuthUser, folioId: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const folio = await this.docs.loadFolio(tx, user.tenantId, folioId);
      if (folio.kind !== 'WALK_IN') throw AppException.badRequest('Reservation folios close at check-out');
      this.assertOpen(folio);
      const balance = await this.balance(tx, folio.id);
      if (balance !== 0) {
        throw appError(HttpStatus.CONFLICT, 'BALANCE_OUTSTANDING', 'Settle the folio before closing it', { balanceKobo: balance });
      }
      await tx.folio.update({ where: { id: folio.id }, data: { status: 'CLOSED', closedAt: new Date() } });
      const invoice = await this.docs.issueInvoice(tx, user.tenantId, folio.id, 'FINAL', { id: user.userId, fullName: user.fullName });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'folio.closed',
        entityType: 'folio',
        entityId: folio.id,
        metadata: { invoiceNumber: invoice.number },
        ip,
      });
      return { folio: await this.folioView(tx, user.tenantId, folio.id), invoice };
    });
  }

  /** Includes for callers that need a folio loaded for posting. */
  static readonly include = folioDocInclude;
}

function paymentLabel(method: PaymentMethod, note?: string | null): string {
  const labels: Record<PaymentMethod, string> = {
    CASH: 'Cash payment',
    TRANSFER: 'Bank transfer',
    POS: 'POS card payment',
    CARD_ONLINE: 'Online card payment',
    COMPLIMENTARY: 'Complimentary',
    CITY_LEDGER: 'Charged to city ledger',
  };
  return note ? `${labels[method]}: ${note}` : labels[method];
}
