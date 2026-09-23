import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { PlatformPrincipal } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { addDays, dateRange, lagosDate, lagosStartOfDay } from '../../common/time/lagos.js';
import { maskPhone } from '../../common/utils/phone.js';
import { DbService } from '../../prisma/db.service.js';
import { AuditService, platformActor } from '../audit/audit.service.js';
import { appError, k, paginate } from '../ops/ops.helpers.js';
import { HOLD_EXPIRED_REASON, maskRecipient } from './booking.logic.js';
import type { NotificationQueryDto } from './booking.dto.js';
import { RefundsService } from './refunds.service.js';

function monthBounds(month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw appError(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'month must be YYYY-MM', { fields: { month: ['YYYY-MM'] } });
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { start: lagosStartOfDay(`${month}-01`), end: lagosStartOfDay(`${next}-01`) };
}

/**
 * Platform console for the marketplace: GMV, commission collected and
 * receivable, orphaned payments and refunds, notifications. Cross-tenant by
 * nature, so it runs on the platform role.
 */
@Injectable()
export class PlatformMarketplaceService {
  constructor(
    private readonly db: DbService,
    private readonly refunds: RefundsService,
    private readonly audit: AuditService,
  ) {}

  summary(q: { from?: string; to?: string }) {
    const to = q.to ?? lagosDate();
    const from = q.from ?? addDays(to, -29);
    const start = lagosStartOfDay(from);
    const end = lagosStartOfDay(addDays(to, 1));
    return this.db.system(async (tx) => {
      const res = await tx.reservation.findMany({
        where: { paymentMode: { not: null }, createdAt: { gte: start, lt: end }, AND: [{ OR: [{ cancelReason: null }, { cancelReason: { not: 'PAYMENT_INIT_FAILED' } }] }] },
        select: { id: true, tenantId: true, source: true, paymentMode: true, status: true, cancelReason: true, quotedTotalKobo: true, createdAt: true },
      });
      const entries = await tx.commissionEntry.findMany({ select: { tenantId: true, kind: true, accrual: true, amountKobo: true, createdAt: true, settledAt: true } });
      const pays = await tx.bookingPayment.findMany({
        where: { status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, paidAt: { gte: start, lt: end } },
        select: { paidAmountKobo: true, amountKobo: true },
      });
      const refunds = await tx.bookingRefund.findMany({ where: { createdAt: { gte: start, lt: end }, status: { not: 'FAILED' } }, select: { amountKobo: true } });
      const orphanedOpen = await tx.bookingPayment.count({ where: { status: 'ORPHANED', refunds: { none: { status: 'PROCESSED' } } } });
      const tenants = await tx.tenant.findMany({
        include: { properties: { select: { name: true, slug: true, payoutReady: true }, orderBy: { createdAt: 'asc' }, take: 1 }, subscription: { include: { plan: { select: { code: true } } } } },
      });

      const counted = res.filter((r) => r.status !== 'CANCELLED' && r.status !== 'PENDING');
      const inRange = (d: Date) => d >= start && d < end;
      const collectedNet = (tid?: string) =>
        entries
          .filter((e) => (!tid || e.tenantId === tid) && inRange(e.createdAt))
          .reduce((a, e) => a + (e.kind === 'COLLECTED' ? k(e.amountKobo) : e.kind === 'REVERSED' && !e.accrual ? -k(e.amountKobo) : 0), 0);
      const receivable = (tid?: string) =>
        entries
          .filter((e) => (!tid || e.tenantId === tid) && !e.settledAt)
          .reduce((a, e) => a + (e.kind === 'ACCRUED' ? k(e.amountKobo) : e.kind === 'REVERSED' && e.accrual ? -k(e.amountKobo) : 0), 0);

      const byHotel = tenants
        .map((t) => {
          const mine = counted.filter((r) => r.tenantId === t.id);
          return {
            tenantId: t.id,
            hotelName: t.properties[0]?.name ?? t.name,
            slug: t.properties[0]?.slug ?? t.slug,
            planCode: t.subscription?.plan.code ?? '',
            payoutReady: t.properties[0]?.payoutReady ?? false,
            bookings: mine.length,
            gmvKobo: mine.reduce((a, r) => a + k(r.quotedTotalKobo), 0),
            commissionCollectedKobo: collectedNet(t.id),
            commissionReceivableKobo: receivable(t.id),
          };
        })
        .filter((h) => h.bookings > 0 || h.commissionReceivableKobo !== 0 || h.commissionCollectedKobo !== 0)
        .sort((a, b) => b.gmvKobo - a.gmvKobo);

      const byDay = dateRange(from, to).map((date) => {
        const ds = lagosStartOfDay(date);
        const de = lagosStartOfDay(addDays(date, 1));
        const day = counted.filter((r) => r.createdAt >= ds && r.createdAt < de);
        const comm = entries
          .filter((e) => e.createdAt >= ds && e.createdAt < de)
          .reduce((a, e) => a + (e.kind === 'REVERSED' ? -k(e.amountKobo) : k(e.amountKobo)), 0);
        return { date, bookings: day.length, gmvKobo: day.reduce((a, r) => a + k(r.quotedTotalKobo), 0), commissionKobo: comm };
      });

      return {
        from,
        to,
        gmvKobo: counted.reduce((a, r) => a + k(r.quotedTotalKobo), 0),
        onlineCollectedKobo: pays.reduce((a, p) => a + k(p.paidAmountKobo ?? p.amountKobo), 0),
        refundsKobo: refunds.reduce((a, x) => a + k(x.amountKobo), 0),
        commissionCollectedKobo: collectedNet(),
        commissionReceivableKobo: receivable(),
        bookings: {
          total: counted.length,
          marketplace: counted.filter((r) => r.source === 'MARKETPLACE').length,
          bookingSite: counted.filter((r) => r.source === 'BOOKING_SITE').length,
          payOnline: counted.filter((r) => r.paymentMode === 'ONLINE').length,
          payAtHotel: counted.filter((r) => r.paymentMode === 'PAY_AT_HOTEL').length,
          cancelled: res.filter((r) => r.status === 'CANCELLED' && r.cancelReason !== HOLD_EXPIRED_REASON).length,
          expiredHolds: res.filter((r) => r.status === 'CANCELLED' && r.cancelReason === HOLD_EXPIRED_REASON).length,
        },
        orphanedOpen,
        byHotel,
        byDay,
      };
    });
  }

  /** Small block for GET /platform/metrics. */
  async metricsBlock(now = new Date()) {
    const s = await this.summary({ to: lagosDate(now), from: addDays(lagosDate(now), -29) });
    const flagged = await this.db.system((tx) => tx.review.count({ where: { status: 'FLAGGED' } }));
    return { gmv30dKobo: s.gmvKobo, commission30dKobo: s.commissionCollectedKobo, receivableKobo: s.commissionReceivableKobo, orphanedOpen: s.orphanedOpen, flaggedReviews: flagged };
  }

  receivables(month?: string) {
    const m = month ?? lagosDate().slice(0, 7);
    const { start, end } = monthBounds(m);
    return this.db.system(async (tx) => {
      const entries = await tx.commissionEntry.findMany({
        where: { createdAt: { gte: start, lt: end }, OR: [{ kind: 'ACCRUED' }, { kind: 'REVERSED', accrual: true }] },
        include: { tenant: { include: { properties: { select: { name: true, slug: true }, orderBy: { createdAt: 'asc' }, take: 1 } } } },
      });
      const byTenant = new Map<string, typeof entries>();
      for (const e of entries) byTenant.set(e.tenantId, [...(byTenant.get(e.tenantId) ?? []), e]);
      const items = [...byTenant.entries()].map(([tenantId, list]) => {
        const accrued = list.filter((e) => e.kind === 'ACCRUED').reduce((a, e) => a + k(e.amountKobo), 0);
        const reversed = list.filter((e) => e.kind === 'REVERSED').reduce((a, e) => a + k(e.amountKobo), 0);
        const settled = list.filter((e) => e.settledAt);
        const settledKobo = settled.reduce((a, e) => a + (e.kind === 'ACCRUED' ? k(e.amountKobo) : -k(e.amountKobo)), 0);
        const allSettled = list.every((e) => e.settledAt);
        return {
          tenantId,
          hotelName: list[0].tenant.properties[0]?.name ?? list[0].tenant.name,
          slug: list[0].tenant.properties[0]?.slug ?? list[0].tenant.slug,
          bookings: new Set(list.filter((e) => e.kind === 'ACCRUED').map((e) => e.reservationId)).size,
          accruedKobo: accrued,
          reversedKobo: reversed,
          dueKobo: accrued - reversed - settledKobo,
          settledKobo,
          settledAt: allSettled && settled.length ? settled.reduce((a, e) => (e.settledAt! > a ? e.settledAt! : a), settled[0].settledAt!).toISOString() : null,
        };
      });
      items.sort((a, b) => b.dueKobo - a.dueKobo);
      return { month: m, totalDueKobo: items.reduce((a, i) => a + i.dueKobo, 0), items };
    });
  }

  async settle(actor: PlatformPrincipal, dto: { tenantId: string; month: string; reference?: string }, ip?: string) {
    const { start, end } = monthBounds(dto.month);
    await this.db.system(async (tx) => {
      const res = await tx.commissionEntry.updateMany({
        where: { tenantId: dto.tenantId, createdAt: { gte: start, lt: end }, settledAt: null, OR: [{ kind: 'ACCRUED' }, { kind: 'REVERSED', accrual: true }] },
        data: { settledAt: new Date(), settlementRef: dto.reference ?? null },
      });
      await this.audit.record(tx, {
        tenantId: dto.tenantId,
        actor: platformActor(actor),
        action: 'commission.receivable_settled',
        entityType: 'tenant',
        entityId: dto.tenantId,
        metadata: { month: dto.month, entries: res.count, reference: dto.reference ?? null },
        ip,
      });
    });
    const all = await this.receivables(dto.month);
    return (
      all.items.find((i) => i.tenantId === dto.tenantId) ?? {
        tenantId: dto.tenantId,
        hotelName: '',
        slug: '',
        bookings: 0,
        accruedKobo: 0,
        reversedKobo: 0,
        dueKobo: 0,
        settledKobo: 0,
        settledAt: null,
      }
    );
  }

  private orphanView(p: Prisma.BookingPaymentGetPayload<{ include: { refunds: true; reservation: { include: { guest: true; property: true } } } }>) {
    const refund = [...p.refunds].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
    return {
      id: p.id,
      reference: p.reference,
      tenantId: p.tenantId,
      hotelName: p.reservation.property.name,
      reservationId: p.reservationId,
      reservationCode: p.reservation.code,
      guestName: p.reservation.guest.fullName,
      guestPhoneMasked: maskPhone(p.reservation.contactPhone ?? p.reservation.guest.phone ?? ''),
      amountKobo: k(p.paidAmountKobo ?? p.amountKobo),
      orphanReason: p.orphanReason,
      paidAt: p.paidAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
      refund: refund ? { id: refund.id, amountKobo: k(refund.amountKobo), status: refund.status, error: refund.error, processedAt: refund.processedAt?.toISOString() ?? null } : null,
    };
  }

  orphaned(q: { status?: string; page?: number; pageSize?: number }) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.system(async (tx) => {
      const where: Prisma.BookingPaymentWhereInput = {
        status: 'ORPHANED',
        ...(q.status !== 'all' && { refunds: { none: { status: 'PROCESSED' } } }),
      };
      const rows = await tx.bookingPayment.findMany({
        where,
        include: { refunds: true, reservation: { include: { guest: true, property: true } } },
        orderBy: { createdAt: 'desc' },
        skip: pg.skip,
        take: pg.take,
      });
      const total = await tx.bookingPayment.count({ where });
      return { items: rows.map((p) => this.orphanView(p)), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  async retryRefund(actor: PlatformPrincipal, paymentId: string, ip?: string) {
    const failed = await this.db.system(async (tx) => {
      const refund = await tx.bookingRefund.findFirst({ where: { paymentId, status: 'FAILED' }, orderBy: { createdAt: 'desc' } });
      if (refund) {
        await this.audit.record(tx, {
          tenantId: refund.tenantId,
          actor: platformActor(actor),
          action: 'refund.retried',
          entityType: 'booking_refund',
          entityId: refund.id,
          metadata: { paymentId, amountKobo: k(refund.amountKobo) },
          ip,
        });
      }
      return refund;
    });
    if (!failed) {
      const exists = await this.db.system((tx) => tx.bookingPayment.findUnique({ where: { id: paymentId } }));
      if (!exists) throw AppException.notFound('Payment');
      throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'There is no failed refund to retry for this payment', { status: exists.status, allowed: ['FAILED'] });
    }
    await this.refunds.retry(failed.id);
    return this.db.system(async (tx) => this.orphanView(await tx.bookingPayment.findUniqueOrThrow({ where: { id: paymentId }, include: { refunds: true, reservation: { include: { guest: true, property: true } } } })));
  }

  notifications(q: NotificationQueryDto) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.system(async (tx) => {
      const where: Prisma.NotificationLogWhereInput = {
        ...(q.template && { template: q.template }),
        ...(q.channel && { channel: q.channel }),
        ...(q.status && { status: q.status }),
      };
      const rows = await tx.notificationLog.findMany({
        where,
        include: { reservation: { select: { code: true } }, tenant: { include: { properties: { select: { name: true }, take: 1 } } } },
        orderBy: { createdAt: 'desc' },
        skip: pg.skip,
        take: pg.take,
      });
      const total = await tx.notificationLog.count({ where });
      return {
        items: rows.map((l) => ({
          id: l.id,
          template: l.template,
          channel: l.channel,
          audience: l.audience,
          recipientMasked: maskRecipient(l.recipient),
          subject: l.subject,
          preview: l.bodyText.slice(0, 160),
          status: l.status,
          provider: l.provider,
          providerMessageId: l.providerMessageId,
          attempts: l.attempts,
          error: l.error,
          reservationId: l.reservationId,
          reservationCode: l.reservation?.code ?? null,
          createdAt: l.createdAt.toISOString(),
          sentAt: l.sentAt?.toISOString() ?? null,
          tenantId: l.tenantId,
          hotelName: l.tenant?.properties[0]?.name ?? l.tenant?.name ?? null,
        })),
        total,
        page: pg.page,
        pageSize: pg.pageSize,
      };
    });
  }
}
