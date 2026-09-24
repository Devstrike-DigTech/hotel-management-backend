import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma, Property, SiteTheme } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { runInProperty } from '../../common/property-scope.js';
import { AppException } from '../../common/errors/app-exception.js';
import { normalisePhone } from '../../common/utils/phone.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { mapUrl, policyView } from '../booking/booking.logic.js';
import { issuesError } from '../booking-form/form.errors.js';
import { customFieldCount } from '../booking-form/form.logic.js';
import type { FormField } from '../booking-form/form.catalogue.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { requiredPlanFor } from '../entitlements/entitlements.logic.js';
import { Err, userRef, userNames } from '../ops/ops.helpers.js';
import { applyColours, HEX_RE } from './contrast.js';
import { PreviewTokens, type PreviewKind } from './preview-tokens.js';
import { fontPairingById, FONT_PAIRINGS, isTemplateId, templateById, TEMPLATES, type TemplateId, type ThemeSection } from './site.registry.js';
import { SiteAssetsService } from './site-assets.service.js';
import {
  appliedFor,
  draftKey,
  gateViolation,
  normaliseDraft,
  normaliseSections,
  resolvedPairing,
  switchTemplate,
  THEME_HISTORY,
  themeChanges,
  validateSections,
  type ThemeDraft,
} from './theme.logic.js';

export type ThemeScope = 'PROPERTY' | 'GROUP';

export interface ThemeDraftInput {
  templateId?: string;
  resetSections?: boolean;
  brand?: { logoAssetId?: string | null; faviconAssetId?: string | null; logoUrl?: string | null; primary?: string; secondary?: string | null; fontPairingId?: string | null };
  colourMode?: 'LIGHT' | 'DARK' | 'SYSTEM';
  sections?: ThemeSection[];
}

export const GATE_FEATURES = ['brand_kit', 'site_templates_all', 'site_sections', 'site_fonts', 'form_fields_unlimited', 'form_conditional_logic', 'paid_extras', 'form_file_uploads'] as const;

/**
 * Brand Studio themes (M7): a draft per property (or group root), published
 * versions (last 20), revert, server-side accessible colours, preview tokens
 * and the public theme the web app renders.
 */
@Injectable()
export class ThemeService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly entitlements: EntitlementsService,
    private readonly assets: SiteAssetsService,
    private readonly previews: PreviewTokens,
  ) {}

  // ---------------------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------------------

  /** The property of a scope (null = group root). Group scope needs access to every property. */
  private target(u: AuthUser, scope: ThemeScope | undefined): string | null {
    if (scope === 'GROUP') {
      if (!u.allProperties) throw new AppException(HttpStatus.FORBIDDEN, 'PROPERTY_ACCESS_DENIED', 'The group site needs access to every property of the group', { propertyId: null });
      return null;
    }
    if (!u.propertyId) throw AppException.notFound('Property');
    return u.propertyId;
  }

  private async firstProperty(tx: Tx, tenantId: string): Promise<Property> {
    const p = await this.db.withAllProperties(tenantId, () => tx.property.findFirst({ where: { tenantId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
    if (!p) throw AppException.notFound('Property');
    return p;
  }

  /** Finds or creates the theme (published version 1 from the hotel profile). */
  async ensure(tx: Tx, tenantId: string, propertyId: string | null): Promise<SiteTheme> {
    const found = await tx.siteTheme.findFirst({ where: { tenantId, propertyId } });
    if (found) return found;
    let draft: ThemeDraft;
    if (propertyId) {
      const p = await tx.property.findFirst({ where: { id: propertyId, tenantId } });
      if (!p) throw AppException.notFound('Property');
      draft = normaliseDraft({ templateId: 'editorial', brand: { primary: p.accentColor && HEX_RE.test(p.accentColor) ? p.accentColor : undefined, logoUrl: p.logoUrl }, colourMode: 'SYSTEM' });
    } else {
      const first = await this.firstProperty(tx, tenantId);
      const base = await this.ensure(tx, tenantId, first.id);
      draft = (await this.publishedDraft(tx, base)) ?? normaliseDraft(base.draft);
    }
    const theme = await tx.siteTheme.create({
      data: { tenantId, propertyId, scope: propertyId ? 'PROPERTY' : 'GROUP', draft: draft as unknown as Prisma.InputJsonValue, draftUpdatedByName: 'System' },
    });
    const v = await tx.siteThemeVersion.create({
      data: { tenantId, themeId: theme.id, version: 1, content: this.content(draft) as unknown as Prisma.InputJsonValue, note: 'Created from the hotel profile', publishedByName: 'System' },
    });
    return tx.siteTheme.update({ where: { id: theme.id }, data: { publishedVersionId: v.id } });
  }

  private content(d: ThemeDraft) {
    return { ...d, applied: appliedFor(d) };
  }

  async publishedDraft(tx: Tx, theme: Pick<SiteTheme, 'publishedVersionId'>): Promise<ThemeDraft | null> {
    if (!theme.publishedVersionId) return null;
    const v = await tx.siteThemeVersion.findUnique({ where: { id: theme.publishedVersionId } });
    return v ? normaliseDraft(v.content) : null;
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  contentView(d: ThemeDraft) {
    return { templateId: d.templateId, brand: d.brand, colourMode: d.colourMode, sections: d.sections, applied: appliedFor(d), fontPairing: resolvedPairing(d) };
  }

  async gates(tx: Tx, tenantId: string, propertyId: string | null) {
    const ent = await this.entitlements.getEntitlements(tenantId, tx);
    const plans = await this.entitlements.listPlans();
    const features = Object.fromEntries(GATE_FEATURES.map((f) => [f, ent.features.includes(f)])) as Record<(typeof GATE_FEATURES)[number], boolean>;
    const requiredPlans = Object.fromEntries(GATE_FEATURES.map((f) => [f, requiredPlanFor(f, plans) ?? 'enterprise']));
    const form = propertyId ? await tx.bookingForm.findUnique({ where: { propertyId }, select: { draftFields: true } }) : null;
    return {
      features,
      requiredPlans,
      templates: TEMPLATES.map((t) => ({ id: t.id, available: !t.feature || ent.features.includes(t.feature) })),
      limits: { max_custom_form_fields: ent.features.includes('form_fields_unlimited') ? -1 : (ent.limits.max_custom_form_fields ?? 3) },
      usage: { customFormFields: form ? customFieldCount(form.draftFields as unknown as FormField[]) : 0 },
    };
  }

  gatesFor(u: AuthUser) {
    return this.db.tenant(u.tenantId, (tx) => this.gates(tx, u.tenantId, u.propertyId ?? null));
  }

  private async siteUrl(tx: Tx, tenantId: string, propertyId: string | null): Promise<string> {
    const web = this.config.get('WEB_URL').replace(/\/$/, '');
    if (!propertyId) {
      const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
      return `${web}/g/${t?.slug ?? ''}`;
    }
    const p = await tx.property.findFirst({ where: { id: propertyId, tenantId }, select: { slug: true, customDomain: true, customDomainVerifiedAt: true } });
    if (!p) return web;
    if (this.config.isProduction) return p.customDomain && p.customDomainVerifiedAt ? `https://${p.customDomain}` : `https://${p.slug}.${this.config.get('APP_DOMAIN')}`;
    return `${web}/h/${p.slug}`;
  }

  private async stateTx(tx: Tx, tenantId: string, propertyId: string | null) {
    const theme = await this.ensure(tx, tenantId, propertyId);
    const draft = normaliseDraft(theme.draft);
    const v = theme.publishedVersionId ? await tx.siteThemeVersion.findUnique({ where: { id: theme.publishedVersionId } }) : null;
    const published = v ? normaliseDraft(v.content) : null;
    const names = await userNames(tx, [theme.draftUpdatedById, v?.publishedById]);
    return {
      scope: (propertyId ? 'PROPERTY' : 'GROUP') as ThemeScope,
      propertyId,
      themeId: theme.id,
      draft: { ...this.contentView(draft), updatedAt: theme.draftUpdatedAt.toISOString(), updatedBy: userRef(names, theme.draftUpdatedById, theme.draftUpdatedByName) ?? (theme.draftUpdatedByName ? { id: null, fullName: theme.draftUpdatedByName } : null) },
      published: v && published ? this.versionView(v, published, names) : null,
      hasUnpublishedChanges: !published || draftKey(draft) !== draftKey(published),
      changes: published && draftKey(draft) === draftKey(published) ? [] : themeChanges(draft, published),
      gates: await this.gates(tx, tenantId, propertyId),
      siteUrl: await this.siteUrl(tx, tenantId, propertyId),
    };
  }

  private versionView(v: { id: string; version: number; publishedAt: Date; publishedById: string | null; publishedByName: string | null; note: string | null }, d: ThemeDraft, names: Map<string, string>) {
    return {
      ...this.contentView(d),
      id: v.id,
      version: v.version,
      publishedAt: v.publishedAt.toISOString(),
      publishedBy: v.publishedById ? userRef(names, v.publishedById, v.publishedByName) : v.publishedByName ? { id: null, fullName: v.publishedByName } : null,
      note: v.note,
    };
  }

  // ---------------------------------------------------------------------------
  // Staff API
  // ---------------------------------------------------------------------------

  state(u: AuthUser, scope?: ThemeScope) {
    const pid = this.target(u, scope);
    return this.db.tenant(u.tenantId, (tx) => this.stateTx(tx, u.tenantId, pid));
  }

  async updateDraft(u: AuthUser, scope: ThemeScope | undefined, dto: ThemeDraftInput, ip?: string) {
    const pid = this.target(u, scope);
    return this.db.tenant(u.tenantId, async (tx) => {
      const ent = await this.entitlements.getEntitlements(u.tenantId, tx);
      const theme = await this.ensure(tx, u.tenantId, pid);
      const current = normaliseDraft(theme.draft);
      const next: ThemeDraft = structuredClone(current);
      const issues: { path: string; fieldKey: null; code: string; message: string }[] = [];
      const bad = (path: string, code: string, message: string) => issues.push({ path, fieldKey: null, code, message });

      if (dto.templateId !== undefined) {
        if (!isTemplateId(dto.templateId)) bad('templateId', 'INVALID_OPTION', 'Unknown template');
        else if (dto.templateId !== current.templateId) {
          const tpl = templateById(dto.templateId)!;
          next.templateId = tpl.id;
          if (dto.resetSections !== false) next.sections = switchTemplate(current.sections, tpl);
          else next.sections = normaliseSections(current.sections, tpl);
          next.colourMode = tpl.defaultColourMode;
          if (next.brand.fontPairingId === templateById(current.templateId)!.defaultFontPairingId) next.brand.fontPairingId = null;
        } else if (dto.resetSections) {
          next.sections = switchTemplate(current.sections, templateById(current.templateId)!);
        }
      }
      const tpl = templateById(next.templateId)!;
      if (dto.brand) {
        const b = dto.brand;
        if (b.primary !== undefined) {
          if (!HEX_RE.test(b.primary)) bad('brand.primary', 'PATTERN', 'Colours are #RRGGBB');
          else next.brand.primary = b.primary.toUpperCase();
        }
        if (b.secondary !== undefined) {
          if (b.secondary !== null && !HEX_RE.test(b.secondary)) bad('brand.secondary', 'PATTERN', 'Colours are #RRGGBB');
          else next.brand.secondary = b.secondary ? b.secondary.toUpperCase() : null;
        }
        if (b.fontPairingId !== undefined) {
          if (b.fontPairingId !== null && !fontPairingById(b.fontPairingId)) bad('brand.fontPairingId', 'INVALID_OPTION', 'Choose one of the font pairings');
          else next.brand.fontPairingId = b.fontPairingId === tpl.defaultFontPairingId ? null : b.fontPairingId;
        }
        const ids = [b.logoAssetId, b.faviconAssetId].filter((x): x is string => typeof x === 'string');
        const found = await this.assets.byIds(tx, u.tenantId, ids);
        for (const [field, kind, urlField] of [['logoAssetId', 'logo', 'logoUrl'], ['faviconAssetId', 'favicon', 'faviconUrl']] as const) {
          const v = b[field];
          if (v === undefined) continue;
          if (v === null) {
            next.brand[field] = null;
            if (!(field === 'logoAssetId' && b.logoUrl)) next.brand[urlField] = null;
            continue;
          }
          const a = found.get(v);
          if (!a || a.kind !== kind) bad(`brand.${field}`, 'INVALID_OPTION', `Upload a ${kind} first (kind ${kind})`);
          else {
            next.brand[field] = a.id;
            next.brand[urlField] = this.assets.url(a);
          }
        }
        if (b.logoUrl !== undefined && b.logoAssetId === undefined) {
          if (b.logoUrl === null) next.brand.logoUrl = next.brand.logoAssetId ? next.brand.logoUrl : null;
          else {
            try {
              if (new URL(b.logoUrl).protocol !== 'https:') throw new Error('not https');
              next.brand.logoUrl = b.logoUrl;
              next.brand.logoAssetId = null;
            } catch {
              bad('brand.logoUrl', 'PATTERN', 'Upload the logo, or give an https address');
            }
          }
        }
      }
      if (dto.colourMode !== undefined) next.colourMode = dto.colourMode;
      if (dto.sections !== undefined) {
        if (!Array.isArray(dto.sections)) bad('sections', 'TYPE', 'sections must be a list');
        else {
          const secIssues = validateSections(dto.sections, tpl, this.assets.base(u.tenantId));
          if (secIssues.length) for (const i of secIssues) bad(i.path, i.code, i.message);
          else next.sections = normaliseSections(dto.sections.map((s, i) => ({ ...s, order: typeof s.order === 'number' ? s.order : i })), tpl);
        }
      }
      if (issues.length) throw issuesError(issues);
      const locked = gateViolation(next, ent.features);
      if (locked) await this.entitlements.assertFeature(ent, locked);
      await tx.siteTheme.update({
        where: { id: theme.id },
        data: { draft: next as unknown as Prisma.InputJsonValue, draftUpdatedAt: new Date(), draftUpdatedById: u.userId, draftUpdatedByName: u.fullName },
      });
      await this.audit.record(tx, {
        tenantId: u.tenantId, actor: userActor(u), action: 'site.theme_draft_saved', entityType: 'site_theme', entityId: theme.id, propertyId: pid,
        metadata: { changes: Object.keys(dto), templateId: next.templateId }, ip,
      });
      return this.stateTx(tx, u.tenantId, pid);
    });
  }

  private async publishDraft(tx: Tx, u: AuthUser, theme: SiteTheme, draft: ThemeDraft, note: string | null, action: string, ip?: string, extra: Record<string, unknown> = {}) {
    const ent = await this.entitlements.getEntitlements(u.tenantId, tx);
    const locked = gateViolation(draft, ent.features);
    if (locked) await this.entitlements.assertFeature(ent, locked);
    const last = await tx.siteThemeVersion.findFirst({ where: { themeId: theme.id }, orderBy: { version: 'desc' }, select: { version: true } });
    const v = await tx.siteThemeVersion.create({
      data: {
        tenantId: u.tenantId,
        themeId: theme.id,
        version: (last?.version ?? 0) + 1,
        content: this.content(draft) as unknown as Prisma.InputJsonValue,
        note,
        publishedById: u.userId,
        publishedByName: u.fullName,
      },
    });
    await tx.siteTheme.update({ where: { id: theme.id }, data: { publishedVersionId: v.id, draft: draft as unknown as Prisma.InputJsonValue } });
    // Keep the last 20 versions.
    const old = await tx.siteThemeVersion.findMany({ where: { themeId: theme.id }, orderBy: { version: 'desc' }, skip: THEME_HISTORY, select: { id: true } });
    if (old.length) await tx.siteThemeVersion.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    // Marketplace cards, emails and invoices read the property's accent and logo.
    if (theme.propertyId) {
      const applied = appliedFor(draft);
      await tx.property.update({ where: { id: theme.propertyId }, data: { accentColor: applied.light.primary, logoUrl: draft.brand.logoUrl } });
    }
    await this.audit.record(tx, {
      tenantId: u.tenantId, actor: userActor(u), action, entityType: 'site_theme', entityId: theme.id, propertyId: theme.propertyId,
      metadata: { version: v.version, templateId: draft.templateId, primary: draft.brand.primary, ...(note && { note }), ...extra }, ip,
    });
    return v;
  }

  async publish(u: AuthUser, scope: ThemeScope | undefined, note: string | undefined, ip?: string) {
    const pid = this.target(u, scope);
    return this.db.tenant(u.tenantId, async (tx) => {
      const theme = await this.ensure(tx, u.tenantId, pid);
      const draft = normaliseDraft(theme.draft);
      const published = await this.publishedDraft(tx, theme);
      if (published && draftKey(published) === draftKey(draft)) {
        throw new AppException(HttpStatus.CONFLICT, 'NOTHING_TO_PUBLISH', 'The draft is the same as the live site');
      }
      await this.publishDraft(tx, u, theme, draft, note ?? null, 'site.theme_published', ip);
      return this.stateTx(tx, u.tenantId, pid);
    });
  }

  async discard(u: AuthUser, scope?: ThemeScope) {
    const pid = this.target(u, scope);
    return this.db.tenant(u.tenantId, async (tx) => {
      const theme = await this.ensure(tx, u.tenantId, pid);
      const published = await this.publishedDraft(tx, theme);
      if (published) {
        await tx.siteTheme.update({ where: { id: theme.id }, data: { draft: published as unknown as Prisma.InputJsonValue, draftUpdatedAt: new Date(), draftUpdatedById: u.userId, draftUpdatedByName: u.fullName } });
      }
      return this.stateTx(tx, u.tenantId, pid);
    });
  }

  async versions(u: AuthUser, scope?: ThemeScope) {
    const pid = this.target(u, scope);
    return this.db.tenant(u.tenantId, async (tx) => {
      const theme = await this.ensure(tx, u.tenantId, pid);
      const rows = await tx.siteThemeVersion.findMany({ where: { themeId: theme.id }, orderBy: { version: 'desc' }, take: THEME_HISTORY });
      const names = await userNames(tx, rows.map((r) => r.publishedById));
      return rows.map((r) => {
        const d = normaliseDraft(r.content);
        return {
          id: r.id,
          version: r.version,
          publishedAt: r.publishedAt.toISOString(),
          publishedBy: r.publishedById ? userRef(names, r.publishedById, r.publishedByName) : r.publishedByName ? { id: null, fullName: r.publishedByName } : null,
          note: r.note,
          templateId: d.templateId,
          primary: d.brand.primary,
          isCurrent: r.id === theme.publishedVersionId,
        };
      });
    });
  }

  async version(u: AuthUser, id: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const v = await tx.siteThemeVersion.findFirst({ where: { id, tenantId: u.tenantId } });
      if (!v) throw AppException.notFound('Theme version');
      const names = await userNames(tx, [v.publishedById]);
      return this.versionView(v, normaliseDraft(v.content), names);
    });
  }

  async revert(u: AuthUser, scope: ThemeScope | undefined, id: string, note: string | undefined, ip?: string) {
    const pid = this.target(u, scope);
    return this.db.tenant(u.tenantId, async (tx) => {
      const theme = await this.ensure(tx, u.tenantId, pid);
      const v = await tx.siteThemeVersion.findFirst({ where: { id, themeId: theme.id } });
      if (!v) throw AppException.notFound('Theme version');
      const draft = normaliseDraft(v.content);
      await this.publishDraft(tx, u, theme, draft, note ?? `Reverted to version ${v.version}`, 'site.theme_reverted', ip, { revertedTo: v.version });
      await tx.siteTheme.update({ where: { id: theme.id }, data: { draftUpdatedAt: new Date(), draftUpdatedById: u.userId, draftUpdatedByName: u.fullName } });
      return this.stateTx(tx, u.tenantId, pid);
    });
  }

  contrast(primary: string, secondary?: string | null) {
    if (!HEX_RE.test(primary)) throw Err.validation('primary', 'Colours are #RRGGBB');
    if (secondary && !HEX_RE.test(secondary)) throw Err.validation('secondary', 'Colours are #RRGGBB');
    return applyColours(primary, secondary ?? null);
  }

  async previewToken(u: AuthUser, dto: { scope?: ThemeScope; kinds?: PreviewKind[]; ttlMinutes?: number }) {
    const pid = this.target(u, dto.scope);
    const kinds = dto.kinds?.length ? [...new Set(dto.kinds)] : (['THEME', 'FORM'] as PreviewKind[]);
    const ttl = dto.ttlMinutes ?? 30;
    if (ttl < 5 || ttl > 120) throw Err.validation('ttlMinutes', 'ttlMinutes is 5 to 120');
    const { token, expiresAt } = this.previews.sign(u.tenantId, pid, kinds, ttl);
    const web = this.config.get('WEB_URL').replace(/\/$/, '');
    const where = await this.db.tenant(u.tenantId, async (tx) => {
      if (!pid) return { site: `${web}/g/${(await tx.tenant.findUnique({ where: { id: u.tenantId }, select: { slug: true } }))?.slug ?? ''}`, slug: null };
      const p = await tx.property.findFirst({ where: { id: pid, tenantId: u.tenantId }, select: { slug: true } });
      return { site: `${web}/h/${p?.slug ?? ''}`, slug: p?.slug ?? null };
    });
    const q = `preview=${encodeURIComponent(token)}`;
    return { token, expiresAt: expiresAt.toISOString(), urls: { site: `${where.site}?${q}`, booking: where.slug ? `${web}/h/${where.slug}/book?${q}` : `${where.site}?${q}` } };
  }

  // ---------------------------------------------------------------------------
  // Public
  // ---------------------------------------------------------------------------

  async hotelRef(slug: string): Promise<{ id: string; tenantId: string }> {
    const p = await this.db.publicForSlug(slug, (tx, t) =>
      tx.property.findFirst({
        where: { ...t.tenants, slug: slug.toLowerCase(), tenant: { subscription: { is: { status: { not: 'SUSPENDED' } } } } },
        select: { id: true, tenantId: true },
      }),
    );
    if (!p) throw AppException.notFound('Hotel');
    return p;
  }

  /** Enabled sections in order, with the data the web needs resolved per key. */
  private async resolveSections(tx: Tx, tenantId: string, p: Property | null, d: ThemeDraft) {
    const enabled = d.sections.filter((s) => s.enabled).sort((a, b) => a.order - b.order);
    const out = [];
    for (const s of enabled) {
      let resolved: Record<string, unknown> | undefined;
      if (p) {
        switch (s.key) {
          case 'getting-here': {
            const ids = (s.options as { pickupPointIds?: string[] | null }).pickupPointIds ?? null;
            const ent = await this.entitlements.getEntitlements(tenantId, tx);
            const points = ent.features.includes('paid_extras')
              ? await tx.pickupPoint.findMany({ where: { tenantId, propertyId: p.id, active: true, ...(ids && { id: { in: ids } }) }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })
              : [];
            resolved = { pickupPoints: points.map(publicPickupPoint) };
            break;
          }
          case 'location-map':
            resolved = { mapUrl: mapUrl(p), staticMapUrl: null, address: [p.address, p.area, p.city, p.state].filter(Boolean).join(', ') };
            break;
          case 'policies':
            resolved = { checkInTime: p.checkInTime, checkOutTime: p.checkOutTime, cancellationSummary: policyView(p).summary, policies: p.policies };
            break;
          case 'amenities':
            resolved = { amenities: p.amenities };
            break;
          case 'contact': {
            const phone = normalisePhone(p.phone);
            resolved = { phone: p.phone || null, email: p.email || null, whatsappUrl: phone ? `https://wa.me/${phone.replace(/\D/g, '')}` : null };
            break;
          }
          default:
            resolved = undefined;
        }
      }
      out.push({ ...s, ...(resolved && { resolved }) });
    }
    return out;
  }

  private async publicView(tx: Tx, tenantId: string, p: Property | null, slug: string, d: ThemeDraft, meta: { version: number | null; preview: boolean; publishedAt: Date | null; updatedAt: Date }) {
    const applied = appliedFor(d);
    const tpl = templateById(d.templateId)!;
    return {
      scope: (p ? 'PROPERTY' : 'GROUP') as ThemeScope,
      slug,
      version: meta.version,
      preview: meta.preview,
      templateId: d.templateId as TemplateId,
      template: { id: tpl.id, name: tpl.name, traits: tpl.traits, performance: tpl.performance },
      colourMode: d.colourMode,
      brand: { logoUrl: d.brand.logoUrl, faviconUrl: d.brand.faviconUrl, primary: d.brand.primary, secondary: d.brand.secondary },
      colours: applied,
      fontPairing: resolvedPairing(d),
      sections: await this.resolveSections(tx, tenantId, p, d),
      publishedAt: meta.publishedAt?.toISOString() ?? null,
      updatedAt: meta.updatedAt.toISOString(),
    };
  }

  /** Published theme of a property inside an open tenant transaction (hotel page, trip view). */
  async publishedPublicTx(tx: Tx, tenantId: string, propertyId: string) {
    const p = await tx.property.findFirst({ where: { id: propertyId, tenantId } });
    if (!p) throw AppException.notFound('Hotel');
    const theme = await this.ensure(tx, tenantId, propertyId);
    const v = theme.publishedVersionId ? await tx.siteThemeVersion.findUnique({ where: { id: theme.publishedVersionId } }) : null;
    const d = v ? normaliseDraft(v.content) : normaliseDraft(theme.draft);
    return this.publicView(tx, tenantId, p, p.slug, d, { version: v?.version ?? null, preview: false, publishedAt: v?.publishedAt ?? null, updatedAt: theme.updatedAt });
  }

  /** Compact theme for the trip page / confirmation card on the hotel host. */
  async tripThemeTx(tx: Tx, tenantId: string, propertyId: string) {
    const theme = await this.ensure(tx, tenantId, propertyId);
    const v = theme.publishedVersionId ? await tx.siteThemeVersion.findUnique({ where: { id: theme.publishedVersionId } }) : null;
    const d = v ? normaliseDraft(v.content) : normaliseDraft(theme.draft);
    const applied = appliedFor(d);
    return { templateId: d.templateId, colours: { light: applied.light, dark: applied.dark }, fontPairing: resolvedPairing(d), logoUrl: d.brand.logoUrl, faviconUrl: d.brand.faviconUrl };
  }

  async publicTheme(slug: string, preview?: string) {
    const ref = await this.hotelRef(slug);
    const grant = preview ? this.previews.verify(preview, 'THEME') : null;
    if (grant && (grant.tenantId !== ref.tenantId || grant.propertyId !== ref.id)) throw AppException.notFound('Preview');
    return runInProperty(ref.tenantId, ref.id, () =>
      this.db.tenant(ref.tenantId, async (tx) => {
        if (!grant) return this.publishedPublicTx(tx, ref.tenantId, ref.id);
        const p = await tx.property.findFirstOrThrow({ where: { id: ref.id } });
        const theme = await this.ensure(tx, ref.tenantId, ref.id);
        return this.publicView(tx, ref.tenantId, p, p.slug, normaliseDraft(theme.draft), { version: null, preview: true, publishedAt: null, updatedAt: theme.draftUpdatedAt });
      }),
    );
  }

  async publicGroupTheme(slug: string, preview?: string) {
    const tenant = await this.db.public((tx) =>
      tx.tenant.findFirst({ where: { slug: slug.toLowerCase(), subscription: { is: { status: { not: 'SUSPENDED' } } } }, select: { id: true, slug: true } }),
    );
    if (!tenant) throw AppException.notFound('Hotel group');
    const grant = preview ? this.previews.verify(preview, 'THEME') : null;
    if (grant && (grant.tenantId !== tenant.id || grant.propertyId !== null)) throw AppException.notFound('Preview');
    return this.db.tenant(tenant.id, async (tx) => {
      const own = await tx.siteTheme.findFirst({ where: { tenantId: tenant.id, propertyId: null } });
      if (!own) {
        const first = await this.firstProperty(tx, tenant.id);
        const base = await runInProperty(tenant.id, first.id, () => this.publishedPublicTx(tx, tenant.id, first.id));
        return { ...base, scope: 'GROUP' as ThemeScope, slug: tenant.slug, preview: !!grant };
      }
      const v = own.publishedVersionId ? await tx.siteThemeVersion.findUnique({ where: { id: own.publishedVersionId } }) : null;
      const d = grant || !v ? normaliseDraft(own.draft) : normaliseDraft(v.content);
      return this.publicView(tx, tenant.id, null, tenant.slug, d, { version: grant ? null : (v?.version ?? null), preview: !!grant, publishedAt: grant ? null : (v?.publishedAt ?? null), updatedAt: own.updatedAt });
    });
  }

  registry() {
    return { templates: TEMPLATES, fontPairings: FONT_PAIRINGS };
  }
}

export function publicPickupPoint(p: {
  id: string; name: string; shortName: string | null; kind: string; city: string; address: string | null; priceKobo: number; dropOffPriceKobo: number | null;
  vehicleOptions: unknown; leadTimeHours: number; operatingHours: unknown; notesForGuest: string | null; taxable: boolean;
}) {
  return {
    id: p.id,
    name: p.name,
    shortName: p.shortName,
    kind: p.kind,
    city: p.city,
    address: p.address,
    priceKobo: p.priceKobo,
    dropOffPriceKobo: p.dropOffPriceKobo,
    vehicleOptions: Array.isArray(p.vehicleOptions) ? p.vehicleOptions : [],
    leadTimeHours: p.leadTimeHours,
    operatingHours: (p.operatingHours as { open: string; close: string } | null) ?? null,
    notesForGuest: p.notesForGuest,
    taxable: p.taxable,
  };
}
