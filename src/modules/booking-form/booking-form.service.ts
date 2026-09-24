import { HttpStatus, Injectable } from '@nestjs/common';
import type { BookingForm, BookingFormVersion, FormUpload, Prisma, Reservation } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { assertCan, can } from '../../common/permissions/can.js';
import { runInProperty } from '../../common/property-scope.js';
import { AppException, ErrorCode } from '../../common/errors/app-exception.js';
import { addDays, lagosDate, lagosStartOfDay } from '../../common/time/lagos.js';
import { normalisePhone } from '../../common/utils/phone.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { FORM_FIELD_LIMIT } from '../entitlements/entitlements.constants.js';
import { requiredPlanFor, upgradePlanFor } from '../entitlements/entitlements.logic.js';
import { ExtrasService } from '../extras/extras.service.js';
import { checkPickupDetails, detailsSummary, quoteTransfer, type PickupKindCode, type QuotedTransfer, type StayInfo } from '../extras/extras.logic.js';
import { pointLike } from '../extras/extras.service.js';
import { GuestsService } from '../guests/guests.service.js';
import { Err } from '../ops/ops.helpers.js';
import { publicPickupPoint } from '../site/theme.service.js';
import { issuesError } from './form.errors.js';
import {
  ALL_CHANNELS,
  CHANNELS,
  LIBRARY,
  presetById,
  PRESETS,
  RECOMMENDED_FIELDS,
  SYSTEM_FIELDS,
  type Channel,
  type FormField,
  type PresetId,
} from './form.catalogue.js';
import {
  buildPreset,
  conditionText,
  customFieldCount,
  displayValue,
  formDiff,
  idCheck,
  normaliseFields,
  storable,
  validateAnswers,
  validateBuilder,
  type FormWarning,
  type ValidationIssue,
} from './form.logic.js';
import { FormUploadsService, type StoredFileAnswer } from './form-uploads.service.js';

export interface BookingValidationInput {
  tenantId: string;
  propertyId: string;
  versionId: string | null;
  channel: Channel;
  answers: Record<string, unknown> | undefined;
  paymentMode: 'ONLINE' | 'PAY_AT_HOTEL' | null;
  adults: number;
  children: number;
  guest: { fullName?: string | null; phone?: string | null; email?: string | null } | null;
  consent: boolean | null;
  checkGuest: boolean;
  /** Priced transfers the PICKUP answer must match (quote or desk selection). */
  transfers: QuotedTransfer[];
  /** Check the PICKUP answer against `transfers` (bookings). False for step validation. */
  matchQuote?: boolean;
  /** Null: times are not checked (no dates yet). */
  stay: StayInfo | null;
  enforceLeadTime: boolean;
  hotelPhone: string | null;
}

export interface BookingValidationResult {
  issues: ValidationIssue[];
  stored: Record<string, unknown>;
  uploadIds: string[];
  /** Transfer details from the PICKUP answer, by direction. */
  transferDetails: Map<'ARRIVAL' | 'DEPARTURE', { details: Record<string, unknown>; scheduledAt: string; luggage: number | null; contactPhone: string | null }>;
  version: { id: string; version: number } | null;
  fields: FormField[];
  visible: string[];
}

type FieldWithText = FormField & { conditionText: string | null };

/**
 * The configurable booking form (M7): builder with presets and a library,
 * immutable published versions, plan gates, server-side validation of
 * answers (quotes, bookings, front desk), uploads and answer views.
 */
@Injectable()
export class BookingFormService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly extras: ExtrasService,
    private readonly uploads: FormUploadsService,
    private readonly guests: GuestsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------------------

  private async limitFor(tx: Tx, tenantId: string): Promise<{ features: string[]; max: number; planCode: string }> {
    const ent = await this.entitlements.getEntitlements(tenantId, tx);
    return { features: ent.features, max: ent.features.includes('form_fields_unlimited') ? -1 : (ent.limits[FORM_FIELD_LIMIT] ?? 3), planCode: ent.subscription.planCode };
  }

  /** Finds or creates the property's form (default preset, published as version 1). */
  async ensure(tx: Tx, tenantId: string, propertyId: string): Promise<BookingForm> {
    const found = await tx.bookingForm.findUnique({ where: { propertyId } });
    if (found && found.tenantId === tenantId) return found;
    if (found) throw AppException.notFound('Booking form');
    const { features, max } = await this.limitFor(tx, tenantId);
    const { fields } = buildPreset('default', features, max);
    const stored = fields.map(storable);
    await tx.$executeRaw`INSERT INTO booking_forms (id, tenant_id, property_id, preset_id, draft_fields, draft_updated_at, draft_updated_by_name, created_at, updated_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${propertyId}::uuid, 'default', ${JSON.stringify(stored)}::jsonb, now(), 'System', now(), now())
      ON CONFLICT (property_id) DO NOTHING`;
    const form = await tx.bookingForm.findUniqueOrThrow({ where: { propertyId } });
    if (form.publishedVersionId) return form;
    const v = await tx.bookingFormVersion.create({
      data: { tenantId, propertyId, formId: form.id, version: 1, fields: stored as unknown as Prisma.InputJsonValue, diff: formDiff(fields, null) as unknown as Prisma.InputJsonValue, note: 'Standard form', publishedByName: 'System' },
    });
    return tx.bookingForm.update({ where: { id: form.id }, data: { publishedVersionId: v.id } });
  }

  async publishedVersionTx(tx: Tx, tenantId: string, propertyId: string): Promise<BookingFormVersion> {
    const form = await this.ensure(tx, tenantId, propertyId);
    return tx.bookingFormVersion.findUniqueOrThrow({ where: { id: form.publishedVersionId! } });
  }

  fieldsOf(v: { fields: unknown }): FormField[] {
    return normaliseFields((Array.isArray(v.fields) ? v.fields : []) as FormField[]);
  }

  private withText(fields: FormField[]): FieldWithText[] {
    return fields.map((f) => ({ ...f, conditionText: conditionText(f, fields) }));
  }

  private warnings(fields: FormField[]): FormWarning[] {
    return fields
      .filter((f) => f.source !== 'SYSTEM')
      .map((f) => ({ f, id: idCheck(f.label, f.helpText) }))
      .filter((x) => x.id.level === 'WARN')
      .map((x) => ({ fieldKey: x.f.key, code: 'ID_LIKE' as const, kind: x.id.kind, message: x.id.message!, suggestion: 'COLLECT_AT_CHECK_IN' as const }));
  }

  private versionSummary(v: BookingFormVersion) {
    return {
      id: v.id,
      version: v.version,
      publishedAt: v.publishedAt.toISOString(),
      publishedBy: v.publishedById ? { id: v.publishedById, fullName: v.publishedByName ?? '' } : v.publishedByName ? { id: null, fullName: v.publishedByName } : null,
      note: v.note,
      fieldCount: Array.isArray(v.fields) ? v.fields.length : 0,
    };
  }

  private async gates(tx: Tx, tenantId: string, fields: FormField[]) {
    const ent = await this.entitlements.getEntitlements(tenantId, tx);
    const plans = await this.entitlements.listPlans();
    const list = ['brand_kit', 'site_templates_all', 'site_sections', 'site_fonts', 'form_fields_unlimited', 'form_conditional_logic', 'paid_extras', 'form_file_uploads'];
    return {
      features: Object.fromEntries(list.map((f) => [f, ent.features.includes(f)])),
      requiredPlans: Object.fromEntries(list.map((f) => [f, requiredPlanFor(f, plans) ?? 'enterprise'])),
      limits: { max_custom_form_fields: ent.features.includes('form_fields_unlimited') ? -1 : (ent.limits[FORM_FIELD_LIMIT] ?? 3) },
      usage: { customFormFields: customFieldCount(fields) },
    };
  }

  private async stateTx(tx: Tx, tenantId: string, propertyId: string, extraWarnings: FormWarning[] = []) {
    const form = await this.ensure(tx, tenantId, propertyId);
    const draft = this.fieldsOf({ fields: form.draftFields });
    const v = form.publishedVersionId ? await tx.bookingFormVersion.findUnique({ where: { id: form.publishedVersionId } }) : null;
    const published = v ? this.fieldsOf(v) : null;
    const diff = formDiff(draft, published);
    return {
      id: form.id,
      propertyId,
      presetId: form.presetId,
      draft: {
        fields: this.withText(draft),
        updatedAt: form.draftUpdatedAt.toISOString(),
        updatedBy: form.draftUpdatedById ? { id: form.draftUpdatedById, fullName: form.draftUpdatedByName ?? '' } : form.draftUpdatedByName ? { id: null, fullName: form.draftUpdatedByName } : null,
      },
      published: v ? this.versionSummary(v) : null,
      hasUnpublishedChanges: !published || diff.added.length + diff.removed.length + diff.changed.length > 0 || diff.summary.includes('order'),
      diff,
      warnings: [...this.warnings(draft), ...extraWarnings],
      gates: await this.gates(tx, tenantId, draft),
    };
  }

  private propertyOf(u: AuthUser): string {
    if (!u.propertyId) throw AppException.notFound('Property');
    return u.propertyId;
  }

  // ---------------------------------------------------------------------------
  // Builder
  // ---------------------------------------------------------------------------

  state(u: AuthUser) {
    const pid = this.propertyOf(u);
    return this.db.tenant(u.tenantId, (tx) => this.stateTx(tx, u.tenantId, pid));
  }

  library(u: AuthUser) {
    const pid = this.propertyOf(u);
    return this.db.tenant(u.tenantId, async (tx) => {
      const form = await this.ensure(tx, u.tenantId, pid);
      const draft = this.fieldsOf({ fields: form.draftFields });
      const keys = new Set(draft.map((f) => f.key));
      const { features } = await this.limitFor(tx, u.tenantId);
      const norm = (list: FormField[]) => normaliseFields(list.map((f, i) => ({ ...f, order: i }))).filter((f) => list.some((x) => x.key === f.key));
      return {
        system: norm(SYSTEM_FIELDS),
        recommended: norm(RECOMMENDED_FIELDS),
        library: LIBRARY.map((l) => ({
          libraryKey: l.libraryKey,
          name: l.name,
          description: l.description,
          fields: norm(l.fields),
          feature: l.feature,
          available: !l.feature || features.includes(l.feature),
          alreadyAdded: l.fields.every((f) => keys.has(f.key)),
        })),
        customTypes: (['SHORT_TEXT', 'LONG_TEXT', 'NUMBER', 'DATE', 'TIME', 'SELECT', 'MULTI_SELECT', 'YES_NO', 'CHECKBOX', 'PHONE', 'EMAIL', 'FILE'] as const).map((type) => ({
          type,
          label: TYPE_LABELS[type],
          feature: type === 'FILE' ? 'form_file_uploads' : null,
          available: type !== 'FILE' || features.includes('form_file_uploads'),
        })),
        sections: ['About you', 'Your stay', 'Getting here', 'Extras'],
        channels: [...CHANNELS],
      };
    });
  }

  presets() {
    return PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      hotelType: p.hotelType,
      description: p.description,
      suggestedTemplateId: p.suggestedTemplateId,
      fieldKeys: p.library.flatMap((k) => LIBRARY.find((l) => l.libraryKey === k)?.fields.map((f) => f.key) ?? []),
      customFields: p.custom.map((f) => f.label),
    }));
  }

  /** Builder checks + plan gates; throws on the first gate, returns warnings. */
  private async checkBuilder(tx: Tx, tenantId: string, fields: FormField[]) {
    const { features, max, planCode } = await this.limitFor(tx, tenantId);
    const r = validateBuilder(fields, features);
    if (r.issues.length) throw issuesError(r.issues);
    if (r.lockedFeature) {
      const ent = await this.entitlements.getEntitlements(tenantId, tx);
      await this.entitlements.assertFeature(ent, r.lockedFeature);
    }
    if (max >= 0 && r.customCount > max) {
      const plans = await this.entitlements.listPlans();
      throw new AppException(HttpStatus.FORBIDDEN, ErrorCode.LIMIT_REACHED, `Your plan allows ${max} extra questions in the booking form; this form has ${r.customCount}`, {
        limit: FORM_FIELD_LIMIT,
        max,
        current: r.customCount,
        upgradePlan: plans.find((p) => p.isActive && p.code !== planCode && p.features.includes('form_fields_unlimited') && p.sortOrder > (plans.find((x) => x.code === planCode)?.sortOrder ?? 0))?.code ?? upgradePlanFor(FORM_FIELD_LIMIT, r.customCount, planCode, plans),
      });
    }
    return r.warnings;
  }

  async saveDraft(u: AuthUser, input: Partial<FormField>[], ip?: string) {
    const pid = this.propertyOf(u);
    if (!Array.isArray(input)) throw Err.validation('fields', 'fields must be a list');
    const fields = normaliseFields(input);
    return this.db.tenant(u.tenantId, async (tx) => {
      const form = await this.ensure(tx, u.tenantId, pid);
      await this.checkBuilder(tx, u.tenantId, fields);
      await this.checkPickupPoints(tx, u.tenantId, pid, fields);
      await tx.bookingForm.update({ where: { id: form.id }, data: { draftFields: fields.map(storable) as unknown as Prisma.InputJsonValue, draftUpdatedAt: new Date(), draftUpdatedById: u.userId, draftUpdatedByName: u.fullName } });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'booking_form.draft_saved', entityType: 'booking_form', entityId: form.id, metadata: { fields: fields.length }, ip });
      return this.stateTx(tx, u.tenantId, pid);
    });
  }

  private async checkPickupPoints(tx: Tx, tenantId: string, propertyId: string, fields: FormField[]) {
    const ids = fields.flatMap((f) => f.pickup?.pickupPointIds ?? []);
    if (!ids.length) return;
    const n = await tx.pickupPoint.count({ where: { tenantId, propertyId, id: { in: ids } } });
    if (n !== new Set(ids).size) {
      const i = fields.findIndex((f) => f.pickup?.pickupPointIds?.length);
      throw issuesError([{ path: `fields[${i}].pickup.pickupPointIds`, fieldKey: fields[i]?.key ?? null, code: 'INVALID_OPTION', message: 'Unknown pickup point' }]);
    }
  }

  checkLabel(label: string, helpText?: string) {
    return idCheck(label, helpText);
  }

  async resetToPreset(u: AuthUser, presetId: string, ip?: string) {
    const pid = this.propertyOf(u);
    if (!presetById(presetId)) throw Err.validation('presetId', `Choose one of: ${PRESETS.map((p) => p.id).join(', ')}`);
    return this.db.tenant(u.tenantId, (tx) => this.resetToPresetTx(tx, u, pid, presetId as PresetId, ip));
  }

  async resetToPresetTx(tx: Tx, u: AuthUser, pid: string, presetId: PresetId, ip?: string) {
    const form = await this.ensure(tx, u.tenantId, pid);
    const { features, max } = await this.limitFor(tx, u.tenantId);
    const { fields, skipped } = buildPreset(presetId, features, max);
    await tx.bookingForm.update({ where: { id: form.id }, data: { presetId, draftFields: fields.map(storable) as unknown as Prisma.InputJsonValue, draftUpdatedAt: new Date(), draftUpdatedById: u.userId, draftUpdatedByName: u.fullName } });
    await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'booking_form.preset_applied', entityType: 'booking_form', entityId: form.id, metadata: { presetId, skipped }, ip });
    return this.stateTx(tx, u.tenantId, pid, skipped.map((k) => ({ fieldKey: k, code: 'PRESET_FIELD_SKIPPED' as const, kind: null, message: `${LIBRARY.find((l) => l.libraryKey === k)?.name ?? k} is not included in your plan`, suggestion: null })));
  }

  async publish(u: AuthUser, note: string | undefined, ip?: string) {
    const pid = this.propertyOf(u);
    return this.db.tenant(u.tenantId, (tx) => this.publishTx(tx, u, pid, note, ip));
  }

  async publishTx(tx: Tx, u: AuthUser, pid: string, note: string | undefined, ip?: string, opts: { allowUnchanged?: boolean } = {}) {
    const form = await this.ensure(tx, u.tenantId, pid);
    const draft = this.fieldsOf({ fields: form.draftFields });
    await this.checkBuilder(tx, u.tenantId, draft);
    const current = form.publishedVersionId ? await tx.bookingFormVersion.findUnique({ where: { id: form.publishedVersionId } }) : null;
    const published = current ? this.fieldsOf(current) : null;
    const diff = formDiff(draft, published);
    const unchanged = published && JSON.stringify(draft.map(storable)) === JSON.stringify(published.map(storable));
    if (unchanged) {
      if (opts.allowUnchanged) return { state: await this.stateTx(tx, u.tenantId, pid), version: this.versionSummary(current!), diff };
      throw new AppException(HttpStatus.CONFLICT, 'NOTHING_TO_PUBLISH', 'The draft is the same as the published form');
    }
    const last = await tx.bookingFormVersion.findFirst({ where: { formId: form.id }, orderBy: { version: 'desc' }, select: { version: true } });
    const v = await tx.bookingFormVersion.create({
      data: {
        tenantId: u.tenantId,
        propertyId: pid,
        formId: form.id,
        version: (last?.version ?? 0) + 1,
        fields: draft.map(storable) as unknown as Prisma.InputJsonValue,
        diff: diff as unknown as Prisma.InputJsonValue,
        note: note ?? null,
        publishedById: u.userId,
        publishedByName: u.fullName,
      },
    });
    await tx.bookingForm.update({ where: { id: form.id }, data: { publishedVersionId: v.id } });
    await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'booking_form.published', entityType: 'booking_form', entityId: form.id, metadata: { version: v.version, summary: diff.summary, ...(note && { note }) }, ip });
    return { state: await this.stateTx(tx, u.tenantId, pid), version: this.versionSummary(v), diff };
  }

  async discard(u: AuthUser) {
    const pid = this.propertyOf(u);
    return this.db.tenant(u.tenantId, async (tx) => {
      const form = await this.ensure(tx, u.tenantId, pid);
      const v = await tx.bookingFormVersion.findUniqueOrThrow({ where: { id: form.publishedVersionId! } });
      await tx.bookingForm.update({ where: { id: form.id }, data: { draftFields: v.fields as Prisma.InputJsonValue, draftUpdatedAt: new Date(), draftUpdatedById: u.userId, draftUpdatedByName: u.fullName } });
      return this.stateTx(tx, u.tenantId, pid);
    });
  }

  versions(u: AuthUser) {
    const pid = this.propertyOf(u);
    return this.db.tenant(u.tenantId, async (tx) => {
      const form = await this.ensure(tx, u.tenantId, pid);
      return (await tx.bookingFormVersion.findMany({ where: { formId: form.id }, orderBy: { version: 'desc' } })).map((v) => this.versionSummary(v));
    });
  }

  version(u: AuthUser, id: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const v = await tx.bookingFormVersion.findFirst({ where: { id, tenantId: u.tenantId } });
      if (!v) throw AppException.notFound('Form version');
      return { ...this.versionSummary(v), fields: this.withText(this.fieldsOf(v)), diff: v.diff };
    });
  }

  restore(u: AuthUser, id: string, ip?: string) {
    const pid = this.propertyOf(u);
    return this.db.tenant(u.tenantId, async (tx) => {
      const form = await this.ensure(tx, u.tenantId, pid);
      const v = await tx.bookingFormVersion.findFirst({ where: { id, formId: form.id } });
      if (!v) throw AppException.notFound('Form version');
      await tx.bookingForm.update({ where: { id: form.id }, data: { draftFields: v.fields as Prisma.InputJsonValue, draftUpdatedAt: new Date(), draftUpdatedById: u.userId, draftUpdatedByName: u.fullName } });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'booking_form.version_restored', entityType: 'booking_form', entityId: form.id, metadata: { version: v.version }, ip });
      return this.stateTx(tx, u.tenantId, pid);
    });
  }

  // ---------------------------------------------------------------------------
  // Rendering (public, preview, front desk)
  // ---------------------------------------------------------------------------

  /** The form as a guest (or the desk) sees it on a channel. */
  async renderTx(tx: Tx, tenantId: string, propertyId: string, channel: Channel, source: 'published' | 'draft') {
    const form = await this.ensure(tx, tenantId, propertyId);
    let version: BookingFormVersion | null = null;
    let fields: FormField[];
    if (source === 'draft') fields = this.fieldsOf({ fields: form.draftFields });
    else {
      version = await tx.bookingFormVersion.findUniqueOrThrow({ where: { id: form.publishedVersionId! } });
      fields = this.fieldsOf(version);
    }
    const ent = await this.entitlements.getEntitlements(tenantId, tx);
    const offered = ent.features.includes('paid_extras');
    const shown = fields.filter((f) => f.required !== 'HIDDEN' && f.channels.includes(channel) && ((f.type !== 'EXTRA' && f.type !== 'PICKUP') || offered));
    const sectionOrder: string[] = [];
    for (const f of shown) if (!sectionOrder.includes(f.section)) sectionOrder.push(f.section);
    const extraField = shown.find((f) => f.type === 'EXTRA');
    const pickupField = shown.find((f) => f.type === 'PICKUP');
    const extras = extraField
      ? (await tx.extra.findMany({ where: { tenantId, propertyId, active: true, channels: { has: channel }, ...(extraField.extra?.categories?.length && { category: { in: extraField.extra.categories } }) }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })).map((e) => ({
          id: e.id, name: e.name, description: e.description, imageUrl: e.imageUrl, category: e.category, kind: e.kind, pricing: e.pricing, priceKobo: e.priceKobo, maxUnits: e.maxUnits, taxable: e.taxable, availability: e.availability, available: null, unavailableReason: null, price: null,
        }))
      : [];
    const pickup = pickupField
      ? {
          points: (await tx.pickupPoint.findMany({ where: { tenantId, propertyId, active: true, ...(pickupField.pickup?.pickupPointIds?.length && { id: { in: pickupField.pickup.pickupPointIds } }) }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })).map(publicPickupPoint),
          transportCompanies: await this.extras.companiesTx(tx, tenantId),
          trainRoutes: await this.extras.trainRoutes(),
        }
      : null;
    const maxMb = Math.max(0, ...shown.filter((f) => f.type === 'FILE').map((f) => f.validation.maxFileMB ?? 5));
    return {
      formVersionId: version?.id ?? null,
      version: version?.version ?? null,
      preview: source === 'draft',
      channel,
      sections: sectionOrder.map((name, order) => ({ name, order, fieldKeys: shown.filter((f) => f.section === name).map((f) => f.key) })),
      fields: shown.map((f) => {
        const { locked: _l, purpose: _p, idLike: _i, ...rest } = f;
        void _l;
        void _p;
        void _i;
        return { ...rest, conditionText: null };
      }),
      rules: { emailRequiredFor: fields.find((f) => f.key === 'email')?.required === 'REQUIRED' ? ['ONLINE', 'PAY_AT_HOTEL'] : ['ONLINE'], phoneDefaultCountry: '+234', consentRequired: channel !== 'FRONT_DESK' },
      extras,
      pickup,
      uploads: { enabled: shown.some((f) => f.type === 'FILE') && ent.features.includes('form_file_uploads'), maxFileMB: maxMb || 5 },
    };
  }

  render(u: AuthUser, channel: Channel, source: 'published' | 'draft') {
    if (source === 'draft') assertCan(u, 'forms.manage', 'Only staff who manage the booking form can preview the draft');
    const pid = this.propertyOf(u);
    return this.db.tenant(u.tenantId, (tx) => this.renderTx(tx, u.tenantId, pid, channel, source));
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /**
   * Validates a booking's answers against a published version (or the
   * current one): unknown keys, visibility, required, types, files, and the
   * PICKUP block against the priced transfers.
   */
  async validateForBooking(tx: Tx, input: BookingValidationInput, draft = false): Promise<BookingValidationResult> {
    let version: BookingFormVersion | null = null;
    let fields: FormField[];
    if (draft) {
      const form = await this.ensure(tx, input.tenantId, input.propertyId);
      fields = this.fieldsOf({ fields: form.draftFields });
    } else {
      version = input.versionId
        ? await tx.bookingFormVersion.findFirst({ where: { id: input.versionId, tenantId: input.tenantId, propertyId: input.propertyId } })
        : await this.publishedVersionTx(tx, input.tenantId, input.propertyId);
      if (!version) version = await this.publishedVersionTx(tx, input.tenantId, input.propertyId);
      fields = this.fieldsOf(version);
    }
    const uploadIds: string[] = [];
    const transferDetails: BookingValidationResult['transferDetails'] = new Map();
    const pickupPromises: Promise<void>[] = [];
    const complexResults = new Map<string, { value?: unknown; issues: ValidationIssue[] }>();
    // FILE and PICKUP need the database: pre-validate them, then feed the sync validator.
    const answers = input.answers ?? {};
    for (const f of fields) {
      const raw = answers[f.key];
      if (f.type === 'FILE' && raw !== undefined && raw !== null && raw !== '') {
        pickupPromises.push(
          this.uploads.check(tx, input.tenantId, input.propertyId, f, raw, `answers.${f.key}`).then((r) => {
            complexResults.set(f.key, r);
          }),
        );
      }
    }
    for (const p of pickupPromises) await p;
    const pickupField = fields.find((f) => f.type === 'PICKUP');
    let pickupCheck: { value?: unknown; issues: ValidationIssue[] } | null = null;
    if (pickupField) pickupCheck = await this.checkPickup(tx, input, pickupField, answers[pickupField.key]);

    const result = validateAnswers(fields, answers, {
      channel: input.channel,
      paymentMode: input.paymentMode,
      adults: input.adults,
      children: input.children,
      guest: input.guest,
      consent: input.consent,
      checkGuest: input.checkGuest,
      today: lagosDate(),
      complex: (f, value, path) => {
        if (f.type === 'FILE') {
          if (value === undefined) return { issues: [] };
          return complexResults.get(f.key) ?? { issues: [{ path, fieldKey: f.key, code: 'FILE_INVALID', message: `${f.label}: upload the file again` }] };
        }
        if (f.type === 'PICKUP') return pickupCheck ?? { issues: [] };
        return { issues: [] };
      },
    });
    const issues = [...result.issues];
    // Priced transfers without a visible PICKUP block (and no answer) are a mismatch.
    const pickupVisible = pickupField && result.visible.includes(pickupField.key);
    if (input.transfers.length && !pickupVisible && input.channel !== 'FRONT_DESK') {
      issues.push({ path: 'transfers', fieldKey: pickupField?.key ?? null, code: 'NOT_AVAILABLE', message: 'This booking form does not offer pickups' });
    }
    for (const [k, v] of Object.entries(result.stored)) {
      const f = fields.find((x) => x.key === k);
      if (f?.type === 'FILE') uploadIds.push((v as StoredFileAnswer).uploadId);
      if (f?.type === 'PICKUP') {
        const p = v as { wanted: boolean; scheduledAt?: string; details?: Record<string, unknown>; luggage?: number | null; contactPhone?: string | null; departure?: { wanted: boolean; scheduledAt?: string } | null };
        if (p.wanted && p.scheduledAt) transferDetails.set('ARRIVAL', { details: p.details ?? {}, scheduledAt: p.scheduledAt, luggage: p.luggage ?? null, contactPhone: p.contactPhone ?? null });
        if (p.departure?.wanted && p.departure.scheduledAt) transferDetails.set('DEPARTURE', { details: {}, scheduledAt: p.departure.scheduledAt, luggage: p.luggage ?? null, contactPhone: p.contactPhone ?? null });
      }
    }
    return { issues, stored: result.stored, uploadIds, transferDetails, version: version ? { id: version.id, version: version.version } : null, fields, visible: result.visible };
  }

  /**
   * The PICKUP block: kind-specific details, times re-validated (lead time,
   * operating hours, window) and, for bookings, matching the priced transfers
   * (point, vehicle, passengers, directions).
   */
  private async checkPickup(tx: Tx, input: BookingValidationInput, f: FormField, raw: unknown): Promise<{ value?: unknown; issues: ValidationIssue[] }> {
    const path = `answers.${f.key}`;
    const issues: ValidationIssue[] = [];
    const add = (sub: string, code: string, message: string, meta?: Record<string, unknown>) => issues.push({ path: sub ? `${path}.${sub}` : path, fieldKey: f.key, code, message, ...(meta && { meta }) });
    const match = input.matchQuote !== false;
    const quotedArr = input.transfers.find((t) => t.direction === 'ARRIVAL');
    const quotedDep = input.transfers.find((t) => t.direction === 'DEPARTURE');
    if (raw === undefined || raw === null) {
      if (match && input.transfers.length) add('', 'QUOTE_MISMATCH', 'Add the pickup details (where and when we meet you)');
      return { issues };
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      add('', 'TYPE', 'The pickup answer is not in the expected format');
      return { issues };
    }
    const a = raw as Record<string, unknown>;
    if (a.wanted !== true) {
      if (match && quotedArr) add('wanted', 'QUOTE_MISMATCH', "Your price includes a pickup: tick \"I'd like a pickup\" or check the price again without it");
      if (match && quotedDep && !quotedArr) add('departure', 'QUOTE_MISMATCH', 'Your price includes a drop-off: check the price again without it');
      return { value: { wanted: false }, issues };
    }
    const dirs = f.pickup?.directions ?? ['ARRIVAL', 'DEPARTURE'];
    if (!dirs.includes('ARRIVAL')) add('wanted', 'NOT_AVAILABLE', 'Arrival pickups are not offered');
    const allowedIds = f.pickup?.pickupPointIds ?? null;
    const pointId = typeof a.pickupPointId === 'string' ? a.pickupPointId : '';
    const point = pointId ? await tx.pickupPoint.findFirst({ where: { id: pointId, tenantId: input.tenantId, propertyId: input.propertyId, active: true } }) : null;
    if (!point || (allowedIds && !allowedIds.includes(point.id))) {
      add('pickupPointId', 'INVALID_OPTION', 'Choose where we should pick you up');
      return { issues };
    }
    const vehicleOptionId = a.vehicleOptionId === undefined ? (quotedArr?.vehicleOptionId ?? null) : ((a.vehicleOptionId as string | null) ?? null);
    const passengers = typeof a.passengers === 'number' ? a.passengers : (quotedArr?.passengers ?? 1);
    if (match) {
      if (!quotedArr || quotedArr.pickupPointId !== point.id || (quotedArr.vehicleOptionId ?? null) !== vehicleOptionId) {
        add('pickupPointId', 'QUOTE_MISMATCH', 'Your pickup changed since the price was calculated: check the price again');
        return { issues };
      }
      if (passengers !== quotedArr.passengers) add('passengers', 'QUOTE_MISMATCH', 'The number of passengers changed: check the price again');
    }
    const luggage = a.luggage === undefined || a.luggage === null ? null : Number(a.luggage);
    if (luggage !== null && (!Number.isInteger(luggage) || luggage < 0 || luggage > 20)) add('luggage', 'MAX', 'Luggage is 0 to 20 bags', { max: 20 });
    let contactPhone: string | null = null;
    if (typeof a.contactPhone === 'string' && a.contactPhone.trim()) {
      contactPhone = normalisePhone(a.contactPhone);
      if (!contactPhone) add('contactPhone', 'INVALID_PHONE', 'Enter a valid phone number for the day, e.g. 0803 123 4567');
    }
    const scheduledAt = typeof a.scheduledAt === 'string' ? a.scheduledAt : (quotedArr?.scheduledAt ?? '');
    if (!scheduledAt) add('scheduledAt', 'REQUIRED', 'Tell us when you expect to arrive');
    else if (input.stay) {
      const timing = quoteTransfer(pointLike(point), { direction: 'ARRIVAL', pickupPointId: point.id, vehicleOptionId, passengers, scheduledAt }, input.stay, [], path, new Date(), { enforceLeadTime: input.enforceLeadTime, hotelPhone: input.hotelPhone });
      issues.push(...timing.issues.map((i) => ({ ...i, fieldKey: f.key })));
    }
    const companyList = await this.extras.companiesTx(tx, input.tenantId);
    const routeList = await this.extras.trainRoutes();
    const det = checkPickupDetails(point.kind as PickupKindCode, a.details, `${path}.details`, { transportCompanyIds: new Set(companyList.map((c) => c.id)), trainRouteIds: new Set(routeList.map((r) => r.id)) });
    issues.push(...det.issues.map((i) => ({ ...i, fieldKey: f.key })));
    const details: Record<string, unknown> = { ...det.value };
    if (typeof details.transportCompanyId === 'string') details.transportCompanyName = companyList.find((c) => c.id === details.transportCompanyId)?.name ?? null;
    if (typeof details.trainRouteId === 'string') details.trainRouteName = routeList.find((r) => r.id === details.trainRouteId)?.name ?? null;
    // Departure drop-off.
    let departure: Record<string, unknown> | null = null;
    const d = a.departure && typeof a.departure === 'object' ? (a.departure as Record<string, unknown>) : null;
    if (d?.wanted === true) {
      if (!dirs.includes('DEPARTURE')) add('departure', 'NOT_AVAILABLE', 'Departure drop-offs are not offered');
      const same = d.sameAsArrival !== false;
      const depPoint = same ? point.id : typeof d.pickupPointId === 'string' ? d.pickupPointId : '';
      if (match && (!quotedDep || quotedDep.pickupPointId !== depPoint)) add('departure', 'QUOTE_MISMATCH', 'Your drop-off changed since the price was calculated: check the price again');
      const depAt = typeof d.scheduledAt === 'string' ? d.scheduledAt : quotedDep?.scheduledAt;
      if (!depAt) add('departure.scheduledAt', 'REQUIRED', 'Tell us when to pick you up at the hotel');
      else if (input.stay) {
        const p2 = depPoint === point.id ? point : await tx.pickupPoint.findFirst({ where: { id: depPoint, tenantId: input.tenantId, propertyId: input.propertyId } });
        const t2 = quoteTransfer(p2 ? pointLike(p2) : null, { direction: 'DEPARTURE', pickupPointId: depPoint, vehicleOptionId: quotedDep?.vehicleOptionId ?? (same ? vehicleOptionId : null), passengers: quotedDep?.passengers ?? passengers, scheduledAt: depAt }, input.stay, [], `${path}.departure`, new Date(), { enforceLeadTime: input.enforceLeadTime, hotelPhone: input.hotelPhone });
        issues.push(...t2.issues.map((i) => ({ ...i, fieldKey: f.key })));
      }
      departure = { wanted: true, sameAsArrival: same, pickupPointId: depPoint, scheduledAt: depAt ?? null };
    } else if (match && quotedDep) {
      add('departure', 'QUOTE_MISMATCH', 'Your price includes a drop-off: add it or check the price again without it');
    }
    const summary = [point.shortName || point.name, detailsSummary(point.kind as PickupKindCode, details, { company: (details.transportCompanyName as string) ?? null, route: (details.trainRouteName as string) ?? null })].filter(Boolean).join(': ');
    return {
      value: { wanted: true, pickupPointId: point.id, vehicleOptionId, passengers, luggage, contactPhone, scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null, details, departure, summary },
      issues,
    };
  }

  /** Staff dry run (`POST /booking-form/validate`). */
  validateForStaff(u: AuthUser, dto: { channel: Channel; source?: 'published' | 'draft'; answers?: Record<string, unknown>; paymentMode?: 'ONLINE' | 'PAY_AT_HOTEL'; adults?: number; children?: number; guest?: { fullName?: string; phone?: string; email?: string } }) {
    const pid = this.propertyOf(u);
    if (!(ALL_CHANNELS as string[]).includes(dto.channel)) throw Err.validation('channel', 'Unknown channel');
    return this.db.tenant(u.tenantId, async (tx) => {
      const r = await this.validateForBooking(
        tx,
        {
          tenantId: u.tenantId, propertyId: pid, versionId: null, channel: dto.channel, answers: dto.answers, paymentMode: dto.paymentMode ?? null,
          adults: dto.adults ?? 1, children: dto.children ?? 0, guest: dto.guest ?? null, consent: true, checkGuest: !!dto.guest, transfers: [],
          matchQuote: false, stay: null, enforceLeadTime: false, hotelPhone: null,
        },
        dto.source === 'draft',
      );
      return { valid: r.issues.length === 0, issues: r.issues, visibleKeys: r.visible };
    });
  }

  /** Public step validation (`POST /public/hotels/:slug/booking-form/validate`); never throws for answer problems. */
  publicValidate(
    ref: { id: string; tenantId: string },
    dto: { channel: Channel; answers?: Record<string, unknown>; paymentMode?: 'ONLINE' | 'PAY_AT_HOTEL'; adults?: number; children?: number; guest?: { fullName?: string; phone?: string; email?: string }; consent?: boolean },
    stay: StayInfo | null,
    draft: boolean,
  ) {
    return runInProperty(ref.tenantId, ref.id, () =>
      this.db.tenant(ref.tenantId, async (tx) => {
        const p = await tx.property.findFirstOrThrow({ where: { id: ref.id } });
        const r = await this.validateForBooking(
          tx,
          {
            tenantId: ref.tenantId, propertyId: ref.id, versionId: null, channel: dto.channel, answers: dto.answers, paymentMode: dto.paymentMode ?? null,
            adults: dto.adults ?? 1, children: dto.children ?? 0, guest: dto.guest ?? null, consent: dto.consent ?? null, checkGuest: !!dto.guest, transfers: [],
            matchQuote: false, stay, enforceLeadTime: true, hotelPhone: p.phone || null,
          },
          draft,
        );
        return { valid: r.issues.length === 0, issues: r.issues, visibleKeys: r.visible };
      }),
    );
  }

  /** Public form (`GET /public/hotels/:slug/booking-form`). */
  publicRender(ref: { id: string; tenantId: string }, channel: Channel, draft: boolean) {
    return runInProperty(ref.tenantId, ref.id, () => this.db.tenant(ref.tenantId, (tx) => this.renderTx(tx, ref.tenantId, ref.id, channel, draft ? 'draft' : 'published')));
  }

  // ---------------------------------------------------------------------------
  // Answers views
  // ---------------------------------------------------------------------------

  async answersTx(tx: Tx, r: Pick<Reservation, 'id' | 'tenantId' | 'formVersionId' | 'formAnswers' | 'formChannel' | 'formSubmittedAt'>, opts: { staff: boolean; includeSensitive: boolean }) {
    if (!r.formVersionId || !r.formAnswers) return null;
    const v = await tx.bookingFormVersion.findFirst({ where: { id: r.formVersionId, tenantId: r.tenantId } });
    if (!v) return null;
    const fields = this.fieldsOf(v);
    const answers = r.formAnswers as Record<string, unknown>;
    const uploads = opts.staff ? await tx.formUpload.findMany({ where: { tenantId: r.tenantId, reservationId: r.id, status: 'ATTACHED' } }) : [];
    const byUpload = new Map<string, FormUpload>(uploads.map((u) => [u.id, u]));
    const list = [];
    for (const f of fields) {
      if (!(f.key in answers)) continue;
      if (f.sensitive && !opts.includeSensitive) continue;
      const value = answers[f.key];
      const file = f.type === 'FILE' ? (value as StoredFileAnswer) : null;
      const up = file ? byUpload.get(file.uploadId) : undefined;
      list.push({
        key: f.key,
        label: f.label,
        type: f.type,
        section: f.section,
        source: f.source,
        value,
        display: displayValue(f, value),
        sensitive: f.sensitive,
        mapsTo: f.mapsTo ?? null,
        ...(file && { file: { name: file.name, contentType: file.contentType, size: file.size, ...(up && { url: this.uploads.url(up) }) } }),
      });
    }
    return { formVersionId: v.id, version: v.version, channel: (r.formChannel ?? 'BOOKING_SITE') as Channel, submittedAt: (r.formSubmittedAt ?? v.publishedAt).toISOString(), answers: list };
  }

  /** Register-card pre-fill from mapped answers. */
  static registerPrefill(answers: Record<string, unknown> | null) {
    const a = answers ?? {};
    const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const purpose = s(a.purposeOfVisit);
    return {
      arrivingFrom: null as string | null,
      purpose: purpose && ['BUSINESS', 'LEISURE', 'EVENT', 'TRANSIT', 'OTHER'].includes(purpose) ? purpose : null,
      vehiclePlate: s(a.vehiclePlate),
      nationality: s(a.nationality),
      address: s(a.homeAddress),
      dateOfBirth: s(a.dateOfBirth),
    };
  }

  static billTo(answers: Record<string, unknown> | null): { companyName: string; tin: string | null } | null {
    const a = answers ?? {};
    return typeof a.companyName === 'string' && a.companyName ? { companyName: a.companyName, tin: typeof a.companyTin === 'string' && a.companyTin ? a.companyTin : null } : null;
  }

  /** Fills EMPTY guest fields from mapped answers (never overwrites). */
  async applyToGuest(tx: Tx, tenantId: string, guestId: string, stored: Record<string, unknown>) {
    const g = await tx.guest.findFirst({ where: { id: guestId, tenantId } });
    if (!g) return;
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const data: Prisma.GuestUpdateInput = {};
    if (s(stored.nationality) && (!g.nationality || g.nationality === 'Nigerian') && stored.nationality !== 'Other') data.nationality = s(stored.nationality)!;
    if (s(stored.dateOfBirth) && !g.dateOfBirth) data.dateOfBirth = new Date(`${s(stored.dateOfBirth)}T00:00:00Z`);
    if (s(stored.homeAddress) && !g.address) data.address = s(stored.homeAddress);
    if (s(stored.vehiclePlate) && !g.vehiclePlate) data.vehiclePlate = s(stored.vehiclePlate)!.toUpperCase();
    if (s(stored.companyName) && !g.company) data.company = s(stored.companyName);
    if (stored.marketingConsent === true && !g.marketingOptIn) data.marketingOptIn = true;
    if (Object.keys(data).length) await tx.guest.update({ where: { id: guestId }, data });
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  exportAnswers(u: AuthUser, q: { from: string; to: string; format?: 'csv' | 'json' }) {
    const pid = this.propertyOf(u);
    const withSensitive = can(u, 'guests.export');
    return this.db.tenant(u.tenantId, async (tx) => {
      const rows = await tx.reservation.findMany({
        where: { tenantId: u.tenantId, propertyId: pid, arrivalAt: { gte: lagosStartOfDay(q.from), lt: lagosStartOfDay(addDays(q.to, 1)) } },
        include: { guest: { select: { fullName: true, phone: true, email: true } } },
        orderBy: { arrivalAt: 'asc' },
        take: 5000,
      });
      const versionIds = [...new Set(rows.map((r) => r.formVersionId).filter((x): x is string => !!x))];
      const versions = await tx.bookingFormVersion.findMany({ where: { id: { in: versionIds } } });
      const fieldsByVersion = new Map(versions.map((v) => [v.id, this.fieldsOf(v)]));
      const columns = new Map<string, { label: string; sensitive: boolean }>();
      for (const v of versions) for (const f of this.fieldsOf(v)) if (f.source !== 'SYSTEM' && f.type !== 'EXTRA' && !columns.has(f.key)) columns.set(f.key, { label: f.label, sensitive: f.sensitive });
      const ids = rows.map((r) => r.id);
      const extras = await tx.reservationExtra.findMany({ where: { tenantId: u.tenantId, reservationId: { in: ids }, status: 'ACTIVE' } });
      const transfers = await tx.transfer.findMany({ where: { tenantId: u.tenantId, reservationId: { in: ids }, status: { not: 'CANCELLED' } } });
      const items = rows.map((r) => {
        const answers = (r.formAnswers ?? {}) as Record<string, unknown>;
        const fields = r.formVersionId ? (fieldsByVersion.get(r.formVersionId) ?? []) : [];
        const out: Record<string, unknown> = {
          code: r.code,
          status: r.status,
          source: r.source,
          arrivalDate: lagosDate(r.arrivalAt),
          departureDate: lagosDate(r.departureAt),
          guestName: r.guest.fullName,
          phone: r.contactPhone ?? r.guest.phone,
          email: r.contactEmail ?? r.guest.email,
        };
        for (const [key, col] of columns) {
          const f = fields.find((x) => x.key === key);
          const v = answers[key];
          out[key] = v === undefined ? '' : col.sensitive && !withSensitive ? '***' : displayValue(f, v);
        }
        out.extras = extras.filter((e) => e.reservationId === r.id).map((e) => e.description).join('; ');
        out.transfers = transfers.filter((t) => t.reservationId === r.id).map((t) => `${t.direction === 'ARRIVAL' ? 'Pickup' : 'Drop-off'} ${t.pickupPointName} ${t.status}`).join('; ');
        return out;
      });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'booking_form.answers_exported', entityType: 'booking_form', metadata: { from: q.from, to: q.to, rows: items.length, sensitive: withSensitive }, propertyId: pid });
      const header = ['code', 'status', 'source', 'arrivalDate', 'departureDate', 'guestName', 'phone', 'email', ...columns.keys(), 'extras', 'transfers'];
      const labels = ['Code', 'Status', 'Source', 'Arrival', 'Departure', 'Guest', 'Phone', 'Email', ...[...columns.values()].map((c) => c.label), 'Extras', 'Transfers'];
      return { from: q.from, to: q.to, columns: header.map((key, i) => ({ key, label: labels[i] })), items };
    });
  }

  static toCsv(data: { columns: { key: string; label: string }[]; items: Record<string, unknown>[] }): string {
    const esc = (v: unknown) => {
      let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v as string | number | boolean);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [data.columns.map((c) => esc(c.label)).join(',')];
    for (const row of data.items) lines.push(data.columns.map((c) => esc(row[c.key])).join(','));
    return `﻿${lines.join('\r\n')}\r\n`;
  }

  /** Public-side helper: the published version and fields for a property. */
  async publishedFor(tenantId: string, propertyId: string) {
    return runInProperty(tenantId, propertyId, () => this.db.tenant(tenantId, async (tx) => {
      const v = await this.publishedVersionTx(tx, tenantId, propertyId);
      return { id: v.id, version: v.version, fields: this.fieldsOf(v) };
    }));
  }

  /** The guest record export (NDPA) of one reservation's answers. */
  async exportForGuest(tx: Tx, tenantId: string, r: Pick<Reservation, 'id' | 'tenantId' | 'formVersionId' | 'formAnswers' | 'formChannel' | 'formSubmittedAt'>) {
    return this.answersTx(tx, { ...r, tenantId }, { staff: true, includeSensitive: true });
  }

  /** Guest profile: non-sensitive answers of the latest stay. */
  async latestAnswers(tx: Tx, tenantId: string, guestId: string) {
    const r = await this.db.withAllProperties(tenantId, () => tx.reservation.findFirst({ where: { tenantId, guestId, formVersionId: { not: null } }, orderBy: { arrivalAt: 'desc' } }));
    if (!r) return [];
    return (await this.answersTx(tx, r, { staff: true, includeSensitive: false }))?.answers ?? [];
  }

  /** Desk edit of a reservation's answers (FRONT_DESK channel, current published version). Pickups are edited on the transfers. */
  async updateAnswers(u: AuthUser, reservationId: string, answersIn: Record<string, unknown>, ip?: string) {
    return this.db.tenant(u.tenantId, async (tx) => {
      const r = await tx.reservation.findFirst({ where: { id: reservationId, tenantId: u.tenantId } });
      if (!r) throw AppException.notFound('Reservation');
      if (!['PENDING', 'CONFIRMED', 'CHECKED_IN'].includes(r.status)) throw Err.invalidState(r.status, ['PENDING', 'CONFIRMED', 'CHECKED_IN'], 'This reservation');
      const version = await this.publishedVersionTx(tx, u.tenantId, r.propertyId);
      const fields = this.fieldsOf(version);
      const pickupKeys = new Set(fields.filter((f) => f.type === 'PICKUP' || f.type === 'EXTRA').map((f) => f.key));
      const answers = Object.fromEntries(Object.entries(answersIn ?? {}).filter(([k]) => !pickupKeys.has(k)));
      const res = await this.validateForBooking(tx, {
        tenantId: u.tenantId, propertyId: r.propertyId, versionId: version.id, channel: 'FRONT_DESK', answers, paymentMode: null,
        adults: r.adults, children: r.children, guest: null, consent: true, checkGuest: false, transfers: [],
        matchQuote: false, stay: null, enforceLeadTime: false, hotelPhone: null,
      });
      if (res.issues.length) throw issuesError(res.issues);
      const previous = (r.formAnswers ?? {}) as Record<string, unknown>;
      const kept = Object.fromEntries(Object.entries(previous).filter(([k]) => pickupKeys.has(k)));
      const stored = { ...kept, ...res.stored };
      await tx.reservation.update({
        where: { id: r.id },
        data: {
          formVersionId: version.id,
          formAnswers: stored as Prisma.InputJsonValue,
          formChannel: r.formChannel ?? 'FRONT_DESK',
          formSubmittedAt: r.formSubmittedAt ?? new Date(),
          ...(typeof stored.estimatedArrivalTime === 'string' && { expectedArrivalTime: stored.estimatedArrivalTime }),
          ...(typeof stored.specialRequests === 'string' && { specialRequests: stored.specialRequests }),
        },
      });
      await this.uploads.attach(tx, u.tenantId, r.id, res.uploadIds);
      await this.applyToGuest(tx, u.tenantId, r.guestId, stored);
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'reservation.form_answers_updated', entityType: 'reservation', entityId: r.id, metadata: { code: r.code, keys: Object.keys(res.stored) }, ip });
      return r.id;
    });
  }

  /** Staff FILE upload for the desk (FRONT_DESK channel, published form). */
  async uploadForDesk(u: AuthUser, fieldKey: string, file: { buffer: Buffer; size: number; originalname?: string } | undefined) {
    const pid = this.propertyOf(u);
    return this.db.tenant(u.tenantId, async (tx) => {
      const ent = await this.entitlements.getEntitlements(u.tenantId, tx);
      await this.entitlements.assertFeature(ent, 'form_file_uploads');
      const v = await this.publishedVersionTx(tx, u.tenantId, pid);
      const f = this.fieldsOf(v).find((x) => x.key === fieldKey && x.type === 'FILE' && x.required !== 'HIDDEN');
      if (!f) throw Err.validation('fieldKey', 'No file question with this key on the booking form');
      return this.uploads.store(tx, u.tenantId, pid, f, file);
    });
  }

  /** Public FILE upload (published form, or the draft with a preview grant). */
  async uploadPublic(ref: { id: string; tenantId: string }, fieldKey: string, channel: Channel, draft: boolean, file: { buffer: Buffer; size: number; originalname?: string } | undefined) {
    return runInProperty(ref.tenantId, ref.id, () =>
      this.db.tenant(ref.tenantId, async (tx) => {
        const ent = await this.entitlements.getEntitlements(ref.tenantId, tx);
        if (!ent.features.includes('form_file_uploads')) throw Err.validation('fieldKey', 'This hotel does not accept files with bookings');
        const form = await this.ensure(tx, ref.tenantId, ref.id);
        const fields = draft ? this.fieldsOf({ fields: form.draftFields }) : this.fieldsOf(await tx.bookingFormVersion.findUniqueOrThrow({ where: { id: form.publishedVersionId! } }));
        const f = fields.find((x) => x.key === fieldKey && x.type === 'FILE' && x.required !== 'HIDDEN' && x.channels.includes(channel));
        if (!f) throw Err.validation('fieldKey', 'No file question with this key on the booking form');
        return this.uploads.store(tx, ref.tenantId, ref.id, f, file);
      }),
    );
  }
}

const TYPE_LABELS: Record<string, string> = {
  SHORT_TEXT: 'Short text',
  LONG_TEXT: 'Paragraph',
  NUMBER: 'Number',
  DATE: 'Date',
  TIME: 'Time',
  SELECT: 'Choose one',
  MULTI_SELECT: 'Choose several',
  YES_NO: 'Yes or no',
  CHECKBOX: 'Tick box',
  PHONE: 'Phone number',
  EMAIL: 'Email',
  FILE: 'File upload',
};
