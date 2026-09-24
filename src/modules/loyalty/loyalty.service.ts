import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { createHash, randomInt } from 'node:crypto';
import type { LoyaltyMember, LoyaltyProgramme, LoyaltyTier, LoyaltyTransaction, Prisma } from '../../generated/prisma/client.js';
import type { LoyaltyTxnType } from '../../generated/prisma/enums.js';
import type { AuthUser, GuestPrincipal } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { assertCan } from '../../common/permissions/can.js';
import { registerStayHooks } from '../../common/stay-hooks.js';
import { DAY_MS, lagosDate } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, SYSTEM_ACTOR, userActor } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { discountBase } from '../folios/folio.logic.js';
import { actorOf, LedgerService } from '../folios/ledger.service.js';
import { GuardService } from '../guard/guard.service.js';
import { DocumentsService } from '../invoices/documents.service.js';
import { OPS_JOBS } from '../jobs/jobs.constants.js';
import { ProJobsService } from '../jobs/pro-jobs.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { appError, Err, paginate, primaryProperty, userNames, userRef } from '../ops/ops.helpers.js';
import { addMonths, defaultMemberPrefix, earnPoints, maxRedeemable, memberNumber, nextTier, redeemProblem, spreadDiscount, tierFor } from './loyalty.logic.js';

const FEATURE = 'loyalty';
const CODE_TTL_MS = 10 * 60_000;
const CODE_TRIES = 5;
const EXPIRING_DAYS = 60;

type Tiered = LoyaltyMember & { tier: LoyaltyTier | null };

/**
 * M5 loyalty (feature `loyalty`), one programme per hotel group: earn at
 * check-out, tiers by nights, redemption as a folio discount (guest code or
 * manager PIN) or in an online quote, audited adjustments and expiry.
 */
@Injectable()
export class LoyaltyService implements OnModuleInit {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationService,
    private readonly refs: ModuleRef,
  ) {
    ProJobsService.register(OPS_JOBS.loyaltyExpiry.name, LoyaltyService);
  }

  onModuleInit() {
    registerStayHooks({
      name: 'loyalty',
      checkedInTx: (tx, tenantId, id, opts) => (opts.enrolLoyalty ? this.enrolAtCheckIn(tx, tenantId, id).then(() => undefined) : Promise.resolve()),
      checkedOutTx: (tx, tenantId, id) => this.earnForStay(tx, tenantId, id).then(() => undefined),
      entriesVoidedTx: (tx, tenantId, ids) => this.reverseForEntries(tx, tenantId, ids),
      releasedTx: (tx, tenantId, id, opts) => this.returnForReservation(tx, tenantId, id, typeof opts.why === 'string' ? opts.why : 'Booking cancelled'),
      detailTx: (tx, tenantId, id) => this.reservationLoyalty(tx, tenantId, id).then((loyalty) => ({ loyalty })),
    });
  }

  private get ledger() {
    return this.refs.get(LedgerService, { strict: false });
  }

  private get docs() {
    return this.refs.get(DocumentsService, { strict: false });
  }

  // ---------------------------------------------------------------------------
  // Programme and tiers
  // ---------------------------------------------------------------------------

  /** The group's programme (created, disabled, on first use). */
  async programmeRow(tx: Tx, tenantId: string): Promise<LoyaltyProgramme> {
    const p = await tx.loyaltyProgramme.findFirst({ where: { tenantId } });
    if (p) return p;
    const hotel = await tx.property.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' }, select: { name: true } });
    const name = `${(hotel?.name ?? 'Hotel').replace(/^The\s+/i, '')} Rewards`;
    return tx.loyaltyProgramme.upsert({ where: { tenantId }, create: { tenantId, name, enabled: false, memberNoPrefix: defaultMemberPrefix(name) }, update: {} });
  }

  /** The active programme when the group has the feature and it is switched on. */
  async activeProgramme(tx: Tx, tenantId: string): Promise<LoyaltyProgramme | null> {
    const ent = await this.entitlements.getEntitlements(tenantId, tx);
    if (!ent.features.includes(FEATURE)) return null;
    const p = await tx.loyaltyProgramme.findFirst({ where: { tenantId } });
    return p?.enabled ? p : null;
  }

  private async tiers(tx: Tx, tenantId: string) {
    return tx.loyaltyTier.findMany({ where: { tenantId }, orderBy: [{ minNights: 'asc' }, { sortOrder: 'asc' }] });
  }

  private tierView(t: LoyaltyTier, members = 0) {
    return { id: t.id, name: t.name, minNights: t.minNights, bonusBps: t.bonusBps, perks: t.perks, color: t.color, sortOrder: t.sortOrder, members };
  }

  private async programmeView(tx: Tx, p: LoyaltyProgramme) {
    const tiers = await this.tiers(tx, p.tenantId);
    const counts = await tx.loyaltyMember.groupBy({ by: ['tierId'], where: { tenantId: p.tenantId }, _count: { _all: true } });
    const byTier = new Map(counts.map((c) => [c.tierId, c._count._all]));
    return {
      enabled: p.enabled,
      name: p.name,
      earnPointsPer1000: p.earnPointsPer1000,
      pointValueKobo: p.pointValueKobo,
      minRedeemPoints: p.minRedeemPoints,
      maxRedeemBps: p.maxRedeemBps,
      expiryMonths: p.expiryMonths,
      adjustmentFlagPoints: p.adjustmentFlagPoints,
      enrolOnline: p.enrolOnline,
      memberNoPrefix: p.memberNoPrefix,
      tiers: tiers.map((t) => this.tierView(t, byTier.get(t.id) ?? 0)),
    };
  }

  getProgramme(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => this.programmeView(tx, await this.programmeRow(tx, user.tenantId)));
  }

  putProgramme(user: AuthUser, dto: Partial<Omit<LoyaltyProgramme, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>>, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const cur = await this.programmeRow(tx, user.tenantId);
      const data = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
      const p = await tx.loyaltyProgramme.update({ where: { id: cur.id }, data });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'loyalty.programme_updated', entityType: 'loyalty_programme', entityId: p.id, metadata: data, ip });
      return this.programmeView(tx, p);
    });
  }

  createTier(user: AuthUser, dto: { name: string; minNights: number; bonusBps?: number; perks?: string[]; color?: string; sortOrder?: number }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      await this.programmeRow(tx, user.tenantId);
      if (await tx.loyaltyTier.findFirst({ where: { tenantId: user.tenantId, name: dto.name.trim() } })) throw Err.validation('name', 'A tier with that name exists');
      const t = await tx.loyaltyTier.create({
        data: { tenantId: user.tenantId, name: dto.name.trim(), minNights: dto.minNights, bonusBps: dto.bonusBps ?? 0, perks: dto.perks ?? [], color: dto.color ?? 'palm', sortOrder: dto.sortOrder ?? dto.minNights },
      });
      await this.retierAll(tx, user.tenantId);
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'loyalty.tier_created', entityType: 'loyalty_tier', entityId: t.id, metadata: { name: t.name, minNights: t.minNights }, ip });
      return this.tierView(t, await tx.loyaltyMember.count({ where: { tierId: t.id } }));
    });
  }

  updateTier(user: AuthUser, id: string, dto: { name?: string; minNights?: number; bonusBps?: number; perks?: string[]; color?: string; sortOrder?: number }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const t = await tx.loyaltyTier.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!t) throw AppException.notFound('Tier');
      const data = Object.fromEntries(Object.entries({ ...dto, name: dto.name?.trim() }).filter(([, v]) => v !== undefined));
      const u = await tx.loyaltyTier.update({ where: { id }, data });
      if (dto.minNights !== undefined) await this.retierAll(tx, user.tenantId);
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'loyalty.tier_updated', entityType: 'loyalty_tier', entityId: id, metadata: data, ip });
      return this.tierView(u, await tx.loyaltyMember.count({ where: { tierId: id } }));
    });
  }

  deleteTier(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const t = await tx.loyaltyTier.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!t) throw AppException.notFound('Tier');
      await tx.loyaltyMember.updateMany({ where: { tierId: id }, data: { tierId: null } });
      await tx.loyaltyTier.delete({ where: { id } });
      await this.retierAll(tx, user.tenantId);
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'loyalty.tier_deleted', entityType: 'loyalty_tier', entityId: id, metadata: { name: t.name }, ip });
      return { deleted: true };
    });
  }

  /** Re-places every member by their stored nights (after tier changes). */
  private async retierAll(tx: Tx, tenantId: string) {
    const tiers = await this.tiers(tx, tenantId);
    const members = await tx.loyaltyMember.findMany({ where: { tenantId }, select: { id: true, tierId: true, nights12m: true } });
    for (const m of members) {
      const t = tierFor(tiers, m.nights12m);
      if ((t?.id ?? null) !== m.tierId) await tx.loyaltyMember.update({ where: { id: m.id }, data: { tierId: t?.id ?? null } });
    }
  }

  // ---------------------------------------------------------------------------
  // Members
  // ---------------------------------------------------------------------------

  /** Nights of checked-out nightly stays in the last 12 months, all properties. */
  private async nights12m(tx: Tx, tenantId: string, guestId: string): Promise<number> {
    const rows = await tx.$queryRaw<{ n: number | null }[]>`
      SELECT COALESCE(SUM(GREATEST(1, (departure_at AT TIME ZONE 'Africa/Lagos')::date - (arrival_at AT TIME ZONE 'Africa/Lagos')::date)), 0)::int AS n
        FROM reservations
       WHERE tenant_id = ${tenantId}::uuid AND guest_id = ${guestId}::uuid AND status = 'CHECKED_OUT'
         AND stay_type = 'NIGHTLY' AND departure_at >= now() - interval '365 days'`;
    return Number(rows[0]?.n ?? 0);
  }

  private async refreshTier(tx: Tx, m: LoyaltyMember): Promise<Tiered> {
    const nights = await this.nights12m(tx, m.tenantId, m.guestId);
    const t = tierFor(await this.tiers(tx, m.tenantId), nights);
    return tx.loyaltyMember.update({ where: { id: m.id }, data: { nights12m: nights, tierId: t?.id ?? null }, include: { tier: true } });
  }

  private async memberViews(tx: Tx, rows: Tiered[]) {
    if (!rows.length) return [];
    const tenantId = rows[0].tenantId;
    const p = await this.programmeRow(tx, tenantId);
    const tiers = await this.tiers(tx, tenantId);
    const guests = new Map((await tx.guest.findMany({ where: { id: { in: rows.map((m) => m.guestId) } }, select: { id: true, fullName: true, phone: true, email: true, vip: true } })).map((g) => [g.id, g]));
    const soon = new Date(Date.now() + EXPIRING_DAYS * DAY_MS);
    const lots = await tx.loyaltyTransaction.findMany({
      where: { memberId: { in: rows.map((m) => m.id) }, remaining: { gt: 0 }, expiresAt: { not: null, lte: soon } },
      select: { memberId: true, remaining: true, expiresAt: true },
    });
    return rows.map((m) => {
      const mine = lots.filter((l) => l.memberId === m.id);
      const first = mine.map((l) => l.expiresAt!).sort((a, b) => a.getTime() - b.getTime())[0];
      return {
        id: m.id,
        memberNo: m.memberNo,
        guest: guests.get(m.guestId) ?? { id: m.guestId, fullName: 'Guest', phone: null, email: null, vip: false },
        tier: m.tier ? { id: m.tier.id, name: m.tier.name, color: m.tier.color, perks: m.tier.perks } : null,
        points: m.points,
        valueKobo: m.points * p.pointValueKobo,
        lifetimePoints: m.lifetimePoints,
        nights12m: m.nights12m,
        nextTier: nextTier(tiers, m.nights12m),
        expiringSoon: mine.length ? { points: mine.reduce((a, l) => a + l.remaining, 0), date: lagosDate(first) } : null,
        enrolledAt: m.enrolledAt.toISOString(),
        enrolledVia: m.enrolledVia,
        status: m.status,
      };
    });
  }

  private async memberView(tx: Tx, m: Tiered) {
    return (await this.memberViews(tx, [m]))[0];
  }

  private async txnViews(tx: Tx, rows: LoyaltyTransaction[], staff = true) {
    const props = new Map((await tx.property.findMany({ where: { id: { in: rows.map((r) => r.propertyId).filter((x): x is string => !!x) } }, select: { id: true, name: true, slug: true } })).map((p) => [p.id, p]));
    const resIds = rows.map((r) => r.reservationId).filter((x): x is string => !!x);
    const res = new Map(
      resIds.length
        ? (await tx.$queryRaw<{ id: string; code: string }[]>`SELECT id::text, code FROM reservations WHERE id = ANY(${resIds}::uuid[])`).map((r) => [r.id, r])
        : [],
    );
    const names = staff ? await userNames(tx, rows.flatMap((r) => [r.createdById, r.approvedById])) : new Map<string, string>();
    return rows.map((t) => ({
      id: t.id,
      type: t.type,
      points: t.points,
      balanceAfter: t.balanceAfter,
      description: t.description,
      reason: t.reason,
      property: t.propertyId ? (props.get(t.propertyId) ?? null) : null,
      reservation: t.reservationId ? (res.get(t.reservationId) ?? null) : null,
      folioId: t.folioId,
      expiresAt: t.expiresAt?.toISOString() ?? null,
      ...(staff && { by: userRef(names, t.createdById, t.createdByName), approvedBy: userRef(names, t.approvedById, t.approvedByName) }),
      createdAt: t.createdAt.toISOString(),
    }));
  }

  async summary(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await this.programmeRow(tx, user.tenantId);
      const tiers = await this.tiers(tx, user.tenantId);
      const counts = await tx.loyaltyMember.groupBy({ by: ['tierId'], where: { tenantId: user.tenantId }, _count: { _all: true } });
      const agg = await tx.loyaltyMember.aggregate({ where: { tenantId: user.tenantId }, _sum: { points: true }, _count: { _all: true } });
      const since = new Date(Date.now() - 30 * DAY_MS);
      const sum = async (types: LoyaltyTxnType[]) =>
        Math.abs((await tx.loyaltyTransaction.aggregate({ where: { tenantId: user.tenantId, type: { in: types }, createdAt: { gte: since } }, _sum: { points: true } }))._sum.points ?? 0);
      const expiring = await tx.loyaltyTransaction.aggregate({
        where: { tenantId: user.tenantId, remaining: { gt: 0 }, expiresAt: { gte: new Date(), lte: new Date(Date.now() + EXPIRING_DAYS * DAY_MS) } },
        _sum: { remaining: true },
      });
      const outstanding = agg._sum.points ?? 0;
      const byTier = new Map(counts.map((c) => [c.tierId, c._count._all]));
      return {
        members: agg._count._all,
        byTier: [...tiers.map((t) => ({ tier: t.name, members: byTier.get(t.id) ?? 0 })), ...(byTier.get(null) ? [{ tier: 'No tier', members: byTier.get(null)! }] : [])],
        pointsOutstanding: outstanding,
        liabilityKobo: outstanding * p.pointValueKobo,
        earned30d: await sum(['EARN']),
        redeemed30d: await sum(['REDEEM']),
        expired30d: await sum(['EXPIRE']),
        expiringNext60d: expiring._sum.remaining ?? 0,
      };
    });
  }

  listMembers(user: AuthUser, q: { q?: string; tierId?: string; page?: number; pageSize?: number }) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const text = q.q?.trim();
      const where: Prisma.LoyaltyMemberWhereInput = {
        tenantId: user.tenantId,
        ...(q.tierId && { tierId: q.tierId }),
        ...(text && {
          OR: [
            { memberNo: { contains: text, mode: 'insensitive' } },
            { guest: { fullName: { contains: text, mode: 'insensitive' } } },
            { guest: { phone: { contains: text.replace(/\s/g, '') } } },
          ],
        }),
      };
      const [rows, total] = await Promise.all([
        tx.loyaltyMember.findMany({ where, include: { tier: true }, orderBy: [{ points: 'desc' }, { enrolledAt: 'asc' }], skip: pg.skip, take: pg.take }),
        tx.loyaltyMember.count({ where }),
      ]);
      return { items: await this.memberViews(tx, rows), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  private async loadMember(tx: Tx, tenantId: string, id: string): Promise<Tiered> {
    const m = await tx.loyaltyMember.findFirst({ where: { id, tenantId }, include: { tier: true } });
    if (!m) throw AppException.notFound('Member');
    return m;
  }

  getMember(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const m = await this.loadMember(tx, user.tenantId, id);
      const rows = await tx.loyaltyTransaction.findMany({ where: { memberId: m.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 });
      return { ...(await this.memberView(tx, m)), statement: await this.txnViews(tx, rows) };
    });
  }

  byGuest(user: AuthUser, guestId: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const m = await tx.loyaltyMember.findFirst({ where: { guestId, tenantId: user.tenantId }, include: { tier: true } });
      if (!m) throw this.notMember();
      return this.memberView(tx, m);
    });
  }

  statement(user: AuthUser, id: string, q: { page?: number; pageSize?: number }) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const m = await this.loadMember(tx, user.tenantId, id);
      const [rows, total] = await Promise.all([
        tx.loyaltyTransaction.findMany({ where: { memberId: m.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: pg.skip, take: pg.take }),
        tx.loyaltyTransaction.count({ where: { memberId: m.id } }),
      ]);
      return { items: await this.txnViews(tx, rows), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  private notMember() {
    return appError(HttpStatus.CONFLICT, 'LOYALTY_NOT_MEMBER', 'This guest is not a member of the loyalty programme');
  }

  /** Enrols a guest (idempotent). */
  async enrolTx(tx: Tx, tenantId: string, guestId: string, via: 'DESK' | 'CHECK_IN' | 'ONLINE'): Promise<{ member: Tiered; created: boolean }> {
    const existing = await tx.loyaltyMember.findFirst({ where: { guestId, tenantId }, include: { tier: true } });
    if (existing) return { member: existing, created: false };
    const p = await this.programmeRow(tx, tenantId);
    const { seq } = await this.docs.nextNumber(tx, tenantId, 'LOYALTY_MEMBER', 0);
    const m = await tx.loyaltyMember.create({ data: { tenantId, guestId, memberNo: memberNumber(p.memberNoPrefix, seq), enrolledVia: via } });
    return { member: await this.refreshTier(tx, m), created: true };
  }

  enrol(user: AuthUser, dto: { guestId: string; via?: 'DESK' | 'CHECK_IN' }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const g = await tx.guest.findFirst({ where: { id: dto.guestId, tenantId: user.tenantId } });
      if (!g || g.anonymisedAt) throw AppException.notFound('Guest');
      const { member, created } = await this.enrolTx(tx, user.tenantId, g.id, dto.via ?? 'DESK');
      if (created) await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'loyalty.member_enrolled', entityType: 'loyalty_member', entityId: member.id, metadata: { guest: g.fullName, memberNo: member.memberNo, via: dto.via ?? 'DESK' }, ip });
      return { created, view: await this.memberView(tx, member) };
    });
  }

  private async enrolAtCheckIn(tx: Tx, tenantId: string, reservationId: string) {
    if (!(await this.activeProgramme(tx, tenantId))) return;
    const r = await tx.reservation.findFirst({ where: { id: reservationId }, select: { guestId: true } });
    if (r) await this.enrolTx(tx, tenantId, r.guestId, 'CHECK_IN');
  }

  // ---------------------------------------------------------------------------
  // Point movements
  // ---------------------------------------------------------------------------

  /** Takes points from the oldest lots first (FIFO by expiry). */
  private async consumeLots(tx: Tx, memberId: string, points: number) {
    let left = points;
    const lots = await tx.loyaltyTransaction.findMany({ where: { memberId, remaining: { gt: 0 } }, orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }] });
    for (const l of lots) {
      if (left <= 0) break;
      const take = Math.min(l.remaining, left);
      await tx.loyaltyTransaction.update({ where: { id: l.id }, data: { remaining: l.remaining - take } });
      left -= take;
    }
  }

  private async post(
    tx: Tx,
    m: LoyaltyMember,
    t: { type: LoyaltyTxnType; points: number; description: string; reason?: string | null; propertyId?: string | null; reservationId?: string | null; folioId?: string | null; folioEntryId?: string | null; dedupeKey?: string | null; lot?: boolean; expiryMonths?: number; by?: { id: string; name: string } | null; approvedBy?: { id: string; name: string } | null },
  ): Promise<{ txn: LoyaltyTransaction; member: Tiered }> {
    if (t.points < 0) await this.consumeLots(tx, m.id, -t.points);
    const fresh = await tx.loyaltyMember.update({
      where: { id: m.id },
      data: { points: { increment: t.points }, ...(t.type === 'EARN' && { lifetimePoints: { increment: t.points } }) },
      include: { tier: true },
    });
    const txn = await tx.loyaltyTransaction.create({
      data: {
        tenantId: m.tenantId,
        memberId: m.id,
        type: t.type,
        points: t.points,
        balanceAfter: fresh.points,
        description: t.description,
        reason: t.reason ?? null,
        propertyId: t.propertyId ?? null,
        reservationId: t.reservationId ?? null,
        folioId: t.folioId ?? null,
        folioEntryId: t.folioEntryId ?? null,
        dedupeKey: t.dedupeKey ?? null,
        remaining: t.lot && t.points > 0 ? t.points : 0,
        expiresAt: t.lot && t.points > 0 && t.expiryMonths ? addMonths(new Date(), t.expiryMonths) : null,
        createdById: t.by?.id ?? null,
        createdByName: t.by?.name ?? null,
        approvedById: t.approvedBy?.id ?? null,
        approvedByName: t.approvedBy?.name ?? null,
      },
    });
    return { txn, member: fresh };
  }

  /** Check-out: points on the stay's eligible spend, once per stay. */
  async earnForStay(tx: Tx, tenantId: string, reservationId: string): Promise<number> {
    const p = await this.activeProgramme(tx, tenantId);
    if (!p) return 0;
    const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId }, include: { folio: { select: { id: true } } } });
    if (!r?.folio) return 0;
    let m = await tx.loyaltyMember.findFirst({ where: { guestId: r.guestId, tenantId }, include: { tier: true } });
    if (!m || m.status !== 'ACTIVE') return 0;
    const key = `EARN:${r.id}`;
    if (await tx.loyaltyTransaction.findFirst({ where: { dedupeKey: key }, select: { id: true } })) return 0;
    const entries = await tx.folioEntry.findMany({ where: { folioId: r.folio.id } });
    const eligible = discountBase(entries);
    const points = earnPoints(eligible, p.earnPointsPer1000, m.tier?.bonusBps ?? 0);
    if (points > 0) {
      const res = await this.post(tx, m, { type: 'EARN', points, description: `Stay ${r.code}`, propertyId: r.propertyId, reservationId: r.id, folioId: r.folio.id, dedupeKey: key, lot: true, expiryMonths: p.expiryMonths });
      m = res.member;
    }
    await this.refreshTier(tx, m);
    return points;
  }

  /** Voided loyalty discount lines give the points back. */
  async reverseForEntries(tx: Tx, tenantId: string, entryIds: string[]) {
    if (!entryIds.length) return;
    const redeems = await tx.loyaltyTransaction.findMany({ where: { tenantId, type: 'REDEEM', folioEntryId: { in: entryIds } } });
    const p = redeems.length ? await this.programmeRow(tx, tenantId) : null;
    for (const t of redeems) {
      const key = `REVERSAL:${t.id}`;
      if (await tx.loyaltyTransaction.findFirst({ where: { dedupeKey: key }, select: { id: true } })) continue;
      const m = await tx.loyaltyMember.findFirstOrThrow({ where: { id: t.memberId } });
      await this.post(tx, m, { type: 'REVERSAL', points: -t.points, description: 'Redemption voided', propertyId: t.propertyId, reservationId: t.reservationId, folioId: t.folioId, dedupeKey: key, lot: true, expiryMonths: p!.expiryMonths });
    }
  }

  /** Points held by an online booking go back (hold expired, cancelled). */
  async returnForReservation(tx: Tx, tenantId: string, reservationId: string, why: string) {
    const redeems = await tx.loyaltyTransaction.findMany({ where: { tenantId, type: 'REDEEM', reservationId, folioEntryId: null } });
    const p = redeems.length ? await this.programmeRow(tx, tenantId) : null;
    for (const t of redeems) {
      const key = `REVERSAL:${t.id}`;
      if (await tx.loyaltyTransaction.findFirst({ where: { dedupeKey: key }, select: { id: true } })) continue;
      const m = await tx.loyaltyMember.findFirstOrThrow({ where: { id: t.memberId } });
      await this.post(tx, m, { type: 'REVERSAL', points: -t.points, description: why, propertyId: t.propertyId, reservationId, dedupeKey: key, lot: true, expiryMonths: p!.expiryMonths });
    }
  }

  async adjust(user: AuthUser, id: string, dto: { points: number; reason: string }, ip?: string) {
    if (!dto.points) throw Err.validation('points', 'Give a non-zero number of points');
    return this.db.tenant(user.tenantId, async (tx) => {
      const m = await this.loadMember(tx, user.tenantId, id);
      if (dto.points < 0 && m.points + dto.points < 0) throw appError(HttpStatus.BAD_REQUEST, 'LOYALTY_INSUFFICIENT_POINTS', 'The member does not have that many points', { balance: m.points });
      const p = await this.programmeRow(tx, user.tenantId);
      const prop = await primaryProperty(tx, user.tenantId);
      const res = await this.post(tx, m, { type: 'ADJUST', points: dto.points, description: dto.points > 0 ? 'Points added' : 'Points removed', reason: dto.reason, propertyId: prop.id, lot: true, expiryMonths: p.expiryMonths, by: { id: user.userId, name: user.fullName } });
      const size = Math.abs(dto.points);
      if (size >= p.adjustmentFlagPoints) {
        const guard = this.refs.get(GuardService, { strict: false });
        const guest = await tx.guest.findFirst({ where: { id: m.guestId }, select: { fullName: true } });
        await guard.raise(tx, user.tenantId, await guard.features(tx, user.tenantId), {
          rule: 'LOYALTY_ADJUSTMENT',
          severity: size >= 4 * p.adjustmentFlagPoints ? 'HIGH' : 'MEDIUM',
          title: `${dto.points > 0 ? '+' : ''}${dto.points.toLocaleString('en-NG')} points for ${guest?.fullName ?? m.memberNo}`,
          detail: `${user.fullName} adjusted ${m.memberNo} by ${dto.points.toLocaleString('en-NG')} points (worth ₦${((size * p.pointValueKobo) / 100).toLocaleString('en-NG')}). Reason: ${dto.reason}`,
          dedupeKey: `LOYALTY_ADJUSTMENT:${res.txn.id}`,
          amountKobo: size * p.pointValueKobo,
          userId: user.userId,
          userName: user.fullName,
          evidence: { memberId: m.id, memberNo: m.memberNo, points: dto.points, reason: dto.reason, transactionId: res.txn.id },
        });
      }
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'loyalty.points_adjusted', entityType: 'loyalty_member', entityId: m.id, metadata: { memberNo: m.memberNo, points: dto.points, reason: dto.reason, balanceAfter: res.member.points }, ip });
      return this.memberView(tx, res.member);
    });
  }

  // ---------------------------------------------------------------------------
  // Desk redemption
  // ---------------------------------------------------------------------------

  private hash(challengeId: string, code: string) {
    return createHash('sha256').update(`${challengeId}:${code}`).digest('hex');
  }

  private async checkRedeem(tx: Tx, tenantId: string, m: LoyaltyMember, folioId: string, points: number) {
    const p = await this.activeProgramme(tx, tenantId);
    if (!p) throw appError(HttpStatus.CONFLICT, 'LOYALTY_NOT_MEMBER', 'The loyalty programme is switched off');
    if (m.status !== 'ACTIVE') throw this.notMember();
    const folio = await this.docs.loadFolio(tx, tenantId, folioId);
    if (folio.status !== 'OPEN') throw Err.invalidState(folio.status, ['OPEN'], 'This folio');
    const base = discountBase(folio.entries);
    const problem = redeemProblem(points, m.points, base, p);
    if (problem?.code === 'LOYALTY_INSUFFICIENT_POINTS') throw appError(HttpStatus.BAD_REQUEST, problem.code, `The member has ${m.points.toLocaleString('en-NG')} points`, { balance: problem.balance });
    if (problem) throw appError(HttpStatus.BAD_REQUEST, problem.code, `Redeem between ${problem.minPoints.toLocaleString('en-NG')} and ${problem.maxPoints.toLocaleString('en-NG')} points on this folio`, { minPoints: problem.minPoints, maxPoints: problem.maxPoints });
    return { p, folio };
  }

  async redeemStart(user: AuthUser, memberId: string, dto: { folioId: string; points: number }) {
    assertCan(user, 'folio.discount', 'You cannot post discounts');
    const out = await this.db.tenant(user.tenantId, async (tx) => {
      const m = await this.loadMember(tx, user.tenantId, memberId);
      const { p, folio } = await this.checkRedeem(tx, user.tenantId, m, dto.folioId, dto.points);
      const g = await tx.guest.findFirstOrThrow({ where: { id: m.guestId } });
      if (!g.phone) throw Err.validation('memberId', 'The member has no phone number for the code; ask a manager to approve with their PIN');
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const c = await tx.loyaltyChallenge.create({ data: { tenantId: user.tenantId, memberId: m.id, folioId: folio.id, points: dto.points, codeHash: 'pending', expiresAt: new Date(Date.now() + CODE_TTL_MS) } });
      await tx.loyaltyChallenge.update({ where: { id: c.id }, data: { codeHash: this.hash(c.id, code) } });
      const hotel = await tx.property.findFirstOrThrow({ where: { id: folio.propertyId }, select: { name: true } });
      const wa = (await this.entitlements.getEntitlements(user.tenantId, tx)).features.includes('whatsapp_messaging');
      return { c, code, phone: g.phone, p, hotel: hotel.name, wa };
    });
    await this.notifications.sendSensitive({
      tenantId: user.tenantId,
      template: 'OTP',
      channel: out.wa ? 'WHATSAPP' : 'SMS',
      audience: 'GUEST',
      to: out.phone,
      subject: null,
      text: `${out.code} is your ${out.p.name} code to redeem ${dto.points.toLocaleString('en-NG')} points at ${out.hotel}. It expires in 10 minutes. Do not share it with anyone who calls you.`,
      redactedText: `(code hidden) ${out.p.name} redemption of ${dto.points} points at ${out.hotel}`,
      html: null,
      waTemplate: { name: 'otp_code', language: 'en', params: [out.code] },
      // The development outbox shows the code (as for guest sign-in codes); providers ignore meta.
      meta: { otpCode: out.code, challengeId: out.c.id },
    });
    return {
      challengeId: out.c.id,
      maskedPhone: `${out.phone.slice(0, 4)}******${out.phone.slice(-3)}`,
      expiresAt: out.c.expiresAt.toISOString(),
      points: dto.points,
      valueKobo: dto.points * out.p.pointValueKobo,
    };
  }

  async redeem(user: AuthUser, dto: { challengeId?: string; code?: string; memberId?: string; folioId?: string; points?: number; approval?: { approverId: string; pin: string } }, ip?: string) {
    assertCan(user, 'folio.discount', 'You cannot post discounts');
    let memberId: string;
    let folioId: string;
    let points: number;
    let approver: { id: string; fullName: string } | null = null;
    let challengeId: string | null = null;
    if (dto.challengeId) {
      if (!dto.code) throw Err.validation('code', 'Enter the code the guest received');
      // The attempt counts even when the code is wrong (own transaction).
      const check = await this.db.tenant(user.tenantId, async (tx) => {
        const c = await tx.loyaltyChallenge.findFirst({ where: { id: dto.challengeId, tenantId: user.tenantId } });
        if (!c) throw AppException.notFound('Redemption');
        if (c.consumedAt || c.expiresAt < new Date() || c.attempts >= CODE_TRIES) return { error: appError(HttpStatus.GONE, 'LOYALTY_CODE_EXPIRED', 'This code has expired. Send a new one.') };
        if (this.hash(c.id, dto.code!) !== c.codeHash) {
          const attempts = c.attempts + 1;
          await tx.loyaltyChallenge.update({ where: { id: c.id }, data: { attempts } });
          return { error: appError(HttpStatus.BAD_REQUEST, 'LOYALTY_CODE_INVALID', 'That code is not right', { attemptsLeft: Math.max(0, CODE_TRIES - attempts) }) };
        }
        return { c };
      });
      if ('error' in check) throw check.error;
      ({ memberId, folioId, points } = check.c);
      challengeId = check.c.id;
    } else {
      if (!dto.memberId || !dto.folioId || !dto.points || !dto.approval) throw Err.validation('challengeId', 'Give the guest code, or the member, folio, points and a manager approval');
      approver = await this.ledger.verifyApproval(user, dto.approval);
      memberId = dto.memberId;
      folioId = dto.folioId;
      points = dto.points;
    }
    return this.db.tenant(user.tenantId, async (tx) => {
      if (challengeId) {
        const used = await tx.loyaltyChallenge.updateMany({ where: { id: challengeId, consumedAt: null }, data: { consumedAt: new Date() } });
        if (!used.count) throw appError(HttpStatus.GONE, 'LOYALTY_CODE_EXPIRED', 'This code has already been used.');
      }
      const m = await this.loadMember(tx, user.tenantId, memberId);
      const { p, folio } = await this.checkRedeem(tx, user.tenantId, m, folioId, points);
      const valueKobo = points * p.pointValueKobo;
      const comps = await this.ledger.discountComponents(tx, user.tenantId, folio);
      const entry = await this.ledger.postDiscountOn(
        tx,
        user.tenantId,
        folio,
        null,
        { description: `${p.name}: ${points.toLocaleString('en-NG')} points`, discountKobo: valueKobo, comps, reason: `Loyalty redemption (${challengeId ? 'guest code' : 'manager PIN'})`, approvedById: approver?.id ?? null },
        actorOf(user),
      );
      const res = await this.post(tx, m, {
        type: 'REDEEM',
        points: -points,
        description: `Redeemed on ${folio.reservation?.code ?? folio.name}`,
        propertyId: folio.propertyId,
        reservationId: folio.reservationId,
        folioId: folio.id,
        folioEntryId: entry.id,
        by: { id: user.userId, name: user.fullName },
        approvedBy: approver ? { id: approver.id, name: approver.fullName } : null,
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'loyalty.points_redeemed',
        entityType: 'folio',
        entityId: folio.id,
        metadata: { memberNo: m.memberNo, points, valueKobo, entryId: entry.id, proof: challengeId ? 'OTP' : 'PIN', ...(approver && { approvedBy: approver.fullName }) },
        ip,
      });
      return { member: await this.memberView(tx, res.member), folio: await this.ledger.folioView(tx, user.tenantId, folio.id), transaction: (await this.txnViews(tx, [res.txn]))[0] };
    });
  }

  // ---------------------------------------------------------------------------
  // Reservation detail, expiry
  // ---------------------------------------------------------------------------

  async reservationLoyalty(tx: Tx, tenantId: string, reservationId: string) {
    const r = await tx.reservation.findFirst({ where: { id: reservationId }, select: { guestId: true } });
    if (!r) return null;
    const m = await tx.loyaltyMember.findFirst({ where: { guestId: r.guestId, tenantId }, include: { tier: { select: { name: true } } } });
    if (!m) return null;
    const txns = await tx.loyaltyTransaction.findMany({ where: { memberId: m.id, reservationId }, select: { type: true, points: true } });
    const earned = txns.filter((t) => t.type === 'EARN').reduce((a, t) => a + t.points, 0);
    const redeemed = -txns.filter((t) => t.type === 'REDEEM' || t.type === 'REVERSAL').reduce((a, t) => a + t.points, 0);
    return { memberNo: m.memberNo, tier: m.tier?.name ?? null, pointsEarned: txns.some((t) => t.type === 'EARN') ? earned : null, pointsRedeemed: Math.max(0, redeemed) };
  }

  /** 04:00: expires lots past their date. */
  async runExpiry(tenantId?: string, now = new Date()) {
    const due = (await this.db.systemAll((tx, t) =>
      tx.loyaltyTransaction.findMany({ where: { ...t.tenants, remaining: { gt: 0 }, expiresAt: { lte: now }, ...(tenantId && { tenantId }) }, select: { id: true, tenantId: true }, orderBy: { expiresAt: 'asc' } }),
    )).flat();
    let expiredLots = 0;
    let points = 0;
    const byTenant = new Map<string, string[]>();
    for (const d of due) byTenant.set(d.tenantId, [...(byTenant.get(d.tenantId) ?? []), d.id]);
    for (const [tid, ids] of byTenant) {
      await this.db.tenant(tid, async (tx) => {
        for (const id of ids) {
          const lot = await tx.loyaltyTransaction.findFirst({ where: { id, remaining: { gt: 0 } } });
          if (!lot) continue;
          const m = await tx.loyaltyMember.findFirstOrThrow({ where: { id: lot.memberId } });
          const take = Math.min(lot.remaining, Math.max(0, m.points));
          await tx.loyaltyTransaction.update({ where: { id: lot.id }, data: { remaining: 0 } });
          if (take <= 0) continue;
          const fresh = await tx.loyaltyMember.update({ where: { id: m.id }, data: { points: { decrement: take } } });
          await tx.loyaltyTransaction.create({
            data: { tenantId: tid, memberId: m.id, type: 'EXPIRE', points: -take, balanceAfter: fresh.points, description: `Points earned ${lagosDate(lot.createdAt)} expired`, dedupeKey: `EXPIRE:${lot.id}` },
          });
          expiredLots++;
          points += take;
        }
        if (ids.length) await this.audit.record(tx, { tenantId: tid, actor: SYSTEM_ACTOR, action: 'loyalty.points_expired', entityType: 'loyalty_programme', propertyId: null, metadata: { lots: ids.length } });
      });
    }
    return { expiredLots, points };
  }

  async runScheduled() {
    const expired = await this.runExpiry();
    const retiered = await this.retierAllTenants();
    return { ...expired, retiered };
  }

  /** Nightly: nights in the last 12 months move members up and down the tiers. */
  async retierAllTenants() {
    const programmes = (await this.db.systemAll((tx, t) => tx.loyaltyProgramme.findMany({ where: { ...t.tenants, enabled: true }, select: { tenantId: true } }))).flat();
    let changed = 0;
    for (const { tenantId } of programmes) {
      try {
        changed += await this.db.tenant(tenantId, async (tx) => {
          const tiers = await this.tiers(tx, tenantId);
          const nights = await tx.$queryRaw<{ guest_id: string; n: number }[]>`
            SELECT guest_id::text, COALESCE(SUM(GREATEST(1, (departure_at AT TIME ZONE 'Africa/Lagos')::date - (arrival_at AT TIME ZONE 'Africa/Lagos')::date)), 0)::int AS n
              FROM reservations
             WHERE tenant_id = ${tenantId}::uuid AND status = 'CHECKED_OUT' AND stay_type = 'NIGHTLY' AND departure_at >= now() - interval '365 days'
             GROUP BY guest_id`;
          const by = new Map(nights.map((r) => [r.guest_id, Number(r.n)]));
          let n = 0;
          for (const m of await tx.loyaltyMember.findMany({ where: { tenantId }, select: { id: true, guestId: true, tierId: true, nights12m: true } })) {
            const nights12m = by.get(m.guestId) ?? 0;
            const tierId = tierFor(tiers, nights12m)?.id ?? null;
            if (nights12m !== m.nights12m || tierId !== m.tierId) {
              await tx.loyaltyMember.update({ where: { id: m.id }, data: { nights12m, tierId } });
              n++;
            }
          }
          return n;
        });
      } catch (e) {
        this.logger.error(`Loyalty tiers for ${tenantId} failed: ${(e as Error).message}`);
      }
    }
    return changed;
  }

  expiryNow(user: AuthUser) {
    return this.runExpiry(user.tenantId);
  }

  // ---------------------------------------------------------------------------
  // Guest side
  // ---------------------------------------------------------------------------

  /** The member for a signed-in guest in a group (linked account or verified phone). */
  async memberForGuest(tx: Tx, tenantId: string, g: GuestPrincipal): Promise<Tiered | null> {
    const guest = await tx.guest.findFirst({ where: { tenantId, anonymisedAt: null, OR: [{ guestAccountId: g.guestAccountId }, { phone: g.phone }] }, select: { id: true } });
    if (!guest) return null;
    return tx.loyaltyMember.findFirst({ where: { guestId: guest.id, tenantId }, include: { tier: true } });
  }

  private async hotelBySlug(slug: string) {
    const p = (await this.db.locate((tx, t) => tx.property.findFirst({ where: { ...t.tenants, slug: slug.toLowerCase() }, select: { id: true, tenantId: true, name: true, slug: true } })))?.value;
    if (!p) throw AppException.notFound('Hotel');
    return p;
  }

  async publicLoyalty(slug: string, g?: GuestPrincipal) {
    const h = await this.hotelBySlug(slug);
    return this.db.tenant(h.tenantId, async (tx) => {
      const p = await this.activeProgramme(tx, h.tenantId);
      if (!p) return { programme: null, member: null };
      const tiers = await this.tiers(tx, h.tenantId);
      const m = g ? await this.memberForGuest(tx, h.tenantId, g) : null;
      return {
        programme: {
          name: p.name,
          earnPointsPer1000: p.earnPointsPer1000,
          pointValueKobo: p.pointValueKobo,
          minRedeemPoints: p.minRedeemPoints,
          maxRedeemBps: p.maxRedeemBps,
          tiers: tiers.map((t) => ({ name: t.name, minNights: t.minNights, perks: t.perks, color: t.color })),
          enrolOnline: p.enrolOnline,
        },
        member: m ? { memberNo: m.memberNo, points: m.points, valueKobo: m.points * p.pointValueKobo, tier: m.tier?.name ?? null } : null,
      };
    });
  }

  private async membership(tx: Tx, tenantId: string, m: Tiered, p: LoyaltyProgramme) {
    const [view] = await this.memberViews(tx, [m]);
    const group = await tx.property.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' }, select: { slug: true, name: true } });
    const recent = await tx.loyaltyTransaction.findMany({ where: { memberId: m.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 10 });
    return {
      group: { slug: group?.slug ?? '', name: group?.name ?? '' },
      programme: p.name,
      memberNo: m.memberNo,
      tier: view.tier ? { name: view.tier.name, color: view.tier.color, perks: view.tier.perks } : null,
      points: m.points,
      valueKobo: view.valueKobo,
      nights12m: m.nights12m,
      nextTier: view.nextTier,
      expiringSoon: view.expiringSoon,
      recent: await this.txnViews(tx, recent, false),
    };
  }

  async guestLoyalty(g: GuestPrincipal) {
    const tenants = (await this.db.systemAll((tx, t) =>
      tx.$queryRaw<{ tenant_id: string }[]>`
        SELECT DISTINCT m.tenant_id::text FROM loyalty_members m JOIN guests g ON g.id = m.guest_id
         WHERE g.anonymised_at IS NULL AND (g.guest_account_id = ${g.guestAccountId}::uuid OR g.phone = ${g.phone})
           AND m.tenant_id <> ALL(${t.excludeTenantIds}::uuid[])`,
    )).flat();
    const memberships = [];
    for (const { tenant_id } of tenants) {
      const one = await this.db.tenant(tenant_id, async (tx) => {
        const p = await this.activeProgramme(tx, tenant_id);
        const m = p ? await this.memberForGuest(tx, tenant_id, g) : null;
        return p && m ? this.membership(tx, tenant_id, m, p) : null;
      });
      if (one) memberships.push(one);
    }
    return { memberships };
  }

  async guestEnrol(g: GuestPrincipal, hotelSlug: string) {
    const h = await this.hotelBySlug(hotelSlug);
    return this.db.tenant(h.tenantId, async (tx) => {
      const p = await this.activeProgramme(tx, h.tenantId);
      if (!p || !p.enrolOnline) throw appError(HttpStatus.CONFLICT, 'LOYALTY_NOT_MEMBER', `${h.name} does not take online sign-ups for its loyalty programme`);
      let guest = await tx.guest.findFirst({ where: { tenantId: h.tenantId, anonymisedAt: null, OR: [{ guestAccountId: g.guestAccountId }, { phone: g.phone }] } });
      if (!guest) {
        const acct = await this.db.system((s) => s.guestAccount.findUnique({ where: { id: g.guestAccountId }, select: { fullName: true, email: true } }));
        guest = await tx.guest.create({ data: { tenantId: h.tenantId, fullName: acct?.fullName || 'Guest', phone: g.phone, email: acct?.email ?? null, guestAccountId: g.guestAccountId, consentAt: new Date() } });
      }
      const { member, created } = await this.enrolTx(tx, h.tenantId, guest.id, 'ONLINE');
      if (created) await this.audit.record(tx, { tenantId: h.tenantId, actor: { kind: 'system', name: 'Guest (online)' }, action: 'loyalty.member_enrolled', entityType: 'loyalty_member', entityId: member.id, propertyId: h.id, metadata: { memberNo: member.memberNo, via: 'ONLINE' } });
      return this.membership(tx, h.tenantId, member, p);
    });
  }

  // ---------------------------------------------------------------------------
  // Online quotes and bookings
  // ---------------------------------------------------------------------------

  /**
   * Loyalty block of a quote and, when `redeemPoints` is asked, the
   * per-night discount (pre-tax, spread over the nights after promo).
   */
  async quoteLoyalty(
    tx: Tx,
    tenantId: string,
    g: GuestPrincipal | undefined,
    nights: { rateKobo: number; discountKobo?: number }[],
    redeemPoints?: number,
  ): Promise<{ block: QuoteLoyalty; perNight: number[]; memberId: string | null; programme: string | null } | null> {
    const p = await this.activeProgramme(tx, tenantId);
    if (!p) {
      if (redeemPoints) throw appError(HttpStatus.CONFLICT, 'LOYALTY_NOT_MEMBER', 'This hotel has no loyalty programme');
      return null;
    }
    const m = g ? await this.memberForGuest(tx, tenantId, g) : null;
    const base = nights.reduce((a, n) => a + Math.max(0, n.rateKobo - (n.discountKobo ?? 0)), 0);
    let perNight = nights.map(() => 0);
    let redeemed = 0;
    if (redeemPoints) {
      if (!m || m.status !== 'ACTIVE') throw this.notMember();
      const problem = redeemProblem(redeemPoints, m.points, base, p);
      if (problem?.code === 'LOYALTY_INSUFFICIENT_POINTS') throw appError(HttpStatus.BAD_REQUEST, problem.code, `You have ${m.points.toLocaleString('en-NG')} points`, { balance: problem.balance });
      if (problem) throw appError(HttpStatus.BAD_REQUEST, problem.code, `Redeem between ${problem.minPoints.toLocaleString('en-NG')} and ${problem.maxPoints.toLocaleString('en-NG')} points on this stay`, { minPoints: problem.minPoints, maxPoints: problem.maxPoints });
      perNight = spreadDiscount(nights, redeemPoints * p.pointValueKobo);
      redeemed = redeemPoints;
    }
    const value = perNight.reduce((a, b) => a + b, 0);
    return {
      block: {
        programme: p.name,
        member: !!m,
        pointsBalance: m ? m.points : null,
        pointsRedeemed: redeemed,
        redeemValueKobo: value,
        maxRedeemablePoints: m ? maxRedeemable(m.points, base, p) : null,
        pointsToEarn: earnPoints(base - value, p.earnPointsPer1000, m?.tier?.bonusBps ?? 0),
        tier: m?.tier?.name ?? null,
      },
      perNight,
      memberId: m?.id ?? null,
      programme: p.name,
    };
  }

  /** Online booking: holds the quoted points (REDEEM) on the reservation. */
  async holdForBooking(tx: Tx, tenantId: string, memberId: string, reservationId: string, points: number, propertyId: string, code: string) {
    const m = await tx.loyaltyMember.findFirst({ where: { id: memberId, tenantId } });
    if (!m || m.status !== 'ACTIVE') throw this.notMember();
    if (m.points < points) throw appError(HttpStatus.BAD_REQUEST, 'LOYALTY_INSUFFICIENT_POINTS', `You have ${m.points.toLocaleString('en-NG')} points`, { balance: m.points });
    await this.post(tx, m, { type: 'REDEEM', points: -points, description: `Redeemed on booking ${code}`, propertyId, reservationId, dedupeKey: `REDEEM:${reservationId}` });
  }

  /** Booking view block (trips, confirmation). */
  async bookingLoyalty(tx: Tx, tenantId: string, r: { id: string; guestId: string; loyaltyPoints: number; status: string }, quoteLoyalty: { pointsToEarn?: number; redeemValueKobo?: number; programme?: string } | null) {
    const p = await tx.loyaltyProgramme.findFirst({ where: { tenantId } });
    if (!p?.enabled && !r.loyaltyPoints) return null;
    const earned = await tx.loyaltyTransaction.findFirst({ where: { tenantId, reservationId: r.id, type: 'EARN' }, select: { points: true } });
    const member = await tx.loyaltyMember.findFirst({ where: { tenantId, guestId: r.guestId }, select: { id: true } });
    if (!member && !r.loyaltyPoints) return null;
    return {
      programme: quoteLoyalty?.programme ?? p?.name ?? '',
      pointsRedeemed: r.loyaltyPoints,
      redeemValueKobo: quoteLoyalty?.redeemValueKobo ?? (p ? r.loyaltyPoints * p.pointValueKobo : 0),
      pointsToEarn: quoteLoyalty?.pointsToEarn ?? 0,
      pointsEarned: earned?.points ?? null,
    };
  }

}

export interface QuoteLoyalty {
  programme: string;
  member: boolean;
  pointsBalance: number | null;
  pointsRedeemed: number;
  redeemValueKobo: number;
  maxRedeemablePoints: number | null;
  pointsToEarn: number;
  tier: string | null;
}
