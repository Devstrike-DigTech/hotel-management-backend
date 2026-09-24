import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { EmailDomain, Prisma, SmsSenderRequest, StaffPortalDomain, WhiteLabelSetting } from '../../../generated/prisma/client.js';
import type { AuthUser, PlatformPrincipal } from '../../../common/auth-types.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { DbService } from '../../../prisma/db.service.js';
import { AuditService, platformActor, userActor } from '../../audit/audit.service.js';
import { MockDnsResolver, SystemDnsResolver, type DnsResolver } from '../../domains/dns.js';
import { domainProblem, expectedRecords, readCheck, verifyPrefix } from '../../domains/domains.logic.js';
import { EntitlementsService } from '../../entitlements/entitlements.service.js';
import { appError, Err } from '../../ops/ops.helpers.js';
import { PlatformJobsService } from '../../platform/console/platform-jobs.service.js';
import { BrandingRegistry } from './branding.registry.js';
import { COLOR_RE, FONTS, fontByName, isHttpsUrl, mockEmailRecords, validSenderId } from './white-label.logic.js';

type EmailRecord = ReturnType<typeof mockEmailRecords>[number] | { purpose: string; type: string; name: string; value: string; priority: number | null; ttl: string; status: string };

export interface WhiteLabelInput {
  enabled?: boolean;
  brandName?: string | null;
  logoUrl?: string | null;
  faviconUrl?: string | null;
  primaryColor?: string | null;
  accentColor?: string | null;
  headingFont?: string | null;
  bodyFont?: string | null;
  footerLinks?: { label: string; url: string }[];
  hidePoweredBy?: boolean;
  emailFromName?: string | null;
}

/**
 * White-label (M6, feature `white_label`): brand kit for the booking site on
 * the hotel's own domain, a verified email sending domain (Resend, or a mock
 * in development), an SMS sender ID request (Termii or mock) and the staff
 * portal on the hotel's own domain.
 */
@Injectable()
export class WhiteLabelService {
  private readonly logger = new Logger(WhiteLabelService.name);
  private readonly dns: DnsResolver;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly brands: BrandingRegistry,
    private readonly entitlements: EntitlementsService,
  ) {
    const kind = config.get('DNS_PROVIDER') ?? (config.get('NODE_ENV') === 'production' ? 'system' : 'mock');
    this.dns = kind === 'system' ? new SystemDnsResolver() : new MockDnsResolver();
    PlatformJobsService.register('white-label-checks', async (refs) => refs.get(WhiteLabelService, { strict: false }).runChecks());
  }

  private get resendKey() {
    return this.config.get('RESEND_API_KEY');
  }

  private get dev() {
    return this.config.get('NODE_ENV') !== 'production';
  }

  fonts() {
    return FONTS;
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  private async state(tenantId: string) {
    return this.db.control(tenantId, async (tx) => ({
      s: await tx.whiteLabelSetting.findUnique({ where: { tenantId } }),
      email: await tx.emailDomain.findUnique({ where: { tenantId } }),
      sms: await tx.smsSenderRequest.findFirst({ where: { tenantId, current: true }, orderBy: { requestedAt: 'desc' } }),
      portal: await tx.staffPortalDomain.findUnique({ where: { tenantId } }),
    }));
  }

  private async customDomainVerified(tenantId: string): Promise<boolean> {
    const n = await this.db.tenant(tenantId, (tx) =>
      this.db.withAllProperties(tenantId, () => tx.property.count({ where: { tenantId, customDomain: { not: null }, customDomainVerifiedAt: { not: null } } })),
    );
    return n > 0;
  }

  private settingsView(s: WhiteLabelSetting | null, email: EmailDomain | null, feature: boolean, domainVerified: boolean) {
    const enabled = !!s?.enabled;
    return {
      enabled,
      brandName: s?.brandName ?? null,
      logoUrl: s?.logoUrl ?? null,
      faviconUrl: s?.faviconUrl ?? null,
      primaryColor: s?.primaryColor ?? null,
      accentColor: s?.accentColor ?? null,
      headingFont: s?.headingFont ?? null,
      bodyFont: s?.bodyFont ?? null,
      footerLinks: ((s?.footerLinks as { label: string; url: string }[] | undefined) ?? []),
      hidePoweredBy: s?.hidePoweredBy ?? true,
      emailFromName: s?.emailFromName ?? null,
      requirements: { customDomainVerified: domainVerified, emailDomainVerified: email?.status === 'VERIFIED' },
      active: enabled && feature && domainVerified,
    };
  }

  emailView(d: EmailDomain) {
    return {
      id: d.id,
      domain: d.domain,
      fromLocalPart: d.fromLocalPart,
      fromAddress: `${d.fromLocalPart}@${d.domain}`,
      status: d.status,
      provider: d.provider as 'resend' | 'mock',
      records: (d.records as unknown as EmailRecord[]) ?? [],
      lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null,
      verifiedAt: d.verifiedAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
    };
  }

  smsView(r: SmsSenderRequest) {
    return {
      id: r.id,
      senderId: r.senderId,
      useCase: r.useCase,
      status: r.status as 'REQUESTED' | 'PENDING' | 'APPROVED' | 'REJECTED',
      note: r.note,
      requestedAt: r.requestedAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      provider: r.provider as 'termii' | 'mock',
    };
  }

  private portalTarget() {
    return (this.config.get('STAFF_PORTAL_TARGET') ?? `portal.${this.config.get('APP_DOMAIN')}`).toLowerCase();
  }

  private portalRecords(d: StaffPortalDomain) {
    return expectedRecords(d.domain, d.token, verifyPrefix(this.config.get('APP_NAME')), this.portalTarget());
  }

  portalView(d: StaffPortalDomain) {
    const e = this.portalRecords(d);
    return {
      id: d.id,
      domain: d.domain,
      status: d.status as 'PENDING' | 'VERIFIED' | 'FAILED',
      records: [
        { ...e.txt, ok: d.txtOk },
        { ...e.cname, ok: d.cnameOk },
      ],
      failures: d.failures,
      lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null,
      verifiedAt: d.verifiedAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
    };
  }

  async get(u: AuthUser) {
    const { s, email, sms, portal } = await this.state(u.tenantId);
    const ent = await this.entitlements.getEntitlements(u.tenantId);
    return {
      ...this.settingsView(s, email, ent.features.includes('white_label'), await this.customDomainVerified(u.tenantId)),
      emailDomain: email ? this.emailView(email) : null,
      smsSender: sms ? this.smsView(sms) : null,
      staffPortal: portal ? this.portalView(portal) : null,
    };
  }

  async put(u: AuthUser, dto: WhiteLabelInput, ip?: string) {
    for (const k of ['primaryColor', 'accentColor'] as const) {
      const v = dto[k];
      if (v && !COLOR_RE.test(v)) throw Err.validation(k, 'Use a colour like #1A2B3C');
    }
    for (const k of ['headingFont', 'bodyFont'] as const) {
      const v = dto[k];
      if (v && !fontByName(v)) throw Err.validation(k, 'Choose one of the listed fonts');
    }
    for (const k of ['logoUrl', 'faviconUrl'] as const) {
      const v = dto[k];
      if (v && !isHttpsUrl(v)) throw Err.validation(k, 'Use an https:// URL');
    }
    if (dto.footerLinks) {
      if (dto.footerLinks.length > 8) throw Err.validation('footerLinks', 'At most 8 links');
      if (dto.footerLinks.some((l) => !isHttpsUrl(l.url) && !l.url.startsWith('mailto:'))) throw Err.validation('footerLinks', 'Links must be https:// or mailto: URLs');
    }
    const data = {
      ...(dto.enabled !== undefined && { enabled: dto.enabled }),
      ...(dto.brandName !== undefined && { brandName: dto.brandName?.trim() || null }),
      ...(dto.logoUrl !== undefined && { logoUrl: dto.logoUrl }),
      ...(dto.faviconUrl !== undefined && { faviconUrl: dto.faviconUrl }),
      ...(dto.primaryColor !== undefined && { primaryColor: dto.primaryColor?.toUpperCase() ?? null }),
      ...(dto.accentColor !== undefined && { accentColor: dto.accentColor?.toUpperCase() ?? null }),
      ...(dto.headingFont !== undefined && { headingFont: fontByName(dto.headingFont)?.family ?? null }),
      ...(dto.bodyFont !== undefined && { bodyFont: fontByName(dto.bodyFont)?.family ?? null }),
      ...(dto.footerLinks !== undefined && { footerLinks: dto.footerLinks as unknown as Prisma.InputJsonValue }),
      ...(dto.hidePoweredBy !== undefined && { hidePoweredBy: dto.hidePoweredBy }),
      ...(dto.emailFromName !== undefined && { emailFromName: dto.emailFromName?.trim() || null }),
    };
    await this.db.control(u.tenantId, async (tx) => {
      await tx.whiteLabelSetting.upsert({ where: { tenantId: u.tenantId }, create: { tenantId: u.tenantId, ...data }, update: data });
      await this.audit.recordControl(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'white_label.updated', entityType: 'white_label', entityId: u.tenantId, propertyId: null,
        metadata: { changes: Object.keys(dto) }, ip,
      });
    });
    await this.brands.reload();
    return this.get(u);
  }

  // ---------------------------------------------------------------------------
  // Email sending domain
  // ---------------------------------------------------------------------------

  private async resend<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.config.get('RESEND_BASE_URL').replace(/\/$/, '')}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.resendKey}`, 'content-type': 'application/json' },
      ...(body !== undefined && method !== 'GET' && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw appError(HttpStatus.BAD_GATEWAY, 'PROVIDER_ERROR', `Resend answered ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  private static resendRecords(records: { record: string; name: string; type: string; value: string; ttl?: string; priority?: number; status?: string }[] | undefined) {
    return (records ?? []).map((r) => ({
      purpose: r.record === 'DKIM' ? 'DKIM' : r.record === 'SPF' ? 'SPF' : r.record,
      type: r.type,
      name: r.name,
      value: r.value,
      priority: r.priority ?? null,
      ttl: r.ttl ?? 'Auto',
      status: r.status === 'verified' ? 'verified' : r.status === 'failure' || r.status === 'failed' ? 'failed' : 'pending',
    }));
  }

  private static resendStatus(s: string | undefined): string {
    switch (s) {
      case 'verified':
        return 'VERIFIED';
      case 'failure':
      case 'failed':
        return 'FAILED';
      case 'temporary_failure':
        return 'TEMPORARY_FAILURE';
      case 'not_started':
        return 'NOT_STARTED';
      default:
        return 'PENDING';
    }
  }

  async createEmailDomain(u: AuthUser, dto: { domain: string; fromLocalPart?: string }, ip?: string) {
    const { domain, problem } = domainProblem(dto.domain);
    if (!domain || problem === 'INVALID') throw Err.validation('domain', 'Enter a domain such as mail.yourhotel.com');
    const local = (dto.fromLocalPart ?? 'reservations').trim().toLowerCase();
    if (!/^[a-z0-9._-]{1,40}$/.test(local)) throw Err.validation('fromLocalPart', 'Use letters, digits, dots, dashes or underscores');
    const taken = await this.db.system((tx) => tx.emailDomain.findUnique({ where: { domain } }));
    if (taken && taken.tenantId !== u.tenantId) throw appError(HttpStatus.CONFLICT, 'DOMAIN_TAKEN', 'That domain is already connected to another hotel');
    let provider = 'mock';
    let providerId: string | null = null;
    let records: EmailRecord[] = mockEmailRecords(domain);
    let status = 'PENDING';
    if (this.resendKey) {
      const old = await this.db.control(u.tenantId, (tx) => tx.emailDomain.findUnique({ where: { tenantId: u.tenantId } }));
      if (old?.providerDomainId) await this.resend('DELETE', `/domains/${old.providerDomainId}`).catch(() => undefined);
      const r = await this.resend<{ id: string; status?: string; records?: Parameters<typeof WhiteLabelService.resendRecords>[0] }>('POST', '/domains', { name: domain });
      provider = 'resend';
      providerId = r.id;
      records = WhiteLabelService.resendRecords(r.records);
      status = WhiteLabelService.resendStatus(r.status);
    }
    const row = await this.db.control(u.tenantId, async (tx) => {
      await tx.emailDomain.deleteMany({ where: { tenantId: u.tenantId } });
      const d = await tx.emailDomain.create({
        data: { tenantId: u.tenantId, domain, fromLocalPart: local, provider, providerDomainId: providerId, status, records: records as unknown as Prisma.InputJsonValue },
      });
      await this.audit.recordControl(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'white_label.email_domain_added', entityType: 'email_domain', entityId: d.id, propertyId: null,
        metadata: { domain, provider }, ip,
      });
      return d;
    });
    await this.brands.reload();
    return this.emailView(row);
  }

  private async emailDomain(tenantId: string) {
    const d = await this.db.control(tenantId, (tx) => tx.emailDomain.findUnique({ where: { tenantId } }));
    if (!d) throw AppException.notFound('Email domain');
    return d;
  }

  /** Asks the provider to verify and reads the status back. */
  async verifyEmailDomain(tenantId: string) {
    const d = await this.emailDomain(tenantId);
    const now = new Date();
    let status = d.status;
    let records = (d.records as unknown as EmailRecord[]) ?? [];
    if (d.provider === 'resend' && d.providerDomainId && this.resendKey) {
      await this.resend('POST', `/domains/${d.providerDomainId}/verify`).catch((e: Error) => this.logger.warn(`Resend verify failed: ${e.message}`));
      const r = await this.resend<{ status?: string; records?: Parameters<typeof WhiteLabelService.resendRecords>[0] }>('GET', `/domains/${d.providerDomainId}`);
      status = WhiteLabelService.resendStatus(r.status);
      records = WhiteLabelService.resendRecords(r.records);
    } else if (d.provider === 'mock') {
      // The mock checks the mock DNS: records published with dev/verify (or the DNS helper) pass.
      const checks = await Promise.all(records.map(async (rec) => (rec.type === 'TXT' ? (await this.dns.txt(rec.name)).includes(rec.value) : rec.status === 'verified')));
      records = records.map((rec, i) => ({ ...rec, status: checks[i] ? 'verified' : rec.status }));
      status = records.every((r) => r.status === 'verified') ? 'VERIFIED' : 'PENDING';
    }
    const updated = await this.db.control(tenantId, (tx) =>
      tx.emailDomain.update({
        where: { id: d.id },
        data: { status, records: records as unknown as Prisma.InputJsonValue, lastCheckedAt: now, verifiedAt: status === 'VERIFIED' ? (d.verifiedAt ?? now) : null },
      }),
    );
    if (status !== d.status) await this.brands.reload();
    return this.emailView(updated);
  }

  async devVerifyEmailDomain(tenantId: string) {
    if (!this.dev) throw AppException.notFound('Route');
    const d = await this.emailDomain(tenantId);
    if (d.provider !== 'mock') throw AppException.notFound('Route');
    const now = new Date();
    const records = ((d.records as unknown as EmailRecord[]) ?? []).map((r) => ({ ...r, status: 'verified' }));
    const updated = await this.db.control(tenantId, (tx) =>
      tx.emailDomain.update({ where: { id: d.id }, data: { status: 'VERIFIED', records: records as unknown as Prisma.InputJsonValue, lastCheckedAt: now, verifiedAt: now } }),
    );
    await this.brands.reload();
    return this.emailView(updated);
  }

  async removeEmailDomain(u: AuthUser, ip?: string) {
    const d = await this.emailDomain(u.tenantId);
    if (d.provider === 'resend' && d.providerDomainId && this.resendKey) await this.resend('DELETE', `/domains/${d.providerDomainId}`).catch(() => undefined);
    await this.db.control(u.tenantId, async (tx) => {
      await tx.emailDomain.delete({ where: { id: d.id } });
      await this.audit.recordControl(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'white_label.email_domain_removed', entityType: 'email_domain', entityId: d.id, propertyId: null,
        metadata: { domain: d.domain }, ip,
      });
    });
    await this.brands.reload();
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // SMS sender ID
  // ---------------------------------------------------------------------------

  async smsSender(u: AuthUser) {
    const r = await this.db.control(u.tenantId, (tx) => tx.smsSenderRequest.findFirst({ where: { tenantId: u.tenantId, current: true }, orderBy: { requestedAt: 'desc' } }));
    return r ? this.smsView(r) : null;
  }

  async requestSmsSender(u: AuthUser, dto: { senderId: string; useCase: string }, ip?: string) {
    const senderId = dto.senderId.trim();
    if (!validSenderId(senderId)) throw Err.validation('senderId', 'Use 3 to 11 letters or digits, with at least one letter');
    const useCase = dto.useCase.trim();
    if (useCase.length < 20 || useCase.length > 500) throw Err.validation('useCase', 'Describe the messages in 20 to 500 characters');
    const termii = this.config.get('TERMII_API_KEY');
    let provider = 'mock';
    let status = 'REQUESTED';
    if (termii) {
      const company = await this.db.control(u.tenantId, (tx) => tx.tenant.findUnique({ where: { id: u.tenantId }, select: { name: true } }));
      const res = await fetch(`${this.config.get('TERMII_BASE_URL').replace(/\/$/, '')}/api/sender-id/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: termii, sender_id: senderId, usecase: useCase, company: company?.name ?? '' }),
        signal: AbortSignal.timeout(15_000),
      }).catch((e: Error) => {
        throw appError(HttpStatus.BAD_GATEWAY, 'PROVIDER_ERROR', `Termii request failed: ${e.message}`);
      });
      if (!res.ok) throw appError(HttpStatus.BAD_GATEWAY, 'PROVIDER_ERROR', `Termii answered ${res.status}`);
      provider = 'termii';
      status = 'PENDING';
    }
    const row = await this.db.control(u.tenantId, async (tx) => {
      await tx.smsSenderRequest.updateMany({ where: { tenantId: u.tenantId, current: true }, data: { current: false } });
      const r = await tx.smsSenderRequest.create({ data: { tenantId: u.tenantId, senderId, useCase, status, provider } });
      await this.audit.recordControl(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'white_label.sms_sender_requested', entityType: 'sms_sender', entityId: r.id, propertyId: null,
        metadata: { senderId, provider }, ip,
      });
      return r;
    });
    await this.brands.reload();
    return this.smsView(row);
  }

  async platformSmsSenders(status?: string) {
    const rows = await this.db.system((tx) => tx.smsSenderRequest.findMany({ where: { current: true, ...(status && { status }) }, orderBy: { requestedAt: 'desc' }, take: 500 }));
    const tenants = await this.db.system((tx) => tx.tenant.findMany({ where: { id: { in: rows.map((r) => r.tenantId) } }, select: { id: true, name: true, slug: true } }));
    const byId = new Map(tenants.map((t) => [t.id, t]));
    return rows.map((r) => ({ ...this.smsView(r), tenant: byId.get(r.tenantId) ?? { id: r.tenantId, name: '', slug: '' } }));
  }

  async decideSmsSender(p: PlatformPrincipal, id: string, dto: { status: 'APPROVED' | 'REJECTED' | 'PENDING'; note?: string }, ip?: string) {
    const r = await this.db.system((tx) => tx.smsSenderRequest.findUnique({ where: { id } }));
    if (!r) throw AppException.notFound('SMS sender request');
    const updated = await this.db.system(async (tx) => {
      const row = await tx.smsSenderRequest.update({
        where: { id },
        data: { status: dto.status, note: dto.note ?? r.note, decidedAt: dto.status === 'PENDING' ? null : new Date(), decidedByName: p.fullName },
      });
      await this.audit.recordControl(tx, {
        tenantId: r.tenantId, actor: platformActor(p), action: 'white_label.sms_sender_decided', entityType: 'sms_sender', entityId: id, propertyId: null,
        metadata: { senderId: r.senderId, status: dto.status, note: dto.note ?? null }, ip,
      });
      return row;
    });
    await this.brands.reload();
    const t = await this.db.system((tx) => tx.tenant.findUnique({ where: { id: r.tenantId }, select: { id: true, name: true, slug: true } }));
    return { ...this.smsView(updated), tenant: t ?? { id: r.tenantId, name: '', slug: '' } };
  }

  // ---------------------------------------------------------------------------
  // Staff portal domain
  // ---------------------------------------------------------------------------

  private async portal(tenantId: string) {
    const d = await this.db.control(tenantId, (tx) => tx.staffPortalDomain.findUnique({ where: { tenantId } }));
    if (!d) throw AppException.notFound('Staff portal domain');
    return d;
  }

  async createPortal(u: AuthUser, input: string, ip?: string) {
    const { domain, problem } = domainProblem(input);
    if (!domain || problem === 'INVALID') throw Err.validation('domain', 'Enter a domain such as staff.yourhotel.com');
    if (problem === 'APEX') throw appError(HttpStatus.BAD_REQUEST, 'DOMAIN_APEX_NOT_SUPPORTED', `Use a subdomain such as staff.${domain}`);
    const appDomain = this.config.get('APP_DOMAIN').toLowerCase();
    if (domain === appDomain || domain.endsWith(`.${appDomain}`)) throw Err.validation('domain', 'Enter your own domain');
    const [portalTaken, booking] = await Promise.all([
      this.db.system((tx) => tx.staffPortalDomain.findUnique({ where: { domain } })),
      this.db.systemAll((tx, t) => tx.customDomain.findFirst({ where: { ...t.tenants, domain }, select: { id: true } })),
    ]);
    if ((portalTaken && portalTaken.tenantId !== u.tenantId) || booking.some(Boolean)) throw appError(HttpStatus.CONFLICT, 'DOMAIN_TAKEN', 'That domain is already connected');
    const row = await this.db.control(u.tenantId, async (tx) => {
      await tx.staffPortalDomain.deleteMany({ where: { tenantId: u.tenantId } });
      const d = await tx.staffPortalDomain.create({ data: { tenantId: u.tenantId, domain, token: randomBytes(16).toString('hex') } });
      await this.audit.recordControl(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'white_label.staff_portal_added', entityType: 'staff_portal_domain', entityId: d.id, propertyId: null,
        metadata: { domain }, ip,
      });
      return d;
    });
    return this.portalView(row);
  }

  async verifyPortal(tenantId: string) {
    const d = await this.portal(tenantId);
    const e = this.portalRecords(d);
    let found: { txt: string[]; cname: string[] } | null;
    try {
      found = { txt: await this.dns.txt(e.txt.name), cname: await this.dns.cname(e.cname.name) };
    } catch {
      found = null;
    }
    const r = readCheck(e, found);
    const ok = r.failures.length === 0;
    const now = new Date();
    const updated = await this.db.control(tenantId, (tx) =>
      tx.staffPortalDomain.update({
        where: { id: d.id },
        data: {
          status: ok ? 'VERIFIED' : d.status === 'VERIFIED' ? 'VERIFIED' : 'PENDING',
          txtOk: r.txtOk, cnameOk: r.cnameOk, failures: r.failures, lastCheckedAt: now, checkCount: { increment: 1 },
          verifiedAt: ok ? (d.verifiedAt ?? now) : d.verifiedAt,
          failingSince: ok ? null : (d.failingSince ?? (d.status === 'VERIFIED' ? now : null)),
        },
      }),
    );
    return this.portalView(updated);
  }

  async devPublishPortal(tenantId: string) {
    if (!this.dev || this.dns.kind !== 'mock') throw AppException.notFound('Route');
    const d = await this.portal(tenantId);
    const e = this.portalRecords(d);
    MockDnsResolver.set(e.txt.name, 'TXT', e.txt.value);
    MockDnsResolver.set(e.cname.name, 'CNAME', e.cname.value);
    return this.verifyPortal(tenantId);
  }

  async removePortal(u: AuthUser, ip?: string) {
    const d = await this.portal(u.tenantId);
    await this.db.control(u.tenantId, async (tx) => {
      await tx.staffPortalDomain.delete({ where: { id: d.id } });
      await this.audit.recordControl(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'white_label.staff_portal_removed', entityType: 'staff_portal_domain', entityId: d.id, propertyId: null,
        metadata: { domain: d.domain }, ip,
      });
    });
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Public reads
  // ---------------------------------------------------------------------------

  /** Brand block for the booking site: only on the property's verified custom domain. */
  publicBrand(tenantId: string, host: string | undefined, property: { customDomain: string | null; customDomainVerifiedAt: Date | null }) {
    const b = this.brands.get(tenantId);
    if (!b || !host) return null;
    const h = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    if (!property.customDomain || !property.customDomainVerifiedAt || property.customDomain !== h) return null;
    return {
      brandName: b.brandName,
      logoUrl: b.logoUrl,
      faviconUrl: b.faviconUrl,
      primaryColor: b.primaryColor,
      accentColor: b.accentColor,
      headingFont: fontByName(b.headingFont),
      bodyFont: fontByName(b.bodyFont),
      footerLinks: b.footerLinks,
      hidePoweredBy: b.hidePoweredBy,
    };
  }

  whiteLabelActive(tenantId: string): boolean {
    return !!this.brands.get(tenantId);
  }

  /** GET /public/staff-portal?host= */
  async staffPortal(rawHost: string) {
    const host = rawHost.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    const d = await this.db.system((tx) => tx.staffPortalDomain.findUnique({ where: { domain: host } }));
    if (!d || d.status !== 'VERIFIED') throw AppException.notFound('Staff portal');
    const b = this.brands.get(d.tenantId);
    if (!b) throw AppException.notFound('Staff portal');
    const [tenant, sso] = await this.db.system(async (tx) => [
      await tx.tenant.findUnique({ where: { id: d.tenantId }, select: { slug: true, name: true } }),
      await tx.ssoConfig.findUnique({ where: { tenantId: d.tenantId } }),
    ] as const);
    if (!tenant) throw AppException.notFound('Staff portal');
    const base = this.config.get('API_PUBLIC_URL').replace(/\/$/, '');
    const ssoOn = !!sso?.enabled;
    return {
      tenantSlug: tenant.slug,
      brandName: b.brandName ?? tenant.name,
      logoUrl: b.logoUrl,
      faviconUrl: b.faviconUrl,
      primaryColor: b.primaryColor,
      accentColor: b.accentColor,
      headingFont: fontByName(b.headingFont),
      bodyFont: fontByName(b.bodyFont),
      hidePlatformBranding: true as const,
      sso: {
        enabled: ssoOn,
        enforced: ssoOn && !!sso?.enforced,
        provider: ssoOn ? (sso?.provider ?? null) : null,
        startUrl: ssoOn ? `${base}/api/v1/auth/sso/start?tenant=${encodeURIComponent(tenant.slug)}&returnTo=${encodeURIComponent(`https://${host}/`)}` : null,
      },
    };
  }

  /** Verified staff-portal hosts (allowed SSO return targets). */
  async isStaffPortalHost(host: string): Promise<string | null> {
    const d = await this.db.system((tx) => tx.staffPortalDomain.findUnique({ where: { domain: host.toLowerCase() } }));
    return d?.status === 'VERIFIED' ? d.tenantId : null;
  }

  /** Job: pending email domains and staff portals are re-checked. */
  async runChecks() {
    const [emails, portals] = await this.db.system(async (tx) => [
      await tx.emailDomain.findMany({ where: { status: { in: ['PENDING', 'NOT_STARTED', 'TEMPORARY_FAILURE'] }, provider: 'resend' }, select: { tenantId: true } }),
      await tx.staffPortalDomain.findMany({ where: { status: 'PENDING' }, select: { tenantId: true } }),
    ] as const);
    let checked = 0;
    for (const e of emails) {
      await this.verifyEmailDomain(e.tenantId).catch((err: Error) => this.logger.warn(`Email domain check failed: ${err.message}`));
      checked++;
    }
    for (const p of portals) {
      await this.verifyPortal(p.tenantId).catch((err: Error) => this.logger.warn(`Staff portal check failed: ${err.message}`));
      checked++;
    }
    return { checked };
  }
}
