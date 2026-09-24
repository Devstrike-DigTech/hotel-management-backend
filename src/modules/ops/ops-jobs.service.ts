import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../prisma/db.service.js';
import { runInProperty } from '../../common/property-scope.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { GuardService } from '../guard/guard.service.js';
import { CorporateService } from '../corporate/corporate.service.js';
import { HousekeepingService } from '../housekeeping/housekeeping.service.js';
import { MaintenanceService } from '../maintenance/maintenance.service.js';
import { AlertsService } from '../whatsapp/alerts.service.js';

/** Cross-tenant housekeeping for the scheduler: guard sweep and key expiry. */
@Injectable()
export class OpsJobsService {
  private readonly logger = new Logger(OpsJobsService.name);

  constructor(
    private readonly db: DbService,
    private readonly guard: GuardService,
    private readonly entitlements: EntitlementsService,
    private readonly housekeeping: HousekeepingService,
    private readonly maintenance: MaintenanceService,
    private readonly corporate: CorporateService,
    private readonly alerts: AlertsService,
  ) {}

  /** Runs `fn` for every active tenant entitled to `feature`, isolating failures. */
  private async eachTenant(job: string, feature: string | null, fn: (tenantId: string) => Promise<number>) {
    const tenants = await this.db.system((tx) =>
      tx.tenant.findMany({ where: { subscription: { status: { not: 'SUSPENDED' } } }, select: { id: true } }),
    );
    let total = 0;
    for (const t of tenants) {
      try {
        if (feature) {
          const ent = await this.entitlements.getEntitlements(t.id);
          if (!ent.features.includes(feature)) continue;
        }
        total += await fn(t.id);
      } catch (e) {
        this.logger.error(`${job} failed for ${t.id}: ${(e as Error).message}`);
      }
    }
    return { tenants: tenants.length, total };
  }

  /**
   * M5: runs `fn` once per property of every active tenant entitled to
   * `feature`, inside that property's scope (see common/property-scope.ts).
   */
  async eachProperty(job: string, feature: string | null, fn: (tenantId: string, propertyId: string) => Promise<number>) {
    const ids = await this.db.system((tx) => tx.tenant.findMany({ where: { subscription: { status: { not: 'SUSPENDED' } } }, select: { id: true } }));
    // M6: properties come from the database that serves each tenant.
    const props = await this.db.propertiesOf(ids.map((t) => t.id));
    const tenants = ids.map((t) => ({ id: t.id, properties: props.get(t.id) ?? [] }));
    let total = 0;
    let properties = 0;
    for (const t of tenants) {
      try {
        if (feature) {
          const ent = await this.entitlements.getEntitlements(t.id);
          if (!ent.features.includes(feature)) continue;
        }
      } catch (e) {
        this.logger.error(`${job} failed for ${t.id}: ${(e as Error).message}`);
        continue;
      }
      for (const p of t.properties) {
        properties++;
        try {
          total += await runInProperty(t.id, p.id, () => fn(t.id, p.id));
        } catch (e) {
          this.logger.error(`${job} failed for ${t.id} / ${p.id}: ${(e as Error).message}`);
        }
      }
    }
    return { tenants: tenants.length, properties, total };
  }

  /** 07:00 Lagos: stayover cleaning tasks for occupied rooms. */
  stayoverAll() {
    return this.eachProperty('Stayover tasks', 'housekeeping', (id) => this.housekeeping.runStayover(id));
  }

  /** 06:00 Lagos: tickets from preventive maintenance schedules that are due. */
  maintenanceSchedulesAll(now = new Date()) {
    return this.eachProperty('Maintenance schedules', 'maintenance', (id) => this.maintenance.runSchedules(id, now));
  }

  /** Hourly: room blocks that start or end move rooms in and out of OUT_OF_ORDER. */
  roomBlocksAll() {
    return this.eachProperty('Room blocks', null, async (id) => {
      const r = await this.maintenance.applyBlocks(id);
      return r.started + r.ended;
    });
  }

  /** 1st of the month 06:00 Lagos: statements for monthly-billed corporate accounts. */
  cityLedgerStatementsAll() {
    return this.eachTenant('City ledger statements', 'promotions', (id) => this.corporate.monthlyStatements(id));
  }

  /** 09:00 Lagos: overdue city ledger reminders (1, 15 and 30 days past due). */
  cityLedgerRemindersAll() {
    return this.eachTenant('City ledger reminders', 'promotions', (id) => this.corporate.overdueReminders(id));
  }

  /** Every minute: owner alerts whose debounce or quiet hours have passed. */
  guardAlertsDue(now = new Date()) {
    return this.alerts.processDue(now);
  }

  async guardSweepAll(now = new Date()) {
    const tenants = await this.db.system((tx) =>
      tx.tenant.findMany({ where: { subscription: { status: { not: 'SUSPENDED' } } }, select: { id: true } }),
    );
    let created = 0;
    for (const t of tenants) {
      try {
        const ent = await this.entitlements.getEntitlements(t.id);
        if (!ent.features.includes('revenue_guard_basic') && !ent.features.includes('revenue_guard_full')) continue;
        created += await this.guard.sweep(t.id, now);
      } catch (e) {
        this.logger.error(`Guard sweep failed for ${t.id}: ${(e as Error).message}`);
      }
    }
    return { tenants: tenants.length, created };
  }

  async purgeIdempotencyKeys(now = new Date()) {
    const res = await this.db.systemAll((tx) => tx.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } }));
    return { deleted: res.reduce((a, r) => a + r.count, 0) };
  }
}
