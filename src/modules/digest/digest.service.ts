import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OwnerDigest, Prisma } from '../../generated/prisma/client.js';
import type { GuardSeverity, JobTrigger } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { dbDate, fromDbDate, isIsoDate, lagosDate } from '../../common/time/lagos.js';
import { maskPhone, normalisePhone } from '../../common/utils/phone.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { Err, paginate, primaryProperty } from '../ops/ops.helpers.js';
import { computeDailyFlashes } from '../reports/stats.compute.js';
import { DIGEST_PROVIDER, type DigestProvider } from './digest.providers.js';
import { renderDigest, type DigestData } from './digest.render.js';

export type { DigestData };

const SEVERITY_ORDER: Record<GuardSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    @Inject(DIGEST_PROVIDER) private readonly provider: DigestProvider,
    @Inject('APP_NAME') private readonly appName: string,
  ) {}

  private toView(d: OwnerDigest) {
    return {
      id: d.id,
      businessDate: fromDbDate(d.businessDate),
      channel: d.channel,
      status: d.status,
      recipients: d.recipients.map(maskPhone),
      body: d.body,
      data: d.data as unknown as DigestData,
      error: d.error,
      createdAt: d.createdAt.toISOString(),
    };
  }

  async compose(tx: Tx, tenantId: string, businessDate: string): Promise<{ data: DigestData; body: string }> {
    const property = await primaryProperty(tx, tenantId);
    const [f] = await computeDailyFlashes(tx, tenantId, businessDate, businessDate);
    const flags = await tx.guardFlag.findMany({
      where: { tenantId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { rule: true, severity: true, title: true },
    });
    flags.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    const data: DigestData = {
      businessDate,
      hotelName: property.name,
      roomsSold: f.roomsSold,
      roomsAvailable: f.roomsAvailable,
      occupancyRate: f.occupancyRate,
      dayUseCount: f.dayUseCount,
      arrivals: f.arrivals,
      departures: f.departures,
      roomRevenueKobo: f.roomRevenueKobo,
      totalRevenueKobo: f.totalRevenueKobo,
      revenueByMethod: f.paymentsByMethod,
      paymentsTotalKobo: f.paymentsTotalKobo,
      openFlags: f.openFlags,
      topFlags: flags.slice(0, 3),
    };
    return { data, body: renderDigest(data, this.appName) };
  }

  private async settingsRow(tx: Tx, tenantId: string) {
    const property = await primaryProperty(tx, tenantId);
    const existing = await tx.digestSetting.findUnique({ where: { propertyId: property.id } });
    if (existing) return existing;
    const owners = await tx.user.findMany({ where: { tenantId, role: 'OWNER', isActive: true }, select: { phone: true } });
    const recipients = owners.map((o) => normalisePhone(o.phone ?? '')).filter((p): p is string => !!p).slice(0, 5);
    return tx.digestSetting.create({ data: { tenantId, propertyId: property.id, recipients } });
  }

  getSettings(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const s = await this.settingsRow(tx, user.tenantId);
      return { enabled: s.enabled, recipients: s.recipients };
    });
  }

  putSettings(user: AuthUser, dto: { enabled: boolean; recipients: string[] }, ip?: string) {
    const recipients = [...new Set(dto.recipients.map((r) => {
      const p = normalisePhone(r);
      if (!p) throw Err.validation('recipients', `Invalid phone number: ${r}`);
      return p;
    }))];
    if (recipients.length > 5) throw Err.validation('recipients', 'At most 5 recipients');
    return this.db.tenant(user.tenantId, async (tx) => {
      const s = await this.settingsRow(tx, user.tenantId);
      const updated = await tx.digestSetting.update({ where: { id: s.id }, data: { enabled: dto.enabled, recipients } });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'digest.settings_updated',
        entityType: 'digest_setting',
        entityId: s.id,
        metadata: { enabled: dto.enabled, recipients: recipients.map(maskPhone) },
        ip,
      });
      return { enabled: updated.enabled, recipients: updated.recipients };
    });
  }

  list(user: AuthUser, page?: number, pageSize?: number) {
    const pg = paginate(page, pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const where = { tenantId: user.tenantId };
      const rows = await tx.ownerDigest.findMany({ where, orderBy: { createdAt: 'desc' }, skip: pg.skip, take: pg.take });
      const total = await tx.ownerDigest.count({ where });
      return { items: rows.map((r) => this.toView(r)), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  preview(user: AuthUser, businessDate?: string) {
    const date = this.date(businessDate);
    return this.db.tenant(user.tenantId, (tx) => this.compose(tx, user.tenantId, date));
  }

  private date(d?: string) {
    const date = d ?? lagosDate();
    if (!isIsoDate(date)) throw Err.validation('businessDate', 'businessDate must be YYYY-MM-DD');
    return date;
  }

  async sendNow(user: AuthUser, businessDate?: string) {
    const view = await this.deliver(user.tenantId, this.date(businessDate), 'MANUAL');
    await this.db.tenant(user.tenantId, (tx) =>
      this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'digest.sent',
        entityType: 'owner_digest',
        entityId: view.id,
        metadata: { businessDate: view.businessDate, status: view.status },
      }),
    );
    return view;
  }

  /** Composes, delivers through the provider and stores the digest. */
  async deliver(tenantId: string, businessDate: string, trigger: JobTrigger) {
    const { data, body, recipients } = await this.db.tenant(tenantId, async (tx) => {
      const s = await this.settingsRow(tx, tenantId);
      return { ...(await this.compose(tx, tenantId, businessDate)), recipients: s.recipients };
    });
    const result = await this.provider.send(recipients, body).catch((e: Error) => ({ status: 'FAILED' as const, error: e.message }));
    const row = await this.db.tenant(tenantId, (tx) =>
      tx.ownerDigest.create({
        data: {
          tenantId,
          businessDate: dbDate(businessDate),
          trigger,
          channel: this.provider.channel,
          status: result.status,
          recipients,
          body,
          data: data as unknown as Prisma.InputJsonValue,
          error: result.error ?? null,
        },
      }),
    );
    return this.toView(row);
  }

  /** Scheduled entry point (23:00 Lagos). Skips tenants already sent today. */
  async runAll(now = new Date()) {
    const businessDate = lagosDate(now);
    const tenants = await this.db.system((tx) =>
      tx.tenant.findMany({ where: { subscription: { status: { notIn: ['SUSPENDED', 'READ_ONLY'] } } }, select: { id: true } }),
    );
    let sent = 0;
    for (const t of tenants) {
      try {
        const ent = await this.entitlements.getEntitlements(t.id);
        if (!ent.features.includes('owner_whatsapp_alerts')) continue;
        const skip = await this.db.tenant(t.id, async (tx) => {
          const s = await this.settingsRow(tx, t.id);
          if (!s.enabled) return true;
          const already = await tx.ownerDigest.count({ where: { tenantId: t.id, businessDate: dbDate(businessDate), trigger: 'SCHEDULED' } });
          return already > 0;
        });
        if (skip) continue;
        await this.deliver(t.id, businessDate, 'SCHEDULED');
        sent++;
      } catch (e) {
        this.logger.error(`Digest failed for ${t.id}: ${(e as Error).message}`);
      }
    }
    return { businessDate, sent };
  }
}
