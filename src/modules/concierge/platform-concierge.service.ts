import { Injectable } from '@nestjs/common';
import type { ConciergeService as ServiceRow, Prisma } from '../../generated/prisma/client.js';
import type { PlatformPrincipal } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, platformActor } from '../audit/audit.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { paginate } from '../ops/ops.helpers.js';
import { ConciergeNotifier } from './concierge-notifier.service.js';
import { questionsOf, variantsOf } from './concierge.service.js';

type ServiceWithProperty = ServiceRow & { property: { id: string; name: string; slug: string } };
type Status = 'PENDING_REVIEW' | 'REJECTED' | 'HIDDEN' | 'LIVE';

/**
 * Platform console (M8): the review queue of hotel concierge services (across
 * the shared and every dedicated database) and per-tenant concierge
 * suspension. The console sees services, never the contents of guest
 * requests (counts only).
 */
@Injectable()
export class PlatformConciergeService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly notifier: ConciergeNotifier,
  ) {}

  private async tenantsById(ids: string[]) {
    if (!ids.length) return new Map<string, { id: string; name: string; slug: string; planCode: string | null }>();
    const rows = await this.db.system((tx) => tx.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, slug: true, subscription: { select: { plan: { select: { code: true } } } } } }));
    return new Map(rows.map((t) => [t.id, { id: t.id, name: t.name, slug: t.slug, planCode: t.subscription?.plan.code ?? null }]));
  }

  private async suspendedTenants(ids: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const rows of await this.db.systemAll((tx, t) => tx.conciergeAccount.findMany({ where: { ...t.tenants, tenantId: { in: ids }, suspendedAt: { not: null } }, select: { tenantId: true } }))) {
      for (const r of rows) out.add(r.tenantId);
    }
    return out;
  }

  private item(s: ServiceWithProperty, tenant: { id: string; name: string; slug: string } | undefined, suspended: boolean) {
    const questions = questionsOf(s.questions);
    return {
      serviceId: s.id,
      tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : { id: s.tenantId, name: '', slug: '' },
      property: s.property,
      name: s.name,
      description: s.description,
      category: s.category,
      pricing: s.pricing,
      priceKobo: s.priceKobo,
      variants: variantsOf(s.variants).map((v) => v.name),
      questions: questions.flatMap((q) => [q.label, ...q.options.map((o) => `${q.label}: ${o.label}`)]),
      flaggedTerms: s.flaggedTerms,
      matches: Array.isArray(s.flagMatches) ? (s.flagMatches as { term: string; category: string; excerpt: string }[]) : [],
      reviewStatus: s.reviewStatus,
      submittedAt: s.submittedAt?.toISOString() ?? null,
      reviewedAt: s.reviewedAt?.toISOString() ?? null,
      reviewedBy: s.reviewedByName,
      reason: s.reviewReason,
      active: s.active,
      tenantSuspended: suspended,
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  async reviews(q: { status?: Status; tenantId?: string; q?: string; page?: number; pageSize?: number }) {
    const status = q.status ?? 'PENDING_REVIEW';
    const term = q.q?.trim();
    const where = (t: { tenants: Prisma.ConciergeServiceWhereInput }): Prisma.ConciergeServiceWhereInput => ({
      ...t.tenants,
      reviewStatus: status,
      ...(q.tenantId && { tenantId: q.tenantId }),
      ...(term && { OR: [{ name: { contains: term, mode: 'insensitive' } }, { description: { contains: term, mode: 'insensitive' } }] }),
    });
    const rows = (await this.db.systemAll((tx, t) => tx.conciergeService.findMany({ where: where(t as { tenants: Prisma.ConciergeServiceWhereInput }), include: { property: { select: { id: true, name: true, slug: true } } } }))).flat();
    rows.sort((a, b) => (status === 'PENDING_REVIEW' ? (a.submittedAt ?? a.updatedAt).getTime() - (b.submittedAt ?? b.updatedAt).getTime() : b.updatedAt.getTime() - a.updatedAt.getTime()));
    const { page, pageSize, skip, take } = paginate(q.page, q.pageSize);
    const slice = rows.slice(skip, skip + take);
    const tenants = await this.tenantsById([...new Set(slice.map((s) => s.tenantId))]);
    const suspended = await this.suspendedTenants([...new Set(slice.map((s) => s.tenantId))]);
    const counts = { pending: 0, rejected: 0, hidden: 0 };
    for (const list of await this.db.systemAll((tx, t) => tx.conciergeService.groupBy({ by: ['reviewStatus'], where: { ...(t.tenants as Prisma.ConciergeServiceWhereInput), reviewStatus: { in: ['PENDING_REVIEW', 'REJECTED', 'HIDDEN'] } }, _count: { _all: true } }))) {
      for (const g of list) {
        if (g.reviewStatus === 'PENDING_REVIEW') counts.pending += g._count._all;
        if (g.reviewStatus === 'REJECTED') counts.rejected += g._count._all;
        if (g.reviewStatus === 'HIDDEN') counts.hidden += g._count._all;
      }
    }
    return { items: slice.map((s) => this.item(s, tenants.get(s.tenantId), suspended.has(s.tenantId))), total: rows.length, page, pageSize, counts };
  }

  private async decide(p: PlatformPrincipal, tenantId: string, serviceId: string, to: Status, reason: string | null, ip?: string) {
    const s = await this.db.systemFor(tenantId, async (tx) => {
      const cur = await tx.conciergeService.findFirst({ where: { id: serviceId, tenantId } });
      if (!cur) throw AppException.notFound('Service');
      const now = new Date();
      const row = await tx.conciergeService.update({
        where: { id: serviceId },
        data: { reviewStatus: to, reviewReason: reason, reviewedAt: now, reviewedByName: `${p.fullName} (platform)` },
        include: { property: { select: { id: true, name: true, slug: true } } },
      });
      const action = to === 'LIVE' ? 'approved' : to === 'REJECTED' ? 'rejected' : 'hidden';
      await this.audit.record(tx, { tenantId, actor: platformActor(p), action: `concierge_service.${action}`, entityType: 'concierge_service', entityId: serviceId, propertyId: row.propertyId, metadata: { name: row.name, from: cur.reviewStatus, to, reason }, ip });
      return row;
    });
    const tenants = await this.tenantsById([tenantId]);
    return this.item(s, tenants.get(tenantId), (await this.suspendedTenants([tenantId])).has(tenantId));
  }

  approve(p: PlatformPrincipal, tenantId: string, serviceId: string, note: string | undefined, ip?: string) {
    return this.decide(p, tenantId, serviceId, 'LIVE', note?.trim() || null, ip);
  }

  reject(p: PlatformPrincipal, tenantId: string, serviceId: string, reason: string, ip?: string) {
    return this.decide(p, tenantId, serviceId, 'REJECTED', reason.trim(), ip);
  }

  hide(p: PlatformPrincipal, tenantId: string, serviceId: string, reason: string, ip?: string) {
    return this.decide(p, tenantId, serviceId, 'HIDDEN', reason.trim(), ip);
  }

  // ---------------------------------------------------------------------------
  // Tenants
  // ---------------------------------------------------------------------------

  private async rowsFor(tenantIds: string[] | null) {
    const since = new Date(Date.now() - 30 * 86_400_000);
    type Acc = { aupAcceptedAt: Date | null; aupVersion: string | null; suspendedAt: Date | null; suspendedReason: string | null; suspendedByName: string | null };
    const accounts = new Map<string, Acc>();
    const services = new Map<string, { live: number; pending: number; rejected: number; hidden: number }>();
    const enabled = new Map<string, number>();
    const requests = new Map<string, { all: number; flagged: number }>();
    await this.db.systemAll(async (tx: Tx, t) => {
      const scoped = <W extends object>(w: W) => ({ ...w, ...t.tenants, ...(tenantIds && { AND: [{ tenantId: { in: tenantIds } }] }) });
      for (const a of await tx.conciergeAccount.findMany({ where: scoped({}) as Prisma.ConciergeAccountWhereInput })) accounts.set(a.tenantId, a);
      for (const g of await tx.conciergeService.groupBy({ by: ['tenantId', 'reviewStatus'], where: scoped({}) as Prisma.ConciergeServiceWhereInput, _count: { _all: true } })) {
        const c = services.get(g.tenantId) ?? { live: 0, pending: 0, rejected: 0, hidden: 0 };
        if (g.reviewStatus === 'LIVE') c.live += g._count._all;
        if (g.reviewStatus === 'PENDING_REVIEW') c.pending += g._count._all;
        if (g.reviewStatus === 'REJECTED') c.rejected += g._count._all;
        if (g.reviewStatus === 'HIDDEN') c.hidden += g._count._all;
        services.set(g.tenantId, c);
      }
      for (const g of await tx.conciergeSettings.groupBy({ by: ['tenantId'], where: scoped({ enabled: true }) as Prisma.ConciergeSettingsWhereInput, _count: { _all: true } })) enabled.set(g.tenantId, g._count._all);
      for (const g of await tx.conciergeRequest.groupBy({ by: ['tenantId', 'flagged'], where: scoped({ createdAt: { gte: since } }) as Prisma.ConciergeRequestWhereInput, _count: { _all: true } })) {
        const c = requests.get(g.tenantId) ?? { all: 0, flagged: 0 };
        c.all += g._count._all;
        if (g.flagged) c.flagged += g._count._all;
        requests.set(g.tenantId, c);
      }
    });
    const ids = [...new Set([...accounts.keys(), ...services.keys()])];
    const tenants = await this.tenantsById(ids);
    const features = await this.db.system((tx) =>
      tx.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, subscription: { select: { plan: { select: { features: { where: { featureCode: 'concierge' }, select: { featureCode: true } } } } } }, featureOverrides: { where: { featureCode: 'concierge' }, select: { enabled: true } } } }),
    );
    const feat = new Map(features.map((f) => [f.id, f.featureOverrides[0] ? f.featureOverrides[0].enabled : !!f.subscription?.plan.features.length]));
    return ids
      .filter((id) => tenants.has(id))
      .map((id) => {
        const a = accounts.get(id);
        return {
          tenant: tenants.get(id)!,
          feature: feat.get(id) ?? false,
          aupAcceptedAt: a?.aupAcceptedAt?.toISOString() ?? null,
          aupVersion: a?.aupVersion ?? null,
          enabledProperties: enabled.get(id) ?? 0,
          services: services.get(id) ?? { live: 0, pending: 0, rejected: 0, hidden: 0 },
          requests30d: requests.get(id)?.all ?? 0,
          flaggedRequests30d: requests.get(id)?.flagged ?? 0,
          suspended: a?.suspendedAt ? { since: a.suspendedAt.toISOString(), reason: a.suspendedReason ?? '', by: a.suspendedByName ?? '' } : null,
        };
      })
      .sort((x, y) => x.tenant.name.localeCompare(y.tenant.name));
  }

  async tenants(q: { suspended?: boolean; q?: string; page?: number; pageSize?: number }) {
    let rows = await this.rowsFor(null);
    if (q.suspended !== undefined) rows = rows.filter((r) => !!r.suspended === q.suspended);
    const term = q.q?.trim().toLowerCase();
    if (term) rows = rows.filter((r) => r.tenant.name.toLowerCase().includes(term) || r.tenant.slug.includes(term));
    const { page, pageSize, skip, take } = paginate(q.page, q.pageSize);
    return { items: rows.slice(skip, skip + take), total: rows.length, page, pageSize };
  }

  async tenant(tenantId: string) {
    const [row] = await this.rowsFor([tenantId]);
    const t = row ?? (await this.emptyRow(tenantId));
    const services = await this.db.systemFor(tenantId, (tx) => tx.conciergeService.findMany({ where: { tenantId }, include: { property: { select: { id: true, name: true, slug: true } } }, orderBy: [{ reviewStatus: 'asc' }, { name: 'asc' }] }));
    return { ...t, services: services.map((s) => this.item(s, t.tenant, !!t.suspended)) };
  }

  private async emptyRow(tenantId: string) {
    const tenant = (await this.tenantsById([tenantId])).get(tenantId);
    if (!tenant) throw AppException.notFound('Tenant');
    return { tenant, feature: false, aupAcceptedAt: null, aupVersion: null, enabledProperties: 0, services: { live: 0, pending: 0, rejected: 0, hidden: 0 }, requests30d: 0, flaggedRequests30d: 0, suspended: null };
  }

  async suspend(p: PlatformPrincipal, tenantId: string, reason: string, ip?: string) {
    const tenant = (await this.tenantsById([tenantId])).get(tenantId);
    if (!tenant) throw AppException.notFound('Tenant');
    const ids = await this.db.systemFor(tenantId, async (tx) => {
      const now = new Date();
      await tx.conciergeAccount.upsert({
        where: { tenantId },
        create: { tenantId, suspendedAt: now, suspendedReason: reason.trim(), suspendedByName: p.fullName },
        update: { suspendedAt: now, suspendedReason: reason.trim(), suspendedByName: p.fullName, reinstatedAt: null, reinstatedByName: null },
      });
      await this.audit.record(tx, { tenantId, actor: platformActor(p), action: 'concierge.suspended', entityType: 'concierge', entityId: null, propertyId: null, metadata: { reason: reason.trim() }, ip });
      const owners = await tx.user.findMany({ where: { tenantId, isActive: true, role: 'OWNER' }, select: { email: true } });
      const property = await tx.property.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
      if (!property) return [];
      return this.notifications.queueTx(tx, owners.map((o) => this.notifier.hotelEmail(tenantId, property, { template: 'CONCIERGE_SUSPENDED', hotelName: tenant.name, reason: reason.trim() }, o.email)));
    });
    await this.notifications.dispatch(ids);
    return this.tenant(tenantId);
  }

  async reinstate(p: PlatformPrincipal, tenantId: string, note: string | undefined, ip?: string) {
    await this.db.systemFor(tenantId, async (tx) => {
      const a = await tx.conciergeAccount.findUnique({ where: { tenantId } });
      if (!a?.suspendedAt) return;
      await tx.conciergeAccount.update({ where: { tenantId }, data: { suspendedAt: null, suspendedReason: null, suspendedByName: null, reinstatedAt: new Date(), reinstatedByName: p.fullName } });
      await this.audit.record(tx, { tenantId, actor: platformActor(p), action: 'concierge.reinstated', entityType: 'concierge', entityId: null, propertyId: null, metadata: { note: note ?? null }, ip });
    });
    return this.tenant(tenantId);
  }
}
