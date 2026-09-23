import { HttpStatus, Injectable } from '@nestjs/common';
import type { CashierShift, Prisma } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { addDays, lagosStartOfDay } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { GuardService } from '../guard/guard.service.js';
import { shiftVarianceSeverity } from '../guard/guard.logic.js';
import { appError, Err, isManager, k, kOrNull, paginate, isUniqueViolation } from '../ops/ops.helpers.js';
import { expectedTotals, variance, type ShiftMovement } from './shift.logic.js';
import type { CloseShiftDto, OpenShiftDto, ShiftQueryDto } from './shifts.dto.js';

const NOTES = ['1000', '500', '200', '100', '50', '20', '10', '5'];

/**
 * Cashier shifts with a blind close: while a shift is open, its expected
 * totals are hidden from front-desk staff; they are revealed after the count
 * is submitted.
 */
@Injectable()
export class ShiftsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly guard: GuardService,
  ) {}

  /** Movements (payments, refunds, and voids of them) attached to a shift. */
  async movements(tx: Tx, shiftId: string) {
    return tx.folioEntry.findMany({
      where: { shiftId, type: { in: ['PAYMENT', 'REFUND', 'VOID'] } },
      include: { folio: { include: { reservation: true, guest: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  private canSeeExpected(viewer: AuthUser, s: CashierShift): boolean {
    if (s.status !== 'OPEN') return true;
    return viewer.role === 'OWNER' || viewer.role === 'MANAGER' || viewer.role === 'ACCOUNTANT';
  }

  async view(tx: Tx, viewer: AuthUser | null, s: CashierShift, withPayments: boolean) {
    const blind = viewer ? !this.canSeeExpected(viewer, s) : false;
    let expected = {
      expectedCashKobo: kOrNull(s.expectedCashKobo),
      expectedPosKobo: kOrNull(s.expectedPosKobo),
      expectedTransferKobo: kOrNull(s.expectedTransferKobo),
      paymentsCount: s.paymentsCount,
    };
    let rows: Awaited<ReturnType<ShiftsService['movements']>> | null = null;
    if (!blind && (s.status === 'OPEN' || withPayments)) {
      rows = await this.movements(tx, s.id);
      if (s.status === 'OPEN') {
        const e = expectedTotals(k(s.openingFloatKobo), rows.map((r) => ({ type: r.type, method: r.paymentMethod, amountKobo: k(r.amountKobo) })));
        expected = e;
      }
    }
    const closed = s.status !== 'OPEN';
    const v =
      closed && s.countedCashKobo !== null && expected.expectedCashKobo !== null
        ? variance(
            { expectedCashKobo: expected.expectedCashKobo, expectedPosKobo: expected.expectedPosKobo ?? 0, expectedTransferKobo: expected.expectedTransferKobo ?? 0, paymentsCount: 0 },
            { countedCashKobo: k(s.countedCashKobo), declaredPosKobo: k(s.declaredPosKobo), declaredTransferKobo: k(s.declaredTransferKobo) },
          )
        : null;
    const voided = new Set(rows?.filter((r) => r.type === 'VOID').map((r) => r.refEntryId) ?? []);
    const base = {
      id: s.id,
      status: s.status,
      user: { id: s.userId, fullName: s.userName },
      openedAt: s.openedAt.toISOString(),
      closedAt: s.closedAt?.toISOString() ?? null,
      openingFloatKobo: k(s.openingFloatKobo),
      countedCashKobo: kOrNull(s.countedCashKobo),
      declaredPosKobo: kOrNull(s.declaredPosKobo),
      declaredTransferKobo: kOrNull(s.declaredTransferKobo),
      denominations: (s.denominations as Record<string, number> | null) ?? null,
      blind,
      expectedCashKobo: blind ? null : expected.expectedCashKobo,
      expectedPosKobo: blind ? null : expected.expectedPosKobo,
      expectedTransferKobo: blind ? null : expected.expectedTransferKobo,
      varianceCashKobo: v?.varianceCashKobo ?? null,
      variancePosKobo: v?.variancePosKobo ?? null,
      varianceTransferKobo: v?.varianceTransferKobo ?? null,
      varianceTotalKobo: v?.varianceTotalKobo ?? null,
      paymentsCount: blind ? null : expected.paymentsCount,
      notes: s.notes,
      closeNotes: s.closeNotes,
      approvedBy: s.approvedById ? { id: s.approvedById, fullName: s.approvedByName ?? '' } : null,
      approvedAt: s.approvedAt?.toISOString() ?? null,
      approvalNotes: s.approvalNotes,
    };
    if (!withPayments) return base;
    return {
      ...base,
      payments:
        blind || !rows
          ? null
          : rows
              .filter((r) => r.type !== 'VOID')
              .map((r) => ({
                entryId: r.id,
                folioId: r.folioId,
                reservationCode: r.folio.reservation?.code ?? null,
                guestName: r.folio.guest?.fullName ?? r.folio.name,
                type: r.type as 'PAYMENT' | 'REFUND',
                method: r.paymentMethod!,
                amountKobo: Math.abs(k(r.amountKobo)),
                reference: r.paymentRef,
                createdAt: r.createdAt.toISOString(),
                voided: voided.has(r.id),
              })),
    };
  }

  current(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const s = await tx.cashierShift.findFirst({ where: { tenantId: user.tenantId, userId: user.userId, status: 'OPEN' } });
      if (!s) return null;
      const v = await this.view(tx, null, s, false);
      // Always blind for the cashier's own open shift.
      return {
        ...v,
        blind: true,
        expectedCashKobo: null,
        expectedPosKobo: null,
        expectedTransferKobo: null,
        paymentsCount: null,
      };
    });
  }

  /** The caller's open shift for dashboards (blind). */
  async currentTx(tx: Tx, user: AuthUser) {
    const s = await tx.cashierShift.findFirst({ where: { tenantId: user.tenantId, userId: user.userId, status: 'OPEN' } });
    if (!s) return null;
    const v = await this.view(tx, null, s, false);
    return { ...v, blind: true, expectedCashKobo: null, expectedPosKobo: null, expectedTransferKobo: null, paymentsCount: null };
  }

  async open(user: AuthUser, dto: OpenShiftDto, ip?: string) {
    try {
      return await this.db.tenant(user.tenantId, async (tx) => {
        const existing = await tx.cashierShift.findFirst({ where: { tenantId: user.tenantId, userId: user.userId, status: 'OPEN' } });
        if (existing) {
          throw appError(HttpStatus.CONFLICT, 'SHIFT_ALREADY_OPEN', 'You already have an open shift', { shiftId: existing.id });
        }
        const s = await tx.cashierShift.create({
          data: {
            tenantId: user.tenantId,
            userId: user.userId,
            userName: user.fullName,
            openingFloatKobo: dto.openingFloatKobo,
            notes: dto.notes ?? '',
          },
        });
        await this.audit.record(tx, {
          tenantId: user.tenantId,
          actor: userActor(user),
          action: 'shift.opened',
          entityType: 'cashier_shift',
          entityId: s.id,
          metadata: { openingFloatKobo: dto.openingFloatKobo },
          ip,
        });
        return this.view(tx, user, s, false);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw appError(HttpStatus.CONFLICT, 'SHIFT_ALREADY_OPEN', 'You already have an open shift');
      throw e;
    }
  }

  close(user: AuthUser, id: string, dto: CloseShiftDto, ip?: string) {
    if (dto.denominations) {
      for (const [note, count] of Object.entries(dto.denominations)) {
        if (!NOTES.includes(note) || !Number.isInteger(count) || count < 0) {
          throw Err.validation('denominations', `Invalid denomination entry ${note}: ${count}`);
        }
      }
    }
    return this.db.tenant(user.tenantId, async (tx) => {
      const s = await tx.cashierShift.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!s) throw AppException.notFound('Shift');
      if (s.userId !== user.userId && !isManager(user.role)) throw AppException.forbidden('You can only close your own shift');
      if (s.status !== 'OPEN') throw Err.invalidState(s.status, ['OPEN'], 'This shift');
      // Lock the shift row so no payment slips in between computing and closing.
      await tx.$executeRaw`SELECT id FROM cashier_shifts WHERE id = ${id}::uuid FOR UPDATE`;
      const rows = await this.movements(tx, id);
      const movements: ShiftMovement[] = rows.map((r) => ({ type: r.type, method: r.paymentMethod, amountKobo: k(r.amountKobo) }));
      const expected = expectedTotals(k(s.openingFloatKobo), movements);
      const counted = { countedCashKobo: dto.countedCashKobo, declaredPosKobo: dto.declaredPosKobo, declaredTransferKobo: dto.declaredTransferKobo };
      const v = variance(expected, counted);
      const updated = await tx.cashierShift.update({
        where: { id },
        data: {
          status: 'CLOSED',
          closedAt: new Date(),
          closedById: user.userId,
          ...counted,
          denominations: (dto.denominations ?? undefined) as Prisma.InputJsonValue | undefined,
          expectedCashKobo: expected.expectedCashKobo,
          expectedPosKobo: expected.expectedPosKobo,
          expectedTransferKobo: expected.expectedTransferKobo,
          paymentsCount: expected.paymentsCount,
          closeNotes: dto.notes ?? null,
        },
      });
      const severity = shiftVarianceSeverity(v);
      if (severity) {
        const features = await this.guard.features(tx, user.tenantId);
        const worst = [v.varianceCashKobo, v.variancePosKobo, v.varianceTransferKobo].reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
        await this.guard.raise(tx, user.tenantId, features, {
          rule: 'SHIFT_VARIANCE',
          severity,
          title: `${s.userName}'s shift is ${worst < 0 ? 'short' : 'over'} by ₦${(Math.abs(worst) / 100).toLocaleString('en-NG')}`,
          detail: `Counted cash ₦${(dto.countedCashKobo / 100).toLocaleString('en-NG')} against ₦${(expected.expectedCashKobo / 100).toLocaleString('en-NG')} expected; POS variance ₦${(v.variancePosKobo / 100).toLocaleString('en-NG')}; transfer variance ₦${(v.varianceTransferKobo / 100).toLocaleString('en-NG')}.`,
          dedupeKey: `SHIFT_VARIANCE:${id}`,
          amountKobo: Math.abs(worst),
          shiftId: id,
          userId: s.userId,
          userName: s.userName,
          evidence: { ...expected, ...counted, ...v, openingFloatKobo: k(s.openingFloatKobo) },
        });
      }
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'shift.closed',
        entityType: 'cashier_shift',
        entityId: id,
        metadata: { ...counted, ...expected, ...v },
        ip,
      });
      return this.view(tx, user, updated, true);
    });
  }

  approve(user: AuthUser, id: string, notes: string | undefined, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const s = await tx.cashierShift.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!s) throw AppException.notFound('Shift');
      if (s.status !== 'CLOSED') throw Err.invalidState(s.status, ['CLOSED'], 'This shift');
      if (s.userId === user.userId && user.role !== 'OWNER') {
        throw AppException.forbidden('Another manager or the owner must approve your own shift');
      }
      const updated = await tx.cashierShift.update({
        where: { id },
        data: { status: 'APPROVED', approvedById: user.userId, approvedByName: user.fullName, approvedAt: new Date(), approvalNotes: notes ?? null },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'shift.approved',
        entityType: 'cashier_shift',
        entityId: id,
        metadata: { cashier: s.userName, notes: notes ?? null },
        ip,
      });
      return this.view(tx, user, updated, true);
    });
  }

  list(user: AuthUser, q: ShiftQueryDto) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const where: Prisma.CashierShiftWhereInput = {
        tenantId: user.tenantId,
        ...(q.status && { status: q.status }),
        ...(user.role === 'FRONT_DESK' ? { userId: user.userId } : q.userId ? { userId: q.userId } : {}),
        ...((q.from || q.to) && {
          openedAt: {
            ...(q.from && { gte: lagosStartOfDay(q.from) }),
            ...(q.to && { lt: lagosStartOfDay(addDays(q.to, 1)) }),
          },
        }),
      };
      const rows = await tx.cashierShift.findMany({ where, orderBy: { openedAt: 'desc' }, skip: pg.skip, take: pg.take });
      const total = await tx.cashierShift.count({ where });
      const items = [];
      for (const r of rows) items.push(await this.view(tx, user, r, false));
      return { items, total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  get(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const s = await tx.cashierShift.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!s) throw AppException.notFound('Shift');
      if (user.role === 'FRONT_DESK' && s.userId !== user.userId) throw AppException.notFound('Shift');
      return this.view(tx, user, s, true);
    });
  }
}
