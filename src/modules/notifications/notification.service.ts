import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import type { NotificationAudience, NotificationChannel } from '../../generated/prisma/enums.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { JobsBridge } from '../infra/jobs-bridge.js';
import { DevOutboxService } from './dev-outbox.service.js';
import { pickProviders, type ChannelProvider } from './providers.js';
import type { TemplateName } from './templates/templates.js';
import type { WaTemplateRef } from '../whatsapp/templates.registry.js';

export interface OutgoingMessage {
  tenantId: string | null;
  reservationId?: string | null;
  guestAccountId?: string | null;
  template: TemplateName;
  channel: NotificationChannel;
  audience?: NotificationAudience;
  to: string;
  subject: string | null;
  text: string;
  html: string | null;
  fromName?: string | null;
  /** Unique per logical message (e.g. PRE_ARRIVAL:<reservation>:EMAIL): a second one is skipped. */
  dedupeKey?: string;
  meta?: Record<string, unknown>;
  /** WhatsApp: the approved template to use when the recipient has not written in the last 24 hours. */
  waTemplate?: WaTemplateRef | null;
}

export const NOTIFY_JOB = 'notify';

/**
 * Every OTP carries the same meta on every channel (SMS, WhatsApp inside or
 * outside the 24-hour window): `otpCode` and the `otp_code` template
 * parameters. Providers ignore meta; the dev outbox shows it.
 */
export function otpMeta(m: Pick<OutgoingMessage, 'template' | 'meta' | 'waTemplate'>): Record<string, unknown> {
  if (m.template !== 'OTP') return {};
  const fromMeta = typeof m.meta?.otpCode === 'string' ? m.meta.otpCode : null;
  const code = fromMeta ?? m.waTemplate?.params[0] ?? null;
  if (!code) return {};
  return { otpCode: code, waTemplate: 'otp_code', waParams: [code] };
}
export const NOTIFY_ATTEMPTS = 5;

/**
 * Stores every outgoing message in `notification_logs` and delivers it.
 *
 * - `queueTx` inserts the rows inside the caller's business transaction (so a
 *   confirmation is logged only if the booking committed); call `dispatch`
 *   with the returned ids after the commit. With BullMQ running, each message
 *   is a job with 5 attempts and exponential backoff; without it (tests,
 *   scripts) delivery happens inline, once.
 * - `sendSensitive` is for OTP codes and magic links: delivered immediately
 *   with the real content, while the log keeps a redacted copy.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly providers: Record<NotificationChannel, ChannelProvider>;

  constructor(
    private readonly db: DbService,
    private readonly jobs: JobsBridge,
    outbox: DevOutboxService,
    private readonly config: AppConfigService,
  ) {
    this.providers = pickProviders(config, outbox);
  }

  providerName(channel: NotificationChannel): string {
    return this.providers[channel].name;
  }

  async queueTx(tx: Tx, messages: OutgoingMessage[]): Promise<string[]> {
    if (!messages.length) return [];
    const rows = messages.map((m) => ({
      id: randomUUID(),
      tenantId: m.tenantId,
      reservationId: m.reservationId ?? null,
      guestAccountId: m.guestAccountId ?? null,
      template: m.template,
      channel: m.channel,
      audience: m.audience ?? 'GUEST',
      recipient: m.to,
      subject: m.subject,
      bodyText: m.text,
      bodyHtml: m.html,
      status: 'QUEUED' as const,
      provider: this.providers[m.channel].name,
      dedupeKey: m.dedupeKey ?? null,
      waTemplate: m.channel === 'WHATSAPP' && m.waTemplate ? (m.waTemplate as unknown as Prisma.InputJsonValue) : undefined,
    }));
    await tx.notificationLog.createMany({ data: rows, skipDuplicates: true });
    const inserted = await tx.notificationLog.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true } });
    const ok = new Set<string>(inserted.map((r) => r.id));
    // M6: the rows live in the database of the transaction's tenant (a
    // platform alert queued inside a hotel's transaction too), so delivery
    // looks them up there.
    const dbTenant = messages.find((m) => m.tenantId)?.tenantId ?? null;
    const meta = new Map<string, { fromName: string | null; meta: Record<string, unknown>; tenantId: string | null }>(rows.map((r, i) => [r.id, { fromName: messages[i].fromName ?? null, meta: messages[i].meta ?? {}, tenantId: dbTenant }]));
    for (const id of ok) this.pendingMeta.set(id, meta.get(id)!);
    return rows.filter((r) => ok.has(r.id)).map((r) => r.id);
  }

  /** Per-process hints for the first delivery attempt (sender name, outbox meta). */
  private readonly pendingMeta = new Map<string, { fromName: string | null; meta: Record<string, unknown>; tenantId: string | null }>();

  /** Hands queued messages to the worker (or delivers inline). Never throws. */
  async dispatch(ids: string[]): Promise<void> {
    for (const id of ids) {
      const hint = this.pendingMeta.get(id);
      this.pendingMeta.delete(id);
      const queued = await this.jobs.enqueue(
        NOTIFY_JOB,
        { id, fromName: hint?.fromName ?? null, meta: hint?.meta ?? {}, tenantId: hint?.tenantId ?? null },
        { jobId: `notify-${id}`, attempts: NOTIFY_ATTEMPTS, backoff: { type: 'exponential', delay: 30_000 } },
      );
      if (!queued) {
        try {
          await this.deliver(id, { final: true, fromName: hint?.fromName ?? null, meta: hint?.meta ?? {}, tenantId: hint?.tenantId ?? null });
        } catch (e) {
          this.logger.warn(`Notification ${id} failed: ${(e as Error).message}`);
        }
      }
    }
  }

  /**
   * Convenience: insert in its own platform transaction and dispatch. M6:
   * rows go to the database of each message's tenant (shared for platform
   * messages and tenants without a dedicated database).
   */
  async send(messages: OutgoingMessage[]): Promise<string[]> {
    const byTenant = new Map<string | null, OutgoingMessage[]>();
    for (const m of messages) byTenant.set(m.tenantId, [...(byTenant.get(m.tenantId) ?? []), m]);
    const ids: string[] = [];
    for (const [tenantId, list] of byTenant) ids.push(...(await this.db.systemFor(tenantId, (tx) => this.queueTx(tx, list))));
    await this.dispatch(ids);
    return ids;
  }

  /**
   * One delivery attempt. Throws on failure so BullMQ retries; on the final
   * attempt the row is marked FAILED.
   */
  async deliver(id: string, opts: { final: boolean; fromName?: string | null; meta?: Record<string, unknown>; tenantId?: string | null }): Promise<void> {
    const tenantId = opts.tenantId ?? null;
    const log = await this.db.systemFor(tenantId, (tx) => tx.notificationLog.findUnique({ where: { id } }));
    if (!log || log.status === 'SENT' || log.status === 'OUTBOX') return;
    const provider = this.providers[log.channel];
    try {
      const wa = log.channel === 'WHATSAPP' && log.waTemplate && !(await this.inServiceWindow(log.recipient)) ? (log.waTemplate as unknown as WaTemplateRef) : null;
      const res = await provider.send({
        to: log.recipient,
        subject: log.subject,
        text: log.bodyText,
        html: log.bodyHtml,
        fromName: opts.fromName,
        template: log.template,
        meta: { ...opts.meta, notificationId: id },
        waTemplate: wa,
      });
      await this.db.systemFor(tenantId, (tx) =>
        tx.notificationLog.update({
          where: { id },
          data: { status: res.outbox ? 'OUTBOX' : 'SENT', provider: provider.name, providerMessageId: res.providerMessageId, attempts: { increment: 1 }, sentAt: new Date(), error: null },
        }),
      );
    } catch (e) {
      const message = (e as Error).message.slice(0, 500);
      await this.db.systemFor(tenantId, (tx) =>
        tx.notificationLog.update({
          where: { id },
          data: { attempts: { increment: 1 }, error: message, ...(opts.final && { status: 'FAILED' }) },
        }),
      );
      throw e;
    }
  }

  /**
   * OTP / magic link: sent right away with the secret content; the log row
   * stores `redacted` text only.
   */
  async sendSensitive(m: OutgoingMessage & { redactedText: string }): Promise<{ ok: boolean; logId: string }> {
    const r = await this.sendNow(m);
    return { ok: r.ok, logId: r.logId };
  }

  /**
   * Sends one message right away (no queue) and reports the outcome: used by
   * the guest inbox, whose message rows mirror the delivery status.
   * `redactedText` (OTP codes) is what the log keeps instead of the text.
   */
  async sendNow(m: OutgoingMessage & { redactedText?: string }): Promise<{ ok: boolean; logId: string; providerMessageId: string | null; outbox: boolean; error: string | null }> {
    const provider = this.providers[m.channel];
    const logId = randomUUID();
    await this.db.systemFor(m.tenantId, (tx) =>
      tx.notificationLog.create({
        data: {
          id: logId,
          tenantId: m.tenantId,
          guestAccountId: m.guestAccountId ?? null,
          template: m.template,
          channel: m.channel,
          audience: m.audience ?? 'GUEST',
          recipient: m.to,
          subject: m.subject,
          bodyText: m.redactedText ?? m.text,
          bodyHtml: null,
          reservationId: m.reservationId ?? null,
          status: 'QUEUED',
          provider: provider.name,
        } satisfies Prisma.NotificationLogUncheckedCreateInput,
      }),
    );
    try {
      const wa = m.channel === 'WHATSAPP' && m.waTemplate && !(await this.inServiceWindow(m.to)) ? m.waTemplate : null;
      const res = await provider.send({ to: m.to, subject: m.subject, text: m.text, html: m.html, template: m.template, meta: { ...m.meta, ...otpMeta(m), notificationId: logId }, waTemplate: wa });
      await this.db.systemFor(m.tenantId, (tx) =>
        tx.notificationLog.update({
          where: { id: logId },
          data: { status: res.outbox ? 'OUTBOX' : 'SENT', providerMessageId: res.providerMessageId, attempts: 1, sentAt: new Date() },
        }),
      );
      return { ok: true, logId, providerMessageId: res.providerMessageId, outbox: !!res.outbox, error: null };
    } catch (e) {
      const error = (e as Error).message.slice(0, 500);
      this.logger.error(`${m.template} to ${m.channel} failed: ${error}`);
      await this.db.systemFor(m.tenantId, (tx) => tx.notificationLog.update({ where: { id: logId }, data: { status: 'FAILED', attempts: 1, error } }));
      return { ok: false, logId, providerMessageId: null, outbox: false, error };
    }
  }

  /**
   * True when the recipient wrote to our WhatsApp number in the last 24 hours
   * (free-form text is allowed); otherwise only approved templates deliver.
   */
  async inServiceWindow(phone: string, now = new Date()): Promise<boolean> {
    const since = new Date(now.getTime() - 24 * 3_600_000);
    const digits = phone.replace(/\D/g, '');
    const n = await this.db.system((tx) => tx.whatsAppInbound.count({ where: { fromPhone: { in: [phone, `+${digits}`, digits] }, createdAt: { gte: since } } }));
    return n > 0;
  }

  get appName(): string {
    return this.config.get('APP_NAME');
  }
}
