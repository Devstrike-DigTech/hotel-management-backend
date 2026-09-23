import { currentPropertyId, runInProperty } from '../../common/property-scope.js';
import { CommissionService } from '../booking/commission.service.js';
import { Injectable, Logger } from '@nestjs/common';
import type { NightAuditRun, Prisma } from '../../generated/prisma/client.js';
import type { JobTrigger } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { humanDate, roomNightLabel, addDays, dbDate, fromDbDate, isIsoDate, lagosDate, lagosStartOfDay } from '../../common/time/lagos.js';
import { pointsLabel } from '../loyalty/loyalty.logic.js';
import { DbService } from '../../prisma/db.service.js';
import { AuditService, SYSTEM_ACTOR, userActor } from '../audit/audit.service.js';
import { LedgerService, SYSTEM } from '../folios/ledger.service.js';
import { GuardService } from '../guard/guard.service.js';
import { DocumentsService } from '../invoices/documents.service.js';
import { advisoryLock, Err, paginate } from '../ops/ops.helpers.js';
import { computeDailyFlashes } from '../reports/stats.compute.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { PromosService } from '../rates/promos.service.js';

export interface AuditSummary {
  roomChargesPosted: number;
  roomChargesKobo: number;
  noShows: number;
  flagsCreated: number;
}

const STALE_RUN_MS = 15 * 60_000;

function toView(r: NightAuditRun) {
  return {
    id: r.id,
    businessDate: fromDbDate(r.businessDate),
    status: r.status,
    trigger: r.trigger,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    summary: (r.summary as AuditSummary | null) ?? null,
    error: r.error,
    runBy: r.runById ? { id: r.runById, fullName: r.runByName ?? '' } : null,
  };
}

/**
 * Night audit for one business date, idempotent per (tenant, date): posts the
 * night's room charges, marks no-shows, runs the Revenue Guard sweep and
 * snapshots the daily statistics.
 */
@Injectable()
export class NightAuditService {
  private readonly logger = new Logger(NightAuditService.name);

  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly docs: DocumentsService,
    private readonly guard: GuardService,
    private readonly audit: AuditService,
    private readonly commission: CommissionService,
    private readonly reservations: ReservationsService,
    private readonly promos: PromosService,
  ) {}

  list(user: AuthUser, page?: number, pageSize?: number) {
    const pg = paginate(page, pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const where = { tenantId: user.tenantId };
      const rows = await tx.nightAuditRun.findMany({ where, orderBy: { businessDate: 'desc' }, skip: pg.skip, take: pg.take });
      const total = await tx.nightAuditRun.count({ where });
      return { items: rows.map(toView), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  runManual(user: AuthUser, businessDate?: string) {
    const date = businessDate ?? addDays(lagosDate(), -1);
    if (!isIsoDate(date)) throw Err.validation('businessDate', 'businessDate must be YYYY-MM-DD');
    if (date >= lagosDate()) throw Err.validation('businessDate', 'The night audit runs for a business date that has ended (before today)');
    return this.run(user.tenantId, date, 'MANUAL', user);
  }

  async run(tenantId: string, businessDate: string, trigger: JobTrigger, user?: AuthUser): Promise<ReturnType<typeof toView> & { alreadyRun: boolean }> {
    // M5: the audit runs per property. Without a property scope (the nightly
    // job), run it for every property of the group and return the first.
    const propertyId = currentPropertyId(tenantId);
    if (!propertyId) {
      const ids = await this.db.tenant(tenantId, (tx) =>
        tx.property.findMany({ where: { tenantId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } }),
      );
      let first: (ReturnType<typeof toView> & { alreadyRun: boolean }) | null = null;
      for (const p of ids) {
        const r = await runInProperty(tenantId, p.id, () => this.run(tenantId, businessDate, trigger, user));
        first ??= r;
      }
      if (!first) throw new Error('Tenant has no property');
      return first;
    }
    const now = new Date();
    const lockKey = `night-audit:${tenantId}:${propertyId}`;
    // Claim the run (or find that it is already done).
    const claim = await this.db.tenant(tenantId, async (tx) => {
      await advisoryLock(tx, lockKey);
      const existing = await tx.nightAuditRun.findUnique({ where: { propertyId_businessDate: { propertyId, businessDate: dbDate(businessDate) } } });
      if (existing?.status === 'COMPLETED') return { run: existing, already: true };
      if (existing?.status === 'RUNNING' && now.getTime() - existing.startedAt.getTime() < STALE_RUN_MS) {
        return { run: existing, already: true };
      }
      const data = {
        status: 'RUNNING' as const,
        trigger,
        startedAt: now,
        finishedAt: null,
        error: null,
        runById: user?.userId ?? null,
        runByName: user?.fullName ?? null,
      };
      const run = existing
        ? await tx.nightAuditRun.update({ where: { id: existing.id }, data })
        : await tx.nightAuditRun.create({ data: { tenantId, propertyId, businessDate: dbDate(businessDate), ...data } });
      return { run, already: false };
    });
    if (claim.already) return { ...toView(claim.run), alreadyRun: true };

    try {
      const run = await this.db.tenant(tenantId, async (tx) => {
        await advisoryLock(tx, lockKey);
        const summary: AuditSummary = { roomChargesPosted: 0, roomChargesKobo: 0, noShows: 0, flagsCreated: 0 };
        const dayStart = lagosStartOfDay(businessDate);
        const dayEnd = lagosStartOfDay(addDays(businessDate, 1));

        // 1. Room charges for every in-house nightly stay covering the night.
        const inHouse = await tx.reservation.findMany({
          where: { tenantId, status: 'CHECKED_IN', stayType: 'NIGHTLY', arrivalAt: { lt: dayEnd }, departureAt: { gt: dayEnd } },
          include: { room: true, roomType: true, promoCode: { select: { code: true } }, folio: { select: { id: true } } },
        });
        for (const r of inHouse) {
          if (!r.folio) continue;
          const posted = await tx.folioEntry.findMany({
            where: { folioId: r.folio.id, type: 'ROOM', businessDate: dbDate(businessDate) },
            select: { id: true },
          });
          const liveCount = posted.length
            ? posted.length - (await tx.folioEntry.count({ where: { refEntryId: { in: posted.map((p) => p.id) } } }))
            : 0;
          if (liveCount > 0) continue;
          const folio = await this.docs.loadFolio(tx, tenantId, r.folio.id);
          if (folio.status !== 'OPEN') continue;
          // Each night is charged at the price snapshotted for it at booking
          // (resolveNightlyRates); a night added later without one is resolved now.
          const night = await this.reservations.nightFor(tx, tenantId, r, businessDate);
          await this.ledger.postRoomNight(
            tx,
            tenantId,
            folio,
            { date: businessDate, rateKobo: night.rateKobo, discountKobo: night.discountKobo, ...(night.loyaltyDiscountKobo ? { loyaltyDiscountKobo: night.loyaltyDiscountKobo, loyaltyLabel: await pointsLabel(tx, tenantId) } : {}), promoCode: r.promoCode?.code ?? null, description: roomNightLabel(r.room?.number, businessDate) },
            SYSTEM,
          );
          summary.roomChargesPosted += 1;
          summary.roomChargesKobo += night.rateKobo;
        }

        // 2. No-shows: confirmed or pending stays that should have arrived by the business date.
        const unarrived = await tx.reservation.findMany({
          where: { tenantId, status: { in: ['PENDING', 'CONFIRMED'] }, arrivalAt: { lt: dayEnd } },
          select: { id: true, code: true },
        });
        if (unarrived.length) {
          await tx.reservation.updateMany({
            where: { id: { in: unarrived.map((u) => u.id) } },
            data: { status: 'NO_SHOW', noShowAt: new Date(), cancelReason: `Not checked in by the night audit of ${humanDate(businessDate)}` },
          });
          summary.noShows = unarrived.length;
          await this.commission.reverseAccruedMany(tx, tenantId, unarrived.map((u) => u.id), 'No-show (night audit)');
          for (const u of unarrived) await this.promos.release(tx, tenantId, u.id);
        }

        // 3. Revenue Guard sweep.
        summary.flagsCreated = await this.guard.sweepTx(tx, tenantId);

        // 4. Daily statistics snapshot.
        const [flash] = await computeDailyFlashes(tx, tenantId, businessDate, businessDate);
        const snapshot = { ...flash, live: false };
        await tx.dailyStat.upsert({
          where: { propertyId_date: { propertyId, date: dbDate(businessDate) } },
          create: {
            tenantId,
            propertyId,
            date: dbDate(businessDate),
            roomsAvailable: flash.roomsAvailable,
            roomsSold: flash.roomsSold,
            occupancyRate: flash.occupancyRate,
            adrKobo: flash.adrKobo,
            revparKobo: flash.revparKobo,
            roomRevenueKobo: flash.roomRevenueKobo,
            totalRevenueKobo: flash.totalRevenueKobo,
            paymentsTotalKobo: flash.paymentsTotalKobo,
            dayUseCount: flash.dayUseCount,
            data: snapshot as unknown as Prisma.InputJsonValue,
          },
          update: {
            roomsAvailable: flash.roomsAvailable,
            roomsSold: flash.roomsSold,
            occupancyRate: flash.occupancyRate,
            adrKobo: flash.adrKobo,
            revparKobo: flash.revparKobo,
            roomRevenueKobo: flash.roomRevenueKobo,
            totalRevenueKobo: flash.totalRevenueKobo,
            paymentsTotalKobo: flash.paymentsTotalKobo,
            dayUseCount: flash.dayUseCount,
            data: snapshot as unknown as Prisma.InputJsonValue,
          },
        });

        await this.audit.record(tx, {
          tenantId,
          actor: user ? userActor(user) : SYSTEM_ACTOR,
          action: 'night_audit.completed',
          entityType: 'night_audit_run',
          entityId: claim.run.id,
          metadata: { businessDate, ...summary, noShowCodes: unarrived.map((u) => u.code), dayStart: dayStart.toISOString() },
        });
        return tx.nightAuditRun.update({
          where: { id: claim.run.id },
          data: { status: 'COMPLETED', finishedAt: new Date(), summary: summary as unknown as Prisma.InputJsonValue },
        });
      });
      return { ...toView(run), alreadyRun: false };
    } catch (e) {
      this.logger.error(`Night audit ${businessDate} failed for ${tenantId}: ${(e as Error).message}`);
      const failed = await this.db.tenant(tenantId, (tx) =>
        tx.nightAuditRun.update({
          where: { id: claim.run.id },
          data: { status: 'FAILED', finishedAt: new Date(), error: (e as Error).message.slice(0, 500) },
        }),
      );
      return { ...toView(failed), alreadyRun: false };
    }
  }

  /** Scheduled entry point (02:00 Lagos): yesterday, for every live tenant. */
  async runAll(now = new Date()) {
    const businessDate = addDays(lagosDate(now), -1);
    const tenants = await this.db.system((tx) =>
      tx.tenant.findMany({ where: { subscription: { status: { not: 'SUSPENDED' } } }, select: { id: true } }),
    );
    let completed = 0;
    for (const t of tenants) {
      const r = await this.run(t.id, businessDate, 'SCHEDULED');
      if (r.status === 'COMPLETED') completed++;
    }
    this.logger.log(`Night audit ${businessDate}: ${completed}/${tenants.length} tenants completed`);
    return { businessDate, tenants: tenants.length, completed };
  }
}
