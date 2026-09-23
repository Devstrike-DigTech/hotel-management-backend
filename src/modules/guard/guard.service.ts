import { Injectable, Logger } from '@nestjs/common';
import type { GuardFlag, Prisma } from '../../generated/prisma/client.js';
import type { GuardRule, GuardSeverity } from '../../generated/prisma/enums.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { humanDateTime, lagosDate } from '../../common/time/lagos.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { k } from '../ops/ops.helpers.js';
import {
  isDayUseOverstay,
  isLateRegistration,
  isOccupiedWithoutStay,
  isRepeatedVoids,
  REPEATED_VOIDS_WINDOW_MS,
  ruleEnabled,
  RULE_INFO,
} from './guard.logic.js';

export interface RaiseFlag {
  rule: GuardRule;
  severity?: GuardSeverity;
  title: string;
  detail: string;
  dedupeKey: string;
  amountKobo?: number | null;
  roomId?: string | null;
  reservationId?: string | null;
  shiftId?: string | null;
  userId?: string | null;
  userName?: string | null;
  evidence?: Record<string, unknown>;
  suggestion?: string | null;
}

/**
 * Revenue Guard: raises flags from events (inside the business transaction,
 * so a flag commits with the action that caused it) and from sweeps.
 * Rules the tenant is not entitled to are skipped silently.
 */
@Injectable()
export class GuardService {
  private readonly logger = new Logger(GuardService.name);

  constructor(
    private readonly db: DbService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async features(tx: Tx, tenantId: string): Promise<string[]> {
    return (await this.entitlements.getEntitlements(tenantId, tx)).features;
  }

  /** Inserts the flag unless the rule is locked or a live flag with the same key exists. Returns 1 if created. */
  async raise(tx: Tx, tenantId: string, features: readonly string[], f: RaiseFlag): Promise<number> {
    if (!ruleEnabled(f.rule, features)) return 0;
    const res = await tx.guardFlag.createMany({
      data: [
        {
          tenantId,
          rule: f.rule,
          severity: f.severity ?? RULE_INFO.get(f.rule)!.defaultSeverity,
          title: f.title,
          detail: f.detail,
          dedupeKey: f.dedupeKey,
          amountKobo: f.amountKobo ?? null,
          roomId: f.roomId ?? null,
          reservationId: f.reservationId ?? null,
          shiftId: f.shiftId ?? null,
          userId: f.userId ?? null,
          userName: f.userName ?? null,
          evidence: (f.evidence ?? {}) as Prisma.InputJsonValue,
          suggestion: f.suggestion ?? null,
        },
      ],
      skipDuplicates: true,
    });
    return res.count;
  }

  /** REPEATED_VOIDS_BY_USER check after a void by `userId`. */
  async checkRepeatedVoids(tx: Tx, tenantId: string, features: readonly string[], userId: string, userName: string, now = new Date()) {
    const since = new Date(now.getTime() - REPEATED_VOIDS_WINDOW_MS);
    // One void action = one VOID of a top-level entry (tax-line voids ride along).
    const voids = await tx.$queryRaw<{ created_at: Date }[]>`
      SELECT v.created_at FROM folio_entries v
      JOIN folio_entries o ON o.id = v.ref_entry_id
      WHERE v.tenant_id = ${tenantId}::uuid AND v.type = 'VOID' AND v.created_by_id = ${userId}::uuid
        AND v.created_at >= ${since} AND o.parent_entry_id IS NULL`;
    const times = voids.map((v) => v.created_at);
    if (!isRepeatedVoids(times, now)) return 0;
    return this.raise(tx, tenantId, features, {
      rule: 'REPEATED_VOIDS_BY_USER',
      title: `${userName} posted ${times.length} voids in 24 hours`,
      detail: 'Several ledger corrections by the same person in a short time. Review the voided entries and their reasons.',
      dedupeKey: `REPEATED_VOIDS_BY_USER:${userId}:${lagosDate(now)}`,
      userId,
      userName,
      evidence: { voidCount: times.length, windowHours: 24, voidTimes: times.map((t) => t.toISOString()) },
    });
  }

  /** Time- and state-based rules. Returns the number of flags created. */
  async sweep(tenantId: string, now = new Date()): Promise<number> {
    return this.db.tenant(tenantId, (tx) => this.sweepTx(tx, tenantId, now));
  }

  async sweepTx(tx: Tx, tenantId: string, now = new Date()): Promise<number> {
    const features = await this.features(tx, tenantId);
    if (!features.includes('revenue_guard_basic') && !features.includes('revenue_guard_full')) return 0;
    let created = 0;
    const today = lagosDate(now);
    const dayAgo = new Date(now.getTime() - 24 * 3_600_000);

    if (ruleEnabled('OCCUPIED_WITHOUT_STAY', features)) {
      const rooms = await tx.room.findMany({
        where: { tenantId, OR: [{ status: 'OCCUPIED' }, { status: 'VACANT_DIRTY', updatedAt: { gte: dayAgo } }] },
      });
      if (rooms.length) {
        const ids = rooms.map((r) => r.id);
        const inHouse = await tx.reservation.findMany({
          where: { tenantId, roomId: { in: ids }, status: 'CHECKED_IN' },
          select: { roomId: true },
        });
        const recentOut = await tx.reservation.findMany({
          where: { tenantId, roomId: { in: ids }, checkedOutAt: { gte: dayAgo } },
          select: { roomId: true },
        });
        const moves = await tx.housekeepingTask.findMany({
          where: { tenantId, roomId: { in: ids }, createdAt: { gte: dayAgo } },
          select: { roomId: true },
        });
        const housed = new Set(inHouse.map((r) => r.roomId));
        const out = new Set([...recentOut.map((r) => r.roomId), ...moves.map((m) => m.roomId)]);
        for (const r of rooms) {
          if (!isOccupiedWithoutStay({ status: r.status, hasCheckedInStay: housed.has(r.id), hasRecentCheckout: out.has(r.id) })) continue;
          created += await this.raise(tx, tenantId, features, {
            rule: 'OCCUPIED_WITHOUT_STAY',
            title: `Room ${r.number} is ${r.status === 'OCCUPIED' ? 'occupied' : 'dirty'} with no stay on record`,
            detail:
              r.status === 'OCCUPIED'
                ? 'The room is marked occupied but no guest is checked in to it. It may have been sold off the books.'
                : 'The room was used (marked dirty) but nobody checked out of it in the last 24 hours.',
            dedupeKey: `OCCUPIED_WITHOUT_STAY:${r.id}:${today}`,
            roomId: r.id,
            evidence: { roomNumber: r.number, status: r.status, statusChangedAt: r.updatedAt.toISOString() },
          });
        }
      }
    }

    if (ruleEnabled('DAY_USE_OVERSTAY', features)) {
      const stays = await tx.reservation.findMany({
        where: { tenantId, status: 'CHECKED_IN', stayType: 'DAY_USE', departureAt: { lt: now } },
        include: { room: true, guest: true },
      });
      for (const s of stays) {
        if (!isDayUseOverstay(s.departureAt, now)) continue;
        const minutes = Math.round((now.getTime() - s.departureAt.getTime()) / 60_000);
        created += await this.raise(tx, tenantId, features, {
          rule: 'DAY_USE_OVERSTAY',
          title: `Day-use ${s.code} is ${minutes} minutes past checkout`,
          detail: `${s.guest.fullName} in room ${s.room?.number ?? '-'} booked until ${humanDateTime(s.departureAt)}.`,
          dedupeKey: `DAY_USE_OVERSTAY:${s.id}`,
          reservationId: s.id,
          roomId: s.roomId,
          amountKobo: k(s.rateKobo),
          evidence: { departureAt: s.departureAt.toISOString(), minutesOver: minutes, hourlyRateKobo: k(s.rateKobo) },
          suggestion: 'Charge the extra hours or convert the stay to a night.',
        });
      }
    }

    if (ruleEnabled('LATE_REGISTRATION', features)) {
      const stays = await tx.reservation.findMany({
        where: { tenantId, status: 'CHECKED_IN', registrationCompletedAt: null, checkedInAt: { not: null } },
        include: { room: true, guest: true },
      });
      for (const s of stays) {
        if (!isLateRegistration(s.checkedInAt!, null, now)) continue;
        created += await this.raise(tx, tenantId, features, {
          rule: 'LATE_REGISTRATION',
          title: `${s.code}: guest register not completed`,
          detail: `${s.guest.fullName} checked in to room ${s.room?.number ?? '-'} over an hour ago without a completed register entry.`,
          dedupeKey: `LATE_REGISTRATION:${s.id}`,
          reservationId: s.id,
          roomId: s.roomId,
          userId: s.checkedInById,
          evidence: { checkedInAt: s.checkedInAt!.toISOString() },
          suggestion: 'Complete the register card (ID, arriving from, going to, purpose).',
        });
      }
    }

    if (ruleEnabled('REPEATED_VOIDS_BY_USER', features)) {
      const voiders = await tx.$queryRaw<{ user_id: string }[]>`
        SELECT DISTINCT v.created_by_id AS user_id FROM folio_entries v
        WHERE v.tenant_id = ${tenantId}::uuid AND v.type = 'VOID' AND v.created_at >= ${dayAgo} AND v.created_by_id IS NOT NULL`;
      for (const v of voiders) {
        const u = await tx.user.findUnique({ where: { id: v.user_id }, select: { fullName: true } });
        created += await this.checkRepeatedVoids(tx, tenantId, features, v.user_id, u?.fullName ?? 'Staff member', now);
      }
    }

    if (created) this.logger.log(`Guard sweep for ${tenantId}: ${created} new flag(s)`);
    return created;
  }
}

export type { GuardFlag };
