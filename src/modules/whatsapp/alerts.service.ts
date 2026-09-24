import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { GuardAlert, Prisma } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { permissionsFor } from '../../common/permissions/catalogue.js';
import { maskPhone, normalisePhone } from '../../common/utils/phone.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { NotificationService, type OutgoingMessage } from '../notifications/notification.service.js';
import { naira, renderTemplate } from '../notifications/templates/templates.js';
import { appError, Err, k, paginate, primaryProperty } from '../ops/ops.helpers.js';
import {
  alertSchedule,
  DEFAULT_GUARD_ALERTS,
  DEFAULT_QUIET_HOURS,
  guardAlertSettings,
  inQuietHours,
  isUrgent,
  quietHours,
  type GuardAlertSettings,
  type QuietHours,
} from './alerts.logic.js';
import { cleanParam, fillTemplate, WHATSAPP_TEMPLATES } from './templates.registry.js';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface AlertFlag {
  id: string;
  rule: string;
  severity: string;
  title: string;
  amountKobo: number | null;
}

/**
 * Real-time WhatsApp alerts to owners and managers for HIGH Revenue Guard
 * flags: debounced into one message, deferred through quiet hours unless
 * urgent, acknowledged by replying "1". Also the notification settings and
 * the WhatsApp template list.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationService,
    private readonly config: AppConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  async settingsRow(tx: Tx, tenantId: string) {
    const property = await primaryProperty(tx, tenantId);
    const row = await tx.notificationSetting.findUnique({ where: { propertyId: property.id } });
    return {
      propertyId: property.id,
      guardAlerts: guardAlertSettings(row?.guardAlerts),
      quietHours: quietHours(row?.quietHours),
      updatedAt: row?.updatedAt ?? null,
    };
  }

  /** Staff who receive guard alerts: owners / managers / listed users, active, with a phone. */
  private async recipients(tx: Tx, tenantId: string, s: GuardAlertSettings) {
    const users = await tx.user.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, fullName: true, role: true, phone: true, email: true, customRole: { select: { name: true, permissions: true } } },
      orderBy: { fullName: 'asc' },
    });
    return users.map((u) => {
      const chosen = (s.recipients.owners && u.role === 'OWNER') || (s.recipients.managers && u.role === 'MANAGER') || s.recipients.userIds.includes(u.id);
      const phone = normalisePhone(u.phone ?? '');
      const canSee = permissionsFor(u.role, u.customRole?.permissions).has('guard.view');
      const reason = !chosen ? 'Not selected' : !canSee ? 'Cannot see Revenue Guard' : !phone ? 'No phone number' : null;
      return { user: u, phone, willReceive: reason === null, reason };
    });
  }

  private async digestRecipients(tx: Tx, tenantId: string, propertyId: string) {
    const s = await tx.digestSetting.findUnique({ where: { propertyId } });
    if (s) return { enabled: s.enabled, recipients: s.recipients };
    const owners = await tx.user.findMany({ where: { tenantId, role: 'OWNER', isActive: true }, select: { phone: true } });
    return { enabled: true, recipients: owners.map((o) => normalisePhone(o.phone ?? '')).filter((p): p is string => !!p).slice(0, 5) };
  }

  getSettings(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const s = await this.settingsRow(tx, user.tenantId);
      const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
      const people = await this.recipients(tx, user.tenantId, s.guardAlerts);
      return {
        guardAlerts: s.guardAlerts,
        quietHours: s.quietHours,
        digest: { ...(await this.digestRecipients(tx, user.tenantId, s.propertyId)), channel: 'WHATSAPP' as const, sendAt: '23:00' as const },
        recipientsPreview: people.map((p) => ({
          userId: p.user.id,
          fullName: p.user.fullName,
          role: p.user.role === 'CUSTOM' ? (p.user.customRole?.name ?? 'Custom') : p.user.role,
          phoneMasked: p.phone ? maskPhone(p.phone) : null,
          willReceive: p.willReceive,
          reason: p.reason,
        })),
        features: { ownerWhatsappAlerts: ent.features.includes('owner_whatsapp_alerts'), whatsappMessaging: ent.features.includes('whatsapp_messaging') },
        updatedAt: s.updatedAt?.toISOString() ?? null,
      };
    });
  }

  async putSettings(
    user: AuthUser,
    dto: { guardAlerts?: Partial<GuardAlertSettings>; quietHours?: Partial<QuietHours>; digest?: { enabled?: boolean; recipients?: string[] } },
    ip?: string,
  ) {
    await this.db.tenant(user.tenantId, async (tx) => {
      const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
      await this.entitlements.assertFeature(ent, 'owner_whatsapp_alerts');
      const cur = await this.settingsRow(tx, user.tenantId);
      const guardAlerts: GuardAlertSettings = {
        ...cur.guardAlerts,
        ...dto.guardAlerts,
        recipients: { ...cur.guardAlerts.recipients, ...dto.guardAlerts?.recipients },
      };
      const quiet: QuietHours = { ...cur.quietHours, ...dto.quietHours };
      if (!TIME.test(quiet.start) || !TIME.test(quiet.end)) throw Err.validation('quietHours', 'Quiet hours use HH:MM');
      if (guardAlerts.debounceMinutes < 0 || guardAlerts.debounceMinutes > 30) throw Err.validation('guardAlerts.debounceMinutes', 'Between 0 and 30 minutes');
      if (guardAlerts.recipients.userIds.length) {
        const found = await tx.user.count({ where: { tenantId: user.tenantId, id: { in: guardAlerts.recipients.userIds } } });
        if (found !== new Set(guardAlerts.recipients.userIds).size) throw Err.validation('guardAlerts.recipients.userIds', 'Unknown staff member');
      }
      await tx.notificationSetting.upsert({
        where: { propertyId: cur.propertyId },
        create: { tenantId: user.tenantId, propertyId: cur.propertyId, guardAlerts: guardAlerts as unknown as Prisma.InputJsonValue, quietHours: quiet as unknown as Prisma.InputJsonValue },
        update: { guardAlerts: guardAlerts as unknown as Prisma.InputJsonValue, quietHours: quiet as unknown as Prisma.InputJsonValue },
      });
      if (dto.digest) {
        const d = await this.digestRecipients(tx, user.tenantId, cur.propertyId);
        const recipients = dto.digest.recipients
          ? [
              ...new Set(
                dto.digest.recipients.map((r) => {
                  const p = normalisePhone(r);
                  if (!p) throw Err.validation('digest.recipients', `Invalid phone number: ${r}`);
                  return p;
                }),
              ),
            ]
          : d.recipients;
        if (recipients.length > 5) throw Err.validation('digest.recipients', 'At most 5 recipients');
        await tx.digestSetting.upsert({
          where: { propertyId: cur.propertyId },
          create: { tenantId: user.tenantId, propertyId: cur.propertyId, enabled: dto.digest.enabled ?? d.enabled, recipients },
          update: { enabled: dto.digest.enabled ?? d.enabled, recipients },
        });
      }
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'notification_settings.updated',
        entityType: 'notification_setting',
        metadata: { guardAlerts: dto.guardAlerts ? Object.keys(dto.guardAlerts) : [], quietHours: dto.quietHours ?? null, digest: !!dto.digest },
        ip,
      });
    });
    return this.getSettings(user);
  }

  templates() {
    const approved = new Set(this.config.get('WHATSAPP_APPROVED_TEMPLATES').split(',').map((x) => x.trim()).filter(Boolean));
    const live = !!(this.config.get('WHATSAPP_TOKEN') && this.config.get('WHATSAPP_PHONE_ID'));
    return {
      provider: live ? ('cloud' as const) : ('outbox' as const),
      templates: WHATSAPP_TEMPLATES.map((t) => ({ ...t, status: approved.has(t.name) ? ('APPROVED' as const) : live ? ('SUBMITTED' as const) : ('NOT_SUBMITTED' as const) })),
    };
  }

  // ---------------------------------------------------------------------------
  // Queueing (inside the transaction that raised the flag)
  // ---------------------------------------------------------------------------

  /** Called by Revenue Guard for every new HIGH flag. */
  async queueTx(tx: Tx, tenantId: string, features: readonly string[], flag: AlertFlag, now = new Date()): Promise<void> {
    if (flag.severity !== 'HIGH' || !features.includes('owner_whatsapp_alerts')) return;
    const s = await this.settingsRow(tx, tenantId);
    if (!s.guardAlerts.enabled) return;
    const urgent = isUrgent(flag, s.guardAlerts);
    const when = alertSchedule(now, urgent, s.guardAlerts, s.quietHours);
    // Debounce: join an alert that has not gone out yet (same urgency).
    const open = await tx.guardAlert.findFirst({
      where: { tenantId, status: { in: ['PENDING', 'DEFERRED'] }, urgent, test: false, sentAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (open) {
      await tx.guardAlert.update({ where: { id: open.id }, data: { flagIds: [...new Set([...open.flagIds, flag.id])] } });
      return;
    }
    await tx.guardAlert.create({
      data: {
        tenantId,
        status: when.deferred ? 'DEFERRED' : 'PENDING',
        urgent,
        flagIds: [flag.id],
        scheduledFor: when.scheduledFor,
        deferredReason: when.deferred ? 'QUIET_HOURS' : null,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  private adminUrl() {
    return `${this.config.get('ADMIN_URL').replace(/\/$/, '')}/guard`;
  }

  private async compose(tx: Tx, tenantId: string, alert: GuardAlert, flags: { id: string; title: string; amountKobo: bigint | null; rule: string }[]) {
    const s = await this.settingsRow(tx, tenantId);
    const property = await primaryProperty(tx, tenantId);
    const people = (await this.recipients(tx, tenantId, s.guardAlerts)).filter((p) => p.willReceive);
    const amount = flags.reduce((a, f) => a + k(f.amountKobo), 0);
    const top = flags[0]?.title ?? 'Revenue Guard test alert';
    const params = [property.name, String(flags.length || 1), flags.length > 1 ? `${top} (and ${flags.length - 1} more)` : top, amount ? naira(amount) : 'not stated', this.adminUrl()].map(cleanParam);
    const text = fillTemplate('guard_alert_high', params);
    const messages: OutgoingMessage[] = [];
    for (const p of people) {
      if (s.guardAlerts.channels.includes('WHATSAPP') && p.phone) {
        messages.push({
          tenantId,
          template: 'GUARD_ALERT',
          channel: 'WHATSAPP',
          audience: 'HOTEL',
          to: p.phone,
          subject: null,
          text,
          html: null,
          waTemplate: { name: 'guard_alert_high', language: 'en', params },
          meta: { hotelName: property.name, alertId: alert.id },
        });
      }
      if (s.guardAlerts.channels.includes('EMAIL') && p.user.email) {
        const r = renderTemplate(
          { appName: this.config.get('APP_NAME'), appDomain: this.config.get('APP_DOMAIN'), supportEmail: this.config.get('SUPPORT_EMAIL') },
          { template: 'GUARD_ALERT', hotelName: property.name, flags: flags.map((f) => ({ title: f.title, amountKobo: f.amountKobo === null ? null : k(f.amountKobo) })), adminUrl: this.adminUrl(), urgent: alert.urgent },
        );
        messages.push({ tenantId, template: 'GUARD_ALERT', channel: 'EMAIL', audience: 'HOTEL', to: p.user.email, subject: r.subject, text: r.text, html: r.html, meta: { alertId: alert.id } });
      }
    }
    return { messages, people };
  }

  /** Sends every alert that is due (a one-minute job; tests call it directly). */
  async processDue(now = new Date()): Promise<{ sent: number }> {
    const due = (await this.db.systemAll((tx, t) =>
      tx.guardAlert.findMany({ where: { ...t.tenants, status: { in: ['PENDING', 'DEFERRED'] }, scheduledFor: { lte: now }, sentAt: null }, select: { id: true, tenantId: true }, take: 200 }),
    )).flat();
    let sent = 0;
    for (const a of due) {
      try {
        if (await this.sendOne(a.tenantId, a.id, now)) sent++;
      } catch (e) {
        this.logger.error(`Guard alert ${a.id} failed: ${(e as Error).message}`);
      }
    }
    return { sent };
  }

  async sendOne(tenantId: string, alertId: string, now = new Date()): Promise<boolean> {
    const ids = await this.db.tenant(tenantId, async (tx) => {
      await tx.$executeRaw`SELECT id FROM guard_alerts WHERE id = ${alertId}::uuid FOR UPDATE`;
      const alert = await tx.guardAlert.findFirst({ where: { id: alertId, tenantId } });
      if (!alert || alert.sentAt || (alert.status !== 'PENDING' && alert.status !== 'DEFERRED')) return null;
      const s = await this.settingsRow(tx, tenantId);
      if (!alert.urgent && inQuietHours(now, s.quietHours)) {
        const next = alertSchedule(now, false, s.guardAlerts, s.quietHours);
        await tx.guardAlert.update({ where: { id: alert.id }, data: { status: 'DEFERRED', deferredReason: 'QUIET_HOURS', scheduledFor: next.scheduledFor } });
        return null;
      }
      const flags = await tx.guardFlag.findMany({ where: { id: { in: alert.flagIds }, status: 'OPEN' }, orderBy: { createdAt: 'asc' } });
      if (!flags.length) {
        await tx.guardAlert.update({ where: { id: alert.id }, data: { status: 'ACKNOWLEDGED', error: 'Flags handled before the alert went out' } });
        return null;
      }
      const { messages, people } = await this.compose(tx, tenantId, alert, flags);
      const queued = await this.notifications.queueTx(tx, messages);
      await tx.guardAlert.update({
        where: { id: alert.id },
        data: {
          status: people.length ? 'SENT' : 'FAILED',
          sentAt: now,
          recipients: people.map((p) => p.phone!).filter(Boolean),
          recipientUserIds: people.map((p) => p.user.id),
          error: people.length ? null : 'Nobody is set up to receive alerts',
        },
      });
      return queued;
    });
    if (!ids) return false;
    await this.notifications.dispatch(ids);
    return true;
  }

  async sendTest(user: AuthUser) {
    const out = await this.db.tenant(user.tenantId, async (tx) => {
      const ent = await this.entitlements.getEntitlements(user.tenantId, tx);
      await this.entitlements.assertFeature(ent, 'owner_whatsapp_alerts');
      const me = await tx.user.findFirst({ where: { id: user.userId }, select: { phone: true } });
      const phone = normalisePhone(me?.phone ?? '');
      if (!phone) throw appError(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Add a phone number to your profile first', { fields: { phone: ['Add a phone number to your profile first'] } });
      const property = await primaryProperty(tx, user.tenantId);
      const now = new Date();
      const alert = await tx.guardAlert.create({
        data: { tenantId: user.tenantId, status: 'SENT', urgent: false, test: true, flagIds: [], recipients: [phone], recipientUserIds: [user.userId], scheduledFor: now, sentAt: now },
      });
      const params = [property.name, '1', 'Test alert: this is what a high-risk flag looks like', 'not stated', this.adminUrl()].map(cleanParam);
      const ids = await this.notifications.queueTx(tx, [
        {
          tenantId: user.tenantId,
          template: 'GUARD_ALERT',
          channel: 'WHATSAPP',
          audience: 'HOTEL',
          to: phone,
          subject: null,
          text: fillTemplate('guard_alert_high', params),
          html: null,
          waTemplate: { name: 'guard_alert_high', language: 'en', params },
          meta: { alertId: alert.id, test: true },
        },
      ]);
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'guard_alert.test_sent', entityType: 'guard_alert', entityId: alert.id, metadata: { to: maskPhone(phone) } });
      return { alert, ids };
    });
    await this.notifications.dispatch(out.ids);
    return this.db.tenant(user.tenantId, async (tx) => (await this.views(tx, [out.alert]))[0]);
  }

  private async views(tx: Tx, rows: GuardAlert[]) {
    const flagIds = [...new Set(rows.flatMap((r) => r.flagIds))];
    const flags = flagIds.length ? await tx.guardFlag.findMany({ where: { id: { in: flagIds } } }) : [];
    const byId = new Map(flags.map((f) => [f.id, f]));
    return rows.map((a) => ({
      id: a.id,
      status: a.status,
      urgent: a.urgent,
      test: a.test,
      flags: a.flagIds
        .map((id) => byId.get(id))
        .filter((f): f is NonNullable<typeof f> => !!f)
        .map((f) => ({ id: f.id, rule: f.rule, title: f.title, severity: f.severity, amountKobo: f.amountKobo === null ? null : k(f.amountKobo) })),
      recipients: a.recipients.map(maskPhone),
      channel: 'WHATSAPP' as const,
      template: 'guard_alert_high' as const,
      scheduledFor: a.scheduledFor.toISOString(),
      sentAt: a.sentAt?.toISOString() ?? null,
      deferredReason: a.deferredReason,
      acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
      acknowledgedBy: a.acknowledgedById ? { id: a.acknowledgedById, fullName: a.acknowledgedByName ?? '' } : null,
      error: a.error,
      createdAt: a.createdAt.toISOString(),
    }));
  }

  list(user: AuthUser, page?: number, pageSize?: number) {
    const pg = paginate(page, pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const where = { tenantId: user.tenantId };
      const rows = await tx.guardAlert.findMany({ where, orderBy: { createdAt: 'desc' }, skip: pg.skip, take: pg.take });
      const total = await tx.guardAlert.count({ where });
      return { items: await this.views(tx, rows), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  /**
   * "1" / "ACK" from WhatsApp: acknowledges the open flags of the latest alert
   * sent to this staff member. Returns how many flags were acknowledged.
   */
  async acknowledgeLatest(tenantId: string, staff: { id: string; fullName: string }): Promise<{ alertId: string | null; acknowledged: number }> {
    return this.db.tenant(tenantId, async (tx) => {
      const alert = await tx.guardAlert.findFirst({
        where: { tenantId, status: { in: ['SENT', 'ACKNOWLEDGED'] }, test: false, recipientUserIds: { has: staff.id } },
        orderBy: { sentAt: 'desc' },
      });
      if (!alert) return { alertId: null, acknowledged: 0 };
      const now = new Date();
      const res = await tx.guardFlag.updateMany({
        where: { id: { in: alert.flagIds }, status: 'OPEN' },
        data: { status: 'ACKNOWLEDGED', resolvedById: staff.id, resolvedByName: staff.fullName, resolution: 'Acknowledged on WhatsApp' },
      });
      await tx.guardAlert.update({ where: { id: alert.id }, data: { status: 'ACKNOWLEDGED', acknowledgedAt: now, acknowledgedById: staff.id, acknowledgedByName: staff.fullName } });
      await this.audit.record(tx, {
        tenantId,
        actor: { kind: 'user', id: staff.id, name: staff.fullName },
        action: 'guard.flags_acknowledged',
        entityType: 'guard_alert',
        entityId: alert.id,
        metadata: { channel: 'whatsapp', flags: alert.flagIds, acknowledged: res.count },
      });
      return { alertId: alert.id, acknowledged: res.count };
    });
  }

  static readonly defaults = { guardAlerts: DEFAULT_GUARD_ALERTS, quietHours: DEFAULT_QUIET_HOURS };
}
