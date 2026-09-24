import { HttpStatus, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Prisma, WebhookDelivery, WebhookEndpoint } from '../../../generated/prisma/client.js';
import type { AuthUser } from '../../../common/auth-types.js';
import { randomString, SecretBox } from '../../../common/crypto/secret-box.js';
import { onDomainEvent } from '../../../common/domain-events.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { checkUrlSyntax, safeRequest, UnsafeUrlError, vetUrl } from '../../../common/net/safe-fetch.js';
import { humanDateTime, lagosDate, nightsBetween } from '../../../common/time/lagos.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DbService, type Tx } from '../../../prisma/db.service.js';
import { AuditService, registerAuditHook, userActor, type AuditEntry } from '../../audit/audit.service.js';
import { NotificationService } from '../../notifications/notification.service.js';
import { renderTemplate } from '../../notifications/templates/templates.js';
import { Err } from '../../ops/ops.helpers.js';
import { PlatformJobsService } from '../../platform/console/platform-jobs.service.js';
import { nightlyOf, reservationInclude } from '../../reservations/reservations.service.js';
import { pRoom, pTask } from '../partner/partner.mappers.js';
import {
  AUDIT_EVENT_MAP,
  EVENT_TYPES,
  MAX_ATTEMPTS,
  WEBHOOK_EVENTS,
  matchesEvents,
  nextAttemptAt,
  shouldDisable,
  signatureHeader,
} from './webhooks.logic.js';

export const API_VERSION = '2026-09-24';
const SECRET_PURPOSE = 'webhook-secret';
const ROTATION_MS = 24 * 3_600_000;
const LOCK_MS = 60_000;
const MAX_REQUEST_BODY_VIEW = 8 * 1024;
const MAX_RESPONSE_BODY = 2 * 1024;

export interface EndpointInput {
  url?: string;
  events?: string[];
  description?: string | null;
  propertyIds?: string[] | null;
  status?: 'ACTIVE' | 'DISABLED';
}

export interface AttemptLogItem {
  at: string;
  responseStatus: number | null;
  durationMs: number | null;
  error: string | null;
}

/**
 * Outbound webhooks (M6). Events come from audit entries and domain events
 * inside the business transaction (a transactional outbox: the delivery row
 * commits with the change), and are delivered by a sweep (every minute, and
 * right after a change on this instance) through the SSRF guard, signed with
 * the endpoint secret. Failures retry with backoff; an endpoint failing for
 * a day is disabled and the owner is told.
 */
@Injectable()
export class WebhooksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhooksService.name);
  private kick: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly box: SecretBox,
    private readonly notifications: NotificationService,
  ) {
    PlatformJobsService.register('webhooks-deliver', async (refs) => refs.get(WebhooksService, { strict: false }).deliverDue());
  }

  onModuleInit(): void {
    registerAuditHook((tx, entry) => this.onAudit(tx, entry));
    onDomainEvent((tx, e) => this.enqueue(tx, e.tenantId, e.propertyId, e.type, e.object));
  }

  onModuleDestroy(): void {
    if (this.kick) clearTimeout(this.kick);
  }

  private fetchOpts() {
    return {
      production: this.config.get('NODE_ENV') === 'production',
      allowPrivateHosts: this.config.get('OUTBOUND_ALLOW_PRIVATE_HOSTS'),
      timeoutMs: this.config.get('WEBHOOK_TIMEOUT_MS'),
    };
  }

  events() {
    return WEBHOOK_EVENTS.map((e) => ({ ...e }));
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  view(e: WebhookEndpoint, stats?: { delivered: number; failed: number }) {
    return {
      id: e.id,
      url: e.url,
      description: e.description,
      events: e.events,
      propertyIds: e.propertyIds.length ? e.propertyIds : null,
      status: e.status as 'ACTIVE' | 'DISABLED',
      disabledReason: e.disabledReason,
      disabledAt: e.disabledAt?.toISOString() ?? null,
      secretPreview: `whsec_...${e.secretLast4}`,
      secretRotatedAt: e.secretRotatedAt?.toISOString() ?? null,
      failingSince: e.failingSince?.toISOString() ?? null,
      consecutiveFailures: e.consecutiveFailures,
      lastSuccessAt: e.lastSuccessAt?.toISOString() ?? null,
      lastFailureAt: e.lastFailureAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
      createdBy: e.createdById ? { id: e.createdById, fullName: e.createdByName ?? '' } : null,
      stats24h: stats ?? { delivered: 0, failed: 0 },
    };
  }

  deliveryView(d: WebhookDelivery) {
    return {
      id: d.id,
      endpointId: d.endpointId,
      eventId: d.eventId,
      eventType: d.eventType,
      status: d.status as 'PENDING' | 'RETRYING' | 'SUCCEEDED' | 'FAILED',
      attempts: d.attempts,
      nextAttemptAt: d.status === 'PENDING' || d.status === 'RETRYING' ? (d.nextAttemptAt?.toISOString() ?? null) : null,
      lastAttemptAt: d.lastAttemptAt?.toISOString() ?? null,
      responseStatus: d.responseStatus,
      durationMs: d.durationMs,
      error: d.error,
      isTest: d.isTest,
      replayOf: d.replayOf,
      createdAt: d.createdAt.toISOString(),
    };
  }

  private detailView(d: WebhookDelivery, url: string) {
    const body = JSON.stringify(d.payload);
    return {
      ...this.deliveryView(d),
      request: { url, headers: (d.requestHeaders as Record<string, string> | null) ?? {}, body: body.length > MAX_REQUEST_BODY_VIEW ? `${body.slice(0, MAX_REQUEST_BODY_VIEW)}...` : body },
      response: d.lastAttemptAt ? { status: d.responseStatus, headers: (d.responseHeaders as Record<string, string> | null) ?? {}, body: d.responseBody } : null,
      attemptLog: (d.attemptLog as unknown as AttemptLogItem[]) ?? [],
    };
  }

  private async stats(tx: Tx, tenantId: string, ids: string[]) {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const rows = await tx.webhookDelivery.groupBy({ by: ['endpointId', 'status'], where: { tenantId, endpointId: { in: ids }, lastAttemptAt: { gte: since } }, _count: { _all: true } });
    const out = new Map<string, { delivered: number; failed: number }>();
    for (const id of ids) out.set(id, { delivered: 0, failed: 0 });
    for (const r of rows) {
      const s = out.get(r.endpointId)!;
      if (r.status === 'SUCCEEDED') s.delivered += r._count._all;
      else if (r.status === 'FAILED' || r.status === 'RETRYING') s.failed += r._count._all;
    }
    return out;
  }

  async list(u: AuthUser) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const rows = await tx.webhookEndpoint.findMany({ where: { tenantId: u.tenantId }, orderBy: { createdAt: 'asc' } });
      const stats = await this.stats(tx, u.tenantId, rows.map((r) => r.id));
      return rows.map((r) => this.view(r, stats.get(r.id)));
    });
  }

  private async load(tx: Tx, tenantId: string, id: string) {
    const e = await tx.webhookEndpoint.findFirst({ where: { id, tenantId } });
    if (!e) throw AppException.notFound('Webhook endpoint');
    return e;
  }

  async get(u: AuthUser, id: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const e = await this.load(tx, u.tenantId, id);
      return this.view(e, (await this.stats(tx, u.tenantId, [id])).get(id));
    });
  }

  // ---------------------------------------------------------------------------
  // Endpoint management
  // ---------------------------------------------------------------------------

  private async vet(url: string) {
    try {
      checkUrlSyntax(url, this.fetchOpts());
      await vetUrl(url, this.fetchOpts());
    } catch (e) {
      if (e instanceof UnsafeUrlError && e.reason !== 'DNS_FAILED') {
        throw new AppException(HttpStatus.UNPROCESSABLE_ENTITY, 'UNSAFE_URL', e.message, { reason: e.reason });
      }
      if (e instanceof UnsafeUrlError) return; // unresolvable now: accepted, deliveries will fail and retry
      throw e;
    }
  }

  private validateEvents(events: string[]) {
    if (!events.length) throw Err.validation('events', 'Choose at least one event (or "*")');
    const bad = events.filter((e) => e !== '*' && !EVENT_TYPES.includes(e));
    if (bad.length) throw Err.validation('events', `Unknown event: ${bad.join(', ')}`);
  }

  private async checkProperties(tx: Tx, tenantId: string, ids: string[] | null | undefined) {
    if (!ids?.length) return;
    const n = await this.db.withAllProperties(tenantId, () => tx.property.count({ where: { tenantId, id: { in: ids } } }));
    if (n !== new Set(ids).size) throw Err.validation('propertyIds', 'Unknown property');
  }

  async create(u: AuthUser, dto: { url: string; events: string[]; description?: string | null; propertyIds?: string[] | null }, ip?: string) {
    this.validateEvents(dto.events);
    await this.vet(dto.url);
    const secret = `whsec_${randomString(32)}`;
    const endpoint = await this.db.tenant(u.tenantId, async (tx) => {
      await this.checkProperties(tx, u.tenantId, dto.propertyIds);
      const e = await tx.webhookEndpoint.create({
        data: {
          tenantId: u.tenantId,
          url: dto.url,
          description: dto.description ?? null,
          events: [...new Set(dto.events)],
          propertyIds: dto.propertyIds ?? [],
          secretEnc: this.box.seal(secret, SECRET_PURPOSE),
          secretLast4: secret.slice(-4),
          createdById: u.apiKey ? null : u.userId,
          createdByName: u.fullName,
          apiKeyId: u.apiKey?.id ?? null,
        },
      });
      await this.audit.record(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'webhook_endpoint.created', entityType: 'webhook_endpoint', entityId: e.id, propertyId: null,
        metadata: { url: e.url, events: e.events }, ip,
      });
      return e;
    });
    return { endpoint: this.view(endpoint), secret };
  }

  async update(u: AuthUser, id: string, dto: EndpointInput, ip?: string) {
    if (dto.events) this.validateEvents(dto.events);
    if (dto.url) await this.vet(dto.url);
    const updated = await this.db.tenant(u.tenantId, async (tx) => {
      const e = await this.load(tx, u.tenantId, id);
      await this.checkProperties(tx, u.tenantId, dto.propertyIds);
      const enabling = dto.status === 'ACTIVE' && e.status !== 'ACTIVE';
      const row = await tx.webhookEndpoint.update({
        where: { id },
        data: {
          ...(dto.url !== undefined && { url: dto.url }),
          ...(dto.events !== undefined && { events: [...new Set(dto.events)] }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.propertyIds !== undefined && { propertyIds: dto.propertyIds ?? [] }),
          ...(dto.status === 'DISABLED' && e.status !== 'DISABLED' && { status: 'DISABLED', disabledReason: 'MANUAL', disabledAt: new Date() }),
          ...(enabling && { status: 'ACTIVE', disabledReason: null, disabledAt: null, failingSince: null, consecutiveFailures: 0 }),
        },
      });
      if (enabling) {
        // Pending deliveries resume at once.
        await tx.webhookDelivery.updateMany({ where: { endpointId: id, status: { in: ['PENDING', 'RETRYING'] } }, data: { nextAttemptAt: new Date() } });
      }
      await this.audit.record(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'webhook_endpoint.updated', entityType: 'webhook_endpoint', entityId: id, propertyId: null,
        metadata: { changes: Object.keys(dto), ...(dto.status && { status: dto.status }) }, ip,
      });
      return row;
    });
    if (dto.status === 'ACTIVE') this.schedule();
    return this.get(u, updated.id);
  }

  async remove(u: AuthUser, id: string, ip?: string) {
    await this.db.tenant(u.tenantId, async (tx) => {
      const e = await this.load(tx, u.tenantId, id);
      await tx.webhookEndpoint.delete({ where: { id } });
      await this.audit.record(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'webhook_endpoint.deleted', entityType: 'webhook_endpoint', entityId: id, propertyId: null,
        metadata: { url: e.url }, ip,
      });
    });
    return { success: true };
  }

  async rotateSecret(u: AuthUser, id: string, ip?: string) {
    const secret = `whsec_${randomString(32)}`;
    const row = await this.db.tenant(u.tenantId, async (tx) => {
      const e = await this.load(tx, u.tenantId, id);
      const r = await tx.webhookEndpoint.update({
        where: { id },
        data: {
          previousSecretEnc: e.secretEnc,
          previousSecretExpiresAt: new Date(Date.now() + ROTATION_MS),
          secretEnc: this.box.seal(secret, SECRET_PURPOSE),
          secretLast4: secret.slice(-4),
          secretRotatedAt: new Date(),
        },
      });
      await this.audit.record(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'webhook_endpoint.secret_rotated', entityType: 'webhook_endpoint', entityId: id, propertyId: null, ip,
      });
      return r;
    });
    return { endpoint: this.view(row), secret };
  }

  async deliveries(u: AuthUser, endpointId: string, q: { status?: string; eventType?: string; limit?: number; cursor?: string }) {
    const limit = q.limit ?? 50;
    return this.db.tenant(u.tenantId, async (tx) => {
      await this.load(tx, u.tenantId, endpointId);
      let before: { createdAt: Date; id: string } | null = null;
      if (q.cursor) {
        const [at, cid] = Buffer.from(q.cursor, 'base64url').toString('utf8').split('|');
        if (!at || !cid || Number.isNaN(new Date(at).getTime())) throw Err.validation('cursor', 'Invalid cursor');
        before = { createdAt: new Date(at), id: cid };
      }
      const rows = await tx.webhookDelivery.findMany({
        where: {
          tenantId: u.tenantId,
          endpointId,
          ...(q.status && { status: q.status }),
          ...(q.eventType && { eventType: q.eventType }),
          ...(before && { OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lt: before.id } }] }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const more = rows.length > limit;
      const items = more ? rows.slice(0, limit) : rows;
      const last = items[items.length - 1];
      return {
        items: items.map((d) => this.deliveryView(d)),
        nextCursor: more && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`, 'utf8').toString('base64url') : null,
      };
    });
  }

  async delivery(u: AuthUser, id: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const d = await tx.webhookDelivery.findFirst({ where: { id, tenantId: u.tenantId }, include: { endpoint: { select: { url: true } } } });
      if (!d) throw AppException.notFound('Webhook delivery');
      return this.detailView(d, d.endpoint.url);
    });
  }

  async replay(u: AuthUser, id: string, ip?: string) {
    const created = await this.db.tenant(u.tenantId, async (tx) => {
      const d = await tx.webhookDelivery.findFirst({ where: { id, tenantId: u.tenantId } });
      if (!d) throw AppException.notFound('Webhook delivery');
      const row = await tx.webhookDelivery.create({
        data: {
          tenantId: d.tenantId, endpointId: d.endpointId, eventId: d.eventId, eventType: d.eventType, propertyId: d.propertyId,
          payload: d.payload as Prisma.InputJsonValue, status: 'PENDING', nextAttemptAt: new Date(), replayOf: d.id, isTest: d.isTest,
        },
      });
      await this.audit.record(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'webhook_delivery.replayed', entityType: 'webhook_delivery', entityId: row.id, propertyId: null,
        metadata: { replayOf: d.id, eventType: d.eventType }, ip,
      });
      return row;
    });
    this.schedule();
    return this.deliveryView(created);
  }

  /** Sends `webhook.ping` now and returns the outcome. */
  async test(u: AuthUser, id: string) {
    const d = await this.db.tenant(u.tenantId, async (tx) => {
      const e = await this.load(tx, u.tenantId, id);
      const eventId = `evt_${randomBytes(12).toString('hex')}`;
      return tx.webhookDelivery.create({
        data: {
          tenantId: u.tenantId, endpointId: e.id, eventId, eventType: 'webhook.ping', propertyId: null,
          payload: this.envelope(eventId, 'webhook.ping', u.tenantId, null, { message: 'Test event from the hotel settings', endpointId: e.id }) as Prisma.InputJsonValue,
          status: 'PENDING', nextAttemptAt: null, isTest: true,
        },
      });
    });
    await this.attempt(d.tenantId, d.id, { test: true });
    return this.delivery(u, d.id);
  }

  // ---------------------------------------------------------------------------
  // Event capture (inside the business transaction)
  // ---------------------------------------------------------------------------

  private envelope(eventId: string, type: string, tenantId: string, propertyId: string | null, object: unknown) {
    return {
      id: eventId,
      type,
      createdAt: new Date().toISOString(),
      apiVersion: API_VERSION,
      livemode: true,
      tenantId,
      propertyId,
      data: { object },
    };
  }

  private async onAudit(tx: Tx, entry: AuditEntry & { propertyId: string | null }) {
    const type = AUDIT_EVENT_MAP[entry.action];
    if (!type || !entry.tenantId) return;
    // Cheap exit for tenants without endpoints (most of them).
    const any = await tx.webhookEndpoint.findFirst({ where: { tenantId: entry.tenantId, status: 'ACTIVE' }, select: { id: true } });
    if (!any) return;
    const built = await this.buildObject(tx, entry.tenantId, type, entry).catch((e: Error) => {
      this.logger.warn(`Webhook payload for ${entry.action} failed: ${e.message}`);
      return null;
    });
    if (!built) return;
    await this.enqueue(tx, entry.tenantId, built.propertyId ?? entry.propertyId, type, built.object);
  }

  private async buildObject(tx: Tx, tenantId: string, type: string, entry: AuditEntry): Promise<{ propertyId: string | null; object: Record<string, unknown> } | null> {
    const id = entry.entityId ?? null;
    const meta = entry.metadata ?? {};
    const unscoped = <T>(fn: () => Promise<T>) => this.db.withAllProperties(tenantId, fn);
    if (type.startsWith('reservation.')) {
      if (!id) return null;
      const r = await unscoped(() => tx.reservation.findFirst({ where: { id, tenantId }, include: reservationInclude }));
      if (!r) return null;
      return { propertyId: r.propertyId, object: reservationObject(r) };
    }
    if (type === 'payment.received') {
      const entryId = typeof meta.entryId === 'string' ? meta.entryId : null;
      const e = entryId
        ? await unscoped(() => tx.folioEntry.findFirst({ where: { id: entryId, tenantId }, include: { folio: { select: { id: true, reservationId: true } } } }))
        : id
          ? await unscoped(() => tx.folioEntry.findFirst({ where: { tenantId, type: 'PAYMENT', folio: { reservationId: id } }, include: { folio: { select: { id: true, reservationId: true } } }, orderBy: { createdAt: 'desc' } }))
          : null;
      if (!e) return null;
      return {
        propertyId: e.propertyId,
        object: {
          reservationId: e.folio.reservationId,
          folioId: e.folio.id,
          entryId: e.id,
          amountKobo: Math.abs(Number(e.amountKobo)),
          method: e.paymentMethod,
          reference: e.paymentRef ?? null,
          receivedAt: e.createdAt.toISOString(),
        },
      };
    }
    if (type === 'room.status_changed') {
      if (!id) return null;
      const r = await unscoped(() => tx.room.findFirst({ where: { id, tenantId } }));
      if (!r) return null;
      return { propertyId: r.propertyId, object: { ...pRoom(r), previousStatus: (meta.from as string) ?? null } };
    }
    if (type === 'housekeeping.task_completed') {
      if (!id) return null;
      const t = await unscoped(() => tx.housekeepingTask.findFirst({ where: { id, tenantId }, include: { room: { select: { number: true } } } }));
      if (!t) return null;
      return { propertyId: t.propertyId, object: pTask(t) };
    }
    if (type === 'review.published') {
      if (!id) return null;
      const r = await unscoped(() => tx.review.findFirst({ where: { id, tenantId } }));
      if (!r || r.status !== 'PUBLISHED') return null;
      return {
        propertyId: r.propertyId,
        object: { id: r.id, propertyId: r.propertyId, overall: r.overall, title: r.title, body: r.body, publishedAt: (r.moderatedAt ?? r.createdAt).toISOString() },
      };
    }
    return null;
  }

  /** Inserts one delivery per matching active endpoint (same transaction as the change). */
  async enqueue(tx: Tx, tenantId: string, propertyId: string | null, type: string, object: Record<string, unknown>) {
    const endpoints = await tx.webhookEndpoint.findMany({ where: { tenantId, status: 'ACTIVE' } });
    const targets = endpoints.filter((e) => matchesEvents(e.events, type) && (!e.propertyIds.length || !propertyId || e.propertyIds.includes(propertyId)));
    if (!targets.length) return;
    const eventId = `evt_${randomBytes(12).toString('hex')}`;
    const payload = this.envelope(eventId, type, tenantId, propertyId, object) as Prisma.InputJsonValue;
    const now = new Date();
    await tx.webhookDelivery.createMany({
      data: targets.map((e) => ({ tenantId, endpointId: e.id, eventId, eventType: type, propertyId, payload, status: 'PENDING', nextAttemptAt: now })),
    });
    this.schedule();
  }

  /** Runs a delivery sweep shortly (after the transaction that queued the rows commits). */
  schedule(delayMs = 400) {
    if (this.kick) return;
    this.kick = setTimeout(() => {
      this.kick = null;
      void this.deliverDue().catch((e: Error) => this.logger.warn(`Webhook sweep failed: ${e.message}`));
    }, delayMs);
    this.kick.unref();
  }

  // ---------------------------------------------------------------------------
  // Delivery
  // ---------------------------------------------------------------------------

  /** Delivers every due delivery (shared and dedicated databases). */
  async deliverDue(now = new Date()): Promise<{ attempted: number; succeeded: number; failed: number }> {
    if (this.running) await this.running.catch(() => undefined);
    const run = (async () => {
      const due = (
        await this.db.systemAll(async (tx, t) => {
          const rows = await tx.webhookDelivery.findMany({
            where: {
              ...t.tenants,
              status: { in: ['PENDING', 'RETRYING'] },
              nextAttemptAt: { lte: now },
              OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
              endpoint: { status: 'ACTIVE' },
            },
            select: { id: true, tenantId: true },
            orderBy: { nextAttemptAt: 'asc' },
            take: 100,
          });
          if (!rows.length) return rows;
          const locked = await tx.webhookDelivery.updateMany({
            where: { id: { in: rows.map((r) => r.id) }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
            data: { lockedUntil: new Date(now.getTime() + LOCK_MS) },
          });
          return locked.count ? rows : [];
        })
      ).flat();
      let succeeded = 0;
      let failed = 0;
      for (const d of due) {
        const ok = await this.attempt(d.tenantId, d.id).catch((e: Error) => {
          this.logger.warn(`Webhook delivery ${d.id} crashed: ${e.message}`);
          return false;
        });
        if (ok) succeeded++;
        else failed++;
      }
      return { attempted: due.length, succeeded, failed };
    })();
    this.running = run;
    try {
      return await run;
    } finally {
      if (this.running === run) this.running = null;
    }
  }

  /** One attempt. Returns true on a 2xx. */
  private async attempt(tenantId: string, deliveryId: string, o: { test?: boolean } = {}): Promise<boolean> {
    const loaded = await this.db.systemFor(tenantId, async (tx) => {
      const d = await tx.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { endpoint: true } });
      return d;
    });
    if (!loaded) return false;
    const { endpoint, ...d } = loaded;
    const secrets = [this.box.open(endpoint.secretEnc, SECRET_PURPOSE)];
    if (endpoint.previousSecretEnc && endpoint.previousSecretExpiresAt && endpoint.previousSecretExpiresAt > new Date()) {
      secrets.push(this.box.open(endpoint.previousSecretEnc, SECRET_PURPOSE));
    }
    const body = JSON.stringify(d.payload);
    const ts = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': `${this.config.get('APP_NAME').replace(/[^A-Za-z0-9]/g, '')}-Webhooks/1.0`,
      'x-webhook-id': d.id,
      'x-event-id': d.eventId,
      'x-event-type': d.eventType,
      'x-signature': signatureHeader(secrets, ts, body),
    };
    const at = new Date();
    let status: number | null = null;
    let duration: number | null = null;
    let error: string | null = null;
    let resHeaders: Record<string, string> = {};
    let resBody: string | null = null;
    try {
      const res = await safeRequest(endpoint.url, { method: 'POST', headers, body }, { ...this.fetchOpts(), maxBytes: MAX_RESPONSE_BODY });
      status = res.status;
      duration = res.durationMs;
      resHeaders = res.headers;
      resBody = res.body;
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (e) {
      duration = Date.now() - at.getTime();
      error = e instanceof UnsafeUrlError ? `${e.reason}: ${e.message}` : (e as Error).message || 'Request failed';
    }
    const ok = error === null;
    const attempts = d.attempts + 1;
    const firstAt = (d.attemptLog as unknown as AttemptLogItem[])?.[0]?.at ? new Date((d.attemptLog as unknown as AttemptLogItem[])[0]!.at) : at;
    const next = ok || o.test ? null : nextAttemptAt(firstAt, attempts);
    const log = [...(((d.attemptLog as unknown as AttemptLogItem[]) ?? []).slice(-(MAX_ATTEMPTS + 5))), { at: at.toISOString(), responseStatus: status, durationMs: duration, error }];
    const outcome = await this.db.systemFor(tenantId, async (tx) => {
      await tx.webhookDelivery.update({
        where: { id: d.id },
        data: {
          attempts,
          lastAttemptAt: at,
          responseStatus: status,
          durationMs: duration,
          error,
          requestHeaders: { ...headers, 'x-signature': headers['x-signature']!.replace(/v1=[0-9a-f]{8}[0-9a-f]+/g, (m) => `${m.slice(0, 11)}...`) },
          responseHeaders: resHeaders,
          responseBody: resBody,
          attemptLog: log as unknown as Prisma.InputJsonValue,
          status: ok ? 'SUCCEEDED' : next ? 'RETRYING' : 'FAILED',
          nextAttemptAt: next,
          lockedUntil: null,
        },
      });
      if (o.test) return null;
      if (ok) {
        await tx.webhookEndpoint.update({ where: { id: endpoint.id }, data: { lastSuccessAt: at, failingSince: null, consecutiveFailures: 0 } });
        return null;
      }
      const e = await tx.webhookEndpoint.update({
        where: { id: endpoint.id },
        data: { lastFailureAt: at, failingSince: endpoint.failingSince ?? at, consecutiveFailures: { increment: 1 } },
      });
      if (e.status === 'ACTIVE' && shouldDisable(e.failingSince, e.consecutiveFailures, at)) {
        await tx.webhookEndpoint.update({ where: { id: e.id }, data: { status: 'DISABLED', disabledReason: 'SUSTAINED_FAILURE', disabledAt: at } });
        await this.audit.record(tx, {
          tenantId, actor: { kind: 'system', name: 'Webhooks' }, action: 'webhook_endpoint.disabled', entityType: 'webhook_endpoint', entityId: e.id, propertyId: null,
          metadata: { url: e.url, reason: 'SUSTAINED_FAILURE', failingSince: e.failingSince?.toISOString(), attempts: e.consecutiveFailures },
        });
        return e;
      }
      return null;
    });
    if (outcome) await this.notifyDisabled(tenantId, outcome, error).catch((e: Error) => this.logger.warn(`Webhook disabled email failed: ${e.message}`));
    return ok;
  }

  private async notifyDisabled(tenantId: string, e: WebhookEndpoint, lastError: string | null) {
    const { owners, name } = await this.db.systemFor(tenantId, async (tx) => ({
      owners: await tx.user.findMany({ where: { tenantId, role: 'OWNER', isActive: true }, select: { email: true } }),
      name: (await tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }))?.name ?? '',
    }));
    const r = renderTemplate(
      { appName: this.config.get('APP_NAME'), appDomain: this.config.get('APP_DOMAIN'), supportEmail: this.config.get('SUPPORT_EMAIL') },
      {
        template: 'WEBHOOK_DISABLED',
        hotelName: name,
        url: e.url,
        failingSinceHuman: humanDateTime(e.failingSince ?? new Date()),
        attempts: e.consecutiveFailures,
        lastError,
        adminUrl: `${this.config.get('ADMIN_URL').replace(/\/$/, '')}/settings/integrations/webhooks/${e.id}`,
      },
    );
    await this.notifications.send(
      owners.map((o) => ({ tenantId, template: 'WEBHOOK_DISABLED' as const, channel: 'EMAIL' as const, audience: 'HOTEL' as const, to: o.email, subject: r.subject, text: r.text, html: r.html })),
    );
  }
}

/** Reservation object of webhook events (the partner API's PReservation). */
export function reservationObject(r: Prisma.ReservationGetPayload<{ include: typeof reservationInclude }>) {
  return {
    id: r.id,
    code: r.code,
    propertyId: r.propertyId,
    status: r.status,
    source: r.source,
    stayType: r.stayType,
    arrivalDate: lagosDate(r.arrivalAt),
    departureDate: lagosDate(r.departureAt),
    arrivalAt: r.arrivalAt.toISOString(),
    departureAt: r.departureAt.toISOString(),
    nights: r.stayType === 'NIGHTLY' ? nightsBetween(r.arrivalAt, r.departureAt) : 0,
    adults: r.adults,
    children: r.children,
    roomType: { id: r.roomType.id, name: r.roomType.name },
    room: r.room ? { id: r.room.id, number: r.room.number } : null,
    ratePlan: r.ratePlan ? { id: r.ratePlan.id, name: r.ratePlan.name } : null,
    rateKobo: Number(r.rateKobo),
    nightlyRates: nightlyOf(r).map((n) => ({ date: n.date, rateKobo: n.rateKobo })),
    guest: { id: r.guest.id, fullName: r.guest.fullName },
    notes: r.notes || null,
    externalRef: r.externalRef ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
  };
}
