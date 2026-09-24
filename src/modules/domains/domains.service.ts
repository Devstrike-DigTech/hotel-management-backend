import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { CustomDomain } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, SYSTEM_ACTOR, userActor, type AuditActor } from '../audit/audit.service.js';
import { OPS_JOBS } from '../jobs/jobs.constants.js';
import { ProJobsService } from '../jobs/pro-jobs.service.js';
import { appError, Err, primaryProperty } from '../ops/ops.helpers.js';
import { DNS_RESOLVER, MockDnsResolver, type DnsResolver } from './dns.js';
import { domainProblem, expectedRecords, PENDING_GIVE_UP_MS, readCheck, VERIFIED_GRACE_MS, VERIFIED_RECHECK_MS, verifyPrefix } from './domains.logic.js';

/**
 * M5 custom domains (feature `custom_domain`): a property's booking site on
 * the hotel's own subdomain, proven with a TXT record and pointed with a
 * CNAME. Verified domains resolve through `/public/resolve-host`.
 */
@Injectable()
export class DomainsService {
  private readonly logger = new Logger(DomainsService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
  ) {
    ProJobsService.register(OPS_JOBS.domainChecks.name, DomainsService);
  }

  private get prefix() {
    return verifyPrefix(this.config.get('APP_NAME'));
  }

  private get target() {
    return (this.config.get('CUSTOM_DOMAIN_TARGET') ?? `sites.${this.config.get('APP_DOMAIN')}`).toLowerCase();
  }

  private records(d: CustomDomain) {
    return expectedRecords(d.domain, d.token, this.prefix, this.target);
  }

  view(d: CustomDomain) {
    const e = this.records(d);
    return {
      id: d.id,
      propertyId: d.propertyId,
      domain: d.domain,
      /** M6: PROPERTY (booking site of one property) or GROUP (group root). */
      scope: d.scope as 'PROPERTY' | 'GROUP',
      status: d.status,
      records: [
        { ...e.txt, ok: d.txtOk },
        { ...e.cname, ok: d.cnameOk },
      ],
      failures: d.failures,
      lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null,
      verifiedAt: d.verifiedAt?.toISOString() ?? null,
      checkCount: d.checkCount,
      createdAt: d.createdAt.toISOString(),
    };
  }

  /** Tenant transaction without the property filter (lookups by id; group-root domains). */
  private anyProperty<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.tenant(tenantId, (tx) => this.db.withAllProperties(tenantId, () => fn(tx)));
  }

  get(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const d = await tx.customDomain.findFirst({ where: { propertyId: p.id, scope: 'PROPERTY' }, orderBy: { createdAt: 'desc' } });
      const g = await this.db.withAllProperties(user.tenantId, () => tx.customDomain.findFirst({ where: { tenantId: user.tenantId, scope: 'GROUP' } }));
      const subdomain = `${p.slug}.${this.config.get('APP_DOMAIN')}`;
      return {
        domain: d ? this.view(d) : null,
        subdomain,
        canonicalHost: p.customDomain && p.customDomainVerifiedAt ? p.customDomain : subdomain,
        // M6: the group root's own domain (all properties of the group).
        groupDomain: g ? this.view(g) : null,
      };
    });
  }

  /** Stops a property's custom domain resolving (removed, replaced or failed). */
  private async unpublish(tx: Tx, propertyId: string) {
    await tx.property.update({ where: { id: propertyId }, data: { customDomain: null, customDomainVerifiedAt: null } });
  }

  async create(user: AuthUser, input: string, ip?: string, scope: 'PROPERTY' | 'GROUP' = 'PROPERTY') {
    const { domain, problem } = domainProblem(input);
    if (problem === 'INVALID' || !domain) throw Err.validation('domain', 'Enter a domain such as book.yourhotel.com');
    if (problem === 'APEX') throw appError(HttpStatus.BAD_REQUEST, 'DOMAIN_APEX_NOT_SUPPORTED', `Use a subdomain such as book.${domain}; a bare domain cannot point to the booking site`);
    const appDomain = this.config.get('APP_DOMAIN').toLowerCase();
    if (domain === appDomain || domain.endsWith(`.${appDomain}`)) throw Err.validation('domain', `Your ${appDomain} address is already set up; enter your own domain`);
    // M6: a domain is unique across the shared and every dedicated database
    // (and staff portal domains).
    const found = await this.db.systemAll(async (tx, t) => {
      const d = await tx.customDomain.findFirst({ where: { ...t.tenants, domain }, select: { tenantId: true, propertyId: true } });
      const p = await tx.property.findFirst({ where: { ...t.tenants, customDomain: domain }, select: { id: true } });
      return { d, p };
    });
    const taken = { d: found.find((f) => f.d)?.d ?? null, p: found.find((f) => f.p)?.p ?? null };
    const portal = await this.db.system((tx) => tx.staffPortalDomain.findUnique({ where: { domain }, select: { tenantId: true } }));
    if (portal) throw appError(HttpStatus.CONFLICT, 'DOMAIN_TAKEN', 'That domain is already connected to another hotel');
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      if ((taken.d && taken.d.propertyId !== p.id) || (taken.p && taken.p.id !== p.id)) throw appError(HttpStatus.CONFLICT, 'DOMAIN_TAKEN', 'That domain is already connected to another hotel');
      const old = scope === 'GROUP'
        ? await this.db.withAllProperties(user.tenantId, () => tx.customDomain.findMany({ where: { tenantId: user.tenantId, scope: 'GROUP' } }))
        : await tx.customDomain.findMany({ where: { propertyId: p.id, scope: 'PROPERTY' } });
      if (old.length) {
        await this.db.withAllProperties(user.tenantId, () => tx.customDomain.deleteMany({ where: { id: { in: old.map((o) => o.id) } } }));
        if (scope === 'PROPERTY') await this.unpublish(tx, p.id);
      }
      const d = await tx.customDomain.create({ data: { tenantId: user.tenantId, propertyId: p.id, domain, scope, token: randomBytes(16).toString('hex') } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'domain.added', entityType: 'custom_domain', entityId: d.id, metadata: { domain, scope, replaced: old.map((o) => o.domain) }, ip });
      return this.view(d);
    });
  }

  remove(user: AuthUser, id: string, ip?: string) {
    return this.anyProperty(user.tenantId, async (tx) => {
      const d = await tx.customDomain.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!d) throw AppException.notFound('Domain');
      await tx.customDomain.delete({ where: { id } });
      const p = await tx.property.findFirstOrThrow({ where: { id: d.propertyId } });
      if (p.customDomain === d.domain) await this.unpublish(tx, p.id);
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'domain.removed', entityType: 'custom_domain', entityId: id, metadata: { domain: d.domain }, ip });
      return { success: true };
    });
  }

  private async lookup(d: CustomDomain) {
    const e = this.records(d);
    try {
      const [txt, cname] = await Promise.all([this.dns.txt(e.txt.name), this.dns.cname(e.cname.name)]);
      return { txt, cname };
    } catch (err) {
      this.logger.warn(`DNS check for ${d.domain} failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Checks DNS and moves the domain between PENDING, VERIFIED and FAILED. */
  private async check(tenantId: string, id: string, actor: AuditActor, now = new Date()) {
    const d0 = await this.anyProperty(tenantId, (tx) => tx.customDomain.findFirst({ where: { id, tenantId } }));
    if (!d0) throw AppException.notFound('Domain');
    const found = await this.lookup(d0);
    const r = readCheck(this.records(d0), found);
    return this.anyProperty(tenantId, async (tx) => {
      const d = await tx.customDomain.findFirst({ where: { id } });
      if (!d) throw AppException.notFound('Domain');
      const ok = r.failures.length === 0;
      let status = d.status;
      let failingSince = d.failingSince;
      let verifiedAt = d.verifiedAt;
      if (ok) {
        status = 'VERIFIED';
        failingSince = null;
        verifiedAt = d.status === 'VERIFIED' ? d.verifiedAt : now;
      } else if (d.status === 'VERIFIED') {
        failingSince = d.failingSince ?? now;
        if (now.getTime() - failingSince.getTime() >= VERIFIED_GRACE_MS) status = 'FAILED';
      } else if (d.status === 'PENDING' && now.getTime() - d.createdAt.getTime() >= PENDING_GIVE_UP_MS) {
        status = 'FAILED';
      }
      const u = await tx.customDomain.update({
        where: { id },
        data: { status, failingSince, verifiedAt, txtOk: r.txtOk, cnameOk: r.cnameOk, failures: r.failures, lastCheckedAt: now, checkCount: { increment: 1 } },
      });
      if (status === 'VERIFIED' && d.status !== 'VERIFIED') {
        if (d.scope === 'PROPERTY') await tx.property.update({ where: { id: d.propertyId }, data: { customDomain: d.domain, customDomainVerifiedAt: now } });
        await this.audit.record(tx, { tenantId, propertyId: d.propertyId, actor, action: 'domain.verified', entityType: 'custom_domain', entityId: id, metadata: { domain: d.domain } });
      } else if (status === 'FAILED' && d.status !== 'FAILED') {
        const p = await tx.property.findFirstOrThrow({ where: { id: d.propertyId } });
        if (p.customDomain === d.domain) await this.unpublish(tx, p.id);
        await this.audit.record(tx, { tenantId, propertyId: d.propertyId, actor, action: 'domain.failed', entityType: 'custom_domain', entityId: id, metadata: { domain: d.domain, failures: r.failures } });
      }
      return this.view(u);
    });
  }

  verify(user: AuthUser, id: string) {
    return this.check(user.tenantId, id, userActor(user));
  }

  /** Job: PENDING domains every 10 minutes, VERIFIED ones daily. */
  async runScheduled() {
    const now = new Date();
    const due = (await this.db.systemAll((tx, t) =>
      tx.customDomain.findMany({
        // The mock DNS lives in memory: in development only PENDING domains are re-checked, so seeded
        // VERIFIED domains keep working across restarts.
        where: {
          ...t.tenants,
          ...(this.dns.kind === 'mock'
            ? { status: 'PENDING' as const }
            : { OR: [{ status: 'PENDING' as const }, { status: 'VERIFIED' as const, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: new Date(now.getTime() - VERIFIED_RECHECK_MS) } }, { failingSince: { not: null } }] }] }),
        },
        select: { id: true, tenantId: true },
      }),
    )).flat();
    let verified = 0;
    for (const d of due) {
      try {
        const v = await this.check(d.tenantId, d.id, SYSTEM_ACTOR, now);
        if (v.status === 'VERIFIED') verified++;
      } catch (e) {
        this.logger.error(`Domain check ${d.id} failed: ${(e as Error).message}`);
      }
    }
    return { checked: due.length, verified };
  }

  // Development helpers (mock DNS) ------------------------------------------------

  private assertMock() {
    if (this.config.get('NODE_ENV') === 'production' || this.dns.kind !== 'mock') throw AppException.notFound('Route');
  }

  devDns(dto: { name: string; type: 'TXT' | 'CNAME'; value: string }) {
    this.assertMock();
    MockDnsResolver.set(dto.name, dto.type, dto.value);
    return { success: true };
  }

  async devPublish(user: AuthUser, id: string) {
    this.assertMock();
    const d = await this.anyProperty(user.tenantId, (tx) => tx.customDomain.findFirst({ where: { id, tenantId: user.tenantId } }));
    if (!d) throw AppException.notFound('Domain');
    const e = this.records(d);
    MockDnsResolver.set(e.txt.name, 'TXT', e.txt.value);
    MockDnsResolver.set(e.cname.name, 'CNAME', e.cname.value);
    return { success: true };
  }
}
