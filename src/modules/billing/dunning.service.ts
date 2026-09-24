import { ControlMirrorService } from '../dedicated-db/control-mirror.service.js';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../prisma/db.service.js';
import { AuditService, SYSTEM_ACTOR } from '../audit/audit.service.js';
import { runDunning } from './dunning.logic.js';

export interface DunningReport {
  checked: number;
  changed: number;
  transitions: { tenantId: string; from: string; to: string }[];
}

/** Moves overdue subscriptions down the dunning ladder. Safe to re-run. */
@Injectable()
export class DunningService {
  private readonly logger = new Logger(DunningService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly mirror: ControlMirrorService,
  ) {}

  async run(now: Date = new Date()): Promise<DunningReport> {
    const report: DunningReport = { checked: 0, changed: 0, transitions: [] };
    // System context: this job legitimately spans every tenant.
    await this.db.system(async (tx) => {
      const subs = await tx.subscription.findMany({
        where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'READ_ONLY'] } },
      });
      report.checked = subs.length;
      for (const sub of subs) {
        const { state, steps } = runDunning(sub, now);
        if (steps.length === 0) continue;
        await tx.subscription.update({
          where: { id: sub.id },
          data: {
            status: state.status,
            pastDueAt: state.pastDueAt,
            readOnlyAt: state.readOnlyAt,
            suspendedAt: state.suspendedAt,
          },
        });
        for (const step of steps) {
          await this.audit.recordControl(tx, {
            tenantId: sub.tenantId,
            actor: SYSTEM_ACTOR,
            action: 'subscription.dunning',
            entityType: 'subscription',
            entityId: sub.id,
            metadata: { from: step.from, to: step.to, effectiveAt: step.at.toISOString() },
          });
          report.transitions.push({ tenantId: sub.tenantId, from: step.from, to: step.to });
        }
        report.changed++;
      }
    });
    // M6: dedicated databases keep a mirror of the subscription.
    for (const tid of new Set(report.transitions.map((t) => t.tenantId))) await this.mirror.sync(tid);
    this.logger.log(
      `Dunning run: checked ${report.checked}, changed ${report.changed}`,
    );
    return report;
  }
}
