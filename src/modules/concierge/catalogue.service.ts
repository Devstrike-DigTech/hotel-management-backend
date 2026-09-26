import { HttpStatus, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { ConciergeService as ServiceRow, ConciergeVendor, Prisma } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { lagosDate, lagosDateTime, addDays } from '../../common/time/lagos.js';
import { normalisePhone } from '../../common/utils/phone.js';
import { type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { issuesError } from '../booking-form/form.errors.js';
import type { ValidationIssue } from '../booking-form/form.logic.js';
import type { FormField } from '../booking-form/form.catalogue.js';
import { componentsFrom } from '../folios/tax.logic.js';
import { TaxSettingsService } from '../folios/tax-settings.service.js';
import { isUniqueViolation, primaryProperty } from '../ops/ops.helpers.js';
import { ConciergeService, serviceLike, variantsOf } from './concierge.service.js';
import {
  CATEGORIES,
  durationOf,
  FINAL_STATUSES,
  normaliseQuestions,
  priceService,
  questionTexts,
  serviceIssues,
  slotsFor,
  validateQuestions,
  type Availability,
  type ServiceVariant,
} from './concierge.logic.js';
import { screen } from './denylist.js';

export interface ServiceInput {
  name?: string;
  description?: string;
  category?: string;
  imageUrl?: string | null;
  pricing?: string;
  priceKobo?: number | null;
  variants?: { id?: string; name: string; priceKobo: number; durationMinutes?: number | null }[];
  durationMinutes?: number | null;
  leadTimeHours?: number;
  availability?: Availability;
  requiresSlot?: boolean;
  slotCapacity?: number | null;
  location?: string;
  fulfilledBy?: string;
  vendorId?: string | null;
  discreetEligible?: boolean;
  questions?: Partial<FormField>[];
  taxable?: boolean;
  channels?: string[];
  active?: boolean;
  sortOrder?: number;
}

export interface VendorInput {
  name?: string;
  category?: string;
  contactName?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  commissionType?: 'NONE' | 'PERCENT' | 'FIXED';
  commissionValue?: number;
  payoutNotes?: string | null;
  notes?: string | null;
  active?: boolean;
}

/** Stable variant ids: kept on edits, generated for new ones. */
function variantsIn(list: ServiceInput['variants'], previous: ServiceVariant[] = []): ServiceVariant[] {
  if (!list) return previous;
  const used = new Set<string>();
  return list.map((v) => {
    let id = v.id && /^[a-z0-9-]{1,40}$/.test(v.id) && !used.has(v.id) ? v.id : '';
    if (!id) {
      const base = v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'option';
      id = used.has(base) ? `${base}-${randomBytes(2).toString('hex')}` : base;
    }
    used.add(id);
    return { id, name: v.name.trim(), priceKobo: v.priceKobo, durationMinutes: v.durationMinutes ?? null };
  });
}

const QUESTION_LIBRARY: Partial<FormField>[] = [
  { key: 'c_massage_type', type: 'SELECT', label: 'Massage type', required: 'REQUIRED', options: [{ value: 'SWEDISH', label: 'Swedish (relaxing)' }, { value: 'DEEP_TISSUE', label: 'Deep tissue' }, { value: 'HOT_STONE', label: 'Hot stone' }, { value: 'AROMATHERAPY', label: 'Aromatherapy' }] },
  { key: 'c_therapist_preference', type: 'SELECT', label: 'Therapist gender preference (for comfort)', required: 'OPTIONAL', options: [{ value: 'FEMALE', label: 'Female therapist' }, { value: 'MALE', label: 'Male therapist' }, { value: 'NO_PREFERENCE', label: 'No preference' }] },
  { key: 'c_pressure', type: 'SELECT', label: 'Pressure preference', required: 'OPTIONAL', options: [{ value: 'LIGHT', label: 'Light' }, { value: 'MEDIUM', label: 'Medium' }, { value: 'FIRM', label: 'Firm' }] },
  { key: 'c_guests', type: 'NUMBER', label: 'Number of guests', required: 'OPTIONAL', validation: { min: 1, max: 50 } },
  { key: 'c_occasion', type: 'SELECT', label: 'Occasion', required: 'OPTIONAL', options: [{ value: 'BIRTHDAY', label: 'Birthday' }, { value: 'ANNIVERSARY', label: 'Anniversary' }, { value: 'PROPOSAL', label: 'Proposal' }, { value: 'HONEYMOON', label: 'Honeymoon' }, { value: 'OTHER', label: 'Something else' }] },
  { key: 'c_dietary', type: 'MULTI_SELECT', label: 'Dietary needs', required: 'OPTIONAL', options: [{ value: 'VEGETARIAN', label: 'Vegetarian' }, { value: 'VEGAN', label: 'Vegan' }, { value: 'HALAL', label: 'Halal' }, { value: 'NO_PORK', label: 'No pork' }, { value: 'NUT_ALLERGY', label: 'Nut allergy' }, { value: 'GLUTEN_FREE', label: 'Gluten free' }] },
  { key: 'c_cuisine', type: 'SELECT', label: 'Cuisine', required: 'REQUIRED', options: [{ value: 'NIGERIAN', label: 'Nigerian' }, { value: 'CONTINENTAL', label: 'Continental' }, { value: 'MIXED', label: 'A bit of both' }] },
  { key: 'c_pickup_address', type: 'SHORT_TEXT', label: 'Pickup address', required: 'OPTIONAL', placeholder: 'e.g. the hotel lobby', validation: { maxLength: 160 } },
  { key: 'c_destination', type: 'SHORT_TEXT', label: 'Destination', required: 'OPTIONAL', placeholder: 'e.g. Victoria Island', validation: { maxLength: 160 } },
  { key: 'c_language', type: 'SELECT', label: 'Preferred language', required: 'OPTIONAL', options: [{ value: 'ENGLISH', label: 'English' }, { value: 'YORUBA', label: 'Yoruba' }, { value: 'IGBO', label: 'Igbo' }, { value: 'HAUSA', label: 'Hausa' }, { value: 'FRENCH', label: 'French' }] },
  { key: 'c_children_ages', type: 'SHORT_TEXT', label: "Children's ages", required: 'OPTIONAL', placeholder: 'e.g. 4, 7', validation: { maxLength: 40 } },
  { key: 'c_outfits', type: 'NUMBER', label: 'Number of outfits', required: 'OPTIONAL', validation: { min: 1, max: 10 } },
  { key: 'c_allergies', type: 'SHORT_TEXT', label: 'Any allergies we should know about?', required: 'OPTIONAL', validation: { maxLength: 200 } },
];

/**
 * Service catalogue and vendor directory (M8, per property). Every service
 * text is screened against the denylist: a hit saves the service as
 * PENDING_REVIEW (hidden from guests) for the platform's review.
 */
@Injectable()
export class CatalogueService {
  constructor(
    private readonly core: ConciergeService,
    private readonly audit: AuditService,
    private readonly taxes: TaxSettingsService,
  ) {}

  private get db() {
    return this.core.db;
  }

  categories() {
    return CATEGORIES.map((c) => ({ ...c }));
  }

  questionLibrary() {
    return normaliseQuestions(QUESTION_LIBRARY);
  }

  screen(texts: string[]) {
    const matches: { term: string; category: string; excerpt: string; textIndex: number }[] = [];
    texts.forEach((t, i) => {
      for (const m of screen([t]).matches) if (!matches.some((x) => x.term === m.term)) matches.push({ ...m, textIndex: i });
    });
    return { flagged: matches.length > 0, matches };
  }

  /** Guest-visible: active, LIVE, concierge enabled on the property, not suspended, feature on. */
  async visibilityTx(tx: Tx, tenantId: string, propertyId: string): Promise<boolean> {
    const ent = await this.core.entitlements.getEntitlements(tenantId, tx);
    if (!ent.features.includes('concierge')) return false;
    const a = await this.core.accountTx(tx, tenantId);
    if (a?.suspendedAt || !this.core.aupAccepted(a)) return false;
    return (await this.core.settingsTx(tx, tenantId, propertyId)).enabled;
  }

  // ---------------------------------------------------------------------------
  // Services
  // ---------------------------------------------------------------------------

  async listServices(u: AuthUser, q: { active?: boolean; category?: string; reviewStatus?: string }) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const p = await primaryProperty(tx, u.tenantId);
      const rows = await tx.conciergeService.findMany({
        where: { tenantId: u.tenantId, propertyId: p.id, ...(q.active !== undefined && { active: q.active }), ...(q.category && { category: q.category as ServiceRow['category'] }), ...(q.reviewStatus && { reviewStatus: q.reviewStatus as ServiceRow['reviewStatus'] }) },
        include: { vendor: { select: { id: true, name: true } } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      });
      const on = await this.visibilityTx(tx, u.tenantId, p.id);
      const since = new Date(Date.now() - 30 * 86_400_000);
      const counts = await tx.conciergeRequest.groupBy({ by: ['serviceId'], where: { tenantId: u.tenantId, propertyId: p.id, createdAt: { gte: since }, serviceId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
      const by = new Map(counts.map((c) => [c.serviceId, c._count._all]));
      return rows.map((s) => this.core.serviceView(s, { guestVisible: on && s.active && s.reviewStatus === 'LIVE', requestsLast30Days: by.get(s.id) ?? 0 }));
    });
  }

  getService(u: AuthUser, id: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const s = await tx.conciergeService.findFirst({ where: { id, tenantId: u.tenantId }, include: { vendor: { select: { id: true, name: true } } } });
      if (!s) throw AppException.notFound('Service');
      const on = await this.visibilityTx(tx, u.tenantId, s.propertyId);
      return this.core.serviceView(s, { guestVisible: on && s.active && s.reviewStatus === 'LIVE' });
    });
  }

  /** Validates a full service definition; returns the stored questions and the screen result. */
  private async checkService(tx: Tx, tenantId: string, propertyId: string, merged: ServiceInput & { name: string; description: string; pricing: string }, variants: ServiceVariant[], features: readonly string[]) {
    const issues: ValidationIssue[] = [];
    const questions = normaliseQuestions(merged.questions ?? []);
    const q = validateQuestions(questions, features);
    issues.push(...q.issues);
    const like = {
      id: '',
      name: merged.name,
      pricing: merged.pricing as ServiceRow['pricing'],
      priceKobo: merged.priceKobo ?? null,
      variants,
      durationMinutes: merged.durationMinutes ?? null,
      leadTimeHours: merged.leadTimeHours ?? 0,
      availability: merged.availability ?? null,
      requiresSlot: merged.requiresSlot ?? false,
      slotCapacity: merged.slotCapacity ?? null,
      taxable: merged.taxable ?? true,
    };
    issues.push(...serviceIssues(like));
    if (merged.name.trim().length < 2 || merged.name.length > 80) issues.push({ path: 'name', fieldKey: null, code: 'TOO_LONG', message: 'Names are 2 to 80 characters' });
    if (merged.fulfilledBy === 'VENDOR' && !merged.vendorId) issues.push({ path: 'vendorId', fieldKey: null, code: 'REQUIRED', message: 'Choose the vendor who provides this service' });
    if (merged.vendorId) {
      const v = await tx.conciergeVendor.findFirst({ where: { id: merged.vendorId, tenantId, propertyId } });
      if (!v) issues.push({ path: 'vendorId', fieldKey: null, code: 'INACTIVE', message: 'This vendor is not in the directory' });
    }
    if (issues.length) throw issuesError(issues);
    if (q.lockedFeature) await this.core.entitlements.assertFeature(await this.core.entitlements.getEntitlements(tenantId, tx), q.lockedFeature);
    const hit = screen([merged.name, merged.description, ...variants.map((v) => v.name), ...questionTexts(questions)]);
    return { questions, warnings: q.warnings, hit };
  }

  async createService(u: AuthUser, dto: ServiceInput & { name: string; pricing: string; category: string }, ip?: string) {
    try {
      return await this.db.tenant(u.tenantId, async (tx) => {
        const a = await this.core.accountTx(tx, u.tenantId);
        this.core.assertAup(a);
        this.core.assertNotSuspended(a);
        const p = await primaryProperty(tx, u.tenantId);
        const ent = await this.core.entitlements.getEntitlements(u.tenantId, tx);
        const variants = variantsIn(dto.variants);
        const merged = { ...dto, description: dto.description ?? '' };
        const { questions, warnings, hit } = await this.checkService(tx, u.tenantId, p.id, merged, variants, ent.features);
        const now = new Date();
        const s = await tx.conciergeService.create({
          data: {
            tenantId: u.tenantId,
            propertyId: p.id,
            name: dto.name.trim(),
            description: merged.description,
            category: dto.category as ServiceRow['category'],
            imageUrl: dto.imageUrl ?? null,
            pricing: dto.pricing as ServiceRow['pricing'],
            priceKobo: dto.pricing === 'FREE' ? null : (dto.priceKobo ?? null),
            variants: variants as unknown as Prisma.InputJsonValue,
            durationMinutes: dto.durationMinutes ?? null,
            leadTimeHours: dto.leadTimeHours ?? 0,
            availability: (dto.availability ?? null) as unknown as Prisma.InputJsonValue,
            requiresSlot: dto.requiresSlot ?? false,
            slotCapacity: dto.slotCapacity ?? (dto.requiresSlot ? 1 : null),
            location: (dto.location ?? 'ON_PROPERTY') as ServiceRow['location'],
            fulfilledBy: dto.fulfilledBy ?? (dto.vendorId ? 'VENDOR' : 'STAFF'),
            vendorId: dto.vendorId ?? null,
            discreetEligible: dto.discreetEligible ?? false,
            questions: questions as unknown as Prisma.InputJsonValue,
            taxable: dto.taxable ?? true,
            channels: dto.channels ?? ['BOOKING_FLOW', 'TRIP_PAGE', 'FRONT_DESK'],
            active: dto.active ?? true,
            sortOrder: dto.sortOrder ?? 0,
            reviewStatus: hit.flagged ? 'PENDING_REVIEW' : 'LIVE',
            flaggedTerms: hit.terms,
            flagMatches: hit.matches as unknown as Prisma.InputJsonValue,
            submittedAt: hit.flagged ? now : null,
          },
          include: { vendor: { select: { id: true, name: true } } },
        });
        await this.audit.record(tx, {
          tenantId: u.tenantId, actor: userActor(u), action: 'concierge_service.created', entityType: 'concierge_service', entityId: s.id,
          metadata: { name: s.name, pricing: s.pricing, reviewStatus: s.reviewStatus, flaggedTerms: hit.terms }, ip,
        });
        const on = await this.visibilityTx(tx, u.tenantId, p.id);
        return { ...this.core.serviceView(s, { guestVisible: on && s.active && s.reviewStatus === 'LIVE' }), warnings };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw AppException.conflict('A service with this name already exists');
      throw e;
    }
  }

  async updateService(u: AuthUser, id: string, dto: ServiceInput, ip?: string) {
    try {
      return await this.db.tenant(u.tenantId, async (tx) => {
        const cur = await tx.conciergeService.findFirst({ where: { id, tenantId: u.tenantId } });
        if (!cur) throw AppException.notFound('Service');
        const a = await this.core.accountTx(tx, u.tenantId);
        this.core.assertAup(a);
        this.core.assertNotSuspended(a);
        const ent = await this.core.entitlements.getEntitlements(u.tenantId, tx);
        const variants = variantsIn(dto.variants, variantsOf(cur.variants));
        const pricing = dto.pricing ?? cur.pricing;
        const merged = {
          name: dto.name ?? cur.name,
          description: dto.description ?? cur.description,
          pricing,
          priceKobo: dto.priceKobo !== undefined ? dto.priceKobo : cur.priceKobo,
          durationMinutes: dto.durationMinutes !== undefined ? dto.durationMinutes : cur.durationMinutes,
          leadTimeHours: dto.leadTimeHours ?? cur.leadTimeHours,
          availability: dto.availability !== undefined ? dto.availability : (cur.availability as Availability),
          requiresSlot: dto.requiresSlot ?? cur.requiresSlot,
          slotCapacity: dto.slotCapacity !== undefined ? dto.slotCapacity : cur.slotCapacity,
          fulfilledBy: dto.fulfilledBy ?? cur.fulfilledBy,
          vendorId: dto.vendorId !== undefined ? dto.vendorId : cur.vendorId,
          questions: dto.questions ?? (cur.questions as Partial<FormField>[]),
          taxable: dto.taxable ?? cur.taxable,
        };
        const { questions, warnings, hit } = await this.checkService(tx, u.tenantId, cur.propertyId, merged, variants, ent.features);
        // Resubmission: a rejected or hidden service goes back to review even when clean.
        const resubmit = cur.reviewStatus === 'REJECTED' || cur.reviewStatus === 'HIDDEN';
        const reviewStatus = hit.flagged || resubmit ? 'PENDING_REVIEW' : 'LIVE';
        const s = await tx.conciergeService.update({
          where: { id },
          data: {
            name: merged.name.trim(),
            description: merged.description,
            ...(dto.category !== undefined && { category: dto.category as ServiceRow['category'] }),
            ...(dto.imageUrl !== undefined && { imageUrl: dto.imageUrl }),
            pricing: pricing as ServiceRow['pricing'],
            priceKobo: pricing === 'FREE' ? null : merged.priceKobo,
            variants: variants as unknown as Prisma.InputJsonValue,
            durationMinutes: merged.durationMinutes,
            leadTimeHours: merged.leadTimeHours,
            availability: (merged.availability ?? null) as unknown as Prisma.InputJsonValue,
            requiresSlot: merged.requiresSlot,
            slotCapacity: merged.slotCapacity ?? (merged.requiresSlot ? 1 : null),
            ...(dto.location !== undefined && { location: dto.location as ServiceRow['location'] }),
            fulfilledBy: merged.fulfilledBy,
            vendorId: merged.vendorId,
            ...(dto.discreetEligible !== undefined && { discreetEligible: dto.discreetEligible }),
            questions: questions as unknown as Prisma.InputJsonValue,
            taxable: merged.taxable,
            ...(dto.channels !== undefined && { channels: dto.channels }),
            ...(dto.active !== undefined && { active: dto.active }),
            ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
            reviewStatus,
            flaggedTerms: hit.terms,
            flagMatches: hit.matches as unknown as Prisma.InputJsonValue,
            ...(reviewStatus === 'PENDING_REVIEW' && cur.reviewStatus !== 'PENDING_REVIEW' && { submittedAt: new Date() }),
            ...(reviewStatus === 'LIVE' && { reviewReason: null }),
          },
          include: { vendor: { select: { id: true, name: true } } },
        });
        await this.audit.record(tx, {
          tenantId: u.tenantId, actor: userActor(u), action: 'concierge_service.updated', entityType: 'concierge_service', entityId: id,
          metadata: { changes: Object.keys(dto), reviewStatus: s.reviewStatus, flaggedTerms: hit.terms }, ip,
        });
        const on = await this.visibilityTx(tx, u.tenantId, s.propertyId);
        return { ...this.core.serviceView(s, { guestVisible: on && s.active && s.reviewStatus === 'LIVE' }), warnings };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw AppException.conflict('A service with this name already exists');
      throw e;
    }
  }

  removeService(u: AuthUser, id: string, ip?: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const cur = await tx.conciergeService.findFirst({ where: { id, tenantId: u.tenantId } });
      if (!cur) throw AppException.notFound('Service');
      const refs = await tx.conciergeRequest.count({ where: { serviceId: id } });
      if (refs) throw new AppException(HttpStatus.CONFLICT, 'SERVICE_IN_USE', 'Guest requests use this service. Switch it off instead (active: false).', { references: refs });
      await tx.conciergeService.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'concierge_service.deleted', entityType: 'concierge_service', entityId: id, metadata: { name: cur.name }, ip });
      return { success: true };
    });
  }

  /** Live requests of a service overlapping a day (for slots). */
  async busyTx(tx: Tx, s: ServiceRow, date: string) {
    const from = lagosDateTime(date, '00:00');
    const to = lagosDateTime(addDays(date, 2), '00:00');
    const rows = await tx.conciergeRequest.findMany({
      where: { serviceId: s.id, status: { notIn: [...FINAL_STATUSES] }, preferredStart: { gte: new Date(from.getTime() - 86_400_000), lt: to } },
      select: { preferredStart: true, preferredEnd: true, variantId: true },
    });
    const like = serviceLike(s);
    return rows.filter((r) => r.preferredStart).map((r) => ({ start: r.preferredStart!, end: r.preferredEnd ?? new Date(r.preferredStart!.getTime() + durationOf(like, r.variantId) * 60_000) }));
  }

  async slotsTx(tx: Tx, s: ServiceRow, date: string, variantId?: string | null, now = new Date()) {
    const like = serviceLike(s);
    const duration = durationOf(like, variantId);
    return { date, durationMinutes: duration, slots: slotsFor(like, date, now, await this.busyTx(tx, s, date), duration) };
  }

  slots(u: AuthUser, id: string, date: string, variantId?: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const s = await tx.conciergeService.findFirst({ where: { id, tenantId: u.tenantId } });
      if (!s) throw AppException.notFound('Service');
      return this.slotsTx(tx, s, date || lagosDate(), variantId);
    });
  }

  async priceTx(tx: Tx, tenantId: string, s: ServiceRow, sel: { variantId?: string | null; partySize?: number | null; hours?: number | null }) {
    const comps = componentsFrom(await this.taxes.forProperty(tx, tenantId, s.propertyId));
    const r = priceService(serviceLike(s), sel, comps);
    if (r.issues.length) throw issuesError(r.issues);
    return { price: r.price, requiresQuote: r.requiresQuote };
  }

  price(u: AuthUser, dto: { serviceId: string; variantId?: string; partySize?: number; hours?: number }) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const s = await tx.conciergeService.findFirst({ where: { id: dto.serviceId, tenantId: u.tenantId } });
      if (!s) throw AppException.notFound('Service');
      return this.priceTx(tx, u.tenantId, s, dto);
    });
  }

  // ---------------------------------------------------------------------------
  // Vendors
  // ---------------------------------------------------------------------------

  vendorView(v: ConciergeVendor, extras: { vendorsFeature: boolean; jobsLast30Days?: number; unsettledPayableKobo?: number }) {
    return {
      id: v.id,
      propertyId: v.propertyId,
      name: v.name,
      category: v.category,
      contactName: v.contactName,
      phone: v.phone,
      whatsapp: v.whatsapp,
      email: v.email,
      commissionType: v.commissionType as 'NONE' | 'PERCENT' | 'FIXED',
      commissionValue: v.commissionValue,
      payoutNotes: v.payoutNotes,
      notes: v.notes,
      active: v.active,
      rating: v.ratingCount ? Math.round((v.ratingSum / v.ratingCount) * 100) / 100 : null,
      ratingCount: v.ratingCount,
      jobsLast30Days: extras.jobsLast30Days ?? 0,
      unsettledPayableKobo: extras.vendorsFeature ? (extras.unsettledPayableKobo ?? 0) : null,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    };
  }

  private async vendorStats(tx: Tx, tenantId: string, ids: string[]) {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const jobs = await tx.conciergeRequest.groupBy({ by: ['vendorId'], where: { tenantId, vendorId: { in: ids }, createdAt: { gte: since } }, _count: { _all: true } });
    const unsettled = await tx.conciergeRequest.groupBy({ by: ['vendorId'], where: { tenantId, vendorId: { in: ids }, status: 'COMPLETED', vendorSettledAt: null }, _sum: { vendorPayableKobo: true } });
    return { jobs: new Map(jobs.map((j) => [j.vendorId, j._count._all])), unsettled: new Map(unsettled.map((j) => [j.vendorId, j._sum.vendorPayableKobo ?? 0])) };
  }

  listVendors(u: AuthUser, q: { active?: boolean; category?: string }) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const p = await primaryProperty(tx, u.tenantId);
      const rows = await tx.conciergeVendor.findMany({ where: { tenantId: u.tenantId, propertyId: p.id, ...(q.active !== undefined && { active: q.active }), ...(q.category && { category: q.category as ConciergeVendor['category'] }) }, orderBy: { name: 'asc' } });
      const ent = await this.core.entitlements.getEntitlements(u.tenantId, tx);
      const st = await this.vendorStats(tx, u.tenantId, rows.map((r) => r.id));
      return rows.map((v) => this.vendorView(v, { vendorsFeature: ent.features.includes('concierge_vendors'), jobsLast30Days: st.jobs.get(v.id), unsettledPayableKobo: st.unsettled.get(v.id) }));
    });
  }

  getVendor(u: AuthUser, id: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const v = await tx.conciergeVendor.findFirst({ where: { id, tenantId: u.tenantId } });
      if (!v) throw AppException.notFound('Vendor');
      const ent = await this.core.entitlements.getEntitlements(u.tenantId, tx);
      const st = await this.vendorStats(tx, u.tenantId, [v.id]);
      return this.vendorView(v, { vendorsFeature: ent.features.includes('concierge_vendors'), jobsLast30Days: st.jobs.get(v.id), unsettledPayableKobo: st.unsettled.get(v.id) });
    });
  }

  private async vendorData(tx: Tx, tenantId: string, dto: VendorInput) {
    const issues: ValidationIssue[] = [];
    const phone = (key: 'phone' | 'whatsapp') => {
      const v = dto[key];
      if (v === undefined) return undefined;
      if (v === null || v === '') return null;
      const p = normalisePhone(v);
      if (!p) issues.push({ path: key, fieldKey: null, code: 'INVALID_PHONE', message: 'Enter a valid phone number, e.g. 0803 123 4567' });
      return p;
    };
    const data = { phone: phone('phone'), whatsapp: phone('whatsapp') };
    if (dto.commissionType && dto.commissionType !== 'NONE') {
      await this.core.entitlements.assertFeature(await this.core.entitlements.getEntitlements(tenantId, tx), 'concierge_vendors');
      const v = dto.commissionValue ?? 0;
      if (dto.commissionType === 'PERCENT' && (v < 1 || v > 10_000)) issues.push({ path: 'commissionValue', fieldKey: null, code: 'MAX', message: 'A percentage is 0.01% to 100% (1 to 10000 basis points)' });
      if (dto.commissionType === 'FIXED' && v < 1) issues.push({ path: 'commissionValue', fieldKey: null, code: 'MIN', message: 'Give the fixed commission in kobo' });
    }
    const hit = screen([dto.name, dto.notes, dto.payoutNotes]);
    if (hit.flagged) issues.push(...hit.matches.map((m) => ({ path: 'name', fieldKey: null, code: 'NOT_ALLOWED', message: `"${m.term}" is not allowed (acceptable-use policy)`, meta: { term: m.term, category: m.category } })));
    if (issues.length) throw issuesError(issues);
    return data;
  }

  async createVendor(u: AuthUser, dto: VendorInput & { name: string; category: string }, ip?: string) {
    try {
      return await this.db.tenant(u.tenantId, async (tx) => {
        this.core.assertNotSuspended(await this.core.accountTx(tx, u.tenantId));
        const p = await primaryProperty(tx, u.tenantId);
        const phones = await this.vendorData(tx, u.tenantId, dto);
        const type = dto.commissionType ?? 'NONE';
        const v = await tx.conciergeVendor.create({
          data: {
            tenantId: u.tenantId,
            propertyId: p.id,
            name: dto.name.trim(),
            category: dto.category as ConciergeVendor['category'],
            contactName: dto.contactName ?? null,
            phone: phones.phone ?? null,
            whatsapp: phones.whatsapp ?? null,
            email: dto.email?.trim().toLowerCase() || null,
            commissionType: type,
            commissionValue: type === 'NONE' ? 0 : (dto.commissionValue ?? 0),
            payoutNotes: dto.payoutNotes ?? null,
            notes: dto.notes ?? null,
            active: dto.active ?? true,
          },
        });
        await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'concierge_vendor.created', entityType: 'concierge_vendor', entityId: v.id, metadata: { name: v.name, commissionType: type }, ip });
        const ent = await this.core.entitlements.getEntitlements(u.tenantId, tx);
        return this.vendorView(v, { vendorsFeature: ent.features.includes('concierge_vendors') });
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw AppException.conflict('A vendor with this name already exists');
      throw e;
    }
  }

  async updateVendor(u: AuthUser, id: string, dto: VendorInput, ip?: string) {
    try {
      return await this.db.tenant(u.tenantId, async (tx) => {
        const cur = await tx.conciergeVendor.findFirst({ where: { id, tenantId: u.tenantId } });
        if (!cur) throw AppException.notFound('Vendor');
        const phones = await this.vendorData(tx, u.tenantId, dto);
        const type = dto.commissionType ?? cur.commissionType;
        const v = await tx.conciergeVendor.update({
          where: { id },
          data: {
            ...(dto.name !== undefined && { name: dto.name.trim() }),
            ...(dto.category !== undefined && { category: dto.category as ConciergeVendor['category'] }),
            ...(dto.contactName !== undefined && { contactName: dto.contactName }),
            ...(phones.phone !== undefined && { phone: phones.phone }),
            ...(phones.whatsapp !== undefined && { whatsapp: phones.whatsapp }),
            ...(dto.email !== undefined && { email: dto.email?.trim().toLowerCase() || null }),
            commissionType: type,
            commissionValue: type === 'NONE' ? 0 : (dto.commissionValue ?? cur.commissionValue),
            ...(dto.payoutNotes !== undefined && { payoutNotes: dto.payoutNotes }),
            ...(dto.notes !== undefined && { notes: dto.notes }),
            ...(dto.active !== undefined && { active: dto.active }),
          },
        });
        await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'concierge_vendor.updated', entityType: 'concierge_vendor', entityId: id, metadata: { changes: Object.keys(dto) }, ip });
        const ent = await this.core.entitlements.getEntitlements(u.tenantId, tx);
        return this.vendorView(v, { vendorsFeature: ent.features.includes('concierge_vendors') });
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw AppException.conflict('A vendor with this name already exists');
      throw e;
    }
  }

  removeVendor(u: AuthUser, id: string, ip?: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const cur = await tx.conciergeVendor.findFirst({ where: { id, tenantId: u.tenantId } });
      if (!cur) throw AppException.notFound('Vendor');
      const refs = (await tx.conciergeRequest.count({ where: { vendorId: id } })) + (await tx.conciergeService.count({ where: { vendorId: id } }));
      if (refs) throw new AppException(HttpStatus.CONFLICT, 'SERVICE_IN_USE', 'Services or requests use this vendor. Switch it off instead (active: false).', { references: refs });
      await tx.conciergeVendor.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'concierge_vendor.deleted', entityType: 'concierge_vendor', entityId: id, metadata: { name: cur.name }, ip });
      return { success: true };
    });
  }

  settle(u: AuthUser, id: string, dto: { requestIds?: string[]; upTo?: string; reference?: string }, ip?: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      await this.core.entitlements.assertFeature(await this.core.entitlements.getEntitlements(u.tenantId, tx), 'concierge_vendors');
      const v = await tx.conciergeVendor.findFirst({ where: { id, tenantId: u.tenantId } });
      if (!v) throw AppException.notFound('Vendor');
      const where: Prisma.ConciergeRequestWhereInput = {
        tenantId: u.tenantId,
        vendorId: id,
        status: 'COMPLETED',
        vendorSettledAt: null,
        ...(dto.requestIds?.length && { id: { in: dto.requestIds } }),
        ...(dto.upTo && { completedAt: { lt: lagosDateTime(addDays(dto.upTo, 1), '00:00') } }),
      };
      const rows = await tx.conciergeRequest.findMany({ where, select: { id: true, vendorPayableKobo: true, commissionKobo: true } });
      if (rows.length) await tx.conciergeRequest.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { vendorSettledAt: new Date(), vendorSettlementRef: dto.reference ?? null } });
      const payableKobo = rows.reduce((a, r) => a + (r.vendorPayableKobo ?? 0), 0);
      const commissionKobo = rows.reduce((a, r) => a + (r.commissionKobo ?? 0), 0);
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'concierge_vendor.settled', entityType: 'concierge_vendor', entityId: id, metadata: { name: v.name, count: rows.length, payableKobo, reference: dto.reference ?? null }, ip });
      return { vendorId: id, settledCount: rows.length, payableKobo, commissionKobo };
    });
  }
}
