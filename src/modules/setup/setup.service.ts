import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma, SetupProgress } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { BookingFormService } from '../booking-form/booking-form.service.js';
import { presetById, PRESETS, type PresetId } from '../booking-form/form.catalogue.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { requiredPlanFor } from '../entitlements/entitlements.logic.js';
import { Err } from '../ops/ops.helpers.js';
import { ThemeService } from '../site/theme.service.js';

export const SETUP_STEPS = ['hotel_type', 'brand', 'rooms', 'booking_form', 'extras', 'payments', 'policies', 'go_live'] as const;
export type SetupStepKey = (typeof SETUP_STEPS)[number];
type Mark = { status: 'DONE' | 'SKIPPED'; at: string };

const META: Record<SetupStepKey, { title: string; description: string; required: boolean }> = {
  hotel_type: { title: 'Hotel type', description: 'Pick the kind of hotel you run: we set up your booking form and suggest a template.', required: false },
  brand: { title: 'Brand and template', description: 'Upload your logo, choose your colours and a booking-site template.', required: false },
  rooms: { title: 'Rooms and rates', description: 'Add your room types with their prices, then your rooms.', required: true },
  booking_form: { title: 'Booking form', description: 'Choose what guests tell you when they book.', required: false },
  extras: { title: 'Extras and pickups', description: 'Sell breakfast, early check-in and airport or motor-park pickups with the room.', required: false },
  payments: { title: 'Payments', description: 'Add the bank account that receives online payments.', required: false },
  policies: { title: 'Policies', description: 'Check-in and check-out times, cancellation policy and taxes.', required: false },
  go_live: { title: 'Go live', description: 'Preview your booking site, publish it and choose whether to list on the marketplace.', required: true },
};

/**
 * Setup wizard (M7): progress saved server-side per property, with steps
 * detected from the data (rooms, payouts, published theme ...) so the
 * checklist on Today stays true even when things are done elsewhere.
 */
@Injectable()
export class SetupService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly forms: BookingFormService,
    private readonly themes: ThemeService,
  ) {}

  /** Hotels that existed before M7 have a completed row (migration); others start now. */
  async ensure(tx: Tx, tenantId: string, propertyId: string): Promise<SetupProgress> {
    const found = await tx.setupProgress.findUnique({ where: { propertyId } });
    if (found) return found;
    await tx.$executeRaw`INSERT INTO setup_progress (id, tenant_id, property_id, steps, started_at, created_at, updated_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${propertyId}::uuid, '{}'::jsonb, now(), now(), now()) ON CONFLICT (property_id) DO NOTHING`;
    return tx.setupProgress.findUniqueOrThrow({ where: { propertyId } });
  }

  private marks(p: SetupProgress): Partial<Record<SetupStepKey, Mark>> {
    return (p.steps && typeof p.steps === 'object' ? p.steps : {}) as Partial<Record<SetupStepKey, Mark>>;
  }

  async viewTx(tx: Tx, tenantId: string, propertyId: string) {
    const p = await this.ensure(tx, tenantId, propertyId);
    const marks = this.marks(p);
    const ent = await this.entitlements.getEntitlements(tenantId, tx);
    const plans = await this.entitlements.listPlans();
    const prop = await tx.property.findFirstOrThrow({ where: { id: propertyId, tenantId } });
    const types = await tx.roomType.count({ where: { tenantId, propertyId } });
    const rooms = await tx.room.count({ where: { tenantId, propertyId } });
    const theme = await tx.siteTheme.findFirst({ where: { tenantId, propertyId }, select: { id: true } });
    const themeVersions = theme ? await tx.siteThemeVersion.count({ where: { themeId: theme.id } }) : 0;
    const form = await tx.bookingForm.findUnique({ where: { propertyId }, select: { id: true } });
    const formVersions = form ? await tx.bookingFormVersion.count({ where: { formId: form.id } }) : 0;
    const extras = await tx.extra.count({ where: { tenantId, propertyId } });
    const points = await tx.pickupPoint.count({ where: { tenantId, propertyId } });
    const payout = prop.payoutReady ? await tx.payoutAccount.findUnique({ where: { propertyId }, select: { bankName: true, accountNumberLast4: true } }) : null;
    const detected: Record<SetupStepKey, { done: boolean; summary: string | null }> = {
      hotel_type: { done: !!p.hotelType, summary: p.hotelType ? (presetById(p.hotelType)?.hotelType ?? p.hotelType) : null },
      brand: { done: themeVersions > 1, summary: themeVersions > 1 ? `Theme published (version ${themeVersions})` : null },
      rooms: { done: types > 0 && rooms > 0, summary: types ? `${types} room type${types === 1 ? '' : 's'}, ${rooms} room${rooms === 1 ? '' : 's'}` : null },
      booking_form: { done: formVersions > 1, summary: formVersions > 1 ? `Form published (version ${formVersions})` : null },
      extras: { done: extras + points > 0, summary: extras + points > 0 ? `${extras} extra${extras === 1 ? '' : 's'}, ${points} pickup point${points === 1 ? '' : 's'}` : null },
      payments: { done: prop.payoutReady, summary: payout ? `Payouts to ${payout.bankName} ...${payout.accountNumberLast4}` : prop.payoutReady ? 'Payouts ready' : null },
      policies: { done: false, summary: `Check-in ${prop.checkInTime}, check-out ${prop.checkOutTime}; free cancellation until ${prop.freeCancellationHours} hours before` },
      go_live: { done: !!p.completedAt, summary: p.completedAt ? (prop.listedOnMarketplace ? 'Live and listed on the marketplace' : 'Live on your own site') : null },
    };
    const steps = SETUP_STEPS.map((key, order) => {
      const m = marks[key];
      const locked = key === 'extras' && !ent.features.includes('paid_extras');
      const status = m?.status ?? (detected[key].done ? 'DONE' : locked ? 'LOCKED' : 'TODO');
      return {
        key,
        order,
        title: META[key].title,
        description: META[key].description,
        status,
        required: META[key].required,
        skippable: !META[key].required,
        completedAt: m?.at ?? (key === 'go_live' ? (p.completedAt?.toISOString() ?? null) : null),
        detected: !m && detected[key].done,
        summary: detected[key].summary,
        feature: key === 'extras' ? 'paid_extras' : null,
        requiredPlan: key === 'extras' ? (requiredPlanFor('paid_extras', plans) ?? 'growth') : null,
      };
    });
    const done = steps.filter((s) => s.status === 'DONE' || s.status === 'SKIPPED').length;
    return {
      propertyId,
      hotelType: (p.hotelType as PresetId | null) ?? null,
      startedAt: p.startedAt.toISOString(),
      completedAt: p.completedAt?.toISOString() ?? null,
      steps,
      currentStep: (p.completedAt ? null : (steps.find((s) => s.status === 'TODO')?.key ?? null)) as SetupStepKey | null,
      progressPct: p.completedAt ? 100 : Math.round((done / SETUP_STEPS.length) * 100),
      canTakeBookings: detected.rooms.done && prop.onlineBookingEnabled,
      showChecklist: !p.completedAt,
    };
  }

  private pid(u: AuthUser): string {
    if (!u.propertyId) throw AppException.notFound('Property');
    return u.propertyId;
  }

  get(u: AuthUser) {
    const pid = this.pid(u);
    return this.db.tenant(u.tenantId, (tx) => this.viewTx(tx, u.tenantId, pid));
  }

  /** Dashboard / Today card. */
  async summaryTx(tx: Tx, tenantId: string, propertyId: string) {
    const v = await this.viewTx(tx, tenantId, propertyId);
    return { completed: !!v.completedAt, progressPct: v.progressPct, nextStep: v.currentStep };
  }

  private async mark(tx: Tx, u: AuthUser, pid: string, key: SetupStepKey, status: 'DONE' | 'SKIPPED' | 'TODO', data: Partial<Prisma.SetupProgressUpdateInput> = {}) {
    const p = await this.ensure(tx, u.tenantId, pid);
    const marks = this.marks(p);
    if (status === 'TODO') delete marks[key];
    else marks[key] = { status, at: new Date().toISOString() };
    await tx.setupProgress.update({ where: { id: p.id }, data: { steps: marks as Prisma.InputJsonValue, ...data } });
  }

  async setStep(u: AuthUser, key: string, status: 'DONE' | 'SKIPPED' | 'TODO', ip?: string) {
    if (!(SETUP_STEPS as readonly string[]).includes(key)) throw AppException.notFound('Setup step');
    const k = key as SetupStepKey;
    if (k === 'go_live') throw Err.validation('key', 'Go live with POST /setup/go-live');
    if (status === 'SKIPPED' && META[k].required) throw Err.validation('status', `${META[k].title} cannot be skipped: it is needed to take bookings`);
    const pid = this.pid(u);
    return this.db.tenant(u.tenantId, async (tx) => {
      if (k === 'rooms' && status === 'DONE') {
        const types = await tx.roomType.count({ where: { tenantId: u.tenantId, propertyId: pid } });
        const rooms = await tx.room.count({ where: { tenantId: u.tenantId, propertyId: pid } });
        if (!types || !rooms) throw Err.validation('status', 'Add at least one room type and one room first');
      }
      await this.mark(tx, u, pid, k, status);
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'setup.step_updated', entityType: 'setup', entityId: pid, metadata: { step: k, status }, ip });
      return this.viewTx(tx, u.tenantId, pid);
    });
  }

  async hotelType(u: AuthUser, dto: { hotelType: string; applyFormPreset?: boolean; applyTemplate?: boolean }, ip?: string) {
    const preset = presetById(dto.hotelType);
    if (!preset) throw Err.validation('hotelType', `Choose one of: ${PRESETS.map((p) => p.id).join(', ')}`);
    const pid = this.pid(u);
    await this.db.tenant(u.tenantId, async (tx) => {
      if (dto.applyFormPreset !== false) await this.forms.resetToPresetTx(tx, u, pid, preset.id, ip);
      await this.mark(tx, u, pid, 'hotel_type', 'DONE', { hotelType: preset.id });
    });
    if (dto.applyTemplate !== false) {
      // The suggested template when the plan allows it (Starter keeps Essentials / Editorial).
      await this.themes.updateDraft(u, 'PROPERTY', { templateId: preset.suggestedTemplateId }, ip).catch((e: unknown) => {
        if (!(e instanceof AppException) || e.code !== 'FEATURE_LOCKED') throw e;
      });
    }
    return this.get(u);
  }

  async goLive(u: AuthUser, dto: { publishTheme?: boolean; publishForm?: boolean; listOnMarketplace?: boolean }, ip?: string) {
    const pid = this.pid(u);
    const before = await this.get(u);
    const missing = before.steps.filter((s) => s.required && s.key !== 'go_live' && s.status !== 'DONE').map((s) => s.key);
    if (missing.length) throw new AppException(HttpStatus.CONFLICT, 'SETUP_INCOMPLETE', 'Add your rooms before going live', { missing });
    if (dto.publishTheme !== false) {
      await this.themes.publish(u, 'PROPERTY', 'Published from the setup wizard', ip).catch((e: unknown) => {
        if (!(e instanceof AppException) || e.code !== 'NOTHING_TO_PUBLISH') throw e;
      });
    }
    if (dto.publishForm !== false) {
      await this.db.tenant(u.tenantId, (tx) => this.forms.publishTx(tx, u, pid, 'Published from the setup wizard', ip, { allowUnchanged: true }));
    }
    return this.db.tenant(u.tenantId, async (tx) => {
      if (dto.listOnMarketplace !== undefined) await tx.property.update({ where: { id: pid }, data: { listedOnMarketplace: dto.listOnMarketplace } });
      await this.mark(tx, u, pid, 'go_live', 'DONE', { completedAt: new Date() });
      await this.audit.record(tx, { tenantId: u.tenantId, actor: userActor(u), action: 'setup.completed', entityType: 'setup', entityId: pid, metadata: { listOnMarketplace: dto.listOnMarketplace ?? null }, ip });
      return this.viewTx(tx, u.tenantId, pid);
    });
  }
}
