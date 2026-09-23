import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma, Review } from '../../generated/prisma/client.js';
import type { AuthUser, PlatformPrincipal } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { addDays, lagosDate, lagosStartOfDay } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, platformActor, userActor } from '../audit/audit.service.js';
import { REVIEW_WINDOW_DAYS } from '../booking/booking.logic.js';
import { BookingTokens } from '../booking/booking-tokens.service.js';
import { appError, isUniqueViolation, paginate } from '../ops/ops.helpers.js';
import { reviewSummaryOf } from '../public/hotel.mapper.js';
import type { HotelReviewsQueryDto, ModerateReviewDto, PlatformReviewsQueryDto, PublicReviewsQueryDto, SubmitReviewDto } from './reviews.dto.js';
import { aggregate, displayName, looksLikePii, stayMonth } from './reviews.logic.js';

const VISIBLE = ['PUBLISHED', 'FLAGGED'] as const;

type ReviewWithStay = Review & { reservation: { code: string }; guest: { fullName: string } };

export function publicReview(r: Review) {
  return {
    id: r.id,
    overall: r.overall,
    cleanliness: r.cleanliness,
    service: r.service,
    location: r.location,
    value: r.value,
    title: r.title,
    body: r.body,
    stayMonth: r.stayMonth,
    travellerType: r.travellerType,
    displayName: r.displayName,
    verifiedStay: true as const,
    createdAt: r.createdAt.toISOString(),
    hotelReply: r.hotelReply && r.hotelRepliedAt ? { body: r.hotelReply, repliedAt: r.hotelRepliedAt.toISOString() } : null,
  };
}

export function hotelReview(r: ReviewWithStay) {
  return {
    ...publicReview(r),
    status: r.status,
    reservationId: r.reservationId,
    reservationCode: r.reservation.code,
    guestName: r.guest.fullName,
    flaggedReason: r.flaggedReason,
    flaggedAt: r.flaggedAt?.toISOString() ?? null,
    moderation: r.status === 'HIDDEN' && r.hiddenReason ? { reason: r.hiddenReason, note: r.moderationNote, at: (r.moderatedAt ?? r.updatedAt).toISOString() } : null,
  };
}

const withStay = { reservation: { select: { code: true } }, guest: { select: { fullName: true } } } satisfies Prisma.ReviewInclude;

/**
 * Verified-stay reviews: one per checked-out reservation, within 30 days,
 * submitted through a signed link. Aggregates live on the property row and
 * are recomputed in the same transaction as every change.
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly db: DbService,
    private readonly tokens: BookingTokens,
    private readonly audit: AuditService,
  ) {}

  async recompute(tx: Tx, propertyId: string): Promise<void> {
    const rows = await tx.review.findMany({
      where: { propertyId, status: { in: [...VISIBLE] } },
      select: { overall: true, cleanliness: true, service: true, location: true, value: true, travellerType: true },
    });
    const a = aggregate(rows);
    await tx.property.update({
      where: { id: propertyId },
      data: {
        rating: a.rating,
        reviewCount: a.count,
        ratingCleanliness: a.cleanliness,
        ratingService: a.service,
        ratingLocation: a.location,
        ratingValue: a.value,
        ratingDistribution: { stars: a.stars, byTravellerType: a.byTravellerType },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Public
  // ---------------------------------------------------------------------------

  async publicList(slug: string, q: PublicReviewsQueryDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 10;
    return this.db.public(async (tx) => {
      const p = await tx.property.findFirst({
        where: { slug: slug.toLowerCase(), tenant: { subscription: { is: { status: { not: 'SUSPENDED' } } } } },
      });
      if (!p) throw AppException.notFound('Hotel');
      const where: Prisma.ReviewWhereInput = {
        propertyId: p.id,
        status: { in: [...VISIBLE] },
        ...(q.travellerType && { travellerType: q.travellerType }),
        ...(q.rating && { overall: q.rating }),
      };
      const orderBy: Prisma.ReviewOrderByWithRelationInput[] =
        q.sort === 'highest' ? [{ overall: 'desc' }, { createdAt: 'desc' }] : q.sort === 'lowest' ? [{ overall: 'asc' }, { createdAt: 'desc' }] : [{ createdAt: 'desc' }];
      const items = await tx.review.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize });
      const total = await tx.review.count({ where });
      return { summary: reviewSummaryOf(p), items: items.map(publicReview), total, page, pageSize };
    });
  }

  private eligibility(r: { status: string; checkedOutAt: Date | null; review: { id: string } | null }, expired: boolean, now: Date) {
    if (r.review) return 'ALREADY_REVIEWED' as const;
    if (r.status !== 'CHECKED_OUT' || !r.checkedOutAt) return 'NOT_CHECKED_OUT' as const;
    if (expired || r.checkedOutAt.getTime() + REVIEW_WINDOW_DAYS * 86_400_000 <= now.getTime()) return 'WINDOW_CLOSED' as const;
    return null;
  }

  async requestContext(t: string) {
    const { tenantId, reservationId, expired } = this.tokens.readReview(t);
    const now = new Date();
    return this.db.tenant(tenantId, async (tx) => {
      const r = await tx.reservation.findFirst({
        where: { id: reservationId, tenantId },
        include: { property: true, roomType: true, guest: true, review: { select: { id: true } } },
      });
      if (!r) throw AppException.notFound('Review link');
      const reason = this.eligibility(r, expired, now);
      const deadline = r.checkedOutAt ? new Date(r.checkedOutAt.getTime() + REVIEW_WINDOW_DAYS * 86_400_000) : null;
      return {
        eligible: reason === null,
        reason,
        hotel: { slug: r.property.slug, name: r.property.name, coverImageUrl: r.property.coverImageUrl, branding: { accentColor: r.property.accentColor, logoUrl: r.property.logoUrl } },
        stay: { code: r.code, roomTypeName: r.roomType.name, arrivalDate: lagosDate(r.arrivalAt), departureDate: lagosDate(r.departureAt), stayMonth: stayMonth(lagosDate(r.arrivalAt)) },
        guestFirstName: r.guest.fullName.trim().split(/\s+/)[0] ?? '',
        displayName: displayName(r.guest.fullName),
        deadline: deadline?.toISOString() ?? null,
      };
    });
  }

  async submit(dto: SubmitReviewDto, ip?: string) {
    const { tenantId, reservationId, expired } = this.tokens.readReview(dto.token);
    if (expired) throw appError(HttpStatus.GONE, 'LINK_EXPIRED', 'Reviews can be left for 30 days after check-out; this link has expired.');
    const now = new Date();
    try {
      return await this.db.tenant(tenantId, async (tx) => {
        await tx.$queryRaw`SELECT id FROM reservations WHERE id = ${reservationId}::uuid FOR UPDATE`;
        const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId }, include: { guest: true, review: { select: { id: true } } } });
        if (!r) throw AppException.notFound('Review link');
        const reason = this.eligibility(r, false, now);
        if (reason) throw this.notAllowed(reason);
        const pii = looksLikePii(`${dto.title ?? ''} ${dto.body}`);
        const review = await tx.review.create({
          data: {
            tenantId,
            propertyId: r.propertyId,
            reservationId: r.id,
            guestId: r.guestId,
            guestAccountId: r.guestAccountId ?? r.guest.guestAccountId,
            overall: dto.overall,
            cleanliness: dto.cleanliness,
            service: dto.service,
            location: dto.location,
            value: dto.value,
            title: dto.title || null,
            body: dto.body,
            stayMonth: stayMonth(lagosDate(r.arrivalAt)),
            travellerType: dto.travellerType,
            displayName: displayName(r.guest.fullName),
            status: pii ? 'FLAGGED' : 'PUBLISHED',
            ...(pii && { flaggedReason: 'Automatic check: the text may contain a phone number or email address', flaggedAt: now }),
          },
        });
        await this.recompute(tx, r.propertyId);
        await this.audit.record(tx, {
          tenantId,
          actor: { kind: 'system', name: `Guest (${review.displayName})` },
          action: 'review.submitted',
          entityType: 'review',
          entityId: review.id,
          metadata: { code: r.code, overall: dto.overall, status: review.status },
          ip,
        });
        return { ...publicReview(review), status: review.status };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw this.notAllowed('ALREADY_REVIEWED');
      throw e;
    }
  }

  private notAllowed(reason: 'ALREADY_REVIEWED' | 'NOT_CHECKED_OUT' | 'WINDOW_CLOSED') {
    const msg = {
      ALREADY_REVIEWED: 'You have already reviewed this stay. Thank you!',
      NOT_CHECKED_OUT: 'You can review your stay after you check out.',
      WINDOW_CLOSED: 'Reviews can be left for 30 days after check-out.',
    }[reason];
    return appError(HttpStatus.CONFLICT, 'REVIEW_NOT_ALLOWED', msg, { reason });
  }

  // ---------------------------------------------------------------------------
  // Hotel
  // ---------------------------------------------------------------------------

  list(user: AuthUser, q: HotelReviewsQueryDto) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const where: Prisma.ReviewWhereInput = {
        tenantId: user.tenantId,
        ...(q.status && { status: q.status }),
        ...(q.rating && { overall: q.rating }),
        ...(q.travellerType && { travellerType: q.travellerType }),
        ...(q.replied === true && { hotelReply: { not: null } }),
        ...(q.replied === false && { hotelReply: null }),
        ...((q.from || q.to) && {
          createdAt: {
            ...(q.from && { gte: lagosStartOfDay(q.from) }),
            ...(q.to && { lt: lagosStartOfDay(addDays(q.to, 1)) }),
          },
        }),
      };
      const rows = await tx.review.findMany({ where, include: withStay, orderBy: { createdAt: 'desc' }, skip: pg.skip, take: pg.take });
      const total = await tx.review.count({ where });
      return { items: rows.map(hotelReview), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  summary(user: AuthUser, months = 12) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await tx.property.findFirst({ where: { tenantId: user.tenantId }, orderBy: { createdAt: 'asc' } });
      if (!p) throw AppException.notFound('Property');
      const rows = await tx.review.findMany({
        where: { tenantId: user.tenantId, status: { in: [...VISIBLE] } },
        select: { overall: true, createdAt: true, hotelReply: true },
      });
      const now = lagosDate();
      const monthsList: string[] = [];
      let y = Number(now.slice(0, 4));
      let m = Number(now.slice(5, 7));
      for (let i = 0; i < months; i++) {
        monthsList.unshift(`${y}-${String(m).padStart(2, '0')}`);
        m -= 1;
        if (m === 0) {
          m = 12;
          y -= 1;
        }
      }
      const byMonth = new Map<string, number[]>();
      for (const r of rows) {
        const key = lagosDate(r.createdAt).slice(0, 7);
        byMonth.set(key, [...(byMonth.get(key) ?? []), r.overall]);
      }
      return {
        ...reviewSummaryOf(p),
        unreplied: rows.filter((r) => !r.hotelReply).length,
        trend: monthsList.map((month) => {
          const xs = byMonth.get(month) ?? [];
          return { month, count: xs.length, rating: xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null };
        }),
      };
    });
  }

  reply(user: AuthUser, id: string, body: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const r = await tx.review.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!r) throw AppException.notFound('Review');
      const updated = await tx.review.update({
        where: { id },
        data: { hotelReply: body, hotelRepliedAt: new Date(), hotelRepliedById: user.userId },
        include: withStay,
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: r.hotelReply ? 'review.reply_edited' : 'review.replied',
        entityType: 'review',
        entityId: id,
        metadata: { code: updated.reservation.code },
        ip,
      });
      return hotelReview(updated);
    });
  }

  flag(user: AuthUser, id: string, reason: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const r = await tx.review.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!r) throw AppException.notFound('Review');
      if (r.status === 'HIDDEN') throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'This review is already hidden', { status: r.status, allowed: ['PUBLISHED', 'FLAGGED'] });
      const updated = await tx.review.update({
        where: { id },
        data: { status: 'FLAGGED', flaggedReason: `Reported by the hotel: ${reason}`, flaggedAt: new Date() },
        include: withStay,
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'review.flagged', entityType: 'review', entityId: id, metadata: { reason }, ip });
      return hotelReview(updated);
    });
  }

  // ---------------------------------------------------------------------------
  // Platform moderation
  // ---------------------------------------------------------------------------

  platformList(q: PlatformReviewsQueryDto) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.system(async (tx) => {
      const where: Prisma.ReviewWhereInput = {
        ...(q.status && { status: q.status }),
        ...(q.q && {
          OR: [
            { body: { contains: q.q, mode: 'insensitive' } },
            { title: { contains: q.q, mode: 'insensitive' } },
            { property: { name: { contains: q.q, mode: 'insensitive' } } },
          ],
        }),
      };
      // Default queue: flagged first (a CASE ordering is not expressible in Prisma, so two reads).
      const include = { ...withStay, property: { select: { name: true, slug: true } } };
      let rows;
      if (q.status) {
        rows = await tx.review.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip: pg.skip, take: pg.take });
      } else {
        const flagged = await tx.review.findMany({ where: { ...where, status: 'FLAGGED' }, include, orderBy: { flaggedAt: 'desc' } });
        const rest = await tx.review.findMany({ where: { ...where, status: { not: 'FLAGGED' } }, include, orderBy: { createdAt: 'desc' }, take: pg.skip + pg.take });
        rows = [...flagged, ...rest].slice(pg.skip, pg.skip + pg.take);
      }
      const total = await tx.review.count({ where });
      return {
        items: rows.map((r) => ({ ...hotelReview(r), tenantId: r.tenantId, hotelName: r.property.name, slug: r.property.slug })),
        total,
        page: pg.page,
        pageSize: pg.pageSize,
      };
    });
  }

  moderate(actor: PlatformPrincipal, id: string, dto: ModerateReviewDto, ip?: string) {
    if (dto.status === 'HIDDEN' && !dto.reason) {
      throw appError(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Give a reason to hide a review', { fields: { reason: ['required when hiding'] } });
    }
    return this.db.system(async (tx) => {
      const r = await tx.review.findUnique({ where: { id } });
      if (!r) throw AppException.notFound('Review');
      const now = new Date();
      const updated = await tx.review.update({
        where: { id },
        data:
          dto.status === 'HIDDEN'
            ? { status: 'HIDDEN', hiddenReason: dto.reason, moderationNote: dto.note ?? null, moderatedAt: now, moderatedBy: actor.fullName }
            : { status: 'PUBLISHED', hiddenReason: null, moderationNote: dto.note ?? null, moderatedAt: now, moderatedBy: actor.fullName, flaggedReason: null, flaggedAt: null },
        include: { ...withStay, property: { select: { name: true, slug: true } } },
      });
      await this.recompute(tx, r.propertyId);
      await this.audit.record(tx, {
        tenantId: r.tenantId,
        actor: platformActor(actor),
        action: dto.status === 'HIDDEN' ? 'review.hidden' : 'review.published',
        entityType: 'review',
        entityId: id,
        metadata: { reason: dto.reason ?? null, note: dto.note ?? null, previousStatus: r.status },
        ip,
      });
      return { ...hotelReview(updated), tenantId: updated.tenantId, hotelName: updated.property.name, slug: updated.property.slug };
    });
  }
}
