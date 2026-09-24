import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../../prisma/db.service.js';

export interface TenantBrand {
  /** White-label is switched on and the plan includes it. */
  active: boolean;
  brandName: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  headingFont: string | null;
  bodyFont: string | null;
  footerLinks: { label: string; url: string }[];
  hidePoweredBy: boolean;
  emailFromName: string | null;
  /** "reservations@mail.theirhotel.com" once the sending domain is verified. */
  emailFrom: string | null;
  /** Approved SMS sender ID. */
  smsSenderId: string | null;
}

/**
 * In-memory view of every tenant's white-label state (M6), for code paths
 * that brand messages and documents synchronously (email templates, the
 * notification providers, printable invoices). Loaded at start-up, refreshed
 * every minute and at once after a change on this instance.
 */
@Injectable()
export class BrandingRegistry implements OnModuleInit {
  private readonly logger = new Logger(BrandingRegistry.name);
  private brands = new Map<string, TenantBrand>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: DbService) {}

  async onModuleInit(): Promise<void> {
    await this.reload().catch((e: Error) => this.logger.warn(`White-label registry not loaded: ${e.message}`));
    this.timer = setInterval(() => void this.reload().catch(() => undefined), 60_000);
    this.timer.unref();
  }

  get(tenantId: string | null | undefined): TenantBrand | null {
    if (!tenantId) return null;
    const b = this.brands.get(tenantId);
    return b?.active ? b : null;
  }

  async reload(): Promise<void> {
    const next = new Map<string, TenantBrand>();
    await this.db.system(async (tx) => {
      const settings = await tx.whiteLabelSetting.findMany({ where: { enabled: true } });
      const ids = settings.map((s) => s.tenantId);
      if (!ids.length) return;
      const [domains, senders, subs, overrides] = await Promise.all([
        tx.emailDomain.findMany({ where: { tenantId: { in: ids }, status: 'VERIFIED' } }),
        tx.smsSenderRequest.findMany({ where: { tenantId: { in: ids }, status: 'APPROVED', current: true } }),
        tx.subscription.findMany({ where: { tenantId: { in: ids } }, include: { plan: { include: { features: true } } } }),
        tx.tenantFeatureOverride.findMany({ where: { tenantId: { in: ids }, featureCode: 'white_label' } }),
      ]);
      for (const s of settings) {
        const sub = subs.find((x) => x.tenantId === s.tenantId);
        const ov = overrides.find((o) => o.tenantId === s.tenantId);
        const entitled = ov ? ov.enabled : !!sub?.plan.features.some((f) => f.featureCode === 'white_label');
        const d = domains.find((x) => x.tenantId === s.tenantId);
        next.set(s.tenantId, {
          active: entitled && s.enabled && sub?.status !== 'SUSPENDED',
          brandName: s.brandName,
          logoUrl: s.logoUrl,
          faviconUrl: s.faviconUrl,
          primaryColor: s.primaryColor,
          accentColor: s.accentColor,
          headingFont: s.headingFont,
          bodyFont: s.bodyFont,
          footerLinks: (s.footerLinks as { label: string; url: string }[]) ?? [],
          hidePoweredBy: s.hidePoweredBy,
          emailFromName: s.emailFromName,
          emailFrom: d ? `${d.fromLocalPart}@${d.domain}` : null,
          smsSenderId: senders.find((x) => x.tenantId === s.tenantId)?.senderId ?? null,
        });
      }
    });
    this.brands = next;
  }
}
