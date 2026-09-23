import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppException } from '../../common/errors/app-exception.js';
import { billableHours, lagosDate, nightsBetween } from '../../common/time/lagos.js';
import type { Tx } from '../../prisma/db.service.js';
import { componentsFrom } from '../folios/tax.logic.js';
import { toImages } from '../public/hotel.mapper.js';
import { k } from '../ops/ops.helpers.js';
import {
  displayStatus,
  freeCancellationUntil,
  mapUrl,
  policyView,
  priceStay,
  REVIEW_WINDOW_DAYS,
  type PriceBreakdown,
} from './booking.logic.js';
import { BookingTokens } from './booking-tokens.service.js';

export const stayInclude = {
  property: true,
  roomType: true,
  room: true,
  guest: true,
  folio: { select: { id: true } },
  bookingPayments: { orderBy: { createdAt: 'asc' } },
  bookingRefunds: { orderBy: { createdAt: 'asc' } },
  review: { select: { id: true } },
} satisfies Prisma.ReservationInclude;

export type StayRow = Prisma.ReservationGetPayload<{ include: typeof stayInclude }>;

const PAID_STATUSES = ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;

export function hotelMini(p: StayRow['property']) {
  return {
    slug: p.slug,
    name: p.name,
    tagline: p.tagline,
    address: p.address,
    area: p.area,
    city: p.city,
    state: p.state,
    phone: p.phone,
    email: p.email,
    checkInTime: p.checkInTime,
    checkOutTime: p.checkOutTime,
    coverImageUrl: p.coverImageUrl,
    branding: { accentColor: p.accentColor, logoUrl: p.logoUrl },
    mapUrl: mapUrl(p),
  };
}

/** Money received online for a stay (orphaned payments are not the booking's money). */
export function paidOnline(r: Pick<StayRow, 'bookingPayments'>): number {
  return r.bookingPayments
    .filter((p) => (PAID_STATUSES as readonly string[]).includes(p.status))
    .reduce((a, p) => a + k(p.paidAmountKobo ?? p.amountKobo), 0);
}

/** Refunds of the booking's own payments (not of orphaned ones); failed refunds excluded. */
export function refundedOnline(r: Pick<StayRow, 'bookingPayments' | 'bookingRefunds'>): number {
  const own = new Set(r.bookingPayments.filter((p) => p.status !== 'ORPHANED').map((p) => p.id));
  return r.bookingRefunds.filter((x) => own.has(x.paymentId) && x.status !== 'FAILED').reduce((a, x) => a + k(x.amountKobo), 0);
}

/**
 * Guest-facing views of a stay (BookingView, TripSummary). Pure reads on the
 * transaction passed in: a tenant transaction for token-based access, or the
 * platform transaction for payment callbacks and the cross-hotel trip list.
 */
@Injectable()
export class BookingViewService {
  constructor(readonly tokens: BookingTokens) {}

  async load(tx: Tx, tenantId: string, reservationId: string): Promise<StayRow> {
    const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId }, include: stayInclude });
    if (!r) throw AppException.notFound('Booking');
    return r;
  }

  /** The quoted breakdown, or (desk bookings) the price computed from the rate and today's tax settings. */
  async breakdown(tx: Tx, r: StayRow): Promise<PriceBreakdown> {
    if (r.quote && typeof r.quote === 'object') return r.quote as unknown as PriceBreakdown;
    const tax = await tx.taxSetting.findUnique({ where: { propertyId: r.propertyId } });
    const comps = tax ? componentsFrom(tax) : [];
    return r.stayType === 'NIGHTLY'
      ? priceStay({ stayType: 'NIGHTLY', rateKobo: k(r.rateKobo), roomTypeName: r.roomType.name, components: comps, arrivalDate: lagosDate(r.arrivalAt), nights: nightsBetween(r.arrivalAt, r.departureAt) })
      : priceStay({ stayType: 'DAY_USE', rateKobo: k(r.rateKobo), roomTypeName: r.roomType.name, components: comps, date: lagosDate(r.arrivalAt), hours: billableHours(r.arrivalAt, r.departureAt) });
  }

  manageToken(r: Pick<StayRow, 'tenantId' | 'id' | 'code' | 'departureAt'>): string {
    return this.tokens.signTrip(r.tenantId, r.id, r.code, r.departureAt);
  }

  reviewState(r: StayRow, now = new Date()) {
    const submitted = !!r.review;
    if (r.status !== 'CHECKED_OUT' || !r.checkedOutAt) return { eligible: false, submitted, token: null, deadline: null };
    const { token, deadline } = this.tokens.signReview(r.tenantId, r.id, r.checkedOutAt);
    const open = deadline > now;
    return { eligible: open && !submitted, submitted, token: open && !submitted ? token : null, deadline: deadline.toISOString() };
  }

  async view(tx: Tx, r: StayRow, now = new Date()) {
    const breakdown = await this.breakdown(tx, r);
    const paid = paidOnline(r);
    const refunded = refundedOnline(r);
    const policy = policyView(r.property);
    const status = displayStatus(r, now);
    const cancelled = r.status === 'CANCELLED' || r.status === 'NO_SHOW';
    const total = r.quotedTotalKobo !== null ? k(r.quotedTotalKobo) : breakdown.totalKobo;
    const token = this.manageToken(r);
    const lastPayment = [...r.bookingPayments].reverse().find((p) => p.status !== 'ORPHANED') ?? null;
    const refundRows = r.bookingRefunds.filter((x) => x.reason !== 'PAYMENT_ORPHANED');
    const docs = r.folio
      ? {
          invoices: (
            await tx.guestInvoice.findMany({ where: { folioId: r.folio.id }, orderBy: { issuedAt: 'asc' }, select: { id: true, number: true, kind: true, issuedAt: true, totalKobo: true } })
          ).map((i) => ({ id: i.id, number: i.number, kind: i.kind, issuedAt: i.issuedAt.toISOString(), totalKobo: k(i.totalKobo) })),
          receipts: (
            await tx.receipt.findMany({ where: { folioId: r.folio.id }, orderBy: { issuedAt: 'asc' }, select: { id: true, number: true, issuedAt: true, amountKobo: true, method: true } })
          ).map((x) => ({ id: x.id, number: x.number, issuedAt: x.issuedAt.toISOString(), amountKobo: k(x.amountKobo), method: x.method })),
        }
      : { invoices: [], receipts: [] };
    const img = toImages(r.roomType.images)[0] ?? null;
    const holdActive = status === 'AWAITING_PAYMENT' && r.holdExpiresAt;
    const shareText = `${r.property.name}: booking ${r.code}, ${lagosDate(r.arrivalAt)} to ${lagosDate(r.departureAt)}. ${this.tokens.manageUrl(r.code, token)}`;
    return {
      code: r.code,
      status: r.status,
      displayStatus: status,
      channel: (r.source === 'BOOKING_SITE' ? 'BOOKING_SITE' : 'MARKETPLACE') as 'MARKETPLACE' | 'BOOKING_SITE',
      paymentMode: r.paymentMode ?? 'PAY_AT_HOTEL',
      guaranteeType: r.guaranteeType ?? 'NONE',
      hotel: hotelMini(r.property),
      roomType: { id: r.roomType.id, name: r.roomType.name, bedType: r.roomType.bedType, capacity: r.roomType.capacity, image: img },
      roomNumber: r.status === 'CHECKED_IN' || r.status === 'CHECKED_OUT' ? (r.room?.number ?? null) : null,
      stayType: r.stayType,
      arrivalAt: r.arrivalAt.toISOString(),
      departureAt: r.departureAt.toISOString(),
      arrivalDate: lagosDate(r.arrivalAt),
      departureDate: lagosDate(r.departureAt),
      nights: r.stayType === 'NIGHTLY' ? nightsBetween(r.arrivalAt, r.departureAt) : null,
      hours: r.stayType === 'DAY_USE' ? billableHours(r.arrivalAt, r.departureAt) : null,
      adults: r.adults,
      children: r.children,
      guest: { fullName: r.guest.fullName, phone: r.contactPhone ?? r.guest.phone ?? '', email: r.contactEmail ?? r.guest.email },
      breakdown,
      totalKobo: total,
      paidKobo: paid,
      refundedKobo: refunded,
      outstandingKobo: cancelled || status === 'EXPIRED' ? 0 : Math.max(0, total - paid),
      hold: holdActive ? { expiresAt: r.holdExpiresAt!.toISOString(), secondsLeft: Math.max(0, Math.floor((r.holdExpiresAt!.getTime() - now.getTime()) / 1000)) } : null,
      payment: lastPayment
        ? {
            reference: lastPayment.reference,
            status: lastPayment.status,
            amountKobo: k(lastPayment.amountKobo),
            paidAt: lastPayment.paidAt?.toISOString() ?? null,
            channel: lastPayment.channel,
          }
        : null,
      cancellation:
        r.status === 'CANCELLED' && r.cancelledAt
          ? {
              cancelledAt: r.cancelledAt.toISOString(),
              cancelledBy: r.cancelledBy ?? 'HOTEL',
              reason: r.cancelReason,
              feeKobo: k(r.cancellationFeeKobo),
              refundKobo: refundRows.reduce((a, x) => a + k(x.amountKobo), 0),
              refundStatus: refundRows.length ? refundRows[refundRows.length - 1].status : null,
            }
          : null,
      cancellationPolicy: policy,
      freeCancellationUntil: freeCancellationUntil(r.arrivalAt, r.property, now)?.toISOString() ?? null,
      canCancel: (r.status === 'PENDING' || r.status === 'CONFIRMED') && status !== 'EXPIRED' && r.arrivalAt > now,
      specialRequests: r.specialRequests,
      calendarUrl: this.tokens.calendarUrl(r.code, token),
      whatsappShareUrl: `https://wa.me/?text=${encodeURIComponent(shareText)}`,
      documents: docs,
      review: this.reviewState(r, now),
      createdAt: r.createdAt.toISOString(),
    };
  }

  tripSummary(r: StayRow, now = new Date()) {
    const status = displayStatus(r, now);
    const paid = paidOnline(r);
    const total = r.quotedTotalKobo !== null ? k(r.quotedTotalKobo) : k(r.rateKobo) * (r.stayType === 'NIGHTLY' ? nightsBetween(r.arrivalAt, r.departureAt) : billableHours(r.arrivalAt, r.departureAt));
    const token = this.manageToken(r);
    const review = this.reviewState(r, now);
    const cancelled = r.status === 'CANCELLED' || r.status === 'NO_SHOW';
    return {
      code: r.code,
      status: r.status,
      displayStatus: status,
      hotel: {
        slug: r.property.slug,
        name: r.property.name,
        city: r.property.city,
        area: r.property.area,
        coverImageUrl: r.property.coverImageUrl,
        branding: { accentColor: r.property.accentColor, logoUrl: r.property.logoUrl },
      },
      roomTypeName: r.roomType.name,
      stayType: r.stayType,
      arrivalAt: r.arrivalAt.toISOString(),
      departureAt: r.departureAt.toISOString(),
      arrivalDate: lagosDate(r.arrivalAt),
      departureDate: lagosDate(r.departureAt),
      nights: r.stayType === 'NIGHTLY' ? nightsBetween(r.arrivalAt, r.departureAt) : null,
      hours: r.stayType === 'DAY_USE' ? billableHours(r.arrivalAt, r.departureAt) : null,
      totalKobo: total,
      paidKobo: paid,
      outstandingKobo: cancelled || status === 'EXPIRED' ? 0 : Math.max(0, total - paid),
      paymentMode: r.paymentMode,
      channel: r.source,
      hold: status === 'AWAITING_PAYMENT' && r.holdExpiresAt ? { expiresAt: r.holdExpiresAt.toISOString(), secondsLeft: Math.max(0, Math.floor((r.holdExpiresAt.getTime() - now.getTime()) / 1000)) } : null,
      canReview: review.eligible,
      reviewed: review.submitted,
      manageToken: token,
      manageUrl: this.tokens.manageUrl(r.code, token),
    };
  }

  static readonly REVIEW_WINDOW_DAYS = REVIEW_WINDOW_DAYS;
}
