import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { AppException } from '../../common/errors/app-exception.js';
import { addDays, lagosDate, lagosStartOfDay, nightsBetween } from '../../common/time/lagos.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { PaystackClient, type PaystackBank } from '../billing/paystack.client.js';
import { RedisService } from '../infra/redis.service.js';
import { appError, k, paginate, primaryProperty } from '../ops/ops.helpers.js';
import { maskRecipient, displayStatus, policyView } from './booking.logic.js';
import type { NotificationQueryDto, RangeQueryDto, SavePayoutAccountDto, UpdateBookingSettingsDto } from './booking.dto.js';
import { CommissionService } from './commission.service.js';

const BANKS_CACHE_KEY = 'paystack:banks:ng';

export type CommissionStatus = 'PENDING' | 'COLLECTED' | 'REVERSED' | 'NONE';

/**
 * Where a payment attempt's commission stands: PENDING = expected but not
 * taken (attempt not paid yet), COLLECTED = taken by the split (net of any
 * partial reversal), REVERSED = taken and given back in full (refund /
 * orphaned payment), NONE = no commission (booking site, failed attempt).
 */
export function commissionStatusOf(p: { status: string; commissionKobo: bigint | number }, collected: number, reversed: number): CommissionStatus {
  if (Number(p.commissionKobo) <= 0) return 'NONE';
  if (p.status === 'INITIALIZED') return 'PENDING';
  if (p.status === 'FAILED') return 'NONE';
  if (collected > 0 && reversed >= collected) return 'REVERSED';
  return collected > 0 ? 'COLLECTED' : 'PENDING';
}

function range(from?: string, to?: string) {
  const t = to ?? lagosDate();
  const f = from ?? addDays(t, -29);
  return { from: f, to: t, start: lagosStartOfDay(f), end: lagosStartOfDay(addDays(t, 1)) };
}

/**
 * Hotel-side M3: booking settings, payout onboarding (Paystack subaccount),
 * online revenue and commission, the online-booking feed, the notification
 * log and the `online` block of a reservation.
 */
@Injectable()
export class HotelBookingService {
  private readonly cipher: FieldCipher;

  constructor(
    private readonly db: DbService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly paystack: PaystackClient,
    private readonly redis: RedisService,
    private readonly commission: CommissionService,
  ) {
    this.cipher = new FieldCipher(config.get('GUEST_DATA_KEY'));
  }

  // ---------------------------------------------------------------------------
  // Booking settings
  // ---------------------------------------------------------------------------

  private async settingsView(tx: Tx, tenantId: string) {
    const p = await primaryProperty(tx, tenantId);
    const sub = await tx.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
    return {
      propertyId: p.id,
      onlineBookingEnabled: p.onlineBookingEnabled,
      allowPayAtHotel: p.allowPayAtHotel,
      requireCardForPayAtHotel: p.requireCardForPayAtHotel,
      cancellationPolicy: policyView(p),
      preArrivalMessage: p.preArrivalMessage,
      payoutReady: p.payoutReady,
      marketplaceListed: p.listedOnMarketplace,
      commissionBps: sub?.plan.commissionBps ?? 0,
      bookingSiteUrl: `${this.config.get('WEB_URL')}/h/${p.slug}`,
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  getSettings(user: AuthUser) {
    return this.db.tenant(user.tenantId, (tx) => this.settingsView(tx, user.tenantId));
  }

  updateSettings(user: AuthUser, dto: UpdateBookingSettingsDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const c = dto.cancellationPolicy ?? {};
      const data: Prisma.PropertyUpdateInput = {
        ...(dto.onlineBookingEnabled !== undefined && { onlineBookingEnabled: dto.onlineBookingEnabled }),
        ...(dto.allowPayAtHotel !== undefined && { allowPayAtHotel: dto.allowPayAtHotel }),
        ...(dto.requireCardForPayAtHotel !== undefined && { requireCardForPayAtHotel: dto.requireCardForPayAtHotel }),
        ...(dto.preArrivalMessage !== undefined && { preArrivalMessage: dto.preArrivalMessage.trim() }),
        ...(c.freeCancellationHours !== undefined && { freeCancellationHours: c.freeCancellationHours }),
        ...(c.lateCancellationFeePct !== undefined && { lateCancellationFeePct: c.lateCancellationFeePct }),
        ...(c.noShowFeePct !== undefined && { noShowFeePct: c.noShowFeePct }),
      };
      await tx.property.update({ where: { id: p.id }, data });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'booking_settings.updated',
        entityType: 'property',
        entityId: p.id,
        metadata: { changes: dto as unknown as Record<string, unknown> },
        ip,
      });
      return this.settingsView(tx, user.tenantId);
    });
  }

  // ---------------------------------------------------------------------------
  // Payouts
  // ---------------------------------------------------------------------------

  async banks(): Promise<PaystackBank[]> {
    const cached = await this.redis.getJson<PaystackBank[]>(`${BANKS_CACHE_KEY}:${this.paystack.providerName}`).catch(() => null);
    if (cached?.length) return cached;
    const banks = (await this.paystack.listBanks()).sort((a, b) => a.name.localeCompare(b.name));
    await this.redis.setJson(`${BANKS_CACHE_KEY}:${this.paystack.providerName}`, banks, 86_400).catch(() => undefined);
    return banks;
  }

  async resolveAccount(bankCode: string, accountNumber: string) {
    const bank = (await this.banks()).find((b) => b.code === bankCode);
    if (!bank) throw appError(HttpStatus.UNPROCESSABLE_ENTITY, 'ACCOUNT_RESOLVE_FAILED', 'Choose a bank from the list');
    const name = await this.paystack.resolveAccount(accountNumber, bankCode);
    if (!name) throw appError(HttpStatus.UNPROCESSABLE_ENTITY, 'ACCOUNT_RESOLVE_FAILED', `We could not find account ${accountNumber} at ${bank.name}. Check the number.`);
    return { bankCode, bankName: bank.name, accountNumber, accountName: name };
  }

  private payoutView(a: Awaited<ReturnType<Tx['payoutAccount']['findUnique']>>) {
    if (!a) return null;
    return {
      id: a.id,
      bankCode: a.bankCode,
      bankName: a.bankName,
      accountNumberMasked: `••••••${a.accountNumberLast4}`,
      accountName: a.accountName,
      businessName: a.businessName,
      subaccountCode: a.subaccountCode,
      settlementVerified: a.settlementVerified,
      percentageCharge: 0 as const,
      provider: a.provider as 'paystack' | 'mock',
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  }

  getPayoutAccount(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      return this.payoutView(await tx.payoutAccount.findUnique({ where: { propertyId: p.id } }));
    });
  }

  async savePayoutAccount(user: AuthUser, dto: SavePayoutAccountDto, ip?: string) {
    const resolved = await this.resolveAccount(dto.bankCode, dto.accountNumber);
    const { existing, property } = await this.db.tenant(user.tenantId, async (tx) => {
      const property = await primaryProperty(tx, user.tenantId);
      return { existing: await tx.payoutAccount.findUnique({ where: { propertyId: property.id } }), property };
    });
    const businessName = dto.businessName?.trim() || property.name;
    const sub = existing
      ? await this.paystack.updateSubaccount(existing.subaccountCode, { businessName, bankCode: dto.bankCode, accountNumber: dto.accountNumber })
      : await this.paystack.createSubaccount({ businessName, bankCode: dto.bankCode, accountNumber: dto.accountNumber, email: property.email || user.email });
    return this.db.tenant(user.tenantId, async (tx) => {
      const data = {
        bankCode: dto.bankCode,
        bankName: resolved.bankName,
        accountNumberEnc: this.cipher.encrypt(dto.accountNumber, user.tenantId),
        accountNumberLast4: dto.accountNumber.slice(-4),
        accountName: resolved.accountName,
        businessName,
        subaccountCode: sub.subaccountCode,
        provider: this.paystack.providerName,
        settlementVerified: sub.verified,
        percentageCharge: 0,
      };
      const saved = await tx.payoutAccount.upsert({ where: { propertyId: property.id }, create: { tenantId: user.tenantId, propertyId: property.id, ...data }, update: data });
      await tx.property.updateMany({ where: { tenantId: user.tenantId, id: property.id }, data: { payoutReady: true } });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'payout.account_saved',
        entityType: 'payout_account',
        entityId: saved.id,
        metadata: { bank: resolved.bankName, accountLast4: data.accountNumberLast4, accountName: resolved.accountName, subaccountCode: sub.subaccountCode, updated: !!existing },
        ip,
      });
      return this.payoutView(saved);
    });
  }

  payoutSummary(user: AuthUser, q: { from?: string; to?: string }) {
    const r = range(q.from, q.to);
    return this.db.tenant(user.tenantId, async (tx) => {
      const pays = await tx.bookingPayment.findMany({
        where: { tenantId: user.tenantId, status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, paidAt: { gte: r.start, lt: r.end } },
        include: { refunds: true },
      });
      const entries = await tx.commissionEntry.findMany({ where: { tenantId: user.tenantId, createdAt: { gte: r.start, lt: r.end } } });
      const sum = (f: (e: (typeof entries)[number]) => boolean) => entries.filter(f).reduce((a, e) => a + k(e.amountKobo), 0);
      const online = pays.reduce((a, p) => a + k(p.paidAmountKobo ?? p.amountKobo), 0);
      const refunds = pays.flatMap((p) => p.refunds).reduce((a, x) => a + k(x.amountKobo), 0);
      const commission = sum((e) => e.kind === 'COLLECTED') - sum((e) => e.kind === 'REVERSED' && !e.accrual);
      const payAtHotel = await tx.reservation.count({
        where: { tenantId: user.tenantId, paymentMode: 'PAY_AT_HOTEL', createdAt: { gte: r.start, lt: r.end }, status: { notIn: ['CANCELLED'] } },
      });
      const p = await primaryProperty(tx, user.tenantId);
      return {
        from: r.from,
        to: r.to,
        onlineRevenueKobo: online,
        refundsKobo: refunds,
        commissionKobo: commission,
        netToHotelKobo: online - refunds - commission,
        bookings: pays.length,
        payAtHotelBookings: payAtHotel,
        commissionAccruedKobo: sum((e) => e.kind === 'ACCRUED') - sum((e) => e.kind === 'REVERSED' && e.accrual),
        payoutReady: p.payoutReady,
      };
    });
  }

  payoutTransactions(user: AuthUser, q: RangeQueryDto) {
    const r = range(q.from, q.to);
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const where: Prisma.BookingPaymentWhereInput = {
        tenantId: user.tenantId,
        status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'ORPHANED'] },
        paidAt: { gte: r.start, lt: r.end },
      };
      const rows = await tx.bookingPayment.findMany({
        where,
        include: { refunds: true, commission: true, reservation: { include: { guest: { select: { fullName: true } } } } },
        orderBy: { paidAt: 'desc' },
        skip: pg.skip,
        take: pg.take,
      });
      const total = await tx.bookingPayment.count({ where });
      return {
        items: rows.map((p) => {
          const amount = k(p.paidAmountKobo ?? p.amountKobo);
          // Every refund decided for this payment (orphan auto-refunds included), whatever its provider status.
          const refunded = p.refunds.reduce((a, x) => a + k(x.amountKobo), 0);
          const lastRefund = [...p.refunds].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
          const comm = p.commission.filter((c) => c.kind === 'COLLECTED').reduce((a, c) => a + k(c.amountKobo), 0);
          const rev = p.commission.filter((c) => c.kind === 'REVERSED').reduce((a, c) => a + k(c.amountKobo), 0);
          return {
            paymentId: p.id,
            reference: p.reference,
            reservationId: p.reservationId,
            reservationCode: p.reservation.code,
            guestName: p.reservation.guest.fullName,
            channel: (p.reservation.source === 'BOOKING_SITE' ? 'BOOKING_SITE' : 'MARKETPLACE') as 'MARKETPLACE' | 'BOOKING_SITE',
            status: p.status,
            paidAt: p.paidAt?.toISOString() ?? null,
            amountKobo: amount,
            commissionBps: p.commissionBps,
            commissionKobo: comm,
            refundedKobo: refunded,
            commissionReversedKobo: rev,
            commissionStatus: commissionStatusOf(p, comm, rev),
            refundStatus: lastRefund?.status ?? null,
            orphanReason: p.orphanReason,
            netKobo: amount - comm - refunded + rev,
          };
        }),
        total,
        page: pg.page,
        pageSize: pg.pageSize,
      };
    });
  }

  commissionEntries(user: AuthUser, q: RangeQueryDto) {
    const r = range(q.from, q.to);
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const where: Prisma.CommissionEntryWhereInput = { tenantId: user.tenantId, createdAt: { gte: r.start, lt: r.end }, ...(q.kind && { kind: q.kind }) };
      const rows = await tx.commissionEntry.findMany({ where, include: { reservation: { select: { code: true } } }, orderBy: { createdAt: 'desc' }, skip: pg.skip, take: pg.take });
      const total = await tx.commissionEntry.count({ where });
      return {
        items: rows.map((e) => ({
          id: e.id,
          kind: e.kind,
          amountKobo: k(e.amountKobo),
          baseKobo: k(e.baseKobo),
          commissionBps: e.commissionBps,
          channel: e.channel,
          reservationId: e.reservationId,
          reservationCode: e.reservation.code,
          note: e.note,
          settledAt: e.settledAt?.toISOString() ?? null,
          createdAt: e.createdAt.toISOString(),
        })),
        total,
        page: pg.page,
        pageSize: pg.pageSize,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Online booking feed
  // ---------------------------------------------------------------------------

  feed(user: AuthUser, sinceRaw?: string, limit = 20) {
    const now = new Date();
    const parsed = sinceRaw ? new Date(sinceRaw) : null;
    const since = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(now.getTime() - 86_400_000);
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.reservation.findMany({
        where: { tenantId: user.tenantId, paymentMode: { not: null }, updatedAt: { gt: since }, AND: [{ OR: [{ cancelReason: null }, { cancelReason: { not: 'PAYMENT_INIT_FAILED' } }] }] },
        include: { guest: { select: { fullName: true } }, roomType: { select: { name: true } }, bookingPayments: true },
        orderBy: { updatedAt: 'desc' },
        take: Math.min(100, Math.max(1, limit)),
      });
      const today = lagosDate(now);
      const startToday = lagosStartOfDay(today);
      const activeHolds = await tx.reservation.count({ where: { tenantId: user.tenantId, status: 'PENDING', paymentMode: 'ONLINE', holdExpiresAt: { gt: now } } });
      const confirmedToday = await tx.reservation.count({
        where: {
          tenantId: user.tenantId,
          paymentMode: { not: null },
          status: { in: ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] },
          OR: [{ bookingPayments: { some: { status: 'SUCCEEDED', paidAt: { gte: startToday } } } }, { paymentMode: 'PAY_AT_HOTEL', createdAt: { gte: startToday } }],
        },
      });
      const arriving = await tx.reservation.count({
        where: { tenantId: user.tenantId, paymentMode: { not: null }, status: 'CONFIRMED', arrivalAt: { gte: startToday, lt: lagosStartOfDay(addDays(today, 8)) } },
      });
      return {
        now: now.toISOString(),
        items: rows.map((r) => {
          const paid = r.bookingPayments.filter((p) => ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status));
          const ds = displayStatus(r, now);
          const event =
            ds === 'EXPIRED' ? 'HOLD_EXPIRED' : r.status === 'CANCELLED' ? 'CANCELLED' : paid.length ? 'PAID' : 'NEW_BOOKING';
          const eventAt = event === 'PAID' ? (paid[0].paidAt ?? r.updatedAt) : event === 'CANCELLED' || event === 'HOLD_EXPIRED' ? (r.cancelledAt ?? r.updatedAt) : r.createdAt;
          return {
            reservationId: r.id,
            code: r.code,
            status: r.status,
            displayStatus: ds,
            event,
            eventAt: eventAt.toISOString(),
            channel: (r.source === 'BOOKING_SITE' ? 'BOOKING_SITE' : 'MARKETPLACE') as 'MARKETPLACE' | 'BOOKING_SITE',
            paymentMode: r.paymentMode!,
            guestName: r.guest.fullName,
            roomTypeName: r.roomType.name,
            arrivalDate: lagosDate(r.arrivalAt),
            departureDate: lagosDate(r.departureAt),
            nights: r.stayType === 'NIGHTLY' ? nightsBetween(r.arrivalAt, r.departureAt) : null,
            totalKobo: k(r.quotedTotalKobo),
            paidKobo: paid.reduce((a, p) => a + k(p.paidAmountKobo ?? p.amountKobo), 0),
            holdExpiresAt: ds === 'AWAITING_PAYMENT' ? (r.holdExpiresAt?.toISOString() ?? null) : null,
            createdAt: r.createdAt.toISOString(),
          };
        }),
        counts: { activeHolds, confirmedToday, arrivingNext7Days: arriving },
      };
    });
  }

  /** Counts for the Today board and dashboard (inside an open tenant transaction). */
  async onlineCountsTx(tx: Tx, tenantId: string, now = new Date()) {
    const today = lagosDate(now);
    const start = lagosStartOfDay(today);
    const end = lagosStartOfDay(addDays(today, 1));
    const [activeHolds, newToday, arrivalsToday] = [
      await tx.reservation.count({ where: { tenantId, status: 'PENDING', paymentMode: 'ONLINE', holdExpiresAt: { gt: now } } }),
      await tx.reservation.count({ where: { tenantId, paymentMode: { not: null }, createdAt: { gte: start }, status: { in: ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] } } }),
      await tx.reservation.count({ where: { tenantId, paymentMode: { not: null }, arrivalAt: { gte: start, lt: end }, status: { in: ['CONFIRMED', 'CHECKED_IN'] } } }),
    ];
    return { activeHolds, newToday, arrivalsToday };
  }

  // ---------------------------------------------------------------------------
  // Notification log
  // ---------------------------------------------------------------------------

  private logItem(l: { id: string; template: string; channel: string; audience: string; recipient: string; subject: string | null; bodyText: string; status: string; provider: string; providerMessageId: string | null; attempts: number; error: string | null; reservationId: string | null; createdAt: Date; sentAt: Date | null }, code: string | null) {
    return {
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
      reservationCode: code,
      createdAt: l.createdAt.toISOString(),
      sentAt: l.sentAt?.toISOString() ?? null,
    };
  }

  reservationNotifications(user: AuthUser, reservationId: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId: user.tenantId }, select: { code: true } });
      if (!r) throw AppException.notFound('Reservation');
      const rows = await tx.notificationLog.findMany({ where: { tenantId: user.tenantId, reservationId }, orderBy: { createdAt: 'asc' } });
      return rows.map((l) => this.logItem(l, r.code));
    });
  }

  notifications(user: AuthUser, q: NotificationQueryDto) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const where: Prisma.NotificationLogWhereInput = {
        tenantId: user.tenantId,
        ...(q.template && { template: q.template }),
        ...(q.channel && { channel: q.channel }),
        ...(q.status && { status: q.status }),
      };
      const rows = await tx.notificationLog.findMany({ where, include: { reservation: { select: { code: true } } }, orderBy: { createdAt: 'desc' }, skip: pg.skip, take: pg.take });
      const total = await tx.notificationLog.count({ where });
      return { items: rows.map((l) => this.logItem(l, l.reservation?.code ?? null)), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  notificationPreview(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const l = await tx.notificationLog.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!l) throw AppException.notFound('Notification');
      return { subject: l.subject, text: l.bodyText, html: l.bodyHtml };
    });
  }

  // ---------------------------------------------------------------------------
  // `online` block of ReservationDetail
  // ---------------------------------------------------------------------------

  async onlineInfo(tx: Tx, r: { id: string; paymentMode: string | null; source: string; guaranteeType: string | null; commissionBps: number | null; quotedTotalKobo: bigint | null; holdExpiresAt: Date | null; contactPhone: string | null; contactEmail: string | null; specialRequests: string; guestAccountId: string | null; cancelledBy: string | null; cancellationFeeKobo: bigint | null; status: string }, guestAccountId: string | null) {
    if (!r.paymentMode) return null;
    const payments = await tx.bookingPayment.findMany({ where: { reservationId: r.id }, orderBy: { createdAt: 'asc' }, include: { commission: true } });
    const refunds = await tx.bookingRefund.findMany({ where: { reservationId: r.id }, orderBy: { createdAt: 'asc' } });
    const c = await this.commission.totals(tx, r.id);
    return {
      channel: (r.source === 'BOOKING_SITE' ? 'BOOKING_SITE' : 'MARKETPLACE') as 'MARKETPLACE' | 'BOOKING_SITE',
      paymentMode: r.paymentMode,
      guaranteeType: r.guaranteeType ?? 'NONE',
      commissionBps: r.commissionBps ?? 0,
      quotedTotalKobo: k(r.quotedTotalKobo),
      holdExpiresAt: r.status === 'PENDING' ? (r.holdExpiresAt?.toISOString() ?? null) : null,
      contact: { phone: r.contactPhone ?? '', email: r.contactEmail },
      specialRequests: r.specialRequests,
      guestAccountLinked: !!(r.guestAccountId ?? guestAccountId),
      cancelledBy: r.cancelledBy,
      cancellationFeeKobo: r.cancellationFeeKobo === null ? null : k(r.cancellationFeeKobo),
      payments: payments.map((p) => {
        const taken = p.commission.filter((c) => c.kind === 'COLLECTED').reduce((a, c) => a + k(c.amountKobo), 0);
        const back = p.commission.filter((c) => c.kind === 'REVERSED').reduce((a, c) => a + k(c.amountKobo), 0);
        return {
          id: p.id,
          reference: p.reference,
          status: p.status,
          amountKobo: k(p.paidAmountKobo ?? p.amountKobo),
          commissionKobo: k(p.commissionKobo),
          commissionStatus: commissionStatusOf(p, taken, back),
          commissionTakenKobo: taken - back,
          paidAt: p.paidAt?.toISOString() ?? null,
          channel: p.channel,
          orphanReason: p.orphanReason,
        };
      }),
      refunds: refunds.map((x) => ({
        id: x.id,
        amountKobo: k(x.amountKobo),
        status: x.status,
        reason: x.reason,
        createdAt: x.createdAt.toISOString(),
        processedAt: x.processedAt?.toISOString() ?? null,
        error: x.error,
      })),
      commission: {
        collectedKobo: c.collectedKobo,
        accruedKobo: c.accruedKobo,
        reversedKobo: c.reversedKobo,
        netKobo: c.netKobo,
        // Expected on an unpaid online hold; becomes COLLECTED when the payment lands.
        pendingKobo:
          r.paymentMode === 'ONLINE' && !payments.some((p) => ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status))
            ? k(payments.find((p) => p.status === 'INITIALIZED')?.commissionKobo ?? 0)
            : 0,
      },
    };
  }
}
