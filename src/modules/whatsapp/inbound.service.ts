import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { permissionsFor } from '../../common/permissions/catalogue.js';
import { lagosDate } from '../../common/time/lagos.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService } from '../../prisma/db.service.js';
import { DigestService } from '../digest/digest.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { GuestInboxService } from '../inbox/inbox.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { isUniqueViolation } from '../ops/ops.helpers.js';
import { parseCommand } from './alerts.logic.js';
import { AlertsService } from './alerts.service.js';

export const HELP_TEXT = 'Reply 1 to acknowledge the latest alert, or DIGEST for today\'s summary.';

/** X-Hub-Signature-256 check: sha256=<hex HMAC-SHA256(raw body, app secret)>, constant time. */
export function verifyHubSignature(raw: Buffer, header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !header || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  const got = header.slice('sha256='.length);
  if (got.length !== expected.length || !/^[0-9a-f]+$/i.test(got)) return false;
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
}

interface InboundMessage {
  id: string;
  from: string;
  text: string;
  /** M5: the business number that received it, and the sender's WhatsApp profile name. */
  phoneNumberId?: string;
  name?: string;
}

export interface InboundStatus {
  id: string;
  status: string;
  error?: string;
}

/** Delivery statuses (sent, delivered, read, failed) out of a Cloud API webhook payload. */
export function extractStatuses(payload: unknown): InboundStatus[] {
  const out: InboundStatus[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry ?? [];
  for (const e of entries as { changes?: { value?: { statuses?: Record<string, unknown>[] } }[] }[]) {
    for (const c of e.changes ?? []) {
      for (const st of c.value?.statuses ?? []) {
        if (typeof st.id !== 'string' || typeof st.status !== 'string') continue;
        const err = (st.errors as { title?: string; message?: string }[] | undefined)?.[0];
        out.push({ id: st.id, status: st.status, ...(err && { error: err.message ?? err.title ?? 'Delivery failed' }) });
      }
    }
  }
  return out;
}

/** Pulls text messages (and quick-reply button presses) out of a Cloud API webhook payload. */
export function extractMessages(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry ?? [];
  for (const e of entries as { changes?: { value?: { messages?: Record<string, unknown>[]; metadata?: { phone_number_id?: string }; contacts?: { wa_id?: string; profile?: { name?: string } }[] } }[] }[]) {
    for (const c of e.changes ?? []) {
      const phoneNumberId = c.value?.metadata?.phone_number_id;
      for (const m of c.value?.messages ?? []) {
        const id = typeof m.id === 'string' ? m.id : null;
        const from = typeof m.from === 'string' ? m.from : null;
        const text =
          (m.text as { body?: string } | undefined)?.body ??
          (m.button as { text?: string } | undefined)?.text ??
          (m.interactive as { button_reply?: { title?: string } } | undefined)?.button_reply?.title ??
          '';
        const name = c.value?.contacts?.find((x) => x.wa_id === from)?.profile?.name;
        if (id && from) out.push({ id, from, text: String(text), ...(phoneNumberId && { phoneNumberId }), ...(name && { name }) });
      }
    }
  }
  return out;
}

/**
 * Inbound WhatsApp messages from owners and managers: "1" / "ACK"
 * acknowledges the latest alert, "DIGEST" sends today's digest now. The
 * sender is matched by phone to active staff with Revenue Guard triage rights
 * in hotels that have `owner_whatsapp_alerts`.
 */
@Injectable()
export class WhatsAppInboundService {
  private readonly logger = new Logger(WhatsAppInboundService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: AppConfigService,
    private readonly alerts: AlertsService,
    private readonly digests: DigestService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationService,
    private readonly refs: ModuleRef,
  ) {}

  private get inbox() {
    return this.refs.get(GuestInboxService, { strict: false });
  }

  verifySubscription(mode: string | undefined, token: string | undefined, challenge: string | undefined): string {
    const expected = this.config.get('WHATSAPP_VERIFY_TOKEN');
    if (mode !== 'subscribe' || !expected || !token || token !== expected || !challenge) throw AppException.forbidden('Verification failed');
    return challenge;
  }

  async receive(raw: Buffer | undefined, signature: string | undefined, payload: unknown) {
    if (!raw || !verifyHubSignature(raw, signature, this.config.get('WHATSAPP_APP_SECRET'))) {
      throw AppException.unauthorized('Invalid webhook signature', ErrorCode.INVALID_SIGNATURE);
    }
    let handled = 0;
    for (const m of extractMessages(payload)) {
      try {
        if (await this.handle(m)) handled++;
      } catch (e) {
        this.logger.error(`WhatsApp message ${m.id} failed: ${(e as Error).message}`);
      }
    }
    // M5: delivery statuses of guest inbox messages.
    for (const st of extractStatuses(payload)) {
      try {
        await this.inbox.applyStatus(st.id, st.status, st.error);
      } catch (e) {
        this.logger.error(`WhatsApp status ${st.id} failed: ${(e as Error).message}`);
      }
    }
    return { received: true, handled };
  }

  /** Staff (active, `guard.resolve`) whose phone matches, in hotels with owner alerts. */
  private async staffFor(fromDigits: string) {
    // M6: staff of every database (shared and dedicated tenants).
    const rows = (await this.db.systemAll((tx, t) =>
      tx.$queryRaw<{ id: string; tenant_id: string; full_name: string }[]>`
        SELECT u.id, u.tenant_id, u.full_name FROM users u
         WHERE u.is_active AND regexp_replace(u.phone, '[^0-9]', '', 'g') IN (${fromDigits}, ${fromDigits.replace(/^234/, '0')})
           AND u.tenant_id <> ALL(${t.excludeTenantIds}::uuid[])`,
    )).flat();
    const out: { id: string; tenantId: string; fullName: string }[] = [];
    for (const r of rows) {
      const u = await this.db.systemFor(r.tenant_id, (tx) => tx.user.findUnique({ where: { id: r.id }, select: { role: true, customRole: { select: { permissions: true } } } }));
      if (!u || !permissionsFor(u.role, u.customRole?.permissions).has('guard.resolve')) continue;
      const ent = await this.entitlements.getEntitlements(r.tenant_id).catch(() => null);
      if (!ent?.features.includes('owner_whatsapp_alerts')) continue;
      out.push({ id: r.id, tenantId: r.tenant_id, fullName: r.full_name });
    }
    return out;
  }

  private async handle(m: InboundMessage): Promise<boolean> {
    const digits = m.from.replace(/\D/g, '');
    const phone = `+${digits}`;
    try {
      await this.db.system((tx) => tx.whatsAppInbound.create({ data: { messageId: m.id, fromPhone: phone, body: m.text.slice(0, 1000) } }));
    } catch (e) {
      if (isUniqueViolation(e)) return false; // a retried delivery
      throw e;
    }
    const staff = await this.staffFor(digits);
    if (!staff.length) {
      // M5: a guest writing to a hotel with the guest inbox.
      const routed = await this.inbox.receiveGuest({ providerMessageId: m.id, from: digits, text: m.text, name: m.name ?? null, phoneNumberId: m.phoneNumberId ?? null });
      if (routed.routed) {
        await this.db.system((tx) => tx.whatsAppInbound.update({ where: { messageId: m.id }, data: { tenantId: routed.tenantId, result: routed.handledBy === 'concierge' ? 'concierge quote reply' : 'guest inbox', handledAt: new Date() } }));
        return true;
      }
      this.logger.log(`WhatsApp message from an unknown number ${phone.slice(0, 7)}••• ignored`);
      await this.db.system((tx) => tx.whatsAppInbound.update({ where: { messageId: m.id }, data: { result: 'unknown sender', handledAt: new Date() } }));
      return false;
    }
    // A staff member of several hotels acts on the hotel of their latest alert.
    const latest = (await this.db.systemAll((tx, t) =>
      tx.guardAlert.findFirst({ where: { ...t.tenants, recipientUserIds: { hasSome: staff.map((s) => s.id) }, sentAt: { not: null } }, orderBy: { sentAt: 'desc' }, select: { tenantId: true, sentAt: true } }),
    )).filter((x) => x !== null).sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0))[0];
    const who = staff.find((s) => s.tenantId === latest?.tenantId) ?? staff[0];
    const command = parseCommand(m.text);
    let reply: string;
    const hotel = await this.db.tenant(who.tenantId, (tx) => tx.property.findFirst({ where: { tenantId: who.tenantId }, orderBy: { createdAt: 'asc' }, select: { name: true } }));
    if (command === 'ACK') {
      const res = await this.alerts.acknowledgeLatest(who.tenantId, { id: who.id, fullName: who.fullName });
      reply = res.alertId
        ? `Acknowledged ${res.acknowledged} alert${res.acknowledged === 1 ? '' : 's'} for ${hotel?.name ?? 'your hotel'}.`
        : `There is no alert to acknowledge for ${hotel?.name ?? 'your hotel'}.`;
    } else if (command === 'DIGEST') {
      await this.digests.deliver(who.tenantId, lagosDate(), 'MANUAL', [phone]);
      reply = `Today's summary for ${hotel?.name ?? 'your hotel'} is on its way.`;
    } else {
      reply = HELP_TEXT;
    }
    await this.db.system((tx) => tx.whatsAppInbound.update({ where: { messageId: m.id }, data: { tenantId: who.tenantId, userId: who.id, command, result: reply, handledAt: new Date() } }));
    // Inside the 24-hour window now (they just wrote), so free-form text is fine.
    await this.notifications.send([{ tenantId: who.tenantId, template: 'WHATSAPP_REPLY', channel: 'WHATSAPP', audience: 'HOTEL', to: phone, subject: null, text: reply, html: null }]);
    return true;
  }
}
