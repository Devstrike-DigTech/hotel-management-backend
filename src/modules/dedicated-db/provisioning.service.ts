import { HttpStatus, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type pg from 'pg';
import type { DbProvisioning, Prisma, TenantDatabase } from '../../generated/prisma/client.js';
import type { PlatformPrincipal } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { SecretBox } from '../../common/crypto/secret-box.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService } from '../../prisma/db.service.js';
import { TenantDbRouter, URL_PURPOSE } from '../../prisma/tenant-db-router.js';
import { AuditService } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { Err } from '../ops/ops.helpers.js';
import { PlatformAuditService } from '../platform/security/platform-audit.service.js';
import {
  applyDeletes, connect, copyTable, countRows, createDatabase, databaseExists, databaseName, dedicatedDbName, deltaTable,
  dropDatabase, purgeTenantRows, schemaVersion, syncMirror, tableChecksum, tenantTables, withDatabase, type TableInfo,
} from './engine.js';
import { ListingsService } from './listings.service.js';
import { migrateDatabase } from './migrate.js';

type Step = 'CREATE_DATABASE' | 'MIGRATE' | 'COPY' | 'READ_ONLY_DELTA' | 'VERIFY' | 'CUTOVER' | 'DONE' | 'ROLLBACK';
const RUNNING = ['PROVISIONING', 'MIGRATING', 'COPYING', 'CUTOVER'];
/** A run interrupted more often than this (crashes, deploys) ends FAILED instead of resuming again. */
export const MAX_RESUMES = 3;
export const PROVISION_JOB = 'dedicated-provision';

function jobsEnabled(): boolean {
  const v = process.env.JOBS_ENABLED;
  return v === undefined || v === 'true' || v === '1';
}

export interface TableRow {
  table: string;
  sourceRows: number;
  copiedRows: number;
  targetRows: number | null;
  sourceChecksum: string | null;
  targetChecksum: string | null;
  ok: boolean | null;
}

class VerificationFailed extends Error {}

export function provisioningView(p: DbProvisioning, tenant: { id: string; name: string; slug: string }) {
  const started = p.readOnlyStartedAt;
  const ended = p.readOnlyEndedAt;
  return {
    id: p.id,
    kind: p.kind as 'PROVISION' | 'ROLLBACK',
    tenant,
    status: p.status,
    step: p.step,
    progressPct: p.progressPct,
    startedAt: p.startedAt.toISOString(),
    finishedAt: p.finishedAt?.toISOString() ?? null,
    requestedBy: p.requestedById ? { id: p.requestedById, fullName: p.requestedByName ?? '', email: '' } : null,
    readOnlyWindow: started ? { startedAt: started.toISOString(), endedAt: ended?.toISOString() ?? null, durationMs: ended ? ended.getTime() - started.getTime() : null } : null,
    tables: p.tables as unknown as TableRow[],
    logs: p.logs as unknown as { at: string; level: string; message: string }[],
    error: p.error,
  };
}

/**
 * Dedicated databases (M6, feature `dedicated_database`): provisioning,
 * rollback and the purge of the shared copy.
 *
 * Provisioning: create the database (AUTO: `hotel_t_<slug>` through
 * DATABASE_ADMIN_URL; URL: an empty database an operator created) -> run
 * every migration -> copy the tenant's rows table by table in foreign-key
 * order -> short read-only window (the gate refuses writes; in-flight
 * transactions are drained with the tenant's advisory lock) with a delta copy
 * -> verify counts and checksums of every table -> flip the routing. The
 * shared copy is kept DEDICATED_SHARED_RETENTION_DAYS (7) and then purged.
 * Any failure before the flip drops the new database and leaves the tenant
 * on the shared database.
 */
@Injectable()
export class ProvisioningService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProvisioningService.name);
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DbService,
    private readonly router: TenantDbRouter,
    private readonly config: AppConfigService,
    private readonly secrets: SecretBox,
    private readonly entitlements: EntitlementsService,
    private readonly listings: ListingsService,
    private readonly audit: AuditService,
    private readonly platformAudit: PlatformAuditService,
    @Optional() private readonly refs?: ModuleRef,
  ) {}

  /**
   * Start-up reconciler: provisionings and rollbacks left in a running state
   * (the API restarted mid-run) are resumed from their last checkpoint.
   */
  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    setTimeout(() => void this.reconcile().catch((e: Error) => this.logger.warn(`Provisioning reconcile failed: ${e.message}`)), 3_000).unref();
  }

  /** Resumes every running provisioning no instance is executing (advisory lock). */
  async reconcile(): Promise<{ resumed: number }> {
    const open = await this.db.system((tx) => tx.dbProvisioning.findMany({ where: { status: { in: RUNNING }, finishedAt: null }, select: { id: true } }));
    let resumed = 0;
    for (const p of open) {
      if (this.running.has(p.id)) continue;
      await this.dispatch(p.id);
      resumed++;
    }
    return { resumed };
  }

  /**
   * Runs a provisioning durably: as a BullMQ job on the platform queue when
   * workers run (a stalled job after a crash is picked up again), in-process
   * otherwise (tests, the seed). Execution is guarded by an advisory lock, so
   * a run is never executed twice at the same time.
   */
  private async dispatch(id: string): Promise<void> {
    if (this.refs && jobsEnabled()) {
      try {
        const { SystemHealthService } = await import('../platform/console/system-health.service.js');
        const queue = this.refs.get(SystemHealthService, { strict: false }).queue('platform');
        await queue.add(PROVISION_JOB, { id }, { jobId: `${PROVISION_JOB}-${id}-${Date.now()}`, attempts: 1, removeOnComplete: 50, removeOnFail: 100 });
        return;
      } catch (e) {
        this.logger.warn(`Queue unavailable, provisioning ${id} runs in-process: ${(e as Error).message}`);
      }
    }
    const job = this.execute(id).finally(() => this.running.delete(id));
    this.running.set(id, job);
  }

  /** Executes (or resumes) a provisioning or rollback; a no-op if another runner holds it. */
  async execute(id: string): Promise<void> {
    const lock = await connect(this.config.get('DATABASE_PLATFORM_URL'));
    try {
      const { rows } = await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok', [`provisioning:${id}`]);
      if (!rows[0]?.ok) return;
      const prov = await this.db.system((tx) => tx.dbProvisioning.findUnique({ where: { id } }));
      if (!prov || !RUNNING.includes(prov.status) || prov.finishedAt) return;
      if (prov.kind === 'ROLLBACK') {
        const reg = await this.db.system((tx) => tx.tenantDatabase.findUniqueOrThrow({ where: { tenantId: prov.tenantId } }));
        return await this.runRollback(id, reg);
      }
      return await this.run(id);
    } finally {
      await lock.end().catch(() => undefined);
    }
  }

  private adminUrl(): string | undefined {
    return this.config.get('DATABASE_ADMIN_URL') ?? (this.config.isProduction ? undefined : this.config.get('DATABASE_MIGRATION_URL'));
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private async tenantRef(tenantId: string) {
    const t = await this.db.system((tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, slug: true } }));
    if (!t) throw AppException.notFound('Tenant');
    return t;
  }

  async databaseView(tenantId: string) {
    await this.tenantRef(tenantId);
    const [reg, current] = await this.db.system(async (tx) => [
      await tx.tenantDatabase.findUnique({ where: { tenantId } }),
      await tx.dbProvisioning.findFirst({ where: { tenantId }, orderBy: { startedAt: 'desc' } }),
    ] as const);
    return this.view(tenantId, reg, current);
  }

  private async view(tenantId: string, reg: TenantDatabase | null, current: DbProvisioning | null) {
    const tenant = await this.tenantRef(tenantId);
    let sizeBytes: number | null = null;
    if (reg?.mode === 'DEDICATED' && reg.dbName) {
      sizeBytes = await this.db.systemFor(tenantId, async (tx) => {
        const [r] = await tx.$queryRaw<{ size: bigint }[]>`SELECT pg_database_size(current_database()) AS size`;
        return r ? Number(r.size) : null;
      }).catch(() => null);
    }
    return {
      tenantId,
      tenant,
      mode: (reg?.mode ?? 'SHARED') as 'SHARED' | 'DEDICATED',
      status: reg?.status ?? null,
      dbName: reg?.dbName ?? null,
      host: reg?.host ?? null,
      version: reg?.version ?? null,
      lastMigratedAt: reg?.lastMigratedAt?.toISOString() ?? null,
      activatedAt: reg?.activatedAt?.toISOString() ?? null,
      sharedCopyPurgeAfter: reg?.sharedPurgeAfter?.toISOString() ?? null,
      sharedCopyPurgedAt: reg?.sharedPurgedAt?.toISOString() ?? null,
      sizeBytes,
      currentProvisioning: current ? provisioningView(current, tenant) : null,
    };
  }

  async list() {
    const regs = await this.db.system((tx) => tx.tenantDatabase.findMany({ orderBy: { createdAt: 'asc' } }));
    return Promise.all(regs.map(async (r) => {
      const current = await this.db.system((tx) => tx.dbProvisioning.findFirst({ where: { tenantId: r.tenantId }, orderBy: { startedAt: 'desc' } }));
      return this.view(r.tenantId, r, current);
    }));
  }

  async provisioning(id: string) {
    const p = await this.db.system((tx) => tx.dbProvisioning.findUnique({ where: { id } }));
    if (!p) throw AppException.notFound('Provisioning');
    return provisioningView(p, await this.tenantRef(p.tenantId));
  }

  /** Resolves when a provisioning or rollback started by this instance has finished. */
  async wait(id: string, timeoutMs = 600_000): Promise<void> {
    await this.running.get(id);
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const p = await this.db.system((tx) => tx.dbProvisioning.findUnique({ where: { id }, select: { status: true, finishedAt: true } }));
      if (!p || p.finishedAt || !RUNNING.includes(p.status)) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ---------------------------------------------------------------------------
  // Provision
  // ---------------------------------------------------------------------------

  async provision(actor: PlatformPrincipal | null, tenantId: string, dto: { source: 'AUTO' | 'URL'; url?: string }, ip?: string) {
    const tenant = await this.tenantRef(tenantId);
    const ent = await this.entitlements.getEntitlements(tenantId);
    if (!ent.features.includes('dedicated_database')) {
      throw new AppException(HttpStatus.FORBIDDEN, 'FEATURE_LOCKED', 'This hotel\'s plan does not include a dedicated database', { feature: 'dedicated_database', requiredPlan: 'enterprise' });
    }
    const reg = await this.db.system((tx) => tx.tenantDatabase.findUnique({ where: { tenantId } }));
    if (reg?.mode === 'DEDICATED') throw Err.invalidState(`DEDICATED_${reg.status ?? ''}`, ['SHARED'], 'This tenant\'s database');
    if (reg?.status && RUNNING.includes(reg.status)) throw Err.invalidState(reg.status, ['FAILED', 'SHARED'], 'The provisioning');

    let ownerUrl: string;
    let createdByUs: boolean;
    if (dto.source === 'URL') {
      if (!dto.url) throw Err.validation('url', 'Give the owner-role URL of an empty database');
      let u: URL;
      try {
        u = new URL(dto.url);
      } catch {
        throw Err.validation('url', 'Not a valid database URL');
      }
      if (!/^postgres(ql)?:$/.test(u.protocol) || !databaseName(dto.url)) throw Err.validation('url', 'Give a postgresql:// URL with a database name');
      ownerUrl = dto.url;
      createdByUs = false;
    } else {
      const admin = this.adminUrl();
      if (!admin) throw new AppException(HttpStatus.SERVICE_UNAVAILABLE, 'DEDICATED_DB_UNAVAILABLE', 'No DATABASE_ADMIN_URL is configured: create the database yourself and paste its URL');
      ownerUrl = withDatabase(admin, dedicatedDbName(this.config.get('DEDICATED_DB_PREFIX'), tenant.slug));
      createdByUs = true;
    }
    const u = new URL(ownerUrl);
    const dbName = databaseName(ownerUrl);
    const prov = await this.db.system(async (tx) => {
      await tx.tenantDatabase.upsert({
        where: { tenantId },
        create: { tenantId, mode: 'SHARED', status: 'PROVISIONING', urlEnc: this.secrets.seal(ownerUrl, URL_PURPOSE.admin), dbName, host: `${u.hostname}${u.port ? `:${u.port}` : ''}`, createdByUs },
        update: { mode: 'SHARED', status: 'PROVISIONING', urlEnc: this.secrets.seal(ownerUrl, URL_PURPOSE.admin), appUrlEnc: null, platformUrlEnc: null, dbName, host: `${u.hostname}${u.port ? `:${u.port}` : ''}`, createdByUs, activatedAt: null, sharedPurgeAfter: null, sharedPurgedAt: null, version: null },
      });
      return tx.dbProvisioning.create({
        data: { tenantId, kind: 'PROVISION', status: 'PROVISIONING', step: 'CREATE_DATABASE', source: dto.source, requestedById: actor?.platformUserId ?? null, requestedByName: actor?.fullName ?? 'System' },
      });
    });
    if (actor) {
      await this.platformAudit.record({ actor, action: 'dedicated_db.provision_started', targetType: 'tenant', targetId: tenantId, tenantId, ip, metadata: { source: dto.source, dbName } });
    }
    await this.dispatch(prov.id);
    return provisioningView(prov, tenant);
  }

  private async log(id: string, level: 'info' | 'warn' | 'error', message: string) {
    const entry = [{ at: new Date().toISOString(), level, message }];
    await this.db.system((tx) => tx.$executeRaw`UPDATE db_provisionings SET logs = logs || ${JSON.stringify(entry)}::jsonb WHERE id = ${id}::uuid`);
    if (level === 'error') this.logger.error(message);
  }

  private async step(id: string, step: Step, progressPct: number, status?: string, extra: Prisma.DbProvisioningUpdateInput = {}) {
    await this.db.system((tx) => tx.dbProvisioning.update({ where: { id }, data: { step, progressPct, ...(status && { status }), ...extra } }));
  }

  private async setTables(id: string, tables: TableRow[], progressPct?: number) {
    await this.db.system((tx) => tx.dbProvisioning.update({ where: { id }, data: { tables: tables as unknown as Prisma.InputJsonValue, ...(progressPct !== undefined && { progressPct }) } }));
  }

  private async setRegistry(tenantId: string, data: Prisma.TenantDatabaseUpdateInput) {
    await this.db.system((tx) => tx.tenantDatabase.update({ where: { tenantId }, data }));
    await this.router.announce();
  }

  private gateKey(tenantId: string) {
    return `tenant-gate:${tenantId}`;
  }

  /** Waits for every in-flight tenant transaction on the shared database to finish. */
  private async drain(src: pg.Client, tenantId: string) {
    await src.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [this.gateKey(tenantId)]);
    await src.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [this.gateKey(tenantId)]);
  }

  private async run(id: string): Promise<void> {
    const prov = await this.db.system((tx) => tx.dbProvisioning.findUniqueOrThrow({ where: { id } }));
    const tenantId = prov.tenantId;
    const reg = await this.db.system((tx) => tx.tenantDatabase.findUniqueOrThrow({ where: { tenantId } }));
    const urls = this.router.urlsOf(reg);
    const dbName = reg.dbName!;
    const logs = (prov.logs as unknown as { message: string }[]) ?? [];
    // Checkpoints: a run with log entries was started before and interrupted.
    const resumed = logs.length > 0;
    let created = false;
    let flipped = false;
    let src: pg.Client | null = null;
    let dst: pg.Client | null = null;
    const started = Date.now();
    try {
      if (resumed) {
        const resumes = logs.filter((l) => l.message.startsWith('Resuming')).length;
        if (reg.mode === 'DEDICATED' && reg.status === 'ACTIVE') {
          // Interrupted after the routing flip: only the bookkeeping is left.
          flipped = true;
          await this.log(id, 'info', 'Resuming after an interruption: the cutover had completed');
          await this.step(id, 'DONE', 100, 'ACTIVE', { readOnlyEndedAt: new Date(), finishedAt: new Date() });
          await this.listings.refreshTenant(tenantId).catch(() => undefined);
          return;
        }
        if (reg.createdByUs) created = true; // our database: dropped if the resumed run fails
        if (resumes >= MAX_RESUMES) throw new Error(`Interrupted ${resumes + 1} times (last at step ${prov.step}); giving up. Start a new provisioning.`);
        await this.log(id, 'warn', `Resuming after an interruption at step ${prov.step}; the copy restarts from a clean target`);
        // Writes were refused during the read-only window: reopen them while the copy runs again.
        if (reg.status === 'CUTOVER') await this.setRegistry(tenantId, { status: 'COPYING' });
      }
      // 1. Create the database.
      if (reg.createdByUs) {
        const admin = this.adminUrl() ?? urls.admin;
        let exists = await databaseExists(admin, dbName);
        if (exists && resumed && ['CREATE_DATABASE', 'MIGRATE'].includes(prov.step)) {
          // Interrupted while migrating: a half-applied migration cannot be resumed; start the database again.
          await this.router.release(dbName);
          await dropDatabase(admin, dbName);
          await this.log(id, 'info', `Dropped ${dbName}: it was interrupted while being migrated`);
          exists = false;
        }
        if (exists) {
          if (!resumed) throw new Error(`Database ${dbName} already exists; drop it or choose another`);
          await this.log(id, 'info', `Reusing ${dbName} created before the interruption`);
        } else {
          await this.log(id, 'info', `Creating database ${dbName}`);
          await createDatabase(admin, dbName);
        }
        created = true;
      } else {
        await this.log(id, 'info', `Using the operator-provided database ${dbName}`);
      }

      // 2. Migrations.
      await this.step(id, 'MIGRATE', 10, 'MIGRATING');
      await this.db.system((tx) => tx.tenantDatabase.update({ where: { tenantId }, data: { status: 'MIGRATING' } }));
      await this.log(id, 'info', 'Applying every migration');
      await migrateDatabase(urls.admin);
      const owner = await connect(urls.admin);
      const version = await schemaVersion(owner).finally(() => owner.end());
      await this.log(id, 'info', `Schema at ${version}`);
      await this.db.system((tx) => tx.tenantDatabase.update({ where: { tenantId }, data: { version, lastMigratedAt: new Date() } }));

      src = await connect(this.config.get('DATABASE_PLATFORM_URL'));
      dst = await connect(urls.platform);
      await dst.query('SELECT app_install_context_key($1)', [this.config.get('DB_CONTEXT_SECRET')]);
      const tables = await tenantTables(src);
      if (resumed) {
        // Rows copied before the interruption are removed; the copy runs again.
        // The purge authorisation needs a registry row in this database: a
        // marker is written and removed inside the same transaction.
        const owner = await connect(urls.admin);
        try {
          await owner.query('BEGIN');
          await owner.query(
            `INSERT INTO tenant_databases (id, tenant_id, mode, status, created_at, updated_at) VALUES (gen_random_uuid(), $1::uuid, 'DEDICATED', 'ACTIVE', now(), now()) ON CONFLICT (tenant_id) DO UPDATE SET mode = 'DEDICATED', status = 'ACTIVE'`,
            [tenantId],
          );
          await owner.query('SELECT app_begin_tenant_purge($1::uuid)', [tenantId]);
          const removed = await purgeTenantRows(owner, tables, tenantId);
          await owner.query('DELETE FROM tenant_databases WHERE tenant_id = $1::uuid', [tenantId]);
          await owner.query('COMMIT');
          if (removed) await this.log(id, 'info', `Removed ${removed} rows copied before the interruption`);
        } catch (err) {
          await owner.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          await owner.end();
        }
      }
      for (const t of tables) {
        if ((await countRows(dst, t.name, tenantId)) > 0) throw new Error(`The target database already holds rows of this tenant in ${t.name}`);
      }
      await syncMirror(src, dst, tenantId);

      // 3. Bulk copy while the hotel keeps working.
      await this.step(id, 'COPY', 20, 'COPYING');
      await this.db.system((tx) => tx.tenantDatabase.update({ where: { tenantId }, data: { status: 'COPYING' } }));
      const rows: TableRow[] = [];
      for (const t of tables) rows.push({ table: t.name, sourceRows: await countRows(src, t.name, tenantId), copiedRows: 0, targetRows: null, sourceChecksum: null, targetChecksum: null, ok: null });
      await this.setTables(id, rows);
      await this.log(id, 'info', `Copying ${rows.reduce((a, r) => a + r.sourceRows, 0)} rows in ${tables.length} tables`);
      for (const [i, t] of tables.entries()) {
        rows[i]!.copiedRows = await copyTable(src, dst, t, tenantId, { batch: 500 });
        if (rows[i]!.copiedRows) await this.setTables(id, rows, 20 + Math.round((50 * (i + 1)) / tables.length));
      }
      await this.setTables(id, rows, 70);

      // 4. Read-only window: drain, delta copy.
      await this.step(id, 'READ_ONLY_DELTA', 72, 'CUTOVER', { readOnlyStartedAt: new Date() });
      await this.setRegistry(tenantId, { status: 'CUTOVER' });
      await this.drain(src, tenantId);
      await this.log(id, 'info', 'Read-only window started; copying changes made during the copy');
      await this.deltaAll(src, dst, tables, tenantId, id, rows);
      await syncMirror(src, dst, tenantId);

      // 5. Verify.
      await this.step(id, 'VERIFY', 85);
      const bad = await this.verify(src, dst, tables, tenantId, rows);
      await this.setTables(id, rows, 92);
      if (bad.length) throw new VerificationFailed(`Verification failed for ${bad.join(', ')}`);
      await this.log(id, 'info', `Verified ${tables.length} tables: row counts and checksums match`);

      // 6. Cutover.
      await this.step(id, 'CUTOVER', 95);
      const retention = this.config.get('DEDICATED_SHARED_RETENTION_DAYS');
      const now = new Date();
      await this.setRegistry(tenantId, { mode: 'DEDICATED', status: 'ACTIVE', activatedAt: now, sharedPurgeAfter: new Date(now.getTime() + retention * 86_400_000), sharedPurgedAt: null });
      flipped = true;
      await this.step(id, 'DONE', 100, 'ACTIVE', { readOnlyEndedAt: new Date(), finishedAt: new Date() });
      await this.log(id, 'info', `Cutover complete in ${Math.round((Date.now() - started) / 1000)} s; the shared copy is kept ${retention} days`);
      await this.db.systemFor(tenantId, (tx) => this.audit.record(tx, {
        tenantId, actor: { kind: 'system', name: 'Devstrike platform' }, action: 'dedicated_db.activated', entityType: 'tenant', entityId: tenantId, metadata: { dbName },
      }));
      await this.platformAudit.record({ actor: null, action: 'dedicated_db.activated', targetType: 'tenant', targetId: tenantId, tenantId, metadata: { dbName, provisioningId: id } });
      await this.listings.refreshTenant(tenantId).catch(() => undefined);
    } catch (e) {
      const message = (e as Error).message;
      await this.log(id, 'error', message).catch(() => undefined);
      if (!flipped) {
        await this.setRegistry(tenantId, { status: 'FAILED', mode: 'SHARED' }).catch(() => undefined);
        await Promise.allSettled([src?.end(), dst?.end()]);
        src = dst = null;
        if (created) {
          await this.router.release(dbName);
          await dropDatabase(this.adminUrl() ?? urls.admin, dbName).catch((err: Error) => this.log(id, 'warn', `Could not drop ${dbName}: ${err.message}`));
          await this.log(id, 'info', `Rolled back: dropped ${dbName}; the hotel stays on the shared database`).catch(() => undefined);
        }
        await this.db.system((tx) => tx.dbProvisioning.update({
          where: { id },
          data: { status: e instanceof VerificationFailed ? 'ROLLED_BACK' : 'FAILED', step: 'ROLLBACK', error: message, finishedAt: new Date(), readOnlyEndedAt: new Date() },
        })).catch(() => undefined);
        await this.platformAudit.record({ actor: null, action: 'dedicated_db.provision_failed', targetType: 'tenant', targetId: tenantId, tenantId, metadata: { error: message, provisioningId: id } });
      }
    } finally {
      await Promise.allSettled([src?.end(), dst?.end()]);
    }
  }

  private async deltaAll(from: pg.Client, to: pg.Client, tables: TableInfo[], tenantId: string, id: string, rows?: TableRow[]) {
    let ins = 0;
    let upd = 0;
    const deletes: { t: TableInfo; keys: string[] }[] = [];
    for (const t of tables) {
      const d = await deltaTable(from, to, t, tenantId);
      ins += d.inserted;
      upd += d.updated;
      if (d.toDelete.length) deletes.push({ t, keys: d.toDelete });
      const r = rows?.find((x) => x.table === t.name);
      if (r) r.copiedRows += d.inserted;
    }
    let del = 0;
    for (const { t, keys } of deletes.reverse()) del += await applyDeletes(to, t, tenantId, keys);
    await this.log(id, 'info', `Delta: ${ins} inserted, ${upd} updated, ${del} deleted`);
  }

  private async verify(a: pg.Client, b: pg.Client, tables: TableInfo[], tenantId: string, rows: TableRow[]): Promise<string[]> {
    const bad: string[] = [];
    for (const t of tables) {
      const [x, y] = [await tableChecksum(a, t, tenantId), await tableChecksum(b, t, tenantId)];
      const r = rows.find((row) => row.table === t.name)!;
      r.sourceRows = x.rows;
      r.targetRows = y.rows;
      r.sourceChecksum = x.checksum;
      r.targetChecksum = y.checksum;
      r.ok = x.rows === y.rows && x.checksum === y.checksum;
      if (!r.ok) bad.push(t.name);
    }
    return bad;
  }

  // ---------------------------------------------------------------------------
  // Rollback to the shared database (before the shared copy is purged)
  // ---------------------------------------------------------------------------

  async rollback(actor: PlatformPrincipal, tenantId: string, ip?: string) {
    const tenant = await this.tenantRef(tenantId);
    const reg = await this.db.system((tx) => tx.tenantDatabase.findUnique({ where: { tenantId } }));
    if (!reg || reg.mode !== 'DEDICATED' || reg.status !== 'ACTIVE') throw Err.invalidState(reg?.status ?? 'SHARED', ['ACTIVE'], 'This tenant\'s dedicated database');
    if (reg.sharedPurgedAt) throw Err.invalidState('PURGED', ['ACTIVE'], 'The shared copy');
    const prov = await this.db.system((tx) => tx.dbProvisioning.create({
      data: { tenantId, kind: 'ROLLBACK', status: 'CUTOVER', step: 'ROLLBACK', source: 'ROLLBACK', requestedById: actor.platformUserId, requestedByName: actor.fullName },
    }));
    await this.platformAudit.record({ actor, action: 'dedicated_db.rollback_started', targetType: 'tenant', targetId: tenantId, tenantId, ip });
    await this.dispatch(prov.id);
    return provisioningView(prov, tenant);
  }

  private async runRollback(id: string, reg: TenantDatabase) {
    const tenantId = reg.tenantId;
    const urls = this.router.urlsOf(reg);
    let src: pg.Client | null = null;
    let dst: pg.Client | null = null;
    try {
      await this.step(id, 'READ_ONLY_DELTA', 10, 'CUTOVER', { readOnlyStartedAt: new Date() });
      await this.setRegistry(tenantId, { status: 'ROLLING_BACK' });
      await new Promise((r) => setTimeout(r, 1500));
      src = await connect(urls.platform);
      dst = await connect(this.config.get('DATABASE_PLATFORM_URL'));
      const tables = await tenantTables(dst);
      const rows: TableRow[] = tables.map((t) => ({ table: t.name, sourceRows: 0, copiedRows: 0, targetRows: null, sourceChecksum: null, targetChecksum: null, ok: null }));
      await this.log(id, 'info', 'Copying changes made in the dedicated database back to the shared database');
      await this.deltaAll(src, dst, tables, tenantId, id, rows);
      await this.step(id, 'VERIFY', 70);
      const bad = await this.verify(src, dst, tables, tenantId, rows);
      await this.setTables(id, rows, 85);
      if (bad.length) throw new VerificationFailed(`Verification failed for ${bad.join(', ')}`);
      await this.setRegistry(tenantId, { mode: 'SHARED', status: null, activatedAt: null, sharedPurgeAfter: null });
      await this.step(id, 'DONE', 100, 'ROLLED_BACK', { readOnlyEndedAt: new Date(), finishedAt: new Date() });
      await this.log(id, 'info', 'The hotel is back on the shared database');
      await Promise.allSettled([src.end(), dst.end()]);
      src = dst = null;
      await this.router.release(reg.dbName!);
      if (reg.createdByUs) {
        await dropDatabase(this.adminUrl() ?? urls.admin, reg.dbName!).catch((e: Error) => this.log(id, 'warn', `Could not drop ${reg.dbName}: ${e.message}`));
      }
      await this.platformAudit.record({ actor: null, action: 'dedicated_db.rolled_back', targetType: 'tenant', targetId: tenantId, tenantId, metadata: { provisioningId: id } });
      await this.listings.refreshTenant(tenantId).catch(() => undefined);
    } catch (e) {
      const message = (e as Error).message;
      await this.log(id, 'error', message).catch(() => undefined);
      await this.setRegistry(tenantId, { status: 'ACTIVE' }).catch(() => undefined);
      await this.db.system((tx) => tx.dbProvisioning.update({ where: { id }, data: { status: 'FAILED', error: message, finishedAt: new Date(), readOnlyEndedAt: new Date() } })).catch(() => undefined);
    } finally {
      await Promise.allSettled([src?.end(), dst?.end()]);
    }
  }

  // ---------------------------------------------------------------------------
  // Purge of the shared copy
  // ---------------------------------------------------------------------------

  async purgeShared(tenantId: string, actor?: PlatformPrincipal | null, ip?: string): Promise<number> {
    const reg = await this.db.system((tx) => tx.tenantDatabase.findUnique({ where: { tenantId } }));
    if (!reg || reg.mode !== 'DEDICATED' || reg.status !== 'ACTIVE') throw Err.invalidState(reg?.status ?? 'SHARED', ['ACTIVE'], 'This tenant\'s dedicated database');
    if (reg.sharedPurgedAt) return 0;
    const c = await connect(this.config.get('DATABASE_PLATFORM_URL'));
    let n = 0;
    try {
      const tables = await tenantTables(c);
      await c.query('BEGIN');
      await c.query('SELECT app_begin_tenant_purge($1::uuid)', [tenantId]);
      n = await purgeTenantRows(c, tables, tenantId);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await c.end();
    }
    await this.db.system((tx) => tx.tenantDatabase.update({ where: { tenantId }, data: { sharedPurgedAt: new Date() } }));
    await this.platformAudit.record({ actor: actor ?? null, action: 'dedicated_db.shared_copy_purged', targetType: 'tenant', targetId: tenantId, tenantId, ip, metadata: { rows: n } });
    return n;
  }

  /** Job: purge shared copies whose retention has passed. */
  async purgeDue(now = new Date()): Promise<{ purged: number }> {
    const due = await this.db.system((tx) => tx.tenantDatabase.findMany({ where: { mode: 'DEDICATED', status: 'ACTIVE', sharedPurgedAt: null, sharedPurgeAfter: { lte: now } } }));
    let purged = 0;
    for (const r of due) {
      try {
        await this.purgeShared(r.tenantId);
        purged++;
      } catch (e) {
        this.logger.error(`Shared copy purge failed for ${r.tenantId}: ${(e as Error).message}`);
      }
    }
    return { purged };
  }

  /** `pnpm db:migrate:all` from the console: shared, then every dedicated database. */
  async migrateAll() {
    const results: { target: string; applied: string[]; ok: boolean; error: string | null }[] = [];
    const targets: { target: string; url: string; tenantId: string | null }[] = [];
    const shared = this.config.get('DATABASE_MIGRATION_URL');
    if (shared) targets.push({ target: 'shared', url: shared, tenantId: null });
    const regs = await this.db.system((tx) => tx.tenantDatabase.findMany({ where: { mode: 'DEDICATED' } }));
    for (const r of regs) targets.push({ target: r.dbName ?? r.tenantId, url: this.router.urlsOf(r).admin, tenantId: r.tenantId });
    for (const t of targets) {
      try {
        const before = await this.versions(t.url);
        await migrateDatabase(t.url);
        const after = await this.versions(t.url);
        const applied = after.filter((m) => !before.includes(m));
        if (t.tenantId) {
          await this.db.system((tx) => tx.tenantDatabase.update({ where: { tenantId: t.tenantId! }, data: { version: after[after.length - 1] ?? null, lastMigratedAt: new Date() } }));
        }
        results.push({ target: t.target, applied, ok: true, error: null });
      } catch (e) {
        results.push({ target: t.target, applied: [], ok: false, error: (e as Error).message.slice(0, 500) });
      }
    }
    return { results };
  }

  private async versions(url: string): Promise<string[]> {
    const c = await connect(url);
    try {
      const { rows } = await c.query<{ migration_name: string }>(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`).catch(() => ({ rows: [] as { migration_name: string }[] }));
      return rows.map((r) => r.migration_name);
    } finally {
      await c.end();
    }
  }

}
