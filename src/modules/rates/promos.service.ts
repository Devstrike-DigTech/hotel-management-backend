import { HttpStatus, Injectable } from '@nestjs/common';
import type { PromoCode, PromoRedemptionStatus } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { dbDate, fromDbDate, humanDate, isIsoDate, lagosDate } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { appError, Err, k } from '../ops/ops.helpers.js';
import { promoMessage, promoStaticProblem, type PromoInvalidReason, type PromoLike, type RateChannel } from './rates.logic.js';
import type { PromoCodeDto, UpdatePromoCodeDto } from './rates.dto.js';

export function toPromoLike(p: PromoCode): PromoLike {
  return {
    code: p.code,
    description: p.description,
    type: p.type,
    value: p.value,
    validFrom: p.validFrom ? fromDbDate(p.validFrom) : null,
    validTo: p.validTo ? fromDbDate(p.validTo) : null,
    stayFrom: p.stayFrom ? fromDbDate(p.stayFrom) : null,
    stayTo: p.stayTo ? fromDbDate(p.stayTo) : null,
    minNights: p.minNights,
    maxUses: p.maxUses,
    perGuestLimit: p.perGuestLimit,
    channels: p.channels,
    roomTypeIds: p.roomTypeIds,
    firstBookingOnly: p.firstBookingOnly,
    active: p.active,
  };
}

export class PromoError extends AppException {
  constructor(
    public readonly promoCode: string,
    public readonly reason: PromoInvalidReason,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(HttpStatus.BAD_REQUEST, 'PROMO_INVALID', message, { code: promoCode, reason, ...extra });
  }
}

export interface PromoCheck {
  promo: PromoCode | null;
  reason: PromoInvalidReason | null;
  message: string | null;
}

/**
 * Promo codes: rules, usage (HELD while an online hold waits for payment,
 * CONFIRMED when the booking is confirmed, RELEASED on expiry / cancel /
 * no-show) and admin CRUD with usage statistics.
 */
@Injectable()
export class PromosService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  normalise(code: string): string {
    return code.trim().toUpperCase().replace(/\s+/g, '');
  }

  /**
   * Checks a code for a stay. `guestPhone` enables the per-guest and
   * first-booking rules (booking time); `lock` takes a row lock on the promo so
   * the last use cannot be taken twice.
   */
  async check(
    tx: Tx,
    tenantId: string,
    input: {
      code: string;
      roomTypeId: string;
      arrivalDate: string;
      departureDate: string;
      channel: RateChannel;
      guestPhone?: string | null;
      guestId?: string | null;
      excludeReservationId?: string | null;
      lock?: boolean;
    },
  ): Promise<PromoCheck> {
    const code = this.normalise(input.code);
    const promo = await tx.promoCode.findFirst({ where: { tenantId, code } });
    if (!promo) return { promo: null, reason: 'NOT_FOUND', message: promoMessage(null, code, 'NOT_FOUND', humanDate) };
    if (input.lock) await tx.$executeRaw`SELECT id FROM promo_codes WHERE id = ${promo.id}::uuid FOR UPDATE`;
    const exclude = input.excludeReservationId ? { reservationId: { not: input.excludeReservationId } } : {};
    const taken = await tx.promoRedemption.count({ where: { promoCodeId: promo.id, status: { in: ['HELD', 'CONFIRMED'] }, ...exclude } });
    const like = toPromoLike(promo);
    let reason = promoStaticProblem(like, {
      today: lagosDate(),
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
      channel: input.channel,
      roomTypeId: input.roomTypeId,
      taken,
    });
    if (!reason && input.guestPhone && promo.perGuestLimit) {
      const mine = await tx.promoRedemption.count({ where: { promoCodeId: promo.id, guestPhone: input.guestPhone, status: { in: ['HELD', 'CONFIRMED'] }, ...exclude } });
      if (mine >= promo.perGuestLimit) reason = 'PER_GUEST_LIMIT';
    }
    if (!reason && promo.firstBookingOnly && (input.guestPhone || input.guestId)) {
      const earlier = await tx.reservation.count({
        where: {
          tenantId,
          status: { notIn: ['CANCELLED'] },
          ...(input.excludeReservationId && { id: { not: input.excludeReservationId } }),
          OR: [
            ...(input.guestId ? [{ guestId: input.guestId }] : []),
            ...(input.guestPhone ? [{ guest: { phone: input.guestPhone } }, { contactPhone: input.guestPhone }] : []),
          ],
        },
      });
      if (earlier > 0) reason = 'FIRST_BOOKING_ONLY';
    }
    return { promo, reason, message: reason ? promoMessage(like, code, reason, humanDate) : null };
  }

  toError(check: PromoCheck, code: string): PromoError {
    const p = check.promo;
    return new PromoError(this.normalise(code), check.reason ?? 'NOT_FOUND', check.message ?? 'Invalid promo code', {
      ...(p?.minNights && { minNights: p.minNights }),
      ...(p?.validFrom && { validFrom: fromDbDate(p.validFrom) }),
      ...(p?.validTo && { validTo: fromDbDate(p.validTo) }),
    });
  }

  /** Records the use of a promo by a reservation (HELD or CONFIRMED). */
  async redeem(
    tx: Tx,
    tenantId: string,
    input: { promoCodeId: string; reservationId: string; guestPhone: string | null; channel: RateChannel; discountKobo: number; nights: number; status: 'HELD' | 'CONFIRMED' },
  ) {
    const existing = await tx.promoRedemption.findUnique({ where: { reservationId: input.reservationId } });
    if (existing && existing.promoCodeId === input.promoCodeId && existing.status !== 'RELEASED') {
      await tx.promoRedemption.update({ where: { id: existing.id }, data: { discountKobo: BigInt(input.discountKobo), nights: input.nights } });
    } else {
      if (existing) {
        await this.release(tx, tenantId, input.reservationId);
        await tx.promoRedemption.delete({ where: { id: existing.id } });
      }
      await tx.promoRedemption.create({
        data: {
          tenantId,
          promoCodeId: input.promoCodeId,
          reservationId: input.reservationId,
          guestPhone: input.guestPhone,
          channel: input.channel,
          status: 'HELD',
          discountKobo: BigInt(input.discountKobo),
          nights: input.nights,
        },
      });
    }
    if (input.status === 'CONFIRMED') await this.confirm(tx, tenantId, input.reservationId);
  }

  /** HELD -> CONFIRMED: the use counts (a released hold revived by a late payment counts again). */
  async confirm(tx: Tx, tenantId: string, reservationId: string) {
    const r = await tx.promoRedemption.findFirst({ where: { tenantId, reservationId } });
    if (!r || r.status === 'CONFIRMED') return;
    await tx.promoRedemption.update({ where: { id: r.id }, data: { status: 'CONFIRMED', confirmedAt: new Date(), releasedAt: null } });
    await tx.promoCode.update({ where: { id: r.promoCodeId }, data: { uses: { increment: 1 } } });
  }

  /** HELD / CONFIRMED -> RELEASED: the use is given back. */
  async release(tx: Tx, tenantId: string, reservationId: string) {
    const r = await tx.promoRedemption.findFirst({ where: { tenantId, reservationId } });
    if (!r || r.status === 'RELEASED') return;
    await tx.promoRedemption.update({ where: { id: r.id }, data: { status: 'RELEASED', releasedAt: new Date() } });
    if (r.status === 'CONFIRMED') await tx.promoCode.update({ where: { id: r.promoCodeId }, data: { uses: { decrement: 1 } } });
  }

  // ---------------------------------------------------------------------------
  // Admin
  // ---------------------------------------------------------------------------

  private status(p: PromoCode, taken: number): 'ACTIVE' | 'SCHEDULED' | 'EXPIRED' | 'USED_UP' | 'INACTIVE' {
    if (!p.active) return 'INACTIVE';
    const today = lagosDate();
    if (p.validTo && fromDbDate(p.validTo) < today) return 'EXPIRED';
    if (p.stayTo && fromDbDate(p.stayTo) < today) return 'EXPIRED';
    if (p.maxUses !== null && taken >= p.maxUses) return 'USED_UP';
    if (p.validFrom && fromDbDate(p.validFrom) > today) return 'SCHEDULED';
    return 'ACTIVE';
  }

  private async stats(tx: Tx, ids: string[]) {
    const rows = await tx.promoRedemption.groupBy({ by: ['promoCodeId', 'status'], where: { promoCodeId: { in: ids } }, _count: { _all: true }, _sum: { discountKobo: true } });
    const confirmed = await tx.promoRedemption.findMany({
      where: { promoCodeId: { in: ids }, status: 'CONFIRMED' },
      select: { promoCodeId: true, discountKobo: true, reservation: { select: { nightlyRates: true } } },
    });
    const revenue = new Map<string, number>();
    for (const c of confirmed) {
      const nights = Array.isArray(c.reservation.nightlyRates) ? (c.reservation.nightlyRates as { rateKobo: number }[]) : [];
      const room = nights.reduce((a, n) => a + (n.rateKobo ?? 0), 0);
      revenue.set(c.promoCodeId, (revenue.get(c.promoCodeId) ?? 0) + room - k(c.discountKobo));
    }
    const out = new Map<string, { held: number; confirmed: number; discount: number; revenue: number }>();
    for (const id of ids) out.set(id, { held: 0, confirmed: 0, discount: 0, revenue: revenue.get(id) ?? 0 });
    for (const r of rows) {
      const s = out.get(r.promoCodeId)!;
      if (r.status === 'HELD') s.held = r._count._all;
      if (r.status === 'CONFIRMED') {
        s.confirmed = r._count._all;
        s.discount = k(r._sum.discountKobo);
      }
    }
    return out;
  }

  private view(p: PromoCode, s: { held: number; confirmed: number; discount: number; revenue: number }) {
    return {
      id: p.id,
      code: p.code,
      description: p.description,
      type: p.type,
      value: p.value,
      validFrom: p.validFrom ? fromDbDate(p.validFrom) : null,
      validTo: p.validTo ? fromDbDate(p.validTo) : null,
      stayFrom: p.stayFrom ? fromDbDate(p.stayFrom) : null,
      stayTo: p.stayTo ? fromDbDate(p.stayTo) : null,
      minNights: p.minNights,
      maxUses: p.maxUses,
      perGuestLimit: p.perGuestLimit,
      channels: p.channels,
      roomTypeIds: p.roomTypeIds,
      firstBookingOnly: p.firstBookingOnly,
      active: p.active,
      uses: s.confirmed,
      held: s.held,
      discountGivenKobo: s.discount,
      revenueKobo: s.revenue,
      status: this.status(p, s.held + s.confirmed),
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  list(user: AuthUser, q: { status?: string; q?: string }) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.promoCode.findMany({
        where: { tenantId: user.tenantId, ...(q.q && { OR: [{ code: { contains: q.q.toUpperCase() } }, { description: { contains: q.q, mode: 'insensitive' } }] }) },
        orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
      });
      const stats = await this.stats(tx, rows.map((r) => r.id));
      const items = rows.map((r) => this.view(r, stats.get(r.id)!));
      return q.status ? items.filter((i) => i.status === q.status!.toUpperCase()) : items;
    });
  }

  get(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await tx.promoCode.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!p) throw AppException.notFound('Promo code');
      const stats = await this.stats(tx, [p.id]);
      const reds = await tx.promoRedemption.findMany({
        where: { promoCodeId: p.id },
        include: { reservation: { select: { code: true, arrivalAt: true, guest: { select: { fullName: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const byChannel: Record<string, number> = { FRONT_DESK: 0, BOOKING_SITE: 0, MARKETPLACE: 0 };
      const all = await tx.promoRedemption.groupBy({ by: ['channel'], where: { promoCodeId: p.id, status: 'CONFIRMED' }, _count: { _all: true } });
      for (const c of all) byChannel[c.channel] = c._count._all;
      return {
        ...this.view(p, stats.get(p.id)!),
        byChannel,
        redemptions: reds.map((r) => ({
          id: r.id,
          reservationId: r.reservationId,
          reservationCode: r.reservation.code,
          guestName: r.reservation.guest.fullName,
          channel: r.channel,
          status: r.status as PromoRedemptionStatus,
          discountKobo: k(r.discountKobo),
          nights: r.nights,
          createdAt: r.createdAt.toISOString(),
          confirmedAt: r.confirmedAt?.toISOString() ?? null,
          releasedAt: r.releasedAt?.toISOString() ?? null,
        })),
      };
    });
  }

  private checkDto(dto: Partial<PromoCodeDto>) {
    for (const f of ['validFrom', 'validTo', 'stayFrom', 'stayTo'] as const) {
      const v = dto[f];
      if (v && !isIsoDate(v)) throw Err.validation(f, `${f} must be YYYY-MM-DD`);
    }
    if (dto.validFrom && dto.validTo && dto.validTo < dto.validFrom) throw Err.validation('validTo', 'validTo must not be before validFrom');
    if (dto.stayFrom && dto.stayTo && dto.stayTo < dto.stayFrom) throw Err.validation('stayTo', 'stayTo must not be before stayFrom');
    if (dto.type === 'PERCENT' && dto.value !== undefined && dto.value > 10_000) throw Err.validation('value', 'A percentage is at most 10000 bps (100%)');
    if (dto.type === 'FREE_NIGHT' && dto.value !== undefined && (dto.value < 2 || dto.value > 30)) throw Err.validation('value', 'Free night needs a stay of 2 to 30 nights');
  }

  private dates(dto: Partial<PromoCodeDto>) {
    const d = (v: string | null | undefined) => (v === undefined ? undefined : v ? dbDate(v) : null);
    return { validFrom: d(dto.validFrom), validTo: d(dto.validTo), stayFrom: d(dto.stayFrom), stayTo: d(dto.stayTo) };
  }

  create(user: AuthUser, dto: PromoCodeDto, ip?: string) {
    this.checkDto(dto);
    const code = this.normalise(dto.code);
    if (!/^[A-Z0-9]{3,20}$/.test(code)) throw Err.validation('code', 'Codes are 3 to 20 letters and digits');
    return this.db.tenant(user.tenantId, async (tx) => {
      if (await tx.promoCode.findFirst({ where: { tenantId: user.tenantId, code } })) throw AppException.conflict('A promo code with this code already exists');
      const p = await tx.promoCode.create({
        data: {
          tenantId: user.tenantId,
          code,
          description: dto.description ?? '',
          type: dto.type,
          value: dto.value,
          ...this.dates(dto),
          minNights: dto.minNights ?? null,
          maxUses: dto.maxUses ?? null,
          perGuestLimit: dto.perGuestLimit ?? null,
          channels: dto.channels ?? ['FRONT_DESK', 'BOOKING_SITE', 'MARKETPLACE'],
          roomTypeIds: dto.roomTypeIds ?? [],
          firstBookingOnly: dto.firstBookingOnly ?? false,
          active: dto.active ?? true,
        },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'promo.created', entityType: 'promo_code', entityId: p.id, metadata: { code, type: p.type, value: p.value }, ip });
      return this.view(p, { held: 0, confirmed: 0, discount: 0, revenue: 0 });
    });
  }

  update(user: AuthUser, id: string, dto: UpdatePromoCodeDto, ip?: string) {
    this.checkDto(dto);
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await tx.promoCode.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!p) throw AppException.notFound('Promo code');
      let code: string | undefined;
      if (dto.code !== undefined && this.normalise(dto.code) !== p.code) {
        const used = await tx.promoRedemption.count({ where: { promoCodeId: id } });
        if (used) throw appError(HttpStatus.CONFLICT, 'CONFLICT', 'A code that has been used cannot be renamed');
        code = this.normalise(dto.code);
        if (!/^[A-Z0-9]{3,20}$/.test(code)) throw Err.validation('code', 'Codes are 3 to 20 letters and digits');
        if (await tx.promoCode.findFirst({ where: { tenantId: user.tenantId, code } })) throw AppException.conflict('A promo code with this code already exists');
      }
      const updated = await tx.promoCode.update({
        where: { id },
        data: {
          ...(code && { code }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.type !== undefined && { type: dto.type }),
          ...(dto.value !== undefined && { value: dto.value }),
          ...Object.fromEntries(Object.entries(this.dates(dto)).filter(([, v]) => v !== undefined)),
          ...(dto.minNights !== undefined && { minNights: dto.minNights }),
          ...(dto.maxUses !== undefined && { maxUses: dto.maxUses }),
          ...(dto.perGuestLimit !== undefined && { perGuestLimit: dto.perGuestLimit }),
          ...(dto.channels !== undefined && { channels: dto.channels }),
          ...(dto.roomTypeIds !== undefined && { roomTypeIds: dto.roomTypeIds }),
          ...(dto.firstBookingOnly !== undefined && { firstBookingOnly: dto.firstBookingOnly }),
          ...(dto.active !== undefined && { active: dto.active }),
        },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'promo.updated', entityType: 'promo_code', entityId: id, metadata: { code: updated.code, changes: Object.keys(dto) }, ip });
      const stats = await this.stats(tx, [id]);
      return this.view(updated, stats.get(id)!);
    });
  }

  remove(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await tx.promoCode.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!p) throw AppException.notFound('Promo code');
      const used = (await tx.promoRedemption.count({ where: { promoCodeId: id } })) + (await tx.reservation.count({ where: { promoCodeId: id } }));
      if (used) throw AppException.conflict('This code has been used; deactivate it instead');
      await tx.promoCode.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'promo.deleted', entityType: 'promo_code', entityId: id, metadata: { code: p.code }, ip });
      return { success: true };
    });
  }
}
