import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ApiKey } from '../../../generated/prisma/client.js';
import type { AuthUser, PlatformPrincipal } from '../../../common/auth-types.js';
import { randomLower36, randomString, safeEqual, sha256Hex } from '../../../common/crypto/secret-box.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { addDays, isIsoDate, lagosDate } from '../../../common/time/lagos.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DbService } from '../../../prisma/db.service.js';
import { AuditService, userActor } from '../../audit/audit.service.js';
import { Err } from '../../ops/ops.helpers.js';
import { isValidCidr } from '../../platform/security/cidr.js';
import { PlatformJobsService } from '../../platform/console/platform-jobs.service.js';
import { API_SCOPES, SCOPE_CODES, displayKey, formatApiKey, keyStatus, parseApiKey, type KeyEnvironment } from './api-keys.logic.js';

const ROTATION_OVERLAP_MS = 24 * 3_600_000;

export interface ApiKeyInput {
  name?: string;
  environment?: KeyEnvironment;
  scopes?: string[];
  propertyIds?: string[] | null;
  ipAllowlist?: string[];
  expiresAt?: string | null;
}

interface UsageDelta {
  tenantId: string;
  keyId: string;
  date: string;
  requests: number;
  errors: number;
  writes: number;
  rateLimited: number;
  lastUsedAt: Date;
  lastUsedIp: string | null;
}

const dbDate = (d: string) => new Date(`${d}T00:00:00.000Z`);

/**
 * API keys (M6): hashed secrets (SHA-256 of a 40-char random secret; the
 * prefix is the lookup key), scopes, optional property restriction, IP
 * allowlist and expiry, rotation with a 24-hour overlap, and per-key daily
 * usage metering (buffered in memory, flushed every few seconds).
 */
@Injectable()
export class ApiKeysService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApiKeysService.name);
  private readonly buffer = new Map<string, UsageDelta>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {
    PlatformJobsService.register('api-usage-flush', async (refs) => refs.get(ApiKeysService, { strict: false }).flush());
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush().catch(() => undefined), 5_000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush().catch(() => undefined);
  }

  scopes() {
    return API_SCOPES.map(({ scope, label, description, write }) => ({ scope, label, description, write }));
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private async requests30d(tenantId: string): Promise<Map<string, number>> {
    const since = dbDate(addDays(lagosDate(), -29));
    const rows = await this.db.control(tenantId, (tx) =>
      tx.apiUsageDaily.groupBy({ by: ['apiKeyId'], where: { tenantId, date: { gte: since } }, _sum: { requests: true } }),
    );
    return new Map(rows.map((r) => [r.apiKeyId, r._sum.requests ?? 0]));
  }

  view(k: ApiKey, requests30d = 0) {
    const env = k.environment as KeyEnvironment;
    return {
      id: k.id,
      name: k.name,
      environment: env,
      prefix: k.prefix,
      last4: k.last4,
      display: displayKey(env, k.prefix, k.last4),
      scopes: k.scopes,
      propertyIds: k.propertyIds.length ? k.propertyIds : null,
      ipAllowlist: k.ipAllowlist,
      expiresAt: k.expiresAt?.toISOString() ?? null,
      status: keyStatus(k),
      previousSecretExpiresAt: k.previousExpiresAt && k.previousExpiresAt > new Date() ? k.previousExpiresAt.toISOString() : null,
      createdBy: k.createdById ? { id: k.createdById, fullName: k.createdByName ?? '' } : null,
      createdAt: k.createdAt.toISOString(),
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      lastUsedIp: k.lastUsedIp,
      revokedAt: k.revokedAt?.toISOString() ?? null,
      requests30d,
    };
  }

  async list(u: AuthUser) {
    await this.flush();
    const rows = await this.db.control(u.tenantId, (tx) => tx.apiKey.findMany({ where: { tenantId: u.tenantId }, orderBy: { createdAt: 'desc' } }));
    const usage = await this.requests30d(u.tenantId);
    return rows.map((k) => this.view(k, usage.get(k.id) ?? 0));
  }

  private async load(tenantId: string, id: string) {
    const k = await this.db.control(tenantId, (tx) => tx.apiKey.findFirst({ where: { id, tenantId } }));
    if (!k) throw AppException.notFound('API key');
    return k;
  }

  async get(u: AuthUser, id: string) {
    await this.flush();
    const k = await this.load(u.tenantId, id);
    return this.view(k, (await this.requests30d(u.tenantId)).get(k.id) ?? 0);
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  private async validate(u: AuthUser, dto: ApiKeyInput) {
    if (dto.scopes !== undefined) {
      if (!dto.scopes.length) throw Err.validation('scopes', 'Choose at least one scope');
      const bad = dto.scopes.filter((s) => !SCOPE_CODES.includes(s));
      if (bad.length) throw Err.validation('scopes', `Unknown scope: ${bad.join(', ')}`);
    }
    if (dto.ipAllowlist) {
      const bad = dto.ipAllowlist.filter((c) => !isValidCidr(c));
      if (bad.length) throw Err.validation('ipAllowlist', `Not a valid IP or CIDR: ${bad.join(', ')}`);
    }
    if (dto.expiresAt && new Date(dto.expiresAt) <= new Date()) throw Err.validation('expiresAt', 'The expiry must be in the future');
    if (dto.propertyIds?.length) {
      const found = await this.db.tenant(u.tenantId, (tx) =>
        this.db.withAllProperties(u.tenantId, () => tx.property.count({ where: { tenantId: u.tenantId, id: { in: dto.propertyIds! } } })),
      );
      if (found !== new Set(dto.propertyIds).size) throw Err.validation('propertyIds', 'Unknown property');
    }
  }

  private newSecret() {
    return { prefix: randomLower36(10), secret: randomString(40) };
  }

  async create(u: AuthUser, dto: Required<Pick<ApiKeyInput, 'name' | 'environment' | 'scopes'>> & ApiKeyInput, ip?: string) {
    await this.validate(u, dto);
    const { prefix, secret } = this.newSecret();
    const k = await this.db.control(u.tenantId, async (tx) => {
      const row = await tx.apiKey.create({
        data: {
          tenantId: u.tenantId,
          name: dto.name.trim(),
          environment: dto.environment,
          prefix,
          secretHash: sha256Hex(secret),
          last4: secret.slice(-4),
          scopes: [...new Set(dto.scopes)],
          propertyIds: dto.propertyIds ?? [],
          ipAllowlist: dto.ipAllowlist ?? [],
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          createdById: u.userId,
          createdByName: u.fullName,
        },
      });
      await this.audit.recordControl(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'api_key.created', entityType: 'api_key', entityId: row.id, propertyId: null,
        metadata: { name: row.name, environment: row.environment, scopes: row.scopes, prefix }, ip,
      });
      return row;
    });
    return { apiKey: this.view(k), secret: formatApiKey(dto.environment, prefix, secret) };
  }

  async update(u: AuthUser, id: string, dto: ApiKeyInput, ip?: string) {
    const k = await this.load(u.tenantId, id);
    if (keyStatus(k) === 'REVOKED') throw Err.invalidState('REVOKED', ['ACTIVE', 'EXPIRED'], 'This API key');
    await this.validate(u, dto);
    const updated = await this.db.control(u.tenantId, async (tx) => {
      const row = await tx.apiKey.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name.trim() }),
          ...(dto.scopes !== undefined && { scopes: [...new Set(dto.scopes)] }),
          ...(dto.propertyIds !== undefined && { propertyIds: dto.propertyIds ?? [] }),
          ...(dto.ipAllowlist !== undefined && { ipAllowlist: dto.ipAllowlist }),
          ...(dto.expiresAt !== undefined && { expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null }),
        },
      });
      await this.audit.recordControl(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'api_key.updated', entityType: 'api_key', entityId: id, propertyId: null,
        metadata: { changes: Object.keys(dto) }, ip,
      });
      return row;
    });
    return this.view(updated, (await this.requests30d(u.tenantId)).get(id) ?? 0);
  }

  async rotate(u: AuthUser, id: string, ip?: string) {
    const k = await this.load(u.tenantId, id);
    if (keyStatus(k) !== 'ACTIVE') throw Err.invalidState(keyStatus(k), ['ACTIVE'], 'This API key');
    const secret = randomString(40);
    const updated = await this.db.control(u.tenantId, async (tx) => {
      const row = await tx.apiKey.update({
        where: { id },
        data: {
          previousSecretHash: k.secretHash,
          previousLast4: k.last4,
          previousExpiresAt: new Date(Date.now() + ROTATION_OVERLAP_MS),
          secretHash: sha256Hex(secret),
          last4: secret.slice(-4),
        },
      });
      await this.audit.recordControl(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'api_key.rotated', entityType: 'api_key', entityId: id, propertyId: null,
        metadata: { name: k.name, previousValidUntil: row.previousExpiresAt?.toISOString() }, ip,
      });
      return row;
    });
    return { apiKey: this.view(updated), secret: formatApiKey(k.environment as KeyEnvironment, k.prefix, secret) };
  }

  async revoke(u: AuthUser, id: string, ip?: string) {
    const k = await this.load(u.tenantId, id);
    if (k.revokedAt) return this.view(k);
    const updated = await this.db.control(u.tenantId, async (tx) => {
      const row = await tx.apiKey.update({ where: { id }, data: { revokedAt: new Date(), previousSecretHash: null, previousExpiresAt: null } });
      await this.audit.recordControl(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'api_key.revoked', entityType: 'api_key', entityId: id, propertyId: null,
        metadata: { name: k.name }, ip,
      });
      return row;
    });
    return this.view(updated);
  }

  // ---------------------------------------------------------------------------
  // Authentication (partner API)
  // ---------------------------------------------------------------------------

  /** The active key a presented secret belongs to, or null (unknown, revoked, expired, malformed). */
  async authenticate(raw: string | undefined): Promise<ApiKey | null> {
    const parsed = parseApiKey(raw);
    if (!parsed) return null;
    const k = await this.db.system((tx) => tx.apiKey.findUnique({ where: { prefix: parsed.prefix } }));
    if (!k || k.environment !== parsed.environment || keyStatus(k) !== 'ACTIVE') return null;
    const hash = sha256Hex(parsed.secret);
    if (safeEqual(hash, k.secretHash)) return k;
    if (k.previousSecretHash && k.previousExpiresAt && k.previousExpiresAt > new Date() && safeEqual(hash, k.previousSecretHash)) return k;
    return null;
  }

  // ---------------------------------------------------------------------------
  // Usage metering
  // ---------------------------------------------------------------------------

  meter(k: { id: string; tenantId: string }, o: { error: boolean; write: boolean; rateLimited: boolean; ip: string | null }) {
    const date = lagosDate();
    const key = `${k.id}|${date}`;
    const d = this.buffer.get(key) ?? { tenantId: k.tenantId, keyId: k.id, date, requests: 0, errors: 0, writes: 0, rateLimited: 0, lastUsedAt: new Date(), lastUsedIp: null };
    d.requests++;
    if (o.error) d.errors++;
    if (o.write) d.writes++;
    if (o.rateLimited) d.rateLimited++;
    d.lastUsedAt = new Date();
    d.lastUsedIp = o.ip;
    this.buffer.set(key, d);
  }

  private flushing: Promise<{ flushed: number }> | null = null;

  /** Writes buffered usage (upsert-increment per key and day). */
  flush(): Promise<{ flushed: number }> {
    if (this.flushing) return this.flushing;
    const run = async () => {
      if (!this.buffer.size) return { flushed: 0 };
      const batch = [...this.buffer.values()];
      this.buffer.clear();
      try {
        await this.db.system(async (tx) => {
          for (const d of batch) {
            await tx.apiUsageDaily.upsert({
              where: { apiKeyId_date: { apiKeyId: d.keyId, date: dbDate(d.date) } },
              create: { tenantId: d.tenantId, apiKeyId: d.keyId, date: dbDate(d.date), requests: d.requests, errors: d.errors, writes: d.writes, rateLimited: d.rateLimited },
              update: { requests: { increment: d.requests }, errors: { increment: d.errors }, writes: { increment: d.writes }, rateLimited: { increment: d.rateLimited } },
            });
            await tx.apiKey.updateMany({ where: { id: d.keyId }, data: { lastUsedAt: d.lastUsedAt, lastUsedIp: d.lastUsedIp } });
          }
        });
      } catch (e) {
        this.logger.warn(`API usage flush failed (${batch.length} rows kept): ${(e as Error).message}`);
        for (const d of batch) {
          const key = `${d.keyId}|${d.date}`;
          const cur = this.buffer.get(key);
          this.buffer.set(key, cur ? { ...cur, requests: cur.requests + d.requests, errors: cur.errors + d.errors, writes: cur.writes + d.writes, rateLimited: cur.rateLimited + d.rateLimited } : d);
        }
        return { flushed: 0 };
      }
      return { flushed: batch.length };
    };
    this.flushing = run().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private range(q: { from?: string; to?: string }) {
    const to = q.to && isIsoDate(q.to) ? q.to : lagosDate();
    const from = q.from && isIsoDate(q.from) ? q.from : addDays(to, -29);
    if (from > to) throw Err.validation('from', 'from must be on or before to');
    return { from, to };
  }

  /** ApiUsage (11.4) of one tenant. */
  async usage(tenantId: string, q: { from?: string; to?: string }) {
    await this.flush();
    const { from, to } = this.range(q);
    const [keys, rows] = await this.db.control(tenantId, async (tx) => [
      await tx.apiKey.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } }),
      await tx.apiUsageDaily.findMany({ where: { tenantId, date: { gte: dbDate(from), lte: dbDate(to) } } }),
    ] as const);
    const totals = { requests: 0, errors: 0, writes: 0, rateLimited: 0 };
    const byKey = new Map<string, { requests: number; errors: number; rateLimited: number }>();
    const byDay = new Map<string, { requests: number; errors: number; rateLimited: number }>();
    for (const r of rows) {
      totals.requests += r.requests;
      totals.errors += r.errors;
      totals.writes += r.writes;
      totals.rateLimited += r.rateLimited;
      const k = byKey.get(r.apiKeyId) ?? { requests: 0, errors: 0, rateLimited: 0 };
      k.requests += r.requests;
      k.errors += r.errors;
      k.rateLimited += r.rateLimited;
      byKey.set(r.apiKeyId, k);
      const day = r.date.toISOString().slice(0, 10);
      const dd = byDay.get(day) ?? { requests: 0, errors: 0, rateLimited: 0 };
      dd.requests += r.requests;
      dd.errors += r.errors;
      dd.rateLimited += r.rateLimited;
      byDay.set(day, dd);
    }
    const days: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    return {
      from,
      to,
      totals,
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        environment: k.environment as KeyEnvironment,
        ...(byKey.get(k.id) ?? { requests: 0, errors: 0, rateLimited: 0 }),
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      })),
      byDay: days.map((date) => ({ date, ...(byDay.get(date) ?? { requests: 0, errors: 0, rateLimited: 0 }) })),
    };
  }

  /** Platform: usage across tenants (9.4). */
  async platformUsage(_p: PlatformPrincipal, q: { from?: string; to?: string }) {
    await this.flush();
    const { from, to } = this.range(q);
    const { rows, keys, tenants } = await this.db.system(async (tx) => {
      const rows = await tx.apiUsageDaily.findMany({ where: { date: { gte: dbDate(from), lte: dbDate(to) } } });
      const keys = await tx.apiKey.findMany({ select: { id: true, tenantId: true, revokedAt: true, expiresAt: true, lastUsedAt: true } });
      const ids = [...new Set([...rows.map((r) => r.tenantId), ...keys.map((k) => k.tenantId)])];
      const tenants = await tx.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, slug: true } });
      return { rows, keys, tenants };
    });
    const totals = { requests: 0, errors: 0, writes: 0, rateLimited: 0 };
    const byTenant = new Map<string, { requests: number; errors: number; rateLimited: number }>();
    const byDay = new Map<string, { requests: number; errors: number }>();
    for (const r of rows) {
      totals.requests += r.requests;
      totals.errors += r.errors;
      totals.writes += r.writes;
      totals.rateLimited += r.rateLimited;
      const t = byTenant.get(r.tenantId) ?? { requests: 0, errors: 0, rateLimited: 0 };
      t.requests += r.requests;
      t.errors += r.errors;
      t.rateLimited += r.rateLimited;
      byTenant.set(r.tenantId, t);
      const day = r.date.toISOString().slice(0, 10);
      const dd = byDay.get(day) ?? { requests: 0, errors: 0 };
      dd.requests += r.requests;
      dd.errors += r.errors;
      byDay.set(day, dd);
    }
    const days: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const now = new Date();
    return {
      totals,
      byTenant: tenants
        .map((t) => {
          const ks = keys.filter((k) => k.tenantId === t.id);
          const last = ks.reduce<Date | null>((a, k) => (k.lastUsedAt && (!a || k.lastUsedAt > a) ? k.lastUsedAt : a), null);
          return {
            tenant: t,
            keys: ks.filter((k) => keyStatus(k, now) === 'ACTIVE').length,
            ...(byTenant.get(t.id) ?? { requests: 0, errors: 0, rateLimited: 0 }),
            lastUsedAt: last?.toISOString() ?? null,
          };
        })
        .sort((a, b) => b.requests - a.requests),
      byDay: days.map((date) => ({ date, ...(byDay.get(date) ?? { requests: 0, errors: 0 }) })),
    };
  }

  /** Developer quick-start data (11.3). */
  async quickstart(u: AuthUser) {
    const base = this.config.get('API_PUBLIC_URL').replace(/\/$/, '');
    const web = this.config.get('WEB_URL').replace(/\/$/, '');
    const properties = await this.db.tenant(u.tenantId, (tx) =>
      this.db.withAllProperties(u.tenantId, () => tx.property.findMany({ where: { tenantId: u.tenantId }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' } })),
    );
    const baseUrl = `${base}/api/partner/v1`;
    const pid = properties[0]?.id ?? '<property id>';
    return {
      baseUrl,
      docsUrl: `${web}/developers`,
      openApiUrl: `${baseUrl}/openapi.json`,
      propertyIds: properties,
      sampleCurl: `curl -s "${baseUrl}/availability?propertyId=${pid}&from=${lagosDate()}&to=${addDays(lagosDate(), 7)}" \\\n  -H "Authorization: Bearer hk_live_..."`,
    };
  }
}
