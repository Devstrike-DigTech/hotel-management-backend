import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../prisma/db.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { GuardService } from '../guard/guard.service.js';

/** Cross-tenant housekeeping for the scheduler: guard sweep and key expiry. */
@Injectable()
export class OpsJobsService {
  private readonly logger = new Logger(OpsJobsService.name);

  constructor(
    private readonly db: DbService,
    private readonly guard: GuardService,
    private readonly entitlements: EntitlementsService,
  ) {}

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
    const res = await this.db.system((tx) => tx.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } }));
    return { deleted: res.count };
  }
}
