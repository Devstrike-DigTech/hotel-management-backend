/**
 * Dedicated tenant databases: the data mover (M6).
 *
 * Framework-free (plain `pg` clients) so the API, the seed and the
 * `db:migrate:all` script share it. Every function takes connected clients;
 * the caller decides roles and transactions:
 *   - reads and writes of tenant rows run as `hotel_platform` (RLS policy
 *     `platform_access`), on the shared and on the dedicated database;
 *   - creating / dropping databases runs as the owner role (CREATEDB).
 *
 * Which tables move: every table with a `tenant_id` column except the
 * control-plane ones (they stay in the shared database: subscriptions,
 * billing, API keys, white-label, SSO, support, exports, the registry...).
 * Rows are copied table by table in foreign-key order, in batches, as JSON
 * (`json_agg` on the source, `json_populate_recordset` on the target), so
 * every column type round-trips exactly (bigint and numeric included: the
 * JSON text is never parsed in JavaScript).
 */
import pg from 'pg';

/** Tables with a tenant_id that never leave the shared database. */
export const CONTROL_TABLES = new Set([
  'tenants', 'subscriptions', 'invoices', 'tenant_feature_overrides', 'payment_events',
  'platform_audit_logs', 'coupon_redemptions', 'announcement_receipts', 'support_requests', 'support_messages',
  'support_attachments', 'impersonation_sessions', 'data_exports', 'api_keys', 'api_usage_daily',
  'white_label_settings', 'email_domains', 'sms_sender_requests', 'staff_portal_domains', 'sso_configs',
  'tenant_offboardings', 'tenant_databases', 'db_provisionings', 'public_listings', 'owner_setup_tokens',
]);

/**
 * Control-plane rows mirrored into a dedicated database (read-only copies
 * kept in step by the API): the tenant row (foreign keys), the plan
 * catalogue, the subscription and feature overrides (public filters and
 * entitlement reads inside tenant transactions).
 */
export const MIRROR_TABLES = ['plans', 'features', 'plan_features', 'tenants', 'subscriptions', 'tenant_feature_overrides'] as const;

export interface TableInfo {
  name: string;
  pk: string[];
  columns: string[];
}

export type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Session settings that make row text identical on both sides (checksums). */
export async function prepareSession(c: pg.ClientBase): Promise<void> {
  await c.query(`SET TIME ZONE 'UTC'; SET DateStyle = 'ISO, MDY'; SET extra_float_digits = 3; SET IntervalStyle = 'postgres'`);
}

/** Tenant data tables in foreign-key order (parents first). */
export async function tenantTables(c: pg.ClientBase): Promise<TableInfo[]> {
  const { rows: tables } = await c.query<{ table_name: string }>(
    `SELECT t.table_name FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = t.table_name AND c.column_name = 'tenant_id')
      ORDER BY t.table_name`,
  );
  const names = tables.map((t) => t.table_name).filter((n) => !CONTROL_TABLES.has(n));
  const set = new Set(names);
  const { rows: fks } = await c.query<{ child: string; parent: string }>(
    `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
       FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid <> c.confrelid`,
  );
  const deps = new Map<string, Set<string>>(names.map((n) => [n, new Set<string>()]));
  for (const f of fks) {
    const child = f.child.replace(/^public\./, '').replace(/"/g, '');
    const parent = f.parent.replace(/^public\./, '').replace(/"/g, '');
    if (set.has(child) && set.has(parent)) deps.get(child)!.add(parent);
  }
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (n: string, path: string[]) => {
    if (state.get(n) === 'done') return;
    if (state.get(n) === 'visiting') throw new Error(`Foreign-key cycle: ${[...path, n].join(' -> ')}`);
    state.set(n, 'visiting');
    for (const p of [...deps.get(n)!].sort()) visit(p, [...path, n]);
    state.set(n, 'done');
    order.push(n);
  };
  for (const n of names) visit(n, []);

  const { rows: cols } = await c.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
  );
  const { rows: pks } = await c.query<{ table_name: string; column_name: string }>(
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY tc.table_name, kcu.ordinal_position`,
  );
  return order.map((name) => ({
    name,
    pk: pks.filter((p) => p.table_name === name).map((p) => p.column_name),
    columns: cols.filter((x) => x.table_name === name).map((x) => x.column_name),
  }));
}

function orderBy(t: TableInfo): string {
  return t.pk.map(ident).join(', ');
}

function pkExpr(t: TableInfo, alias = 't'): string {
  return t.pk.length === 1 ? `${alias}.${ident(t.pk[0]!)}::text` : `(${t.pk.map((k) => `${alias}.${ident(k)}::text`).join(` || '|' || `)})`;
}

export async function countRows(c: pg.ClientBase, t: string, tenantId: string): Promise<number> {
  const { rows } = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${ident(t)} WHERE tenant_id = $1`, [tenantId]);
  return Number(rows[0]!.n);
}

/** Copies the tenant's rows of one table in batches; returns the number of rows inserted. */
export async function copyTable(src: pg.ClientBase, dst: pg.ClientBase, t: TableInfo, tenantId: string, opts: { batch?: number; onBatch?: (copied: number) => void } = {}): Promise<number> {
  const batch = opts.batch ?? 500;
  let offset = 0;
  let copied = 0;
  for (;;) {
    const { rows } = await src.query<{ data: string | null; n: number }>(
      `SELECT json_agg(t)::text AS data, count(*)::int AS n FROM (SELECT * FROM ${ident(t.name)} WHERE tenant_id = $1 ORDER BY ${orderBy(t)} LIMIT $2 OFFSET $3) t`,
      [tenantId, batch, offset],
    );
    const n = rows[0]?.n ?? 0;
    if (!n || !rows[0]!.data) break;
    const res = await dst.query(`INSERT INTO ${ident(t.name)} SELECT * FROM json_populate_recordset(NULL::${ident(t.name)}, $1::json) ON CONFLICT DO NOTHING`, [rows[0]!.data]);
    copied += res.rowCount ?? 0;
    offset += n;
    opts.onBatch?.(copied);
    if (n < batch) break;
  }
  return copied;
}

/** Row count and an order-independent-of-storage checksum of the tenant's rows. */
export async function tableChecksum(c: pg.ClientBase, t: TableInfo, tenantId: string): Promise<{ rows: number; checksum: string }> {
  const { rows } = await c.query<{ n: string; sum: string | null }>(
    `SELECT count(*)::text AS n, md5(string_agg(md5(row_to_json(t)::text), '' ORDER BY ${t.pk.map((k) => `t.${ident(k)}`).join(', ')})) AS sum
       FROM ${ident(t.name)} t WHERE t.tenant_id = $1`,
    [tenantId],
  );
  return { rows: Number(rows[0]!.n), checksum: rows[0]!.sum ?? 'empty' };
}

async function rowHashes(c: pg.ClientBase, t: TableInfo, tenantId: string): Promise<Map<string, string>> {
  const { rows } = await c.query<{ k: string; h: string }>(
    `SELECT ${pkExpr(t)} AS k, md5(row_to_json(t)::text) AS h FROM ${ident(t.name)} t WHERE t.tenant_id = $1`,
    [tenantId],
  );
  return new Map(rows.map((r) => [r.k, r.h]));
}

async function fetchRows(c: pg.ClientBase, t: TableInfo, tenantId: string, keys: string[]): Promise<string | null> {
  const { rows } = await c.query<{ data: string | null }>(
    `SELECT json_agg(t)::text AS data FROM ${ident(t.name)} t WHERE t.tenant_id = $1 AND ${pkExpr(t)} = ANY($2::text[])`,
    [tenantId, keys],
  );
  return rows[0]?.data ?? null;
}

export interface TableDelta {
  inserted: number;
  updated: number;
  /** Keys present on the target only; delete them with `applyDeletes` in reverse table order. */
  toDelete: string[];
}

/**
 * Brings the target's copy of one table in line with the source (rows added
 * or changed since the bulk copy). Deletions are returned, not applied, so the
 * caller can apply them children-first.
 */
export async function deltaTable(src: pg.ClientBase, dst: pg.ClientBase, t: TableInfo, tenantId: string): Promise<TableDelta> {
  const [a, b] = await Promise.all([rowHashes(src, t, tenantId), rowHashes(dst, t, tenantId)]);
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [k, h] of a) {
    const other = b.get(k);
    if (other === undefined) missing.push(k);
    else if (other !== h) changed.push(k);
  }
  const toDelete = [...b.keys()].filter((k) => !a.has(k));
  for (let i = 0; i < missing.length; i += 500) {
    const data = await fetchRows(src, t, tenantId, missing.slice(i, i + 500));
    if (data) await dst.query(`INSERT INTO ${ident(t.name)} SELECT * FROM json_populate_recordset(NULL::${ident(t.name)}, $1::json) ON CONFLICT DO NOTHING`, [data]);
  }
  const setCols = t.columns.filter((col) => !t.pk.includes(col));
  for (let i = 0; i < changed.length && setCols.length; i += 500) {
    const data = await fetchRows(src, t, tenantId, changed.slice(i, i + 500));
    if (!data) continue;
    await dst.query(
      `UPDATE ${ident(t.name)} AS t SET ${setCols.map((col) => `${ident(col)} = r.${ident(col)}`).join(', ')}
         FROM json_populate_recordset(NULL::${ident(t.name)}, $1::json) AS r
        WHERE ${t.pk.map((k) => `t.${ident(k)} = r.${ident(k)}`).join(' AND ')}`,
      [data],
    );
  }
  return { inserted: missing.length, updated: changed.length, toDelete };
}

export async function applyDeletes(dst: pg.ClientBase, t: TableInfo, tenantId: string, keys: string[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < keys.length; i += 500) {
    const r = await dst.query(`DELETE FROM ${ident(t.name)} t WHERE t.tenant_id = $1 AND ${pkExpr(t)} = ANY($2::text[])`, [tenantId, keys.slice(i, i + 500)]);
    n += r.rowCount ?? 0;
  }
  return n;
}

/**
 * Copies the control-plane rows a dedicated database needs (plan catalogue,
 * the tenant row, its subscription and feature overrides) from the shared
 * database. Idempotent: upserts by primary key and removes stale overrides.
 */
export async function syncMirror(src: pg.ClientBase, dst: pg.ClientBase, tenantId: string): Promise<void> {
  const filters: Record<(typeof MIRROR_TABLES)[number], { where: string; params: unknown[] }> = {
    plans: { where: 'TRUE', params: [] },
    features: { where: 'TRUE', params: [] },
    plan_features: { where: 'TRUE', params: [] },
    tenants: { where: 'id = $1', params: [tenantId] },
    subscriptions: { where: 'tenant_id = $1', params: [tenantId] },
    tenant_feature_overrides: { where: 'tenant_id = $1', params: [tenantId] },
  };
  const { rows: cols } = await src.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY ordinal_position`,
    [MIRROR_TABLES as unknown as string[]],
  );
  const pkOf: Record<string, string[]> = { plans: ['id'], features: ['code'], plan_features: ['plan_id', 'feature_code'], tenants: ['id'], subscriptions: ['id'], tenant_feature_overrides: ['id'] };
  for (const table of MIRROR_TABLES) {
    const f = filters[table];
    const { rows } = await src.query<{ data: string | null }>(`SELECT json_agg(t)::text AS data FROM ${ident(table)} t WHERE ${f.where}`, f.params);
    const data = rows[0]?.data ?? '[]';
    const pk = pkOf[table]!;
    const set = cols.filter((c) => c.table_name === table && !pk.includes(c.column_name)).map((c) => c.column_name);
    const conflict = set.length ? `DO UPDATE SET ${set.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ')}` : 'DO NOTHING';
    await dst.query(
      `INSERT INTO ${ident(table)} SELECT * FROM json_populate_recordset(NULL::${ident(table)}, $1::json) ON CONFLICT (${pk.map(ident).join(', ')}) ${conflict}`,
      [data],
    );
    if (table === 'tenant_feature_overrides' || table === 'plan_features') {
      const keyCols = pk.map((k) => `t.${ident(k)}::text`).join(` || '|' || `);
      await dst.query(
        `DELETE FROM ${ident(table)} t WHERE ${table === 'tenant_feature_overrides' ? 't.tenant_id = $2 AND' : ''} (${keyCols}) <> ALL (
           SELECT (${pk.map((k) => `r.${ident(k)}::text`).join(` || '|' || `)}) FROM json_populate_recordset(NULL::${ident(table)}, $1::json) r)`,
        table === 'tenant_feature_overrides' ? [data, tenantId] : [data],
      );
    }
  }
}

/**
 * Deletes every data-plane row of a tenant (children first) inside the
 * caller's transaction. The caller must have called
 * `app_begin_tenant_purge(tenant)` in the same transaction so the
 * append-only ledgers let the deletes through.
 */
export async function purgeTenantRows(c: pg.ClientBase, tables: TableInfo[], tenantId: string, log?: Log): Promise<number> {
  let total = 0;
  for (const t of [...tables].reverse()) {
    const r = await c.query(`DELETE FROM ${ident(t.name)} WHERE tenant_id = $1`, [tenantId]);
    if (r.rowCount) log?.('info', `purged ${r.rowCount} rows from ${t.name}`);
    total += r.rowCount ?? 0;
  }
  return total;
}

/** "postgresql://u:p@h:5432/db" with another database name. */
export function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

export function isSafeDbName(name: string): boolean {
  return /^[a-z_][a-z0-9_]{0,62}$/.test(name);
}

/** hotel_t_<slug> (lowercase, underscores, at most 63 characters). */
export function dedicatedDbName(prefix: string, slug: string): string {
  const s = slug.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${prefix}${s}`.slice(0, 63);
}

export async function createDatabase(adminUrl: string, name: string): Promise<void> {
  if (!isSafeDbName(name)) throw new Error(`Refusing database name ${name}`);
  const c = new pg.Client({ connectionString: withDatabase(adminUrl, 'postgres') });
  await c.connect();
  try {
    await c.query(`CREATE DATABASE ${ident(name)}`);
  } finally {
    await c.end();
  }
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  if (!isSafeDbName(name)) throw new Error(`Refusing database name ${name}`);
  const c = new pg.Client({ connectionString: withDatabase(adminUrl, 'postgres') });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
  } finally {
    await c.end();
  }
}

export async function databaseExists(adminUrl: string, name: string): Promise<boolean> {
  const c = new pg.Client({ connectionString: withDatabase(adminUrl, 'postgres') });
  await c.connect();
  try {
    const { rows } = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return rows.length > 0;
  } finally {
    await c.end();
  }
}

/** Name of the newest migration applied to a database (its schema version). */
export async function schemaVersion(c: pg.ClientBase): Promise<string | null> {
  const { rows } = await c.query<{ migration_name: string }>(
    `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1`,
  ).catch(() => ({ rows: [] as { migration_name: string }[] }));
  return rows[0]?.migration_name ?? null;
}

/** Opens a client and applies the checksum session settings. */
export async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await prepareSession(c);
  return c;
}
