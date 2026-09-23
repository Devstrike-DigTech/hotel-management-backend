import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type RatePlan } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { addDays, dateRange, dbDate, diffDays, fromDbDate, isIsoDate, lagosDate, nightWindow } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { appError, Err, firstProperty, primaryProperty } from '../ops/ops.helpers.js';
import { scopeIds } from '../../common/property-scope.js';
import { ACTIVE_STATUSES, unsellableByNight } from './capacity.js';
import {
  applyAdjustment,
  barForNight,
  planPrice,
  resolveNights,
  restrictionOn,
  stayDates,
  VIRTUAL_BAR,
  type CancelPolicyOverride,
  type NightlyRate,
  type PlanLike,
  type RestrictionLike,
  type RuleLike,
} from './rates.logic.js';
import type {
  PutOverridesDto,
  PutRestrictionsDto,
  RatePlanDto,
  RateRuleDto,
  UpdateRatePlanDto,
  UpdateRateRuleDto,
} from './rates.dto.js';

const MAX_CAL_DAYS = 92;

function jsonOrNull(v: object | null | undefined): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return v ? (v as unknown as Prisma.InputJsonValue) : Prisma.JsonNull;
}
const MAX_BULK_DAYS = 366;

/** Everything needed to price a hotel's stays over a date range. */
export interface RateContext {
  promotions: boolean;
  plans: PlanLike[];
  bar: PlanLike;
  rules: RuleLike[];
  overrides: Map<string, number>;
  restrictions: RestrictionLike[];
}

export function toPlanLike(p: RatePlan): PlanLike {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    kind: p.kind,
    isBar: p.isBar,
    pricing: p.pricing,
    adjustmentType: p.adjustmentType,
    adjustmentValue: p.adjustmentValue,
    fixedPrices: Array.isArray(p.fixedPrices) ? (p.fixedPrices as { roomTypeId: string; rateKobo: number }[]) : [],
    minNights: p.minNights,
    maxNights: p.maxNights,
    channels: p.channels,
    roomTypeIds: p.roomTypeIds,
    active: p.active,
    includesBreakfast: p.includesBreakfast,
    cancelPolicy: (p.cancelPolicy as CancelPolicyOverride | null) ?? null,
    description: p.description,
  };
}

export function toRuleLike(r: { id: string; name: string; roomTypeIds: string[]; dateFrom: Date; dateTo: Date; daysOfWeek: number[]; adjustmentType: RuleLike['adjustmentType']; adjustmentValue: number; priority: number; active: boolean; updatedAt: Date }): RuleLike {
  return {
    id: r.id,
    name: r.name,
    roomTypeIds: r.roomTypeIds,
    dateFrom: fromDbDate(r.dateFrom),
    dateTo: fromDbDate(r.dateTo),
    daysOfWeek: r.daysOfWeek,
    adjustmentType: r.adjustmentType,
    adjustmentValue: r.adjustmentValue,
    priority: r.priority,
    active: r.active,
    updatedAt: r.updatedAt,
  };
}

/** "-10%", "+N5,000", "Breakfast included", "7+ nights". */
export function planLabel(p: PlanLike): string {
  const parts: string[] = [];
  if (!p.isBar && p.pricing === 'DERIVED' && p.adjustmentType && p.adjustmentValue) {
    if (p.adjustmentType === 'PERCENT') parts.push(`${p.adjustmentValue > 0 ? '+' : '-'}${Math.abs(p.adjustmentValue) / 100}%`);
    else if (p.adjustmentType === 'AMOUNT') parts.push(`${p.adjustmentValue > 0 ? '+' : '-'}N${(Math.abs(p.adjustmentValue) / 100).toLocaleString('en-NG')}`);
  }
  if (p.pricing === 'FIXED') parts.push('Negotiated rate');
  if (p.minNights) parts.push(`${p.minNights}+ nights`);
  if (p.includesBreakfast) parts.push('Breakfast included');
  if (p.cancelPolicy?.nonRefundable) parts.push('Non-refundable');
  return parts.join(', ') || 'Flexible';
}

/**
 * Structured plan terms for clients (so nobody parses `label`):
 * `discountPct` is the whole-percent saving on BAR for a negative PERCENT plan
 * (10 for "-10%"), `surchargePct` the same for a positive one.
 */
export function planTerms(p: PlanLike) {
  const derived = !p.isBar && p.pricing === 'DERIVED' && p.adjustmentType !== null && p.adjustmentValue !== null && p.adjustmentType !== 'FIXED';
  const pct = derived && p.adjustmentType === 'PERCENT' ? p.adjustmentValue! / 100 : null;
  return {
    pricing: p.pricing,
    adjustment: derived ? { type: p.adjustmentType as 'PERCENT' | 'AMOUNT', value: p.adjustmentValue! } : null,
    discountPct: pct !== null && pct < 0 ? -pct : null,
    surchargePct: pct !== null && pct > 0 ? pct : null,
    negotiated: p.pricing === 'FIXED',
    nonRefundable: !!p.cancelPolicy?.nonRefundable,
    refundable: !p.cancelPolicy?.nonRefundable,
    includesBreakfast: p.includesBreakfast,
    minNights: p.minNights,
    maxNights: p.maxNights,
  };
}

export function ruleView(r: { id: string; name: string; roomTypeIds: string[]; dateFrom: Date; dateTo: Date; daysOfWeek: number[]; adjustmentType: string; adjustmentValue: number; priority: number; color: string; active: boolean; createdAt: Date; updatedAt: Date }) {
  return {
    id: r.id,
    name: r.name,
    roomTypeIds: r.roomTypeIds,
    dateFrom: fromDbDate(r.dateFrom),
    dateTo: fromDbDate(r.dateTo),
    daysOfWeek: r.daysOfWeek,
    adjustment: { type: r.adjustmentType, value: r.adjustmentValue },
    priority: r.priority,
    color: r.color,
    active: r.active,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Rates: plans, season rules, single-date overrides and restrictions, and
 * `resolveNightlyRates`, the one pricing function behind admin reservations,
 * the public side and the night audit. Without the `promotions` feature every
 * stay is priced at BAR = the room type's base price.
 */
@Injectable()
export class RatesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  /** Loads plans, rules, overrides and restrictions touching [from, to] (dates, inclusive). */
  async context(tx: Tx, tenantId: string, from: string, to: string, features?: readonly string[], propertyId?: string | null): Promise<RateContext> {
    const feats = features ?? (await this.entitlements.getEntitlements(tenantId, tx)).features;
    const promotions = feats.includes('promotions');
    // M5: rates are per property. The given property, else the scope's, else the primary.
    const pids = propertyId ? [propertyId] : (scopeIds(tenantId) ?? [(await firstProperty(tx, tenantId)).id]);
    const pw = { propertyId: { in: pids } };
    const planRows = await tx.ratePlan.findMany({ where: { tenantId, ...pw }, orderBy: [{ isBar: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }] });
    const rows = planRows.map(toPlanLike);
    const barRow = rows.find((p) => p.isBar);
    const bar = barRow ?? VIRTUAL_BAR;
    // A hotel whose BAR row does not exist yet still sells at BAR.
    const plans = barRow ? rows : [VIRTUAL_BAR, ...rows];
    if (!promotions) {
      return { promotions, plans: [bar], bar, rules: [], overrides: new Map(), restrictions: [] };
    }
    const [rules, overrides, restrictions] = await Promise.all([
      tx.rateRule.findMany({ where: { tenantId, ...pw, active: true, dateFrom: { lte: dbDate(to) }, dateTo: { gte: dbDate(from) } } }),
      tx.rateOverride.findMany({ where: { tenantId, ...pw, date: { gte: dbDate(from), lte: dbDate(to) } } }),
      tx.rateRestriction.findMany({ where: { tenantId, ...pw, date: { gte: dbDate(from), lte: dbDate(to) } } }),
    ]);
    return {
      promotions,
      plans,
      bar,
      rules: rules.map(toRuleLike),
      overrides: new Map(overrides.map((o) => [`${o.roomTypeId}|${fromDbDate(o.date)}`, o.rateKobo])),
      restrictions: restrictions.map((r) => ({
        roomTypeId: r.roomTypeId,
        date: fromDbDate(r.date),
        closedToArrival: r.closedToArrival,
        closedToDeparture: r.closedToDeparture,
        stopSell: r.stopSell,
        minNights: r.minNights,
      })),
    };
  }

  /** The plan to use: the given id, else BAR. Unknown or other-tenant ids -> 404. */
  planFrom(ctx: RateContext, ratePlanId?: string | null): PlanLike {
    if (!ratePlanId) return ctx.bar;
    const p = ctx.plans.find((x) => x.id === ratePlanId);
    if (!p) throw AppException.notFound('Rate plan');
    return p;
  }

  /**
   * Per-night prices for a stay (the single source of truth). Throws
   * RATE_PLAN_UNAVAILABLE when the plan does not sell this room type.
   */
  async resolveNightlyRates(
    tx: Tx,
    tenantId: string,
    input: { roomType: { id: string; basePriceKobo: number; propertyId?: string }; ratePlanId?: string | null; arrivalDate: string; departureDate: string; ctx?: RateContext },
  ): Promise<{ plan: PlanLike; nights: NightlyRate[]; ctx: RateContext }> {
    const dates = stayDates(input.arrivalDate, input.departureDate);
    const ctx = input.ctx ?? (await this.context(tx, tenantId, input.arrivalDate, input.departureDate, undefined, input.roomType.propertyId));
    const plan = this.planFrom(ctx, input.ratePlanId);
    const nights = resolveNights({ roomType: input.roomType, plan, dates, rules: ctx.rules, overrides: ctx.overrides });
    if (!nights) {
      throw appError(HttpStatus.BAD_REQUEST, 'RATE_PLAN_UNAVAILABLE', `${plan.name} is not sold for this room type`, { ratePlanId: plan.id, reason: 'ROOM_TYPE' });
    }
    return { plan, nights, ctx };
  }

  /** One night's price for a reservation whose snapshot lacks that night (extensions). */
  async priceForNight(tx: Tx, tenantId: string, roomType: { id: string; basePriceKobo: number; propertyId?: string }, ratePlanId: string | null, date: string): Promise<NightlyRate> {
    const ctx = await this.context(tx, tenantId, date, date, undefined, roomType.propertyId);
    const plan = ctx.plans.find((p) => p.id === ratePlanId) ?? ctx.bar;
    const nights = resolveNights({ roomType, plan, dates: [date], rules: ctx.rules, overrides: ctx.overrides })
      ?? resolveNights({ roomType, plan: ctx.bar, dates: [date], rules: ctx.rules, overrides: ctx.overrides })!;
    return nights[0];
  }

  /** Makes sure the hotel has its BAR plan row (new hotels, lazily). */
  async ensureBar(tx: Tx, tenantId: string, propertyId?: string): Promise<RatePlan> {
    const property = propertyId ? { id: propertyId } : await primaryProperty(tx, tenantId);
    const existing = await tx.ratePlan.findFirst({ where: { tenantId, propertyId: property.id, isBar: true } });
    if (existing) return existing;
    return tx.ratePlan.create({
      data: {
        tenantId,
        propertyId: property.id,
        code: 'BAR',
        name: 'Best Available Rate',
        description: "Flexible rate at the day's best price.",
        kind: 'BAR',
        isBar: true,
        pricing: 'DERIVED',
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------------

  private async planView(tx: Tx, p: RatePlan) {
    const types = await tx.roomType.findMany({ where: { tenantId: p.tenantId }, select: { id: true, name: true } });
    const names = new Map(types.map((t) => [t.id, t.name]));
    const count = await tx.reservation.count({ where: { ratePlanId: p.id } });
    const like = toPlanLike(p);
    return {
      id: p.id,
      propertyId: p.propertyId,
      code: p.code,
      name: p.name,
      description: p.description,
      kind: p.kind,
      isBar: p.isBar,
      pricing: p.pricing,
      adjustment: p.pricing === 'DERIVED' && p.adjustmentType && p.adjustmentValue !== null ? { type: p.adjustmentType, value: p.adjustmentValue } : null,
      fixedPrices: like.fixedPrices.map((f) => ({ roomTypeId: f.roomTypeId, roomTypeName: names.get(f.roomTypeId) ?? '', rateKobo: f.rateKobo })),
      cancellationPolicy: like.cancelPolicy,
      minNights: p.minNights,
      maxNights: p.maxNights,
      includesBreakfast: p.includesBreakfast,
      channels: p.channels,
      roomTypeIds: p.roomTypeIds,
      active: p.active,
      sortOrder: p.sortOrder,
      label: planLabel(like),
      discountPct: planTerms(like).discountPct,
      surchargePct: planTerms(like).surchargePct,
      negotiated: planTerms(like).negotiated,
      nonRefundable: planTerms(like).nonRefundable,
      refundable: planTerms(like).refundable,
      reservationsCount: count,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  listPlans(user: AuthUser, active?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      await this.ensureBar(tx, user.tenantId);
      const rows = await tx.ratePlan.findMany({
        where: { tenantId: user.tenantId, ...(active === 'true' ? { active: true } : active === 'false' ? { active: false } : {}) },
        orderBy: [{ isBar: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      });
      const out = [];
      for (const r of rows) out.push(await this.planView(tx, r));
      return out;
    });
  }

  private async validatePlanInput(tx: Tx, tenantId: string, dto: Partial<RatePlanDto>, pricing: string) {
    if (pricing === 'DERIVED' && dto.adjustment && dto.adjustment.type !== 'PERCENT' && dto.adjustment.type !== 'AMOUNT') {
      throw Err.validation('adjustment.type', 'A derived plan adjusts BAR by PERCENT or AMOUNT');
    }
    if (pricing === 'FIXED' && dto.fixedPrices !== undefined && !dto.fixedPrices.length) {
      throw Err.validation('fixedPrices', 'Give a price for at least one room type');
    }
    const ids = [...(dto.roomTypeIds ?? []), ...(dto.fixedPrices ?? []).map((f) => f.roomTypeId)];
    if (ids.length) {
      const found = await tx.roomType.count({ where: { tenantId, id: { in: [...new Set(ids)] } } });
      if (found !== new Set(ids).size) throw Err.validation('roomTypeIds', 'Unknown room type');
    }
    if (dto.minNights && dto.maxNights && dto.maxNights < dto.minNights) throw Err.validation('maxNights', 'maxNights must be at least minNights');
  }

  createPlan(user: AuthUser, dto: RatePlanDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      await this.ensureBar(tx, user.tenantId);
      if (dto.kind === 'BAR') throw Err.validation('kind', 'The hotel already has its BAR plan');
      const code = dto.code.toUpperCase();
      if (await tx.ratePlan.findFirst({ where: { tenantId: user.tenantId, code } })) throw AppException.conflict('A rate plan with this code already exists');
      await this.validatePlanInput(tx, user.tenantId, dto, dto.pricing);
      const property = await primaryProperty(tx, user.tenantId);
      const nonRefundable = dto.kind === 'NON_REFUNDABLE';
      const p = await tx.ratePlan.create({
        data: {
          tenantId: user.tenantId,
          propertyId: property.id,
          code,
          name: dto.name,
          description: dto.description ?? '',
          kind: dto.kind,
          pricing: dto.pricing,
          adjustmentType: dto.pricing === 'DERIVED' ? (dto.adjustment?.type ?? null) : null,
          adjustmentValue: dto.pricing === 'DERIVED' ? (dto.adjustment?.value ?? null) : null,
          fixedPrices: (dto.pricing === 'FIXED' ? (dto.fixedPrices ?? []) : []) as unknown as Prisma.InputJsonValue,
          cancelPolicy: jsonOrNull(dto.cancellationPolicy ?? (nonRefundable ? { nonRefundable: true, freeCancellationHours: 0, lateCancellationFeePct: 100 } : null)),
          minNights: dto.minNights ?? null,
          maxNights: dto.maxNights ?? null,
          includesBreakfast: dto.includesBreakfast ?? false,
          channels: dto.channels ?? ['FRONT_DESK', 'BOOKING_SITE', 'MARKETPLACE'],
          roomTypeIds: dto.roomTypeIds ?? [],
          active: dto.active ?? true,
          sortOrder: dto.sortOrder ?? 10,
        },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'rate_plan.created', entityType: 'rate_plan', entityId: p.id, metadata: { code, name: p.name, kind: p.kind }, ip });
      return this.planView(tx, p);
    });
  }

  updatePlan(user: AuthUser, id: string, dto: UpdateRatePlanDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await tx.ratePlan.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!p) throw AppException.notFound('Rate plan');
      if (p.isBar) {
        const forbiddenKeys = ['code', 'kind', 'pricing', 'adjustment', 'fixedPrices', 'minNights', 'maxNights', 'roomTypeIds', 'active'].filter(
          (key) => (dto as Record<string, unknown>)[key] !== undefined,
        );
        if (forbiddenKeys.length) throw Err.validation(forbiddenKeys[0], 'BAR always sells every room type at the day\'s price; only its name, description, breakfast, channels and cancellation policy can change');
      }
      if (dto.kind === 'BAR') throw Err.validation('kind', 'There is only one BAR plan');
      const pricing = dto.pricing ?? p.pricing;
      await this.validatePlanInput(tx, user.tenantId, dto, pricing);
      if (dto.code && dto.code.toUpperCase() !== p.code) {
        if (await tx.ratePlan.findFirst({ where: { tenantId: user.tenantId, code: dto.code.toUpperCase() } })) throw AppException.conflict('A rate plan with this code already exists');
      }
      const updated = await tx.ratePlan.update({
        where: { id },
        data: {
          ...(dto.code !== undefined && { code: dto.code.toUpperCase() }),
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.kind !== undefined && { kind: dto.kind }),
          ...(dto.pricing !== undefined && { pricing: dto.pricing }),
          ...(dto.adjustment !== undefined && { adjustmentType: dto.adjustment?.type ?? null, adjustmentValue: dto.adjustment?.value ?? null }),
          ...(dto.fixedPrices !== undefined && { fixedPrices: dto.fixedPrices as unknown as Prisma.InputJsonValue }),
          ...(dto.cancellationPolicy !== undefined && { cancelPolicy: jsonOrNull(dto.cancellationPolicy) }),
          ...(dto.minNights !== undefined && { minNights: dto.minNights }),
          ...(dto.maxNights !== undefined && { maxNights: dto.maxNights }),
          ...(dto.includesBreakfast !== undefined && { includesBreakfast: dto.includesBreakfast }),
          ...(dto.channels !== undefined && { channels: dto.channels }),
          ...(dto.roomTypeIds !== undefined && { roomTypeIds: dto.roomTypeIds }),
          ...(dto.active !== undefined && { active: dto.active }),
          ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'rate_plan.updated', entityType: 'rate_plan', entityId: id, metadata: { code: updated.code, changes: Object.keys(dto) }, ip });
      return this.planView(tx, updated);
    });
  }

  deletePlan(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await tx.ratePlan.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!p) throw AppException.notFound('Rate plan');
      if (p.isBar) throw AppException.conflict('The BAR plan cannot be deleted');
      const used = (await tx.reservation.count({ where: { ratePlanId: id } })) + (await tx.corporateAccount.count({ where: { ratePlanId: id } }));
      if (used) throw AppException.conflict('This plan is used by bookings or corporate accounts; deactivate it instead');
      await tx.ratePlan.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'rate_plan.deleted', entityType: 'rate_plan', entityId: id, metadata: { code: p.code }, ip });
      return { success: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------

  listRules(user: AuthUser, q: { active?: string; from?: string; to?: string }) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.rateRule.findMany({
        where: {
          tenantId: user.tenantId,
          ...(q.active === 'true' ? { active: true } : q.active === 'false' ? { active: false } : {}),
          ...(q.from && isIsoDate(q.from) && { dateTo: { gte: dbDate(q.from) } }),
          ...(q.to && isIsoDate(q.to) && { dateFrom: { lte: dbDate(q.to) } }),
        },
        orderBy: [{ dateFrom: 'asc' }, { priority: 'desc' }],
      });
      return rows.map(ruleView);
    });
  }

  private checkRule(dto: Partial<RateRuleDto>) {
    if (dto.dateFrom && !isIsoDate(dto.dateFrom)) throw Err.validation('dateFrom', 'dateFrom must be YYYY-MM-DD');
    if (dto.dateTo && !isIsoDate(dto.dateTo)) throw Err.validation('dateTo', 'dateTo must be YYYY-MM-DD');
    if (dto.dateFrom && dto.dateTo && dto.dateTo < dto.dateFrom) throw Err.validation('dateTo', 'dateTo must not be before dateFrom');
    if (dto.daysOfWeek?.some((d) => d < 0 || d > 6)) throw Err.validation('daysOfWeek', 'Days of the week are 0 (Sunday) to 6 (Saturday)');
    if (dto.adjustment?.type === 'FIXED' && dto.adjustment.value <= 0) throw Err.validation('adjustment.value', 'A fixed price must be positive');
    if (dto.adjustment?.type === 'PERCENT' && (dto.adjustment.value < -9000 || dto.adjustment.value > 50_000)) {
      throw Err.validation('adjustment.value', 'Percent adjustments are between -90% and +500% (in basis points)');
    }
  }

  createRule(user: AuthUser, dto: RateRuleDto, ip?: string) {
    this.checkRule(dto);
    return this.db.tenant(user.tenantId, async (tx) => {
      const property = await primaryProperty(tx, user.tenantId);
      if (dto.roomTypeIds?.length) {
        const found = await tx.roomType.count({ where: { tenantId: user.tenantId, id: { in: dto.roomTypeIds } } });
        if (found !== new Set(dto.roomTypeIds).size) throw Err.validation('roomTypeIds', 'Unknown room type');
      }
      const r = await tx.rateRule.create({
        data: {
          tenantId: user.tenantId,
          propertyId: property.id,
          name: dto.name,
          roomTypeIds: dto.roomTypeIds ?? [],
          dateFrom: dbDate(dto.dateFrom),
          dateTo: dbDate(dto.dateTo),
          daysOfWeek: [...new Set(dto.daysOfWeek ?? [])].sort((a, b) => a - b),
          adjustmentType: dto.adjustment.type,
          adjustmentValue: dto.adjustment.value,
          priority: dto.priority ?? 0,
          color: dto.color ?? 'brass',
          active: dto.active ?? true,
        },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'rate_rule.created', entityType: 'rate_rule', entityId: r.id, metadata: { name: r.name, dateFrom: dto.dateFrom, dateTo: dto.dateTo, adjustment: dto.adjustment }, ip });
      return ruleView(r);
    });
  }

  updateRule(user: AuthUser, id: string, dto: UpdateRateRuleDto, ip?: string) {
    this.checkRule(dto);
    return this.db.tenant(user.tenantId, async (tx) => {
      const r = await tx.rateRule.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!r) throw AppException.notFound('Rate rule');
      const from = dto.dateFrom ?? fromDbDate(r.dateFrom);
      const to = dto.dateTo ?? fromDbDate(r.dateTo);
      if (to < from) throw Err.validation('dateTo', 'dateTo must not be before dateFrom');
      const updated = await tx.rateRule.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.roomTypeIds !== undefined && { roomTypeIds: dto.roomTypeIds }),
          dateFrom: dbDate(from),
          dateTo: dbDate(to),
          ...(dto.daysOfWeek !== undefined && { daysOfWeek: [...new Set(dto.daysOfWeek)].sort((a, b) => a - b) }),
          ...(dto.adjustment !== undefined && { adjustmentType: dto.adjustment.type, adjustmentValue: dto.adjustment.value }),
          ...(dto.priority !== undefined && { priority: dto.priority }),
          ...(dto.color !== undefined && { color: dto.color }),
          ...(dto.active !== undefined && { active: dto.active }),
        },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'rate_rule.updated', entityType: 'rate_rule', entityId: id, metadata: { name: updated.name, changes: Object.keys(dto) }, ip });
      return ruleView(updated);
    });
  }

  deleteRule(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const r = await tx.rateRule.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!r) throw AppException.notFound('Rate rule');
      await tx.rateRule.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'rate_rule.deleted', entityType: 'rate_rule', entityId: id, metadata: { name: r.name }, ip });
      return { success: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Overrides and restrictions
  // ---------------------------------------------------------------------------

  private bulkDates(from: string, to: string, days?: number[]): string[] {
    if (!isIsoDate(from) || !isIsoDate(to)) throw Err.validation('from', 'from and to must be YYYY-MM-DD');
    if (to < from) throw Err.validation('to', '"to" must not be before "from"');
    if (diffDays(from, to) + 1 > MAX_BULK_DAYS) throw Err.validation('to', `At most ${MAX_BULK_DAYS} days at once`);
    const all = dateRange(from, to);
    if (!days?.length) return all;
    return all.filter((d) => days.includes(new Date(`${d}T12:00:00Z`).getUTCDay()));
  }

  listOverrides(user: AuthUser, q: { from?: string; to?: string; roomTypeId?: string }) {
    const from = q.from && isIsoDate(q.from) ? q.from : lagosDate();
    const to = q.to && isIsoDate(q.to) ? q.to : addDays(from, 60);
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.rateOverride.findMany({
        where: { tenantId: user.tenantId, date: { gte: dbDate(from), lte: dbDate(to) }, ...(q.roomTypeId && { roomTypeId: q.roomTypeId }) },
        orderBy: [{ date: 'asc' }],
      });
      return rows.map((o) => ({
        roomTypeId: o.roomTypeId,
        date: fromDbDate(o.date),
        rateKobo: o.rateKobo,
        source: o.source,
        note: o.note,
        updatedBy: o.updatedById ? { id: o.updatedById, fullName: o.updatedByName ?? '' } : null,
        updatedAt: o.updatedAt.toISOString(),
      }));
    });
  }

  putOverrides(user: AuthUser, dto: PutOverridesDto, ip?: string) {
    const dates = this.bulkDates(dto.from, dto.to, dto.daysOfWeek);
    return this.db.tenant(user.tenantId, async (tx) => {
      const types = await tx.roomType.findMany({ where: { tenantId: user.tenantId, id: { in: dto.roomTypeIds } }, select: { id: true, propertyId: true } });
      if (types.length !== new Set(dto.roomTypeIds).size) throw Err.validation('roomTypeIds', 'Unknown room type');
      let updated = 0;
      for (const rt of types) {
        if (dto.rateKobo === null || dto.rateKobo === undefined) {
          const del = await tx.rateOverride.deleteMany({ where: { tenantId: user.tenantId, roomTypeId: rt.id, date: { in: dates.map(dbDate) } } });
          updated += del.count;
          continue;
        }
        for (const d of dates) {
          await tx.rateOverride.upsert({
            where: { roomTypeId_date: { roomTypeId: rt.id, date: dbDate(d) } },
            create: { tenantId: user.tenantId, propertyId: rt.propertyId, roomTypeId: rt.id, date: dbDate(d), rateKobo: dto.rateKobo!, note: dto.note ?? null, source: 'MANUAL', updatedById: user.userId, updatedByName: user.fullName },
            update: { rateKobo: dto.rateKobo!, note: dto.note ?? null, source: 'MANUAL', updatedById: user.userId, updatedByName: user.fullName },
          });
          updated++;
        }
      }
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: dto.rateKobo == null ? 'rate_override.cleared' : 'rate_override.set',
        entityType: 'rate_override',
        metadata: { roomTypeIds: dto.roomTypeIds, from: dto.from, to: dto.to, daysOfWeek: dto.daysOfWeek ?? [], rateKobo: dto.rateKobo, count: updated },
        ip,
      });
      return { updated };
    });
  }

  listRestrictions(user: AuthUser, q: { from?: string; to?: string }) {
    const from = q.from && isIsoDate(q.from) ? q.from : lagosDate();
    const to = q.to && isIsoDate(q.to) ? q.to : addDays(from, 60);
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.rateRestriction.findMany({ where: { tenantId: user.tenantId, date: { gte: dbDate(from), lte: dbDate(to) } }, orderBy: { date: 'asc' } });
      return rows.map((r) => ({
        roomTypeId: r.roomTypeId,
        date: fromDbDate(r.date),
        closedToArrival: r.closedToArrival,
        closedToDeparture: r.closedToDeparture,
        stopSell: r.stopSell,
        minNights: r.minNights,
      }));
    });
  }

  putRestrictions(user: AuthUser, dto: PutRestrictionsDto, ip?: string) {
    const dates = this.bulkDates(dto.from, dto.to, dto.daysOfWeek);
    return this.db.tenant(user.tenantId, async (tx) => {
      const typeIds: (string | null)[] = dto.roomTypeIds === null || dto.roomTypeIds === undefined ? [null] : dto.roomTypeIds;
      if (dto.roomTypeIds?.length) {
        const found = await tx.roomType.count({ where: { tenantId: user.tenantId, id: { in: dto.roomTypeIds } } });
        if (found !== new Set(dto.roomTypeIds).size) throw Err.validation('roomTypeIds', 'Unknown room type');
      }
      let updated = 0;
      for (const rt of typeIds) {
        for (const d of dates) {
          const existing = await tx.rateRestriction.findFirst({ where: { tenantId: user.tenantId, roomTypeId: rt, date: dbDate(d) } });
          const next = {
            closedToArrival: dto.closedToArrival ?? existing?.closedToArrival ?? false,
            closedToDeparture: dto.closedToDeparture ?? existing?.closedToDeparture ?? false,
            stopSell: dto.stopSell ?? existing?.stopSell ?? false,
            minNights: dto.minNights !== undefined ? dto.minNights : (existing?.minNights ?? null),
          };
          const empty = !next.closedToArrival && !next.closedToDeparture && !next.stopSell && !next.minNights;
          if (existing && empty) await tx.rateRestriction.delete({ where: { id: existing.id } });
          else if (existing) await tx.rateRestriction.update({ where: { id: existing.id }, data: next });
          else if (!empty) await tx.rateRestriction.create({ data: { tenantId: user.tenantId, propertyId: (await primaryProperty(tx, user.tenantId)).id, roomTypeId: rt, date: dbDate(d), ...next } });
          updated++;
        }
      }
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'rate_restriction.set',
        entityType: 'rate_restriction',
        metadata: { roomTypeIds: dto.roomTypeIds ?? null, from: dto.from, to: dto.to, closedToArrival: dto.closedToArrival, closedToDeparture: dto.closedToDeparture, stopSell: dto.stopSell, minNights: dto.minNights },
        ip,
      });
      return { updated };
    });
  }

  // ---------------------------------------------------------------------------
  // The Rate Almanac
  // ---------------------------------------------------------------------------

  calendar(user: AuthUser, q: { from?: string; to?: string; ratePlanId?: string }) {
    const from = q.from && isIsoDate(q.from) ? q.from : lagosDate();
    const to = q.to && isIsoDate(q.to) ? q.to : addDays(from, 41);
    if (to < from) throw Err.validation('to', '"to" must not be before "from"');
    if (diffDays(from, to) + 1 > MAX_CAL_DAYS) throw Err.validation('to', `The range can be at most ${MAX_CAL_DAYS} days`);
    return this.db.tenant(user.tenantId, async (tx) => {
      await this.ensureBar(tx, user.tenantId);
      const property = await primaryProperty(tx, user.tenantId);
      const ctx = await this.context(tx, user.tenantId, from, to);
      const plan = this.planFrom(ctx, q.ratePlanId);
      const planRow = plan.id ? await tx.ratePlan.findFirst({ where: { id: plan.id } }) : null;
      const types = await tx.roomType.findMany({ where: { tenantId: user.tenantId }, orderBy: [{ sortOrder: 'asc' }, { basePriceKobo: 'asc' }] });
      const dates = dateRange(from, to);
      const windows = dates.map((d) => ({ date: d, ...nightWindow(d, property.checkInTime, property.checkOutTime) }));
      const stays = await tx.reservation.findMany({
        where: { tenantId: user.tenantId, status: { in: ACTIVE_STATUSES }, arrivalAt: { lt: windows[windows.length - 1].end }, departureAt: { gt: windows[0].start } },
        select: { roomTypeId: true, arrivalAt: true, departureAt: true },
      });
      const unsellable = await unsellableByNight(tx, user.tenantId, windows);
      const overrideSources = new Map(
        (await tx.rateOverride.findMany({ where: { tenantId: user.tenantId, date: { gte: dbDate(from), lte: dbDate(to) } }, select: { roomTypeId: true, date: true, source: true } })).map((o) => [
          `${o.roomTypeId}|${fromDbDate(o.date)}`,
          o.source as 'MANUAL' | 'PRICING',
        ]),
      );
      const rooms = await tx.room.groupBy({ by: ['roomTypeId'], where: { tenantId: user.tenantId }, _count: { _all: true } });
      const roomCount = new Map(rooms.map((r) => [r.roomTypeId, r._count._all]));
      const occ = new Map<string, { sellable: number; booked: number }>();
      const roomTypes = types.map((t) => {
        const total = roomCount.get(t.id) ?? 0;
        return {
          roomType: { id: t.id, name: t.name, basePriceKobo: t.basePriceKobo },
          days: windows.map((w) => {
            const bar = barForNight(t, w.date, ctx.rules, ctx.overrides);
            const price = planPrice(plan, t.id, bar.baseRateKobo);
            const blocked = unsellable.get(`${t.id}|${w.date}`) ?? 0;
            const sellable = Math.max(0, total - blocked);
            const booked = stays.filter((s) => s.roomTypeId === t.id && s.arrivalAt < w.end && s.departureAt > w.start).length;
            const o = occ.get(w.date) ?? { sellable: 0, booked: 0 };
            o.sellable += sellable;
            o.booked += Math.min(booked, sellable);
            occ.set(w.date, o);
            return {
              date: w.date,
              rateKobo: price ?? 0,
              baseRateKobo: bar.baseRateKobo,
              source: plan.pricing === 'FIXED' ? 'FIXED' : bar.source,
              ruleId: bar.ruleId,
              ruleName: bar.ruleName,
              override: bar.source === 'OVERRIDE',
              overrideSource: bar.source === 'OVERRIDE' ? (overrideSources.get(`${t.id}|${w.date}`) ?? 'MANUAL') : null,
              sold: price !== null,
              restriction: restrictionOn(ctx.restrictions, t.id, w.date),
              sellable,
              booked,
              available: Math.max(0, sellable - booked),
              blocked,
            };
          }),
        };
      });
      const bands = ctx.promotions
        ? await tx.rateRule.findMany({ where: { tenantId: user.tenantId, dateFrom: { lte: dbDate(to) }, dateTo: { gte: dbDate(from) } }, orderBy: [{ priority: 'desc' }, { dateFrom: 'asc' }] })
        : [];
      return {
        from,
        to,
        today: lagosDate(),
        promotions: ctx.promotions,
        ratePlan: planRow ? await this.planView(tx, planRow) : { ...VIRTUAL_BAR, label: 'Flexible' },
        roomTypes,
        bands: bands.map(ruleView),
        occupancy: dates.map((d) => {
          const o = occ.get(d) ?? { sellable: 0, booked: 0 };
          return { date: d, sellable: o.sellable, booked: o.booked, rate: o.sellable ? Math.round((o.booked / o.sellable) * 10_000) / 10_000 : 0 };
        }),
      };
    });
  }

  /** Exposed for the unit tests of the adjustment maths. */
  static adjust = applyAdjustment;
}
