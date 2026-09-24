import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type pg from 'pg';
import type { DataExport } from '../../../generated/prisma/client.js';
import type { AuthUser, PlatformPrincipal } from '../../../common/auth-types.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { FieldCipher } from '../../../common/crypto/field-cipher.js';
import { signToken, verifyToken } from '../../../common/crypto/signed-token.js';
import { ZipWriter } from '../../../common/utils/zip.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DbService } from '../../../prisma/db.service.js';
import { TenantDbRouter } from '../../../prisma/tenant-db-router.js';
import { AuditService, csvCell, SYSTEM_ACTOR } from '../../audit/audit.service.js';
import { connect, tenantTables } from '../../dedicated-db/engine.js';
import { appError, Err } from '../../ops/ops.helpers.js';
import { PlatformAuditService } from '../../platform/security/platform-audit.service.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../../storage/object-storage.js';

const LINK_HOURS = 24;
const KEEP_DAYS = 7;
/** Tables never exported (secrets and plumbing). */
const SKIP_TABLES = new Set(['refresh_tokens', 'idempotency_keys', 'loyalty_challenges', 'platform_refresh_tokens', 'platform_sessions']);
/** Control-plane tables of the tenant (shared database) included in the export. */
const CONTROL_EXPORT = [
  'subscriptions', 'invoices', 'tenant_feature_overrides', 'coupon_redemptions', 'support_requests', 'support_messages',
  'impersonation_sessions', 'api_keys', 'white_label_settings', 'email_domains', 'sms_sender_requests', 'staff_portal_domains', 'sso_configs',
];

type Requester = { kind: 'USER' | 'PLATFORM'; id: string; fullName: string };

interface ExportPayload {
  e: string;
  tid: string;
  exp: number;
}

/**
 * Full tenant data export (M6, feature `data_export`; also the first step of
 * offboarding): every table of the tenant as JSON and CSV in a zip with a
 * README and a manifest, stored for 7 days, downloadable through a signed
 * link valid 24 hours. Secrets (password, PIN, token and key hashes,
 * encrypted secrets) are left out; guest ID numbers are decrypted and
 * marked sensitive in the README.
 */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly db: DbService,
    private readonly router: TenantDbRouter,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly platformAudit: PlatformAuditService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  // ---------------------------------------------------------------------------
  // Views and links
  // ---------------------------------------------------------------------------

  downloadUrl(e: DataExport): string | null {
    if (e.status !== 'READY' || !e.linkExpiresAt || e.linkExpiresAt <= new Date()) return null;
    const token = signToken<ExportPayload>(this.config.get('SHARE_TOKEN_SECRET'), 'export', {
      e: e.id,
      tid: e.tenantId,
      exp: Math.floor(e.linkExpiresAt.getTime() / 1000),
    });
    return `${this.config.get('API_PUBLIC_URL').replace(/\/$/, '')}/api/v1/public/exports/${token}`;
  }

  view(e: DataExport) {
    const url = this.downloadUrl(e);
    return {
      id: e.id,
      status: e.status as 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'EXPIRED',
      requestedBy: { kind: e.requestedByKind as 'USER' | 'PLATFORM', id: e.requestedById, fullName: e.requestedByName },
      reason: e.reason as 'REQUEST' | 'OFFBOARDING',
      progressPct: e.progressPct,
      entities: e.entities as { name: string; rows: number }[],
      sizeBytes: e.sizeBytes,
      fileName: e.fileName,
      downloadUrl: url,
      expiresAt: url ? e.linkExpiresAt!.toISOString() : null,
      createdAt: e.createdAt.toISOString(),
      finishedAt: e.finishedAt?.toISOString() ?? null,
      error: e.error,
    };
  }

  async list(tenantId: string) {
    const rows = await this.db.control(tenantId, (tx) => tx.dataExport.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 50 }));
    return rows.map((r) => this.view(r));
  }

  async get(tenantId: string, id: string) {
    const row = await this.db.control(tenantId, (tx) => tx.dataExport.findFirst({ where: { id, tenantId } }));
    if (!row) throw AppException.notFound('Export');
    return this.view(row);
  }

  /** A fresh 24-hour link while the file is kept. */
  async link(tenantId: string, id: string, actor: Requester, ip?: string) {
    const row = await this.db.control(tenantId, (tx) => tx.dataExport.findFirst({ where: { id, tenantId } }));
    if (!row) throw AppException.notFound('Export');
    if (row.status !== 'READY' || !row.deleteFileAfter || row.deleteFileAfter <= new Date()) throw Err.invalidState(row.status, ['READY'], 'This export');
    const until = new Date(Math.min(Date.now() + LINK_HOURS * 3_600_000, row.deleteFileAfter.getTime()));
    const updated = await this.db.system((tx) => tx.dataExport.update({ where: { id }, data: { linkExpiresAt: until } }));
    await this.recordTenant(tenantId, actor, 'export.link_issued', id, { until: until.toISOString() }, ip);
    return this.view(updated);
  }

  // ---------------------------------------------------------------------------
  // Request and run
  // ---------------------------------------------------------------------------

  async request(tenantId: string, by: Requester, opts: { reason?: 'REQUEST' | 'OFFBOARDING'; formats?: ('json' | 'csv')[] } = {}, ip?: string) {
    const formats = opts.formats?.length ? [...new Set(opts.formats)] : ['json', 'csv'];
    let row: DataExport;
    try {
      row = await this.db.system((tx) =>
        tx.dataExport.create({
          data: { tenantId, status: 'QUEUED', reason: opts.reason ?? 'REQUEST', requestedByKind: by.kind, requestedById: by.id, requestedByName: by.fullName, formats },
        }),
      );
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'An export is already running for this hotel', { status: 'RUNNING', allowed: ['READY', 'FAILED'] });
      throw e;
    }
    await this.recordTenant(tenantId, by, 'export.requested', row.id, { formats, reason: row.reason }, ip);
    const job = this.run(row.id).finally(() => this.running.delete(row.id));
    this.running.set(row.id, job);
    return this.view(row);
  }

  /** Resolves when an export started on this instance has finished (tests, offboarding). */
  async wait(id: string): Promise<void> {
    await this.running.get(id);
  }

  private async progress(id: string, progressPct: number, entities?: { name: string; rows: number }[]) {
    await this.db.system((tx) => tx.dataExport.update({ where: { id }, data: { progressPct, ...(entities && { entities }) } }));
  }

  private async run(id: string): Promise<void> {
    const e = await this.db.system((tx) => tx.dataExport.update({ where: { id }, data: { status: 'RUNNING' } }));
    const tenantId = e.tenantId;
    const route = this.router.dedicated(tenantId);
    let data: pg.Client | null = null;
    let control: pg.Client | null = null;
    try {
      const tenant = await this.db.system((tx) => tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }));
      data = await connect(route ? this.router.urlsOf(route).platform : this.config.get('DATABASE_PLATFORM_URL'));
      control = await connect(this.config.get('DATABASE_PLATFORM_URL'));
      const tables = (await tenantTables(data)).filter((t) => !SKIP_TABLES.has(t.name));
      const cipher = new FieldCipher(this.config.get('GUEST_DATA_KEY'));
      const zip = new ZipWriter();
      const entities: { name: string; rows: number }[] = [];
      const total = tables.length + CONTROL_EXPORT.length + 1;
      let done = 0;
      const addEntity = (name: string, rows: Record<string, unknown>[]) => {
        entities.push({ name, rows: rows.length });
        if (e.formats.includes('json')) zip.add(`json/${name}.json`, JSON.stringify(rows, null, 2));
        if (e.formats.includes('csv')) zip.add(`csv/${name}.csv`, toCsv(rows));
      };
      const tenantRow = (await control.query(`SELECT row_to_json(t) AS r FROM tenants t WHERE id = $1`, [tenantId])).rows.map((r: { r: Record<string, unknown> }) => r.r);
      addEntity('tenant', tenantRow);
      for (const t of tables) {
        const rows = await fetchAll(data, t.name, tenantId, t.pk);
        addEntity(t.name, sanitise(t.name, rows, (enc) => {
          try {
            return cipher.decrypt(enc, tenantId);
          } catch {
            return null;
          }
        }));
        done++;
        if (done % 10 === 0) await this.progress(id, Math.round((done / total) * 90), entities);
      }
      for (const name of CONTROL_EXPORT) {
        const rows = await fetchAll(control, name, tenantId, ['id']).catch(() => fetchAll(control!, name, tenantId, ['tenant_id']));
        addEntity(name, sanitise(name, rows, () => null));
        done++;
      }
      const at = new Date();
      zip.add('manifest.json', JSON.stringify({ tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug }, generatedAt: at.toISOString(), formats: e.formats, entities }, null, 2));
      zip.add('README.txt', readme(tenant.name, this.config.get('APP_NAME'), at, entities, e.formats));
      const body = zip.toBuffer();
      const date = at.toISOString().slice(0, 10);
      const fileName = `${tenant.slug}-export-${date}.zip`;
      const key = `tenants/${tenantId}/exports/${id}.zip`;
      await this.storage.put(key, body, 'application/zip');
      await this.db.system((tx) =>
        tx.dataExport.update({
          where: { id },
          data: {
            status: 'READY', progressPct: 100, entities, sizeBytes: body.length, fileKey: key, fileName, finishedAt: at,
            linkExpiresAt: new Date(at.getTime() + LINK_HOURS * 3_600_000), deleteFileAfter: new Date(at.getTime() + KEEP_DAYS * 86_400_000),
          },
        }),
      );
      await this.recordTenant(tenantId, null, 'export.ready', id, { sizeBytes: body.length, entities: entities.length });
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      this.logger.error(`Export ${id} failed: ${message}`);
      await this.db.system((tx) => tx.dataExport.update({ where: { id }, data: { status: 'FAILED', error: message, finishedAt: new Date() } })).catch(() => undefined);
    } finally {
      await Promise.allSettled([data?.end(), control?.end()]);
    }
  }

  // ---------------------------------------------------------------------------
  // Download and cleanup
  // ---------------------------------------------------------------------------

  async download(token: string, ip?: string) {
    const res = verifyToken<ExportPayload>(this.config.get('SHARE_TOKEN_SECRET'), 'export', token);
    if (!res.ok) {
      if (res.reason === 'expired') throw appError(HttpStatus.GONE, 'LINK_EXPIRED', 'This download link has expired. Ask for a new one.');
      throw AppException.notFound('Export');
    }
    const e = await this.db.system((tx) => tx.dataExport.findFirst({ where: { id: res.payload.e, tenantId: res.payload.tid } }));
    if (!e || e.status !== 'READY' || !e.fileKey || !e.linkExpiresAt || e.linkExpiresAt <= new Date()) throw appError(HttpStatus.GONE, 'LINK_EXPIRED', 'This download link has expired. Ask for a new one.');
    const obj = await this.storage.get(e.fileKey);
    if (!obj) throw AppException.notFound('Export file');
    await this.recordTenant(e.tenantId, null, 'export.downloaded', e.id, {}, ip);
    return { body: obj.body, fileName: e.fileName ?? `${e.id}.zip` };
  }

  /** Job: deletes export files past their 7 days. */
  async cleanup(now = new Date()) {
    const due = await this.db.system((tx) => tx.dataExport.findMany({ where: { status: 'READY', deleteFileAfter: { lte: now } } }));
    for (const e of due) {
      if (e.fileKey) await this.storage.delete(e.fileKey).catch(() => undefined);
      await this.db.system((tx) => tx.dataExport.update({ where: { id: e.id }, data: { status: 'EXPIRED', fileKey: null, linkExpiresAt: null } }));
    }
    // Exports interrupted by a restart are run again.
    const stale = await this.db.system((tx) => tx.dataExport.findMany({ where: { status: { in: ['QUEUED', 'RUNNING'] }, updatedAt: { lte: new Date(now.getTime() - 10 * 60_000) } } }));
    for (const e of stale) {
      if (this.running.has(e.id)) continue;
      const job = this.run(e.id).finally(() => this.running.delete(e.id));
      this.running.set(e.id, job);
    }
    return { expired: due.length, restarted: stale.length };
  }

  private async recordTenant(tenantId: string, by: Requester | null, action: string, exportId: string, metadata: Record<string, unknown>, ip?: string) {
    await this.db
      .systemFor(tenantId, (tx) =>
        this.audit.record(tx, {
          tenantId,
          actor: by ? (by.kind === 'USER' ? { kind: 'user', id: by.id, name: by.fullName } : { kind: 'platform', id: by.id, name: by.fullName }) : SYSTEM_ACTOR,
          action,
          entityType: 'data_export',
          entityId: exportId,
          propertyId: null,
          metadata,
          ip,
        }),
      )
      .catch((e: Error) => this.logger.warn(`Audit for export ${exportId} failed: ${e.message}`));
  }

  // Convenience wrappers for the controllers.
  requestAsUser(u: AuthUser, formats?: ('json' | 'csv')[], ip?: string) {
    return this.request(u.tenantId, { kind: 'USER', id: u.userId, fullName: u.fullName }, { formats }, ip);
  }

  async requestAsPlatform(p: PlatformPrincipal, tenantId: string, reason: 'REQUEST' | 'OFFBOARDING' = 'REQUEST', ip?: string) {
    const view = await this.request(tenantId, { kind: 'PLATFORM', id: p.platformUserId, fullName: p.fullName }, { reason }, ip);
    await this.platformAudit.record({ actor: p, action: 'export.requested', targetType: 'tenant', targetId: tenantId, tenantId, ip, metadata: { exportId: view.id, reason } });
    return view;
  }
}

async function fetchAll(c: pg.ClientBase, table: string, tenantId: string, pk: string[]): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const order = pk.map((k) => `"${k}"`).join(', ');
  for (let offset = 0; ; offset += 2000) {
    const { rows } = await c.query<{ data: string | null }>(
      `SELECT json_agg(t)::text AS data FROM (SELECT * FROM "${table}" WHERE tenant_id = $1 ORDER BY ${order} LIMIT 2000 OFFSET $2) t`,
      [tenantId, offset],
    );
    const batch = rows[0]?.data ? (JSON.parse(rows[0].data) as Record<string, unknown>[]) : [];
    out.push(...batch);
    if (batch.length < 2000) break;
  }
  return out;
}

/** Drops secrets (`*_hash`, `*_enc`); guest ID numbers are decrypted into `id_number`. */
export function sanitise(table: string, rows: Record<string, unknown>[], decrypt: (enc: string) => string | null): Record<string, unknown>[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (table === 'guests' && k === 'id_number_enc') {
        out.id_number = typeof v === 'string' ? decrypt(v) : null;
        continue;
      }
      if (/_hash$|_enc$/.test(k) || k === 'handoff_code_hash') continue;
      out[k] = v;
    }
    return out;
  });
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => (v === null || v === undefined ? '' : csvCell(typeof v === 'object' ? JSON.stringify(v) : String(v as string | number | boolean | bigint)));
  return `${[cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n')}\r\n`;
}

function readme(name: string, appName: string, at: Date, entities: { name: string; rows: number }[], formats: string[]): string {
  const lines = [
    `${name}: full data export`,
    `Generated by ${appName} on ${at.toISOString()}`,
    '',
    'What is in this archive',
    ...(formats.includes('json') ? ['  json/<entity>.json  every record as JSON (one array per file)'] : []),
    ...(formats.includes('csv') ? ['  csv/<entity>.csv    the same records as CSV (nested values as JSON text)'] : []),
    '  manifest.json       the entities and their row counts',
    '',
    'Entities and row counts',
    ...entities.map((e) => `  ${e.name.padEnd(28)} ${e.rows}`),
    '',
    'Sensitive data',
    '  guests.id_number holds guests\' identity document numbers in clear text.',
    '  Keep this archive safe: it contains personal data protected by the',
    '  Nigeria Data Protection Act (NDPA) 2023. Share it only with people who',
    '  need it, and delete copies you no longer need.',
    '',
    'Left out on purpose: password, PIN, token and API key hashes, and encrypted',
    'secrets (webhook signing secrets, SSO client secrets, bank account numbers).',
    '',
  ];
  return lines.join('\n');
}
