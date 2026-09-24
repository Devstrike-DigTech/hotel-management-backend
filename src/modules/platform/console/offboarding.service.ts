import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { DataExport, SubscriptionStatus, TenantOffboarding } from '../../../generated/prisma/client.js';
import type { PlatformPrincipal } from '../../../common/auth-types.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { humanDate, lagosDate } from '../../../common/time/lagos.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DbService } from '../../../prisma/db.service.js';
import { TenantDbRouter } from '../../../prisma/tenant-db-router.js';
import { AuditService } from '../../audit/audit.service.js';
import { ControlMirrorService } from '../../dedicated-db/control-mirror.service.js';
import { connect, dropDatabase, purgeTenantRows, tenantTables } from '../../dedicated-db/engine.js';
import { ListingsService } from '../../dedicated-db/listings.service.js';
import { ExportsService } from '../../enterprise/exports/exports.service.js';
import { NotificationService } from '../../notifications/notification.service.js';
import { renderTemplate } from '../../notifications/templates/templates.js';
import { appError, Err } from '../../ops/ops.helpers.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../../storage/object-storage.js';
import { PlatformAuditService } from '../security/platform-audit.service.js';

/** Control-plane rows of a tenant deleted with it (the tenant row, subscription and our invoices stay). */
const CONTROL_PURGE = [
  'api_usage_daily', 'api_keys', 'white_label_settings', 'email_domains', 'sms_sender_requests', 'staff_portal_domains', 'sso_configs',
  'support_messages', 'support_requests', 'support_attachments', 'announcement_receipts', 'impersonation_sessions',
  'owner_setup_tokens', 'public_listings', 'data_exports', 'coupon_redemptions', 'tenant_feature_overrides',
];

/**
 * Offboarding (M6, NDPA): the tenant is suspended, a full export is made for
 * them, and after a 30-day grace every record is deleted (shared and
 * dedicated database, files and exports). The tenant row stays as a
 * tombstone for the platform's own billing records.
 */
@Injectable()
export class OffboardingService {
  private readonly logger = new Logger(OffboardingService.name);

  constructor(
    private readonly db: DbService,
    private readonly router: TenantDbRouter,
    private readonly config: AppConfigService,
    private readonly exports: ExportsService,
    private readonly mirror: ControlMirrorService,
    private readonly listings: ListingsService,
    private readonly audit: AuditService,
    private readonly platformAudit: PlatformAuditService,
    private readonly notifications: NotificationService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  view(o: TenantOffboarding, e: DataExport | null) {
    return {
      id: o.id,
      tenant: { id: o.tenantId, name: o.tenantName, slug: o.tenantSlug },
      status: o.status as 'EXPORTING' | 'GRACE' | 'DELETING' | 'DELETED' | 'CANCELLED' | 'FAILED',
      reason: o.reason,
      requestedBy: { id: o.requestedById ?? '', fullName: o.requestedByName, email: o.requestedByEmail ?? '' },
      requestedAt: o.requestedAt.toISOString(),
      exportId: o.exportId,
      export: e ? this.exports.view(e) : null,
      deleteAfter: o.deleteAfter?.toISOString() ?? null,
      deletedAt: o.deletedAt?.toISOString() ?? null,
      cancelledAt: o.cancelledAt?.toISOString() ?? null,
      cancelledBy: o.cancelledById ? { id: o.cancelledById, fullName: o.cancelledByName ?? '', email: '' } : null,
      summary: (o.summary as { tables: number; rowsDeleted: number } | null) ?? null,
      error: o.error,
    };
  }

  private async withExport(o: TenantOffboarding) {
    const e = o.exportId ? await this.db.system((tx) => tx.dataExport.findUnique({ where: { id: o.exportId! } })) : null;
    return this.view(o, e);
  }

  async forTenant(tenantId: string) {
    const o = await this.db.system((tx) => tx.tenantOffboarding.findFirst({ where: { tenantId }, orderBy: { requestedAt: 'desc' } }));
    return o ? this.withExport(o) : null;
  }

  async list(status?: string) {
    const rows = await this.db.system((tx) => tx.tenantOffboarding.findMany({ where: status ? { status } : {}, orderBy: { requestedAt: 'desc' }, take: 200 }));
    return Promise.all(rows.map((r) => this.withExport(r)));
  }

  private graceDays() {
    return this.config.get('OFFBOARDING_GRACE_DAYS');
  }

  async start(p: PlatformPrincipal, tenantId: string, dto: { confirmName: string; reason: string }, ip?: string) {
    const tenant = await this.db.system((tx) => tx.tenant.findUnique({ where: { id: tenantId }, include: { subscription: true } }));
    if (!tenant) throw AppException.notFound('Tenant');
    if (tenant.lifecycle !== 'ACTIVE') throw Err.invalidState(tenant.lifecycle, ['ACTIVE'], 'This tenant');
    if (dto.confirmName.trim() !== tenant.name.trim()) {
      throw appError(HttpStatus.BAD_REQUEST, 'CONFIRMATION_MISMATCH', 'Type the hotel name exactly as shown to confirm', { expected: tenant.name.length });
    }
    const now = new Date();
    const o = await this.db.system(async (tx) => {
      const row = await tx.tenantOffboarding.create({
        data: {
          tenantId, tenantName: tenant.name, tenantSlug: tenant.slug, status: 'EXPORTING', reason: dto.reason.trim(),
          previousStatus: tenant.subscription?.status ?? null, requestedById: p.platformUserId, requestedByName: p.fullName, requestedByEmail: p.email,
          deleteAfter: new Date(now.getTime() + this.graceDays() * 86_400_000),
        },
      });
      await tx.tenant.update({ where: { id: tenantId }, data: { lifecycle: 'OFFBOARDING' } });
      if (tenant.subscription) await tx.subscription.update({ where: { tenantId }, data: { status: 'SUSPENDED', suspendedAt: now } });
      return row;
    });
    await this.mirror.sync(tenantId);
    await this.listings.refreshTenant(tenantId).catch(() => undefined);
    await this.db.systemFor(tenantId, (tx) =>
      this.audit.record(tx, { tenantId, actor: { kind: 'platform', id: p.platformUserId, name: p.fullName }, action: 'tenant.offboarding_started', entityType: 'tenant', entityId: tenantId, propertyId: null, metadata: { reason: o.reason, deleteAfter: o.deleteAfter?.toISOString() }, ip }),
    );
    await this.platformAudit.record({ actor: p, action: 'tenant.offboarding_started', targetType: 'tenant', targetId: tenantId, tenantId, ip, metadata: { offboardingId: o.id, reason: o.reason } });
    const exp = await this.exports.request(tenantId, { kind: 'PLATFORM', id: p.platformUserId, fullName: p.fullName }, { reason: 'OFFBOARDING' }, ip);
    const withExport = await this.db.system((tx) => tx.tenantOffboarding.update({ where: { id: o.id }, data: { exportId: exp.id } }));
    void this.exports.wait(exp.id).then(() => this.advance()).catch(() => undefined);
    return this.withExport(withExport);
  }

  async cancel(p: PlatformPrincipal, id: string, reason: string, ip?: string) {
    const o = await this.db.system((tx) => tx.tenantOffboarding.findUnique({ where: { id } }));
    if (!o) throw AppException.notFound('Offboarding');
    if (!['EXPORTING', 'GRACE'].includes(o.status)) throw Err.invalidState(o.status, ['EXPORTING', 'GRACE'], 'This offboarding');
    const updated = await this.db.system(async (tx) => {
      const row = await tx.tenantOffboarding.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: p.platformUserId, cancelledByName: p.fullName } });
      await tx.tenant.update({ where: { id: o.tenantId }, data: { lifecycle: 'ACTIVE' } });
      const restore = (o.previousStatus ?? 'ACTIVE') as SubscriptionStatus;
      await tx.subscription.updateMany({ where: { tenantId: o.tenantId }, data: { status: restore, suspendedAt: restore === 'SUSPENDED' ? undefined : null } });
      return row;
    });
    await this.mirror.sync(o.tenantId);
    await this.listings.refreshTenant(o.tenantId).catch(() => undefined);
    await this.platformAudit.record({ actor: p, action: 'tenant.offboarding_cancelled', targetType: 'tenant', targetId: o.tenantId, tenantId: o.tenantId, ip, metadata: { offboardingId: id, reason } });
    await this.db.systemFor(o.tenantId, (tx) =>
      this.audit.record(tx, { tenantId: o.tenantId, actor: { kind: 'platform', id: p.platformUserId, name: p.fullName }, action: 'tenant.offboarding_cancelled', entityType: 'tenant', entityId: o.tenantId, propertyId: null, metadata: { reason }, ip }),
    ).catch(() => undefined);
    return this.withExport(updated);
  }

  /** Moves EXPORTING offboardings whose export is ready into the grace period. */
  async advance() {
    const exporting = await this.db.system((tx) => tx.tenantOffboarding.findMany({ where: { status: 'EXPORTING' } }));
    for (const o of exporting) {
      const e = o.exportId ? await this.db.system((tx) => tx.dataExport.findUnique({ where: { id: o.exportId! } })) : null;
      if (!e || !['READY', 'FAILED'].includes(e.status)) continue;
      await this.db.system((tx) => tx.tenantOffboarding.update({ where: { id: o.id }, data: { status: 'GRACE', ...(e.status === 'FAILED' && { error: `Export failed: ${e.error ?? ''}`.slice(0, 300) }) } }));
      await this.notifyOwner(o, e.status === 'READY').catch((err: Error) => this.logger.warn(`Offboarding notice failed: ${err.message}`));
    }
  }

  private async notifyOwner(o: TenantOffboarding, exportReady: boolean) {
    const owners = await this.db.systemFor(o.tenantId, (tx) => tx.user.findMany({ where: { tenantId: o.tenantId, role: 'OWNER', isActive: true }, select: { email: true } }));
    const rendered = renderTemplate(
      { appName: this.config.get('APP_NAME'), appDomain: this.config.get('APP_DOMAIN'), supportEmail: this.config.get('SUPPORT_EMAIL') },
      { template: 'OFFBOARDING_NOTICE', hotelName: o.tenantName, deleteAfterHuman: humanDate(lagosDate(o.deleteAfter ?? new Date())), exportReady },
    );
    await this.notifications.send(owners.map((u) => ({ tenantId: o.tenantId, template: 'OFFBOARDING_NOTICE' as const, channel: 'EMAIL' as const, audience: 'HOTEL' as const, to: u.email, subject: rendered.subject, text: rendered.text, html: rendered.html })));
  }

  /** Job (daily 04:30): grace over -> delete. */
  async runDue(now = new Date()) {
    await this.advance();
    const due = await this.db.system((tx) => tx.tenantOffboarding.findMany({ where: { status: 'GRACE', deleteAfter: { lte: now } } }));
    let deleted = 0;
    for (const o of due) {
      try {
        await this.purge(o.id);
        deleted++;
      } catch (e) {
        this.logger.error(`Offboarding ${o.id} failed: ${(e as Error).message}`);
      }
    }
    return { deleted };
  }

  async deleteNow(p: PlatformPrincipal, id: string, ip?: string) {
    const o = await this.db.system((tx) => tx.tenantOffboarding.findUnique({ where: { id } }));
    if (!o) throw AppException.notFound('Offboarding');
    if (o.status === 'EXPORTING') await this.advance();
    const fresh = await this.db.system((tx) => tx.tenantOffboarding.findUniqueOrThrow({ where: { id } }));
    if (fresh.status !== 'GRACE') throw Err.invalidState(fresh.status, ['GRACE'], 'This offboarding');
    if (this.config.isProduction && fresh.deleteAfter && fresh.deleteAfter > new Date()) {
      throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'The 30-day grace period has not ended', { status: 'GRACE', deleteAfter: fresh.deleteAfter.toISOString() });
    }
    await this.platformAudit.record({ actor: p, action: 'tenant.delete_now', targetType: 'tenant', targetId: o.tenantId, tenantId: o.tenantId, ip, metadata: { offboardingId: id } });
    await this.purge(id);
    return this.withExport(await this.db.system((tx) => tx.tenantOffboarding.findUniqueOrThrow({ where: { id } })));
  }

  /** Deletes every record of the tenant. */
  private async purge(id: string) {
    const o = await this.db.system((tx) => tx.tenantOffboarding.update({ where: { id }, data: { status: 'DELETING' } }));
    const tenantId = o.tenantId;
    let rows = 0;
    let tables = 0;
    try {
      // 1. Dedicated database: dropped whole.
      const reg = await this.db.system((tx) => tx.tenantDatabase.findUnique({ where: { tenantId } }));
      if (reg?.mode === 'DEDICATED' && reg.dbName) {
        const urls = this.router.urlsOf(reg);
        await this.db.system((tx) => tx.tenantDatabase.update({ where: { tenantId }, data: { status: 'DELETED', mode: 'SHARED' } }));
        await this.router.announce();
        await this.router.release(reg.dbName);
        if (reg.createdByUs) await dropDatabase(this.config.get('DATABASE_ADMIN_URL') ?? this.config.get('DATABASE_MIGRATION_URL') ?? urls.admin, reg.dbName);
        tables++;
      }
      // 2. Shared database: tenant data, then its control-plane rows.
      const c = await connect(this.config.get('DATABASE_PLATFORM_URL'));
      try {
        const data = await tenantTables(c);
        await c.query('BEGIN');
        await c.query('SELECT app_begin_tenant_purge($1::uuid)', [tenantId]);
        rows += await purgeTenantRows(c, data, tenantId);
        for (const t of CONTROL_PURGE) {
          const r = await c.query(`DELETE FROM "${t}" WHERE tenant_id = $1`, [tenantId]);
          rows += r.rowCount ?? 0;
        }
        tables += data.length + CONTROL_PURGE.length;
        await c.query(`UPDATE tenants SET lifecycle = 'DELETED', deleted_at = now(), slug = $2 WHERE id = $1`, [tenantId, `deleted-${tenantId.slice(0, 8)}`]);
        await c.query(`UPDATE subscriptions SET status = 'CANCELLED', cancelled_at = COALESCE(cancelled_at, now()) WHERE tenant_id = $1`, [tenantId]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        await c.end();
      }
      // 3. Files (ID images, photos, attachments, exports).
      await this.storage.deletePrefix(`tenants/${tenantId}/`).catch((e: Error) => this.logger.warn(`File purge for ${tenantId}: ${e.message}`));
      await this.db.system((tx) => tx.tenantOffboarding.update({ where: { id }, data: { status: 'DELETED', deletedAt: new Date(), summary: { tables, rowsDeleted: rows } } }));
      await this.platformAudit.record({ actor: null, action: 'tenant.deleted', targetType: 'tenant', targetId: tenantId, tenantId, metadata: { offboardingId: id, tables, rowsDeleted: rows, name: o.tenantName } });
    } catch (e) {
      const message = (e as Error).message.slice(0, 500);
      await this.db.system((tx) => tx.tenantOffboarding.update({ where: { id }, data: { status: 'FAILED', error: message } }));
      throw e;
    }
  }
}
