import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { PriceChange, PriceSuggestion, PricingEvent as PricingEventRow, PricingSetting, Prisma, RoomType } from '../../generated/prisma/client.js';
import type { PriceChangeSource, PricingMode, SuggestionStatus } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { AppException } from '../../common/errors/app-exception.js';
import { runInProperty } from '../../common/property-scope.js';
import { addDays, DAY_MS, dateRange, dbDate, diffDays, fromDbDate, isIsoDate, lagosClock, lagosDate, lagosDateTime, nightWindow } from '../../common/time/lagos.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, SYSTEM_ACTOR, userActor, type AuditActor } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { OPS_JOBS } from '../jobs/jobs.constants.js';
import { ProJobsService } from '../jobs/pro-jobs.service.js';
import { appError, Err, paginate, primaryProperty, userNames, userRef } from '../ops/ops.helpers.js';
import { ACTIVE_STATUSES } from '../rates/capacity.js';
import { barForNight } from '../rates/rates.logic.js';
import { RatesService } from '../rates/rates.service.js';
import { relevantCompetitors, suggest, type EngineInput, type EngineOutput, type Factor, type Guardrail as EngineGuardrail } from './engine.js';
import { IMPACT_BPS, nationalEventsBetween, type CalendarEvent, type EventImpact } from './events.js';
import { inSeries } from '../../common/utils/in-series.js';

const MAX_RANGE_DAYS = 366;
const SPIKE_WINDOW_DAYS = 30;
const SPIKE_MIN_INTERVAL_MS = 60 * 60_000;
const DISCLAIMER =
  'Estimate: assumes the same rooms would have sold at the earlier price. Demand changes with price, so treat this as a guide, not an accounting figure.';

type Actor = { user: AuthUser | null; actor: AuditActor };

interface Night {
  roomType: RoomType;
  date: string;
  input: EngineInput;
  out: EngineOutput;
}

interface RunOptions {
  from?: string;
  to?: string;
  roomTypeIds?: string[];
  /** Apply at once (autopilot) instead of leaving PENDING suggestions. */
  apply: boolean;
  reasonSuffix?: string;
}

/**
 * M5 dynamic pricing (feature `dynamic_pricing`), per property: settings,
 * guardrails, frozen dates, events, competitor prices, suggestions and the
 * change log. Prices are applied as rate overrides with source PRICING, so
 * every consumer of `resolveNightlyRates` picks them up.
 */
@Injectable()
export class DynamicPricingService {
  private readonly logger = new Logger(DynamicPricingService.name);

  constructor(
    private readonly db: DbService,
    private readonly rates: RatesService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {
    ProJobsService.register(OPS_JOBS.pricingNightly.name, DynamicPricingService);
    ProJobsService.register(OPS_JOBS.pricingPace.name, DynamicPricingService);
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  private async settingsRow(tx: Tx, tenantId: string, propertyId: string): Promise<PricingSetting> {
    const s = await tx.pricingSetting.findFirst({ where: { propertyId } });
    if (s) return s;
    return tx.pricingSetting.upsert({ where: { propertyId }, create: { tenantId, propertyId }, update: {} });
  }

  static nextRunAt(now = new Date()): string {
    const today = lagosDate(now);
    const { hhmm } = lagosClock(now);
    return lagosDateTime(hhmm < '03:00' ? today : addDays(today, 1), '03:00').toISOString();
  }

  private settingsView(s: PricingSetting) {
    return {
      mode: s.mode,
      horizonDays: s.horizonDays,
      minChangeBps: s.minChangeBps,
      paceSpikeEnabled: s.paceSpikeEnabled,
      paceSpikeRooms: s.paceSpikeRooms,
      lastRunAt: s.lastRunAt?.toISOString() ?? null,
      nextRunAt: s.mode === 'OFF' ? null : DynamicPricingService.nextRunAt(),
    };
  }

  getSettings(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      return this.settingsView(await this.settingsRow(tx, user.tenantId, p.id));
    });
  }

  putSettings(user: AuthUser, dto: { mode?: PricingMode; horizonDays?: number; minChangeBps?: number; paceSpikeEnabled?: boolean; paceSpikeRooms?: number }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const before = await this.settingsRow(tx, user.tenantId, p.id);
      const s = await tx.pricingSetting.update({
        where: { id: before.id },
        data: {
          ...(dto.mode !== undefined && { mode: dto.mode }),
          ...(dto.horizonDays !== undefined && { horizonDays: dto.horizonDays }),
          ...(dto.minChangeBps !== undefined && { minChangeBps: dto.minChangeBps }),
          ...(dto.paceSpikeEnabled !== undefined && { paceSpikeEnabled: dto.paceSpikeEnabled }),
          ...(dto.paceSpikeRooms !== undefined && { paceSpikeRooms: dto.paceSpikeRooms }),
        },
      });
      if (dto.mode && dto.mode !== before.mode && dto.mode !== 'SUGGEST') {
        // Pending suggestions are moot once the engine is off or on autopilot.
        await tx.priceSuggestion.updateMany({ where: { propertyId: p.id, status: 'PENDING' }, data: { status: 'EXPIRED', decidedAt: new Date() } });
      }
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pricing.settings_updated', entityType: 'pricing_setting', entityId: s.id, metadata: { ...dto, previousMode: before.mode }, ip });
      return this.settingsView(s);
    });
  }

  // ---------------------------------------------------------------------------
  // Guardrails
  // ---------------------------------------------------------------------------

  static defaultGuardrail(basePriceKobo: number): EngineGuardrail {
    return { enabled: true, floorKobo: Math.round((basePriceKobo * 0.7) / 100) * 100, ceilingKobo: basePriceKobo * 2, maxDailyChangeBps: 1500 };
  }

  private async guardrailMap(tx: Tx, types: RoomType[]): Promise<Map<string, EngineGuardrail>> {
    const rows = await tx.pricingGuardrail.findMany({ where: { roomTypeId: { in: types.map((t) => t.id) } } });
    const byType = new Map(rows.map((r) => [r.roomTypeId, r]));
    return new Map(
      types.map((t) => {
        const r = byType.get(t.id);
        return [t.id, r ? { enabled: r.enabled, floorKobo: r.floorKobo, ceilingKobo: r.ceilingKobo, maxDailyChangeBps: r.maxDailyChangeBps } : DynamicPricingService.defaultGuardrail(t.basePriceKobo)];
      }),
    );
  }

  private guardrailView(t: RoomType, g: EngineGuardrail) {
    return { roomType: { id: t.id, name: t.name, basePriceKobo: t.basePriceKobo }, ...g };
  }

  listGuardrails(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const types = await tx.roomType.findMany({ where: { propertyId: p.id }, orderBy: [{ sortOrder: 'asc' }, { basePriceKobo: 'asc' }] });
      const map = await this.guardrailMap(tx, types);
      return types.map((t) => this.guardrailView(t, map.get(t.id)!));
    });
  }

  putGuardrail(user: AuthUser, roomTypeId: string, dto: Partial<EngineGuardrail>, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const t = await tx.roomType.findFirst({ where: { id: roomTypeId, tenantId: user.tenantId } });
      if (!t) throw AppException.notFound('Room type');
      const cur = (await this.guardrailMap(tx, [t])).get(t.id)!;
      const next = { ...cur, ...Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)) } as EngineGuardrail;
      if (next.floorKobo >= next.ceilingKobo) throw Err.validation('ceilingKobo', 'The ceiling must be above the floor');
      await tx.pricingGuardrail.upsert({
        where: { roomTypeId: t.id },
        create: { tenantId: user.tenantId, propertyId: t.propertyId, roomTypeId: t.id, ...next },
        update: next,
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pricing.guardrail_updated', entityType: 'pricing_guardrail', entityId: t.id, metadata: { roomType: t.name, ...next }, ip });
      return this.guardrailView(t, next);
    });
  }

  // ---------------------------------------------------------------------------
  // Frozen dates
  // ---------------------------------------------------------------------------

  private frozenView(f: { id: string; date: Date; roomTypeId: string | null; note: string; createdById: string | null; createdByName: string | null }) {
    return { id: f.id, date: fromDbDate(f.date), roomTypeId: f.roomTypeId, note: f.note, createdBy: f.createdById ? { id: f.createdById, fullName: f.createdByName ?? '' } : null };
  }

  listFrozen(user: AuthUser, q: { from?: string; to?: string }) {
    const { from, to } = this.range(q.from, q.to, 365);
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const rows = await tx.pricingFrozenDate.findMany({ where: { propertyId: p.id, date: { gte: dbDate(from), lte: dbDate(to) } }, orderBy: [{ date: 'asc' }] });
      return rows.map((f) => this.frozenView(f));
    });
  }

  addFrozen(user: AuthUser, dto: { date?: string; dateFrom?: string; dateTo?: string; roomTypeId?: string | null; note?: string }, ip?: string) {
    const from = dto.date ?? dto.dateFrom;
    const to = dto.date ?? dto.dateTo ?? dto.dateFrom;
    if (!from || !to || !isIsoDate(from) || !isIsoDate(to)) throw Err.validation('date', 'Give a date, or dateFrom and dateTo (YYYY-MM-DD)');
    if (to < from) throw Err.validation('dateTo', '"dateTo" must not be before "dateFrom"');
    if (diffDays(from, to) >= MAX_RANGE_DAYS) throw Err.validation('dateTo', `At most ${MAX_RANGE_DAYS} days at once`);
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      if (dto.roomTypeId) {
        const t = await tx.roomType.findFirst({ where: { id: dto.roomTypeId, propertyId: p.id } });
        if (!t) throw AppException.notFound('Room type');
      }
      const out = [];
      for (const d of dateRange(from, to)) {
        const existing = await tx.pricingFrozenDate.findFirst({ where: { propertyId: p.id, date: dbDate(d), roomTypeId: dto.roomTypeId ?? null } });
        const row = existing
          ? await tx.pricingFrozenDate.update({ where: { id: existing.id }, data: { note: dto.note ?? existing.note } })
          : await tx.pricingFrozenDate.create({ data: { tenantId: user.tenantId, propertyId: p.id, date: dbDate(d), roomTypeId: dto.roomTypeId ?? null, note: dto.note ?? '', createdById: user.userId, createdByName: user.fullName } });
        out.push(this.frozenView(row));
      }
      // Frozen nights keep their price: pending suggestions on them are withdrawn.
      await tx.priceSuggestion.updateMany({
        where: { propertyId: p.id, status: 'PENDING', date: { gte: dbDate(from), lte: dbDate(to) }, ...(dto.roomTypeId && { roomTypeId: dto.roomTypeId }) },
        data: { status: 'EXPIRED', decidedAt: new Date() },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pricing.dates_frozen', entityType: 'pricing_frozen_date', metadata: { from, to, roomTypeId: dto.roomTypeId ?? null, note: dto.note ?? '' }, ip });
      return out;
    });
  }

  removeFrozen(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const f = await tx.pricingFrozenDate.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!f) throw AppException.notFound('Frozen date');
      await tx.pricingFrozenDate.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pricing.date_unfrozen', entityType: 'pricing_frozen_date', entityId: id, metadata: { date: fromDbDate(f.date), roomTypeId: f.roomTypeId }, ip });
      return { deleted: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  private customView(e: PricingEventRow): CalendarEvent {
    return {
      id: e.id,
      kind: 'CUSTOM',
      name: e.name,
      dateFrom: fromDbDate(e.dateFrom),
      dateTo: fromDbDate(e.dateTo),
      impact: e.impact as EventImpact,
      upliftBps: e.upliftBps,
      moonDependent: false,
      city: e.city,
      disabled: e.disabled,
      note: e.note,
    };
  }

  /** National events (with this property's overrides) plus custom events overlapping [from, to]. */
  async eventsBetween(tx: Tx, propertyId: string, from: string, to: string): Promise<CalendarEvent[]> {
    const rows = await tx.pricingEvent.findMany({ where: { propertyId } });
    const overrides = new Map(rows.filter((r) => r.kind === 'NATIONAL' && r.nationalKey).map((r) => [r.nationalKey!, r]));
    const national = nationalEventsBetween(from, to).map((e) => {
      const o = overrides.get(e.id.slice('national:'.length));
      return o ? { ...e, disabled: o.disabled, upliftBps: o.upliftBps } : e;
    });
    const custom = rows
      .filter((r) => r.kind === 'CUSTOM')
      .map((r) => this.customView(r))
      .filter((e) => e.dateFrom <= to && e.dateTo >= from);
    return [...national, ...custom].sort((a, b) => a.dateFrom.localeCompare(b.dateFrom) || a.name.localeCompare(b.name));
  }

  listEvents(user: AuthUser, q: { from?: string; to?: string }) {
    const { from, to } = this.range(q.from, q.to, 365, 800);
    return this.db.tenant(user.tenantId, async (tx) => this.eventsBetween(tx, (await primaryProperty(tx, user.tenantId)).id, from, to));
  }

  createEvent(user: AuthUser, dto: { name: string; dateFrom: string; dateTo: string; impact?: EventImpact; upliftBps?: number; city?: string | null; note?: string }, ip?: string) {
    if (dto.dateTo < dto.dateFrom) throw Err.validation('dateTo', '"dateTo" must not be before "dateFrom"');
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const impact = dto.impact ?? 'MEDIUM';
      const e = await tx.pricingEvent.create({
        data: { tenantId: user.tenantId, propertyId: p.id, kind: 'CUSTOM', name: dto.name.trim(), dateFrom: dbDate(dto.dateFrom), dateTo: dbDate(dto.dateTo), impact, upliftBps: dto.upliftBps ?? IMPACT_BPS[impact], city: dto.city ?? null, note: dto.note ?? '' },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pricing.event_created', entityType: 'pricing_event', entityId: e.id, metadata: { name: e.name, dateFrom: dto.dateFrom, dateTo: dto.dateTo, upliftBps: e.upliftBps }, ip });
      return this.customView(e);
    });
  }

  patchEvent(user: AuthUser, id: string, dto: { name?: string; dateFrom?: string; dateTo?: string; impact?: EventImpact; upliftBps?: number; city?: string | null; note?: string; disabled?: boolean }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      if (id.startsWith('national:')) {
        const key = id.slice('national:'.length);
        const year = Number(key.slice(-4));
        const base = nationalEventsBetween(`${year}-01-01`, `${year}-12-31`).find((e) => e.id === id);
        if (!base) throw AppException.notFound('Event');
        const existing = await tx.pricingEvent.findFirst({ where: { propertyId: p.id, nationalKey: key } });
        const data = {
          disabled: dto.disabled ?? existing?.disabled ?? false,
          upliftBps: dto.upliftBps ?? existing?.upliftBps ?? base.upliftBps,
        };
        await tx.pricingEvent.upsert({
          where: { propertyId_nationalKey: { propertyId: p.id, nationalKey: key } },
          create: { tenantId: user.tenantId, propertyId: p.id, kind: 'NATIONAL', nationalKey: key, name: base.name, dateFrom: dbDate(base.dateFrom), dateTo: dbDate(base.dateTo), impact: base.impact, ...data },
          update: data,
        });
        await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pricing.event_updated', entityType: 'pricing_event', entityId: null, metadata: { id, ...data }, ip });
        return { ...base, ...data };
      }
      const e = await tx.pricingEvent.findFirst({ where: { id, propertyId: p.id, kind: 'CUSTOM' } });
      if (!e) throw AppException.notFound('Event');
      const dateFrom = dto.dateFrom ?? fromDbDate(e.dateFrom);
      const dateTo = dto.dateTo ?? fromDbDate(e.dateTo);
      if (dateTo < dateFrom) throw Err.validation('dateTo', '"dateTo" must not be before "dateFrom"');
      const impact = dto.impact ?? (e.impact as EventImpact);
      const updated = await tx.pricingEvent.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name.trim() }),
          dateFrom: dbDate(dateFrom),
          dateTo: dbDate(dateTo),
          impact,
          upliftBps: dto.upliftBps ?? (dto.impact ? IMPACT_BPS[impact] : e.upliftBps),
          ...(dto.city !== undefined && { city: dto.city }),
          ...(dto.note !== undefined && { note: dto.note }),
          ...(dto.disabled !== undefined && { disabled: dto.disabled }),
        },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pricing.event_updated', entityType: 'pricing_event', entityId: id, metadata: { ...dto }, ip });
      return this.customView(updated);
    });
  }

  deleteEvent(user: AuthUser, id: string, ip?: string) {
    if (id.startsWith('national:')) throw Err.validation('id', 'National holidays cannot be deleted; disable them instead');
    return this.db.tenant(user.tenantId, async (tx) => {
      const e = await tx.pricingEvent.findFirst({ where: { id, tenantId: user.tenantId, kind: 'CUSTOM' } });
      if (!e) throw AppException.notFound('Event');
      await tx.pricingEvent.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pricing.event_deleted', entityType: 'pricing_event', entityId: id, metadata: { name: e.name }, ip });
      return { deleted: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Competitor prices
  // ---------------------------------------------------------------------------

  private competitorView(c: { id: string; competitorName: string; date: Date; rateKobo: number; roomTypeId: string | null; createdAt: Date }) {
    return { id: c.id, competitorName: c.competitorName, date: fromDbDate(c.date), rateKobo: c.rateKobo, roomTypeId: c.roomTypeId, createdAt: c.createdAt.toISOString() };
  }

  listCompetitors(user: AuthUser, q: { from?: string; to?: string }) {
    const { from, to } = this.range(q.from, q.to, 90);
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const rows = await tx.competitorRate.findMany({ where: { propertyId: p.id, date: { gte: dbDate(from), lte: dbDate(to) } }, orderBy: [{ date: 'asc' }, { competitorName: 'asc' }] });
      return rows.map((c) => this.competitorView(c));
    });
  }

  putCompetitors(user: AuthUser, entries: { competitorName: string; date: string; rateKobo: number; roomTypeId?: string | null }[], ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const typeIds = [...new Set(entries.map((e) => e.roomTypeId).filter((x): x is string => !!x))];
      if (typeIds.length && (await tx.roomType.count({ where: { id: { in: typeIds }, propertyId: p.id } })) !== typeIds.length) throw Err.validation('roomTypeId', 'Unknown room type');
      const out = [];
      for (const e of entries) {
        const name = e.competitorName.trim();
        const existing = await tx.competitorRate.findFirst({ where: { propertyId: p.id, competitorName: name, date: dbDate(e.date), roomTypeId: e.roomTypeId ?? null } });
        const row = existing
          ? await tx.competitorRate.update({ where: { id: existing.id }, data: { rateKobo: e.rateKobo } })
          : await tx.competitorRate.create({ data: { tenantId: user.tenantId, propertyId: p.id, competitorName: name, date: dbDate(e.date), rateKobo: e.rateKobo, roomTypeId: e.roomTypeId ?? null } });
        out.push(this.competitorView(row));
      }
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'pricing.competitors_updated', entityType: 'competitor_rate', metadata: { count: entries.length }, ip });
      return out;
    });
  }

  removeCompetitor(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const c = await tx.competitorRate.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!c) throw AppException.notFound('Competitor price');
      await tx.competitorRate.delete({ where: { id } });
      return { deleted: true };
    });
  }

  // ---------------------------------------------------------------------------
  // The engine over a range
  // ---------------------------------------------------------------------------

  private range(from?: string, to?: string, defaultDays = 90, maxDays = MAX_RANGE_DAYS) {
    const f = from && isIsoDate(from) ? from : lagosDate();
    const t = to && isIsoDate(to) ? to : addDays(f, defaultDays - 1);
    if (t < f) throw Err.validation('to', '"to" must not be before "from"');
    if (diffDays(f, t) >= maxDays) throw Err.validation('to', `The range can be at most ${maxDays} days`);
    return { from: f, to: t };
  }

  /** Engine inputs and outputs for every (room type, night) in [from, to]. */
  async compute(tx: Tx, tenantId: string, propertyId: string, from: string, to: string, roomTypeIds?: string[], now = new Date()): Promise<Night[]> {
    const today = lagosDate(now);
    if (from < today) from = today;
    if (to < from) return [];
    const property = await tx.property.findFirstOrThrow({ where: { id: propertyId } });
    const settings = await this.settingsRow(tx, tenantId, propertyId);
    const types = await tx.roomType.findMany({ where: { propertyId, ...(roomTypeIds?.length && { id: { in: roomTypeIds } }) }, orderBy: [{ sortOrder: 'asc' }, { basePriceKobo: 'asc' }] });
    if (!types.length) return [];
    const typeIds = types.map((t) => t.id);
    const rooms = await tx.room.groupBy({ by: ['roomTypeId'], where: { propertyId, roomTypeId: { in: typeIds } }, _count: { _all: true } });
    const roomCount = new Map(rooms.map((r) => [r.roomTypeId, r._count._all]));
    const features = (await this.entitlements.getEntitlements(tenantId, tx)).features;
    const ctx = await this.rates.context(tx, tenantId, from, to, features, propertyId);
    const manual = new Set(
      (await tx.rateOverride.findMany({ where: { propertyId, roomTypeId: { in: typeIds }, source: 'MANUAL', date: { gte: dbDate(from), lte: dbDate(to) } }, select: { roomTypeId: true, date: true } })).map(
        (o) => `${o.roomTypeId}|${fromDbDate(o.date)}`,
      ),
    );
    const guardrails = await this.guardrailMap(tx, types);
    const frozen = await tx.pricingFrozenDate.findMany({ where: { propertyId, date: { gte: dbDate(from), lte: dbDate(to) } } });
    const frozenSet = new Set(frozen.map((f) => `${f.roomTypeId ?? '*'}|${fromDbDate(f.date)}`));
    const city = property.city.trim().toLowerCase();
    const events = (await this.eventsBetween(tx, propertyId, from, to)).filter((e) => !e.disabled && (!e.city || e.city.trim().toLowerCase() === city));
    const competitors = await tx.competitorRate.findMany({ where: { propertyId, date: { gte: dbDate(from), lte: dbDate(to) } } });

    // Reservations touching the horizon and the reference nights four weeks back.
    const histFrom = addDays(from, -28);
    const first = nightWindow(histFrom, property.checkInTime, property.checkOutTime);
    const last = nightWindow(to, property.checkInTime, property.checkOutTime);
    const stays = await tx.reservation.findMany({
      where: { propertyId, roomTypeId: { in: typeIds }, arrivalAt: { lt: last.end }, departureAt: { gt: first.start } },
      select: { roomTypeId: true, arrivalAt: true, departureAt: true, createdAt: true, cancelledAt: true, status: true },
    });
    const earliest = await tx.reservation.findFirst({ where: { propertyId }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
    const byType = new Map<string, typeof stays>();
    for (const s of stays) byType.set(s.roomTypeId, [...(byType.get(s.roomTypeId) ?? []), s]);

    const out: Night[] = [];
    for (const t of types) {
      const list = byType.get(t.id) ?? [];
      const covering = (d: string) => {
        const w = nightWindow(d, property.checkInTime, property.checkOutTime);
        return list.filter((s) => s.arrivalAt < w.end && s.departureAt > w.start);
      };
      for (const date of dateRange(from, to)) {
        const daysOut = diffDays(today, date);
        const sold = covering(date).filter((s) => ACTIVE_STATUSES.includes(s.status)).length;
        const reference: EngineInput['reference'] = [];
        for (let w = 1; w <= 4; w++) {
          const ref = addDays(date, -7 * w);
          if (ref >= today) continue;
          const cutoff = new Date(now.getTime() - 7 * w * DAY_MS);
          if (!earliest || earliest.createdAt > cutoff) continue;
          const c = covering(ref);
          reference.push({
            otbAtLead: c.filter((s) => s.createdAt <= cutoff && (!s.cancelledAt || s.cancelledAt > cutoff)).length,
            final: c.filter((s) => s.status !== 'CANCELLED' && s.status !== 'NO_SHOW').length,
          });
        }
        const key = `${t.id}|${date}`;
        const currentKobo = barForNight(t, date, ctx.rules, ctx.overrides).baseRateKobo;
        const input: EngineInput = {
          date,
          currentKobo,
          baseKobo: t.basePriceKobo,
          capacity: roomCount.get(t.id) ?? 0,
          sold,
          daysOut,
          reference,
          events: events.filter((e) => e.dateFrom <= date && e.dateTo >= date).map((e) => ({ name: e.name, upliftBps: e.upliftBps })),
          competitorKobo: relevantCompetitors(currentKobo, competitors.filter((c) => fromDbDate(c.date) === date), t.id),
          guardrail: guardrails.get(t.id)!,
          minChangeBps: settings.minChangeBps,
          frozen: frozenSet.has(`*|${date}`) || frozenSet.has(key),
          manualOverride: manual.has(key),
        };
        if (!input.capacity) continue;
        out.push({ roomType: t, date, input, out: suggest(input) });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Suggestions and changes
  // ---------------------------------------------------------------------------

  private async suggestionViews(tx: Tx, rows: PriceSuggestion[]) {
    const types = new Map((await tx.roomType.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.roomTypeId))] } }, select: { id: true, name: true } })).map((t) => [t.id, t]));
    return rows.map((s) => ({
      id: s.id,
      roomType: types.get(s.roomTypeId) ?? { id: s.roomTypeId, name: 'Room type' },
      date: fromDbDate(s.date),
      currentKobo: s.currentKobo,
      suggestedKobo: s.suggestedKobo,
      changeBps: s.changeBps,
      factors: s.factors as unknown as Factor[],
      reason: s.reason,
      occupancy: s.occupancy as unknown as EngineOutput['occupancy'],
      confidence: s.confidence as EngineOutput['confidence'],
      status: s.status,
      generatedAt: s.generatedAt.toISOString(),
      decidedAt: s.decidedAt?.toISOString() ?? null,
      decidedBy: s.decidedById ? { id: s.decidedById, fullName: s.decidedByName ?? '' } : null,
    }));
  }

  private async changeViews(tx: Tx, rows: PriceChange[]) {
    const types = new Map((await tx.roomType.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.roomTypeId))] } }, select: { id: true, name: true } })).map((t) => [t.id, t]));
    const names = await userNames(tx, rows.map((r) => r.byId));
    return rows.map((c) => ({
      id: c.id,
      roomType: types.get(c.roomTypeId) ?? { id: c.roomTypeId, name: 'Room type' },
      date: fromDbDate(c.date),
      fromKobo: c.fromKobo,
      toKobo: c.toKobo,
      source: c.source,
      reason: c.reason,
      suggestionId: c.suggestionId,
      by: userRef(names, c.byId, c.byName),
      createdAt: c.createdAt.toISOString(),
      reverted: c.reverted,
    }));
  }

  listSuggestions(user: AuthUser, q: { from?: string; to?: string; roomTypeId?: string; status?: SuggestionStatus }) {
    const { from, to } = this.range(q.from, q.to, 365);
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const rows = await tx.priceSuggestion.findMany({
        where: { propertyId: p.id, status: q.status ?? 'PENDING', date: { gte: dbDate(from), lte: dbDate(to) }, ...(q.roomTypeId && { roomTypeId: q.roomTypeId }) },
        orderBy: [{ date: 'asc' }, { roomTypeId: 'asc' }, { generatedAt: 'desc' }],
        take: 2000,
      });
      return this.suggestionViews(tx, rows);
    });
  }

  /**
   * Writes the price as a PRICING rate override and logs the change. Nights
   * with a MANUAL override are never touched.
   */
  private async apply(
    tx: Tx,
    a: { tenantId: string; propertyId: string; roomTypeId: string; date: string; fromKobo: number; toKobo: number; source: PriceChangeSource; reason: string; suggestionId: string | null; by: AuthUser | null },
  ): Promise<PriceChange> {
    const existing = await tx.rateOverride.findUnique({ where: { roomTypeId_date: { roomTypeId: a.roomTypeId, date: dbDate(a.date) } } });
    if (existing && existing.source === 'MANUAL') {
      throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'This night has a manual rate override; dynamic pricing leaves it alone', { status: 'MANUAL_OVERRIDE', allowed: [] });
    }
    await tx.rateOverride.upsert({
      where: { roomTypeId_date: { roomTypeId: a.roomTypeId, date: dbDate(a.date) } },
      create: { tenantId: a.tenantId, propertyId: a.propertyId, roomTypeId: a.roomTypeId, date: dbDate(a.date), rateKobo: a.toKobo, source: 'PRICING', note: 'Dynamic pricing', updatedById: a.by?.userId ?? null, updatedByName: a.by?.fullName ?? 'Autopilot' },
      update: { rateKobo: a.toKobo, source: 'PRICING', note: 'Dynamic pricing', updatedById: a.by?.userId ?? null, updatedByName: a.by?.fullName ?? 'Autopilot' },
    });
    return tx.priceChange.create({
      data: {
        tenantId: a.tenantId,
        propertyId: a.propertyId,
        roomTypeId: a.roomTypeId,
        date: dbDate(a.date),
        fromKobo: a.fromKobo,
        toKobo: a.toKobo,
        previousKobo: existing?.rateKobo ?? null,
        source: a.source,
        reason: a.reason,
        suggestionId: a.suggestionId,
        byId: a.by?.userId ?? null,
        byName: a.by?.fullName ?? null,
      },
    });
  }

  /** Generates suggestions (and applies them on autopilot) for one property. */
  async runTx(tx: Tx, tenantId: string, propertyId: string, opts: RunOptions, by: Actor) {
    const settings = await this.settingsRow(tx, tenantId, propertyId);
    const from = opts.from ?? lagosDate();
    const to = opts.to ?? addDays(lagosDate(), settings.horizonDays - 1);
    const nights = await this.compute(tx, tenantId, propertyId, from, to, opts.roomTypeIds);
    let generated = 0;
    let applied = 0;
    let skipped = 0;
    const created: PriceSuggestion[] = [];
    for (const n of nights) {
      const pending = { propertyId, roomTypeId: n.roomType.id, date: dbDate(n.date), status: 'PENDING' as const };
      if (n.out.blockedBy) {
        skipped++;
        // A pending suggestion that no longer holds (frozen, manual, now small) is withdrawn.
        await tx.priceSuggestion.updateMany({ where: pending, data: { status: 'SUPERSEDED', decidedAt: new Date() } });
        continue;
      }
      await tx.priceSuggestion.updateMany({ where: pending, data: { status: 'SUPERSEDED', decidedAt: new Date() } });
      const reason = opts.reasonSuffix ? `${n.out.reason}; ${opts.reasonSuffix}` : n.out.reason;
      const s = await tx.priceSuggestion.create({
        data: {
          tenantId,
          propertyId,
          roomTypeId: n.roomType.id,
          date: dbDate(n.date),
          currentKobo: n.input.currentKobo,
          suggestedKobo: n.out.suggestedKobo,
          changeBps: n.out.changeBps,
          factors: n.out.factors as unknown as Prisma.InputJsonValue,
          reason,
          occupancy: n.out.occupancy as unknown as Prisma.InputJsonValue,
          confidence: n.out.confidence,
          status: opts.apply ? 'APPLIED' : 'PENDING',
          ...(opts.apply && { decidedAt: new Date() }),
        },
      });
      created.push(s);
      generated++;
      if (opts.apply) {
        await this.apply(tx, { tenantId, propertyId, roomTypeId: n.roomType.id, date: n.date, fromKobo: n.input.currentKobo, toKobo: n.out.suggestedKobo, source: 'AUTOPILOT', reason, suggestionId: s.id, by: null });
        applied++;
      }
    }
    await tx.pricingSetting.update({ where: { id: settings.id }, data: { lastRunAt: new Date() } });
    await this.audit.record(tx, {
      tenantId,
      propertyId,
      actor: by.actor,
      action: opts.apply ? 'pricing.autopilot' : 'pricing.run',
      entityType: applied ? 'price_change' : 'pricing_setting',
      entityId: settings.id,
      metadata: { from, to, generated, applied, skipped, ...(opts.reasonSuffix && { trigger: opts.reasonSuffix }) },
    });
    return { generated, applied, skipped, suggestions: await this.suggestionViews(tx, created) };
  }

  run(user: AuthUser, dto: { from?: string; to?: string }) {
    const { from, to } = this.range(dto.from, dto.to, 90);
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const s = await this.settingsRow(tx, user.tenantId, p.id);
      return this.runTx(tx, user.tenantId, p.id, { from, to, apply: s.mode === 'AUTOPILOT' }, { user, actor: userActor(user) });
    });
  }

  preview(user: AuthUser, q: { roomTypeId: string; date: string }) {
    if (!isIsoDate(q.date)) throw Err.validation('date', 'Give a date (YYYY-MM-DD)');
    if (q.date < lagosDate()) throw Err.validation('date', 'Only today and future nights can be priced');
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const t = await tx.roomType.findFirst({ where: { id: q.roomTypeId, propertyId: p.id } });
      if (!t) throw AppException.notFound('Room type');
      const [n] = await this.compute(tx, user.tenantId, p.id, q.date, q.date, [t.id]);
      if (!n) throw Err.validation('roomTypeId', 'This room type has no rooms to price');
      return {
        roomType: { id: t.id, name: t.name },
        date: n.date,
        currentKobo: n.input.currentKobo,
        suggestedKobo: n.out.suggestedKobo,
        changeBps: n.out.changeBps,
        factors: n.out.factors,
        reason: n.out.reason,
        occupancy: n.out.occupancy,
        confidence: n.out.confidence,
        blockedBy: n.out.blockedBy,
      };
    });
  }

  private async decide(tx: Tx, user: AuthUser, id: string, action: 'ACCEPT' | 'REJECT', opts: { priceKobo?: number; note?: string } = {}) {
    const s = await tx.priceSuggestion.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!s) throw AppException.notFound('Suggestion');
    if (s.status !== 'PENDING') throw Err.invalidState(s.status, ['PENDING'], 'This suggestion');
    const date = fromDbDate(s.date);
    if (action === 'REJECT') {
      const updated = await tx.priceSuggestion.update({ where: { id }, data: { status: 'REJECTED', decidedAt: new Date(), decidedById: user.userId, decidedByName: user.fullName } });
      await this.audit.record(tx, { tenantId: user.tenantId, propertyId: s.propertyId, actor: userActor(user), action: 'pricing.rejected', entityType: 'price_suggestion', entityId: id, metadata: { date, suggestedKobo: s.suggestedKobo, note: opts.note ?? '' } });
      return { suggestion: updated, change: null };
    }
    if (date < lagosDate()) throw Err.invalidState('PAST', ['PENDING'], 'This night');
    let price = s.suggestedKobo;
    let reason = s.reason;
    if (opts.priceKobo !== undefined && opts.priceKobo !== s.suggestedKobo) {
      const t = await tx.roomType.findFirstOrThrow({ where: { id: s.roomTypeId } });
      const g = (await this.guardrailMap(tx, [t])).get(t.id)!;
      if (g.enabled && (opts.priceKobo < g.floorKobo || opts.priceKobo > g.ceilingKobo)) {
        throw Err.validation('priceKobo', `The price must be between the floor (₦${(g.floorKobo / 100).toLocaleString('en-NG')}) and the ceiling (₦${(g.ceilingKobo / 100).toLocaleString('en-NG')})`);
      }
      price = opts.priceKobo;
      reason = `${s.reason} (edited to ₦${(price / 100).toLocaleString('en-NG')} by ${user.fullName})`;
    }
    const change = await this.apply(tx, { tenantId: user.tenantId, propertyId: s.propertyId, roomTypeId: s.roomTypeId, date, fromKobo: s.currentKobo, toKobo: price, source: 'ACCEPTED', reason, suggestionId: s.id, by: user });
    const updated = await tx.priceSuggestion.update({ where: { id }, data: { status: 'ACCEPTED', decidedAt: new Date(), decidedById: user.userId, decidedByName: user.fullName } });
    await this.audit.record(tx, { tenantId: user.tenantId, propertyId: s.propertyId, actor: userActor(user), action: 'pricing.applied', entityType: 'price_change', entityId: change.id, metadata: { date, roomTypeId: s.roomTypeId, fromKobo: s.currentKobo, toKobo: price, suggestionId: s.id } });
    return { suggestion: updated, change };
  }

  accept(user: AuthUser, id: string, dto: { priceKobo?: number }) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const r = await this.decide(tx, user, id, 'ACCEPT', dto);
      return { suggestion: (await this.suggestionViews(tx, [r.suggestion]))[0], change: (await this.changeViews(tx, [r.change!]))[0] };
    });
  }

  reject(user: AuthUser, id: string, dto: { note?: string }) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const r = await this.decide(tx, user, id, 'REJECT', dto);
      return (await this.suggestionViews(tx, [r.suggestion]))[0];
    });
  }

  async bulk(user: AuthUser, dto: { ids: string[]; action: 'ACCEPT' | 'REJECT' }) {
    let accepted = 0;
    let rejected = 0;
    const failed: { id: string; reason: string }[] = [];
    for (const id of new Set(dto.ids)) {
      try {
        await this.db.tenant(user.tenantId, (tx) => this.decide(tx, user, id, dto.action));
        if (dto.action === 'ACCEPT') accepted++;
        else rejected++;
      } catch (e) {
        failed.push({ id, reason: (e as Error).message });
      }
    }
    return { accepted, rejected, failed };
  }

  listChanges(user: AuthUser, q: { from?: string; to?: string; roomTypeId?: string; source?: PriceChangeSource; page?: number; pageSize?: number }) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const where: Prisma.PriceChangeWhereInput = {
        propertyId: p.id,
        ...((q.from || q.to) && { date: { ...(q.from && { gte: dbDate(q.from) }), ...(q.to && { lte: dbDate(q.to) }) } }),
        ...(q.roomTypeId && { roomTypeId: q.roomTypeId }),
        ...(q.source && { source: q.source }),
      };
      const [rows, total] = await inSeries(
        () => tx.priceChange.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: pg.skip, take: pg.take }),
        () => tx.priceChange.count({ where }),
      );
      return { items: await this.changeViews(tx, rows), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  revert(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const c = await tx.priceChange.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!c) throw AppException.notFound('Price change');
      if (c.source === 'REVERT') throw Err.invalidState('REVERT', ['ACCEPTED', 'AUTOPILOT'], 'This change');
      if (c.reverted) throw Err.invalidState('REVERTED', ['ACCEPTED', 'AUTOPILOT'], 'This change');
      const date = fromDbDate(c.date);
      if (date < lagosDate()) throw Err.invalidState('PAST', ['ACCEPTED', 'AUTOPILOT'], 'This night');
      const later = await tx.priceChange.findFirst({ where: { roomTypeId: c.roomTypeId, date: c.date, createdAt: { gt: c.createdAt }, reverted: false, source: { not: 'REVERT' } } });
      if (later) throw Err.invalidState('SUPERSEDED', ['LATEST'], 'This change');
      const override = await tx.rateOverride.findUnique({ where: { roomTypeId_date: { roomTypeId: c.roomTypeId, date: c.date } } });
      if (override?.source === 'MANUAL') throw appError(HttpStatus.CONFLICT, 'INVALID_STATE', 'The night now has a manual rate override', { status: 'MANUAL_OVERRIDE', allowed: [] });
      let restored: number;
      if (c.previousKobo === null) {
        if (override) await tx.rateOverride.delete({ where: { roomTypeId_date: { roomTypeId: c.roomTypeId, date: c.date } } });
        const t = await tx.roomType.findFirstOrThrow({ where: { id: c.roomTypeId } });
        const ctx = await this.rates.context(tx, user.tenantId, date, date, undefined, c.propertyId);
        restored = barForNight(t, date, ctx.rules, ctx.overrides).baseRateKobo;
      } else {
        restored = c.previousKobo;
        await tx.rateOverride.upsert({
          where: { roomTypeId_date: { roomTypeId: c.roomTypeId, date: c.date } },
          create: { tenantId: user.tenantId, propertyId: c.propertyId, roomTypeId: c.roomTypeId, date: c.date, rateKobo: restored, source: 'PRICING', note: 'Dynamic pricing (reverted)', updatedById: user.userId, updatedByName: user.fullName },
          update: { rateKobo: restored, source: 'PRICING', note: 'Dynamic pricing (reverted)', updatedById: user.userId, updatedByName: user.fullName },
        });
      }
      await tx.priceChange.update({ where: { id }, data: { reverted: true } });
      const r = await tx.priceChange.create({
        data: { tenantId: user.tenantId, propertyId: c.propertyId, roomTypeId: c.roomTypeId, date: c.date, fromKobo: c.toKobo, toKobo: restored, previousKobo: c.toKobo, source: 'REVERT', reason: `Reverted by ${user.fullName}`, suggestionId: c.suggestionId, byId: user.userId, byName: user.fullName },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, propertyId: c.propertyId, actor: userActor(user), action: 'pricing.reverted', entityType: 'price_change', entityId: r.id, metadata: { date, roomTypeId: c.roomTypeId, fromKobo: c.toKobo, toKobo: restored, revertedChangeId: c.id }, ip });
      return (await this.changeViews(tx, [r]))[0];
    });
  }

  // ---------------------------------------------------------------------------
  // "What autopilot earned" (estimate)
  // ---------------------------------------------------------------------------

  report(user: AuthUser, q: { from?: string; to?: string }) {
    const to = q.to && isIsoDate(q.to) ? q.to : lagosDate();
    const from = q.from && isIsoDate(q.from) ? q.from : addDays(to, -29);
    if (to < from) throw Err.validation('to', '"to" must not be before "from"');
    if (diffDays(from, to) >= MAX_RANGE_DAYS) throw Err.validation('to', `The range can be at most ${MAX_RANGE_DAYS} days`);
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      const changes = await tx.priceChange.findMany({ where: { propertyId: p.id, date: { gte: dbDate(from), lte: dbDate(to) } }, orderBy: { createdAt: 'asc' } });
      // Per night: the price before dynamic pricing touched it, and the live dynamic change.
      const nights = new Map<string, { roomTypeId: string; date: string; barKobo: number; live: PriceChange | null }>();
      for (const c of changes) {
        const key = `${c.roomTypeId}|${fromDbDate(c.date)}`;
        const n = nights.get(key) ?? { roomTypeId: c.roomTypeId, date: fromDbDate(c.date), barKobo: c.fromKobo, live: null };
        if (c.source === 'REVERT') n.live = null;
        else if (!c.reverted) n.live = c;
        nights.set(key, n);
      }
      const live = [...nights.values()].filter((n) => n.live);
      const types = new Map((await tx.roomType.findMany({ where: { propertyId: p.id }, select: { id: true, name: true } })).map((t) => [t.id, t]));
      const property = await tx.property.findFirstOrThrow({ where: { id: p.id } });
      const stays = live.length
        ? await tx.reservation.findMany({
            where: {
              propertyId: p.id,
              roomTypeId: { in: [...new Set(live.map((n) => n.roomTypeId))] },
              status: { notIn: ['CANCELLED', 'NO_SHOW'] },
              arrivalAt: { lt: nightWindow(to, property.checkInTime, property.checkOutTime).end },
              departureAt: { gt: nightWindow(from, property.checkInTime, property.checkOutTime).start },
            },
            select: { roomTypeId: true, createdAt: true, nightlyRates: true },
          })
        : [];
      let roomNightsSold = 0;
      let actual = 0;
      let bar = 0;
      const byMonth = new Map<string, { actualRevenueKobo: number; barRevenueKobo: number }>();
      const byType = new Map<string, { roomNightsSold: number; upliftKobo: number }>();
      const bySource = new Map<'ACCEPTED' | 'AUTOPILOT', { roomNightsSold: number; upliftKobo: number }>([
        ['ACCEPTED', { roomNightsSold: 0, upliftKobo: 0 }],
        ['AUTOPILOT', { roomNightsSold: 0, upliftKobo: 0 }],
      ]);
      for (const n of live) {
        const c = n.live!;
        for (const s of stays) {
          if (s.roomTypeId !== n.roomTypeId || s.createdAt < c.createdAt) continue;
          const snap = (s.nightlyRates as { date: string; rateKobo: number; baseRateKobo: number }[]).find((x) => x.date === n.date);
          if (!snap) continue;
          const counter = snap.baseRateKobo > 0 ? Math.round((snap.rateKobo * n.barKobo) / snap.baseRateKobo) : n.barKobo;
          const up = snap.rateKobo - counter;
          roomNightsSold++;
          actual += snap.rateKobo;
          bar += counter;
          const m = byMonth.get(n.date.slice(0, 7)) ?? { actualRevenueKobo: 0, barRevenueKobo: 0 };
          m.actualRevenueKobo += snap.rateKobo;
          m.barRevenueKobo += counter;
          byMonth.set(n.date.slice(0, 7), m);
          const t = byType.get(n.roomTypeId) ?? { roomNightsSold: 0, upliftKobo: 0 };
          t.roomNightsSold++;
          t.upliftKobo += up;
          byType.set(n.roomTypeId, t);
          const src = bySource.get(c.source as 'ACCEPTED' | 'AUTOPILOT')!;
          src.roomNightsSold++;
          src.upliftKobo += up;
        }
      }
      return {
        from,
        to,
        nightsRepriced: live.length,
        roomNightsSold,
        actualRevenueKobo: actual,
        barRevenueKobo: bar,
        upliftKobo: actual - bar,
        upliftPct: bar ? Math.round(((actual - bar) / bar) * 10_000) / 100 : 0,
        byMonth: [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, m]) => ({ month, ...m, upliftKobo: m.actualRevenueKobo - m.barRevenueKobo })),
        byRoomType: [...byType.entries()].map(([id, v]) => ({ roomType: types.get(id) ?? { id, name: 'Room type' }, ...v })),
        bySource: [...bySource.entries()].map(([source, v]) => ({ source, ...v })),
        disclaimer: DISCLAIMER,
      };
    });
  }

  /** Dashboard card: mode, pending suggestions, changes today. */
  async summaryTx(tx: Tx, tenantId: string, propertyId: string) {
    const s = await tx.pricingSetting.findFirst({ where: { propertyId } });
    const [pending, changesToday] = await inSeries(
      () => tx.priceSuggestion.count({ where: { propertyId, status: 'PENDING', date: { gte: dbDate(lagosDate()) } } }),
      () => tx.priceChange.count({ where: { propertyId, createdAt: { gte: lagosDateTime(lagosDate()) } } }),
    );
    return { mode: s?.mode ?? 'OFF', pendingSuggestions: pending, changesToday, lastRunAt: s?.lastRunAt?.toISOString() ?? null };
  }

  // ---------------------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------------------

  async runScheduled(job: string) {
    if (job === OPS_JOBS.pricingNightly.name) return this.nightly();
    if (job === OPS_JOBS.pricingPace.name) return this.paceCheck();
    return undefined;
  }

  private async activeSettings(modes: PricingMode[]) {
    return (await this.db.systemAll((tx, t) => tx.pricingSetting.findMany({ where: { ...t.tenants, mode: { in: modes } }, select: { tenantId: true, propertyId: true, mode: true, paceSpikeEnabled: true, paceSpikeRooms: true, lastSpikeRunAt: true } }))).flat();
  }

  /** 03:00 Lagos: re-prices every property whose engine is on. */
  async nightly() {
    const rows = await this.activeSettings(['SUGGEST', 'AUTOPILOT']);
    let properties = 0;
    let applied = 0;
    let generated = 0;
    for (const s of rows) {
      try {
        const ent = await this.entitlements.getEntitlements(s.tenantId);
        if (!ent.features.includes('dynamic_pricing')) continue;
        const r = await this.db.tenant(s.tenantId, (tx) =>
          runInProperty(s.tenantId, s.propertyId, async () => {
            // Pending suggestions for nights that have passed are expired.
            await tx.priceSuggestion.updateMany({ where: { propertyId: s.propertyId, status: 'PENDING', date: { lt: dbDate(lagosDate()) } }, data: { status: 'EXPIRED', decidedAt: new Date() } });
            return this.runTx(tx, s.tenantId, s.propertyId, { apply: s.mode === 'AUTOPILOT' }, { user: null, actor: SYSTEM_ACTOR });
          }),
        );
        properties++;
        applied += r.applied;
        generated += r.generated;
      } catch (e) {
        this.logger.error(`Nightly pricing failed for property ${s.propertyId}: ${(e as Error).message}`);
      }
    }
    return { properties, generated, applied };
  }

  /**
   * Autopilot pace spike: a room type with `paceSpikeRooms` or more rooms
   * booked within 24 h for one night in the next 30 days (and a new booking
   * since the last spike run) is re-priced at once, at most hourly.
   */
  async paceCheck(now = new Date()) {
    const rows = (await this.activeSettings(['AUTOPILOT'])).filter((s) => s.paceSpikeEnabled);
    let triggered = 0;
    for (const s of rows) {
      if (s.lastSpikeRunAt && now.getTime() - s.lastSpikeRunAt.getTime() < SPIKE_MIN_INTERVAL_MS) continue;
      try {
        const ent = await this.entitlements.getEntitlements(s.tenantId);
        if (!ent.features.includes('dynamic_pricing')) continue;
        const done = await this.db.tenant(s.tenantId, (tx) => runInProperty(s.tenantId, s.propertyId, () => this.spikeTx(tx, s, now)));
        if (done) triggered++;
      } catch (e) {
        this.logger.error(`Pace check failed for property ${s.propertyId}: ${(e as Error).message}`);
      }
    }
    return { properties: rows.length, triggered };
  }

  private async spikeTx(tx: Tx, s: { tenantId: string; propertyId: string; paceSpikeRooms: number; lastSpikeRunAt: Date | null }, now: Date): Promise<boolean> {
    const property = await tx.property.findFirstOrThrow({ where: { id: s.propertyId } });
    const today = lagosDate(now);
    const end = addDays(today, SPIKE_WINDOW_DAYS - 1);
    const since = new Date(now.getTime() - DAY_MS);
    const recent = await tx.reservation.findMany({
      where: {
        propertyId: s.propertyId,
        status: { in: ACTIVE_STATUSES },
        createdAt: { gte: since },
        arrivalAt: { lt: nightWindow(end, property.checkInTime, property.checkOutTime).end },
        departureAt: { gt: nightWindow(today, property.checkInTime, property.checkOutTime).start },
      },
      select: { roomTypeId: true, arrivalAt: true, departureAt: true, createdAt: true },
    });
    if (!recent.length || (s.lastSpikeRunAt && !recent.some((r) => r.createdAt > s.lastSpikeRunAt!))) return false;
    const spiking = new Map<string, number>();
    for (const d of dateRange(today, end)) {
      const w = nightWindow(d, property.checkInTime, property.checkOutTime);
      const counts = new Map<string, number>();
      for (const r of recent) if (r.arrivalAt < w.end && r.departureAt > w.start) counts.set(r.roomTypeId, (counts.get(r.roomTypeId) ?? 0) + 1);
      for (const [t, n] of counts) if (n >= s.paceSpikeRooms) spiking.set(t, Math.max(spiking.get(t) ?? 0, n));
    }
    if (!spiking.size) return false;
    await tx.pricingSetting.update({ where: { propertyId: s.propertyId }, data: { lastSpikeRunAt: now } });
    for (const [roomTypeId, n] of spiking) {
      await this.runTx(
        tx,
        s.tenantId,
        s.propertyId,
        { from: today, to: end, roomTypeIds: [roomTypeId], apply: true, reasonSuffix: `booking pace spike: ${n} rooms booked in 24 h` },
        { user: null, actor: SYSTEM_ACTOR },
      );
    }
    return true;
  }
}
