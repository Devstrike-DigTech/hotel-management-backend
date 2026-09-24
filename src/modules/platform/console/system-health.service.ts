import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DbService } from '../../../prisma/db.service.js';
import { BILLING_QUEUE, GUEST_QUEUE, OPERATIONS_QUEUE, OPS_JOBS, redisConnection } from '../../jobs/jobs.constants.js';
import { GUEST_JOBS } from '../../booking/guest-jobs.service.js';
import { Err } from '../../ops/ops.helpers.js';

export const PLATFORM_QUEUE = 'platform';
export const QUEUES = [BILLING_QUEUE, OPERATIONS_QUEUE, GUEST_QUEUE, PLATFORM_QUEUE] as const;

/** M6 scheduled jobs on the platform queue (Africa/Lagos). */
export const PLATFORM_JOBS = {
  webhooksDeliver: { name: 'webhooks-deliver', scheduler: 'webhooks-deliver-minutely', cron: '* * * * *' },
  announcementsEmail: { name: 'announcements-email', scheduler: 'announcements-email-minutely', cron: '* * * * *' },
  offboarding: { name: 'offboarding', scheduler: 'offboarding-daily', cron: '30 4 * * *' },
  dedicatedPurge: { name: 'dedicated-purge', scheduler: 'dedicated-purge-hourly', cron: '40 * * * *' },
  publicListings: { name: 'public-listings', scheduler: 'public-listings-15m', cron: '*/15 * * * *' },
  apiUsageFlush: { name: 'api-usage-flush', scheduler: 'api-usage-flush-5m', cron: '*/5 * * * *' },
  mirrorSync: { name: 'mirror-sync', scheduler: 'mirror-sync-5m', cron: '*/5 * * * *' },
  exportsCleanup: { name: 'exports-cleanup', scheduler: 'exports-cleanup-hourly', cron: '50 * * * *' },
  whiteLabelChecks: { name: 'white-label-checks', scheduler: 'white-label-checks-10m', cron: '*/10 * * * *' },
} as const;

/** Every scheduled job with its queue and cron, for the cron table. */
export const SCHEDULES: { job: string; queue: string; schedule: string; everyMinutes: number }[] = [
  { job: 'dunning', queue: BILLING_QUEUE, schedule: '0 2 * * *', everyMinutes: 1440 },
  ...Object.values(OPS_JOBS).map((j) => ({ job: j.name, queue: OPERATIONS_QUEUE, schedule: j.cron, everyMinutes: cronMinutes(j.cron) })),
  ...[GUEST_JOBS.holdSweep, GUEST_JOBS.guestSweep].map((j) => ({ job: j.name, queue: GUEST_QUEUE, schedule: j.cron, everyMinutes: cronMinutes(j.cron) })),
  ...Object.values(PLATFORM_JOBS).map((j) => ({ job: j.name, queue: PLATFORM_QUEUE, schedule: j.cron, everyMinutes: cronMinutes(j.cron) })),
];

/** Rough interval of a cron pattern in minutes (for the "overdue" test). */
export function cronMinutes(cron: string): number {
  const [min, hour, dom, , dow] = cron.split(' ');
  if (dom !== '*' ) return 31 * 1440;
  if (dow !== '*') return 7 * 1440;
  if (hour !== '*') return hour.startsWith('*/') ? Number(hour.slice(2)) * 60 : 1440;
  if (min === '*') return 1;
  if (min.startsWith('*/')) return Number(min.slice(2));
  return 60;
}

const DAY = 86_400_000;

/**
 * Operational view for the console (M6): BullMQ queues (with retry / clean of
 * failed jobs), notification, webhook, channel-sync and Paystack events,
 * the last run of every scheduled job, and database sizes, across the shared
 * and every dedicated database.
 */
@Injectable()
export class SystemHealthService implements OnModuleDestroy {
  private readonly logger = new Logger(SystemHealthService.name);
  private readonly queues = new Map<string, Queue>();
  private connection: Redis | null = null;

  constructor(
    private readonly db: DbService,
    private readonly config: AppConfigService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    this.connection?.disconnect();
  }

  queue(name: string): Queue {
    if (!(QUEUES as readonly string[]).includes(name)) throw Err.validation('name', `Unknown queue ${name}`);
    let q = this.queues.get(name);
    if (!q) {
      this.connection ??= new Redis(redisConnection(this.config.get('REDIS_URL')));
      q = new Queue(name, { connection: this.connection, prefix: 'hotel' });
      this.queues.set(name, q);
    }
    return q;
  }

  async queueCounts() {
    return Promise.all(
      QUEUES.map(async (name) => {
        const q = this.queue(name);
        try {
          const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
          return { name, waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0, completed: c.completed ?? 0, paused: await q.isPaused() };
        } catch (e) {
          this.logger.warn(`Queue ${name}: ${(e as Error).message}`);
          return { name, waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0, paused: false };
        }
      }),
    );
  }

  async failedJobs(name: string, limit = 50) {
    const jobs = await this.queue(name).getFailed(0, Math.min(limit, 200) - 1);
    return jobs.map((j) => ({
      id: String(j.id),
      name: j.name,
      failedReason: j.failedReason ?? '',
      attemptsMade: j.attemptsMade,
      timestamp: new Date(j.finishedOn ?? j.timestamp).toISOString(),
      data: JSON.parse(JSON.stringify(j.data ?? {}, (_k, v: unknown) => (typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}...` : v))) as unknown,
    }));
  }

  async retry(name: string, jobIds?: string[]) {
    const q = this.queue(name);
    const jobs = jobIds?.length ? (await Promise.all(jobIds.map((id) => q.getJob(id)))).filter((j) => j) : await q.getFailed(0, 999);
    let retried = 0;
    for (const j of jobs) {
      if (!j) continue;
      try {
        await j.retry('failed');
        retried++;
      } catch {
        // not failed any more
      }
    }
    return { retried };
  }

  async clean(name: string, jobIds?: string[]) {
    const q = this.queue(name);
    if (!jobIds?.length) {
      const removed = await q.clean(0, 10_000, 'failed');
      return { removed: removed.length };
    }
    let removed = 0;
    for (const id of jobIds) {
      const j = await q.getJob(id);
      if (j && (await j.isFailed())) {
        await j.remove();
        removed++;
      }
    }
    return { removed };
  }

  private async crons() {
    const runs = await this.db.system((tx) => tx.jobRun.findMany());
    const next = new Map<string, number>();
    for (const name of QUEUES) {
      try {
        for (const s of await this.queue(name).getJobSchedulers(0, 200)) if (s.name && s.next) next.set(s.name, s.next);
      } catch {
        // Redis unavailable
      }
    }
    const now = Date.now();
    return SCHEDULES.map((s) => {
      const r = runs.find((x) => x.job === s.job);
      const last = r?.lastRunAt ?? null;
      const overdue = !!last && now - last.getTime() > s.everyMinutes * 60_000 * 2 + 5 * 60_000;
      return {
        job: s.job, queue: s.queue, schedule: s.schedule,
        lastRunAt: last?.toISOString() ?? null, lastStatus: (r?.lastStatus ?? null) as 'OK' | 'FAILED' | null,
        lastDurationMs: r?.lastDurationMs ?? null, lastError: r?.lastError ?? null,
        nextRunAt: next.has(s.job) ? new Date(next.get(s.job)!).toISOString() : null, overdue,
      };
    });
  }

  async health() {
    const since = new Date(Date.now() - DAY);
    const [queues, crons, parts, database] = await Promise.all([
      this.queueCounts(),
      this.crons(),
      this.db.systemAll(async (tx, t) => {
        const notif = await tx.notificationLog.groupBy({
          by: ['channel', 'provider', 'status'],
          where: { createdAt: { gte: since }, ...(t.tenantId ? { tenantId: t.tenantId } : t.excludeTenantIds.length ? { OR: [{ tenantId: null }, { tenantId: { notIn: t.excludeTenantIds } }] } : {}) },
          _count: { _all: true },
        });
        const failedNotifs = await tx.notificationLog.findMany({
          where: { status: 'FAILED', createdAt: { gte: since }, ...(t.tenantId ? { tenantId: t.tenantId } : {}) },
          orderBy: { createdAt: 'desc' }, take: 10,
          select: { id: true, tenantId: true, template: true, channel: true, recipient: true, error: true, createdAt: true },
        });
        const failedDeliveries = await tx.webhookDelivery.findMany({
          where: { ...t.tenants, status: 'FAILED', updatedAt: { gte: since } }, orderBy: { updatedAt: 'desc' }, take: 10,
          include: { endpoint: { select: { url: true } } },
        });
        const failedCount = await tx.webhookDelivery.count({ where: { ...t.tenants, status: { in: ['FAILED', 'RETRYING'] }, updatedAt: { gte: since } } });
        const disabled = await tx.webhookEndpoint.count({ where: { ...t.tenants, status: 'DISABLED' } });
        const syncErrors = await tx.channelSyncLog.findMany({
          where: { ...t.tenants, status: 'ERROR', startedAt: { gte: since } }, orderBy: { startedAt: 'desc' }, take: 10,
          include: { connection: { select: { property: { select: { name: true } } } } },
        });
        const syncCount = await tx.channelSyncLog.count({ where: { ...t.tenants, status: 'ERROR', startedAt: { gte: since } } });
        const paystack = await tx.paymentEvent.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 20 });
        const paystackCount = await tx.paymentEvent.count({ where: { createdAt: { gte: since } } });
        return { notif, failedNotifs, failedDeliveries, failedCount, disabled, syncErrors, syncCount, paystack, paystackCount };
      }),
      this.databaseSizes(),
    ]);
    const tenantIds = new Set<string>();
    for (const p of parts) {
      p.failedNotifs.forEach((n) => n.tenantId && tenantIds.add(n.tenantId));
      p.failedDeliveries.forEach((d) => tenantIds.add(d.tenantId));
      p.syncErrors.forEach((s) => tenantIds.add(s.tenantId));
      p.paystack.forEach((e) => e.tenantId && tenantIds.add(e.tenantId));
    }
    const tenants = await this.db.system((tx) => tx.tenant.findMany({ where: { id: { in: [...tenantIds] } }, select: { id: true, name: true, slug: true } }));
    const ref = (id: string | null) => (id ? (tenants.find((t) => t.id === id) ?? { id, name: '', slug: '' }) : null);

    const byChannel = new Map<string, { channel: 'EMAIL' | 'SMS' | 'WHATSAPP'; provider: string; sent24h: number; failed24h: number }>();
    for (const g of parts.flatMap((p) => p.notif)) {
      const key = `${g.channel}|${g.provider}`;
      const cur = byChannel.get(key) ?? { channel: g.channel, provider: g.provider, sent24h: 0, failed24h: 0 };
      if (g.status === 'FAILED') cur.failed24h += g._count._all;
      else if (g.status === 'SENT' || g.status === 'OUTBOX') cur.sent24h += g._count._all;
      byChannel.set(key, cur);
    }
    const notifFailed = [...byChannel.values()].reduce((a, c) => a + c.failed24h, 0);
    const failedJobs = queues.reduce((a, q) => a + q.failed, 0);
    const webhookFailures = parts.reduce((a, p) => a + p.failedCount, 0);
    const syncErrors = parts.reduce((a, p) => a + p.syncCount, 0);
    const overdueCrons = crons.filter((c) => c.overdue).length;
    const dedicatedUnhealthy = database.tenants.filter((t) => t.mode === 'DEDICATED' && t.sizeBytes === null).length;
    const summary = {
      status: (failedJobs > 50 || overdueCrons > 3 || dedicatedUnhealthy > 0 ? 'down' : failedJobs || notifFailed || webhookFailures || syncErrors || overdueCrons ? 'degraded' : 'ok') as 'ok' | 'degraded' | 'down',
      failedJobs, webhookFailures24h: webhookFailures, notificationFailures24h: notifFailed, channelSyncErrors24h: syncErrors, overdueCrons, dedicatedDbsUnhealthy: dedicatedUnhealthy,
    };
    const mask = (r: string) => (r.includes('@') ? r.replace(/^(.).*(@.*)$/, '$1***$2') : r.replace(/^(\+?\d{4}).*(\d{3})$/, '$1***$2'));
    return {
      summary,
      queues,
      notifications: {
        failed24h: notifFailed,
        byChannel: [...byChannel.values()],
        recentFailures: parts.flatMap((p) => p.failedNotifs).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 10)
          .map((n) => ({ id: n.id, tenant: ref(n.tenantId), template: n.template, channel: n.channel, recipient: mask(n.recipient), error: n.error, createdAt: n.createdAt.toISOString() })),
      },
      webhooks: {
        failed24h: webhookFailures,
        disabledEndpoints: parts.reduce((a, p) => a + p.disabled, 0),
        recentFailures: parts.flatMap((p) => p.failedDeliveries).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, 10)
          .map((d) => ({ deliveryId: d.id, tenant: ref(d.tenantId)!, endpointUrl: d.endpoint.url, eventType: d.eventType, responseStatus: d.responseStatus, error: d.error, attempts: d.attempts, at: (d.lastAttemptAt ?? d.updatedAt).toISOString() })),
      },
      channelSync: {
        errors24h: syncErrors,
        recent: parts.flatMap((p) => p.syncErrors).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()).slice(0, 10)
          .map((s) => ({ tenant: ref(s.tenantId)!, propertyName: s.connection.property?.name ?? '', kind: s.kind, message: s.error ?? s.summary, at: s.startedAt.toISOString() })),
      },
      paystack: {
        events24h: parts.reduce((a, p) => a + p.paystackCount, 0),
        recent: parts.flatMap((p) => p.paystack).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 20)
          .map((e) => ({ id: e.id, eventType: e.eventType, tenant: ref(e.tenantId), processed: !!e.processedAt, createdAt: e.createdAt.toISOString() })),
      },
      crons,
      database,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Cached summary for the overview (30 s). */
  private summaryCache: { at: number; value: Awaited<ReturnType<SystemHealthService['health']>>['summary'] } | null = null;

  async summary() {
    if (this.summaryCache && Date.now() - this.summaryCache.at < 30_000) return this.summaryCache.value;
    const value = (await this.health()).summary;
    this.summaryCache = { at: Date.now(), value };
    return value;
  }

  async databaseSizes() {
    const shared = await this.db.system(async (tx) => {
      const [size] = await tx.$queryRaw<{ size: bigint }[]>`SELECT pg_database_size(current_database()) AS size`;
      const rows = await tx.$queryRaw<{ tenant_id: string; n: bigint }[]>`
        SELECT tenant_id::text, sum(n)::bigint AS n FROM (
          SELECT tenant_id, count(*) AS n FROM reservations GROUP BY tenant_id
          UNION ALL SELECT tenant_id, count(*) FROM folio_entries GROUP BY tenant_id
          UNION ALL SELECT tenant_id, count(*) FROM audit_logs WHERE tenant_id IS NOT NULL GROUP BY tenant_id
          UNION ALL SELECT tenant_id, count(*) FROM guests GROUP BY tenant_id
          UNION ALL SELECT tenant_id, count(*) FROM notification_logs WHERE tenant_id IS NOT NULL GROUP BY tenant_id
          UNION ALL SELECT tenant_id, count(*) FROM pos_order_lines GROUP BY tenant_id
        ) x GROUP BY tenant_id`;
      const tenants = await tx.tenant.findMany({ where: { lifecycle: { not: 'DELETED' } }, select: { id: true, name: true, slug: true } });
      return { size: Number(size?.size ?? 0), rows, tenants };
    });
    const dedicated = new Map(this.db.router.activeDedicated().map((r) => [r.tenantId, r]));
    const out = [];
    for (const t of shared.tenants) {
      const r = dedicated.get(t.id);
      if (r) {
        const size = await this.db.systemFor(t.id, async (tx) => {
          const [s] = await tx.$queryRaw<{ size: bigint; n: bigint }[]>`SELECT pg_database_size(current_database()) AS size, (SELECT count(*) FROM reservations) + (SELECT count(*) FROM folio_entries) + (SELECT count(*) FROM audit_logs) + (SELECT count(*) FROM guests) AS n`;
          return s ? { size: Number(s.size), n: Number(s.n) } : null;
        }).catch(() => null);
        out.push({ tenant: t, mode: 'DEDICATED' as const, sizeBytes: size?.size ?? null, estimatedBytes: size?.size ?? 0, rows: size?.n ?? 0 });
      } else {
        const n = Number(shared.rows.find((x) => x.tenant_id === t.id)?.n ?? 0);
        out.push({ tenant: t, mode: 'SHARED' as const, sizeBytes: null, estimatedBytes: n * 420, rows: n });
      }
    }
    out.sort((a, b) => b.estimatedBytes - a.estimatedBytes);
    return { sharedSizeBytes: shared.size, tenants: out };
  }
}

/** Records the last run of each scheduled job (the cron table). */
@Injectable()
export class JobRunsService {
  private readonly logger = new Logger(JobRunsService.name);

  constructor(private readonly db: DbService) {}

  async track<T>(queue: string, job: string, fn: () => Promise<T>): Promise<T> {
    const started = new Date();
    await this.db.system((tx) => tx.jobRun.upsert({ where: { job }, create: { job, queue, lastRunAt: started, runs: 1 }, update: { lastRunAt: started, queue, runs: { increment: 1 } } })).catch(() => undefined);
    try {
      const out = await fn();
      await this.finish(job, started, 'OK', null);
      return out;
    } catch (e) {
      await this.finish(job, started, 'FAILED', (e as Error).message);
      throw e;
    }
  }

  private async finish(job: string, started: Date, status: 'OK' | 'FAILED', error: string | null) {
    await this.db
      .system((tx) =>
        tx.jobRun.update({
          where: { job },
          data: { lastFinishedAt: new Date(), lastStatus: status, lastDurationMs: Date.now() - started.getTime(), lastError: error?.slice(0, 500) ?? null, ...(status === 'FAILED' && { failures: { increment: 1 } }) },
        }),
      )
      .catch((e: Error) => this.logger.warn(`Job run record for ${job} failed: ${e.message}`));
  }
}
