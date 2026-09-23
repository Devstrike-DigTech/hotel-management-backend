import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ChannelConnection, Prisma } from '../../generated/prisma/client.js';
import type { OtaChannel, SyncDirection, SyncKind, SyncStatus } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { signToken, verifyToken } from '../../common/crypto/signed-token.js';
import { AppException } from '../../common/errors/app-exception.js';
import { runInProperty } from '../../common/property-scope.js';
import { addDays, dateRange, dbDate, fromDbDate, humanDate, lagosDate, lagosDateTime, lagosStartOfDay } from '../../common/time/lagos.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, userActor } from '../audit/audit.service.js';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { appError, Err, k, paginate, primaryProperty } from '../ops/ops.helpers.js';
import { freeRoomsOverWindow, loadCapacity } from '../rates/capacity.js';
import { resolveNights } from '../rates/rates.logic.js';
import { RatesService } from '../rates/rates.service.js';
import {
  CHANNEL_PROVIDER,
  ChannelProviderError,
  type AvailabilityValue,
  type ChannelProvider,
  type ProviderConnection,
  type RestrictionValue,
} from './channel-provider.js';
import { buildIcs, nightsToRanges } from './ical.js';

export const DEFAULT_COMMISSION_BPS: Record<OtaChannel, number> = {
  BOOKING_COM: 1500,
  EXPEDIA: 1800,
  AGODA: 1500,
  AIRBNB: 300,
  VRBO: 800,
  HOTELS_NG: 1000,
  OTHER: 1500,
};

export const CHANNEL_LABEL: Record<OtaChannel, string> = {
  AIRBNB: 'Airbnb',
  BOOKING_COM: 'Booking.com',
  EXPEDIA: 'Expedia',
  AGODA: 'Agoda',
  VRBO: 'Vrbo',
  HOTELS_NG: 'Hotels.ng',
  OTHER: 'OTA',
};

export interface ConnectionSettings {
  stopSellBuffer: number;
  commissionBps: Partial<Record<OtaChannel, number>>;
  pushRates: boolean;
  pushRestrictions: boolean;
  horizonDays: number;
}

export function settingsOf(c: Pick<ChannelConnection, 'settings' | 'channel'>): ConnectionSettings {
  const s = (c.settings ?? {}) as Partial<ConnectionSettings>;
  return {
    stopSellBuffer: s.stopSellBuffer ?? 0,
    commissionBps: s.commissionBps ?? {},
    pushRates: s.pushRates ?? true,
    pushRestrictions: s.pushRestrictions ?? true,
    horizonDays: s.horizonDays ?? 365,
  };
}

export function commissionBpsFor(c: Pick<ChannelConnection, 'settings' | 'channel'>, channel: OtaChannel): number {
  return settingsOf(c).commissionBps[channel] ?? DEFAULT_COMMISSION_BPS[channel];
}

/** "Booking.com" / "BookingCom" / "booking" -> BOOKING_COM. */
export function otaChannelOf(name: string | null | undefined): OtaChannel {
  const n = (name ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (n.includes('booking')) return 'BOOKING_COM';
  if (n.includes('expedia')) return 'EXPEDIA';
  if (n.includes('agoda')) return 'AGODA';
  if (n.includes('airbnb')) return 'AIRBNB';
  if (n.includes('vrbo') || n.includes('homeaway')) return 'VRBO';
  if (n.includes('hotelsng')) return 'HOTELS_NG';
  return 'OTHER';
}

interface IcalTokenPayload {
  exp: number;
  tid: string;
  pid: string;
  c: string;
  v: number;
  rt: string;
  r: string | null;
}

/** Groups consecutive dates with the same value into ranges (inclusive `to`). */
export function runsOf<T>(dates: string[], valueOf: (d: string) => T, same: (a: T, b: T) => boolean): { from: string; to: string; value: T }[] {
  const out: { from: string; to: string; value: T }[] = [];
  for (const d of [...dates].sort()) {
    const v = valueOf(d);
    const last = out[out.length - 1];
    if (last && addDays(last.to, 1) === d && same(last.value, v)) last.to = d;
    else out.push({ from: d, to: d, value: v });
  }
  return out;
}

/**
 * Channel manager: connections (iCal, Channex), iCal feeds, mappings,
 * availability / rate / restriction pushes (diffed against what was last
 * pushed), sync logs, dashboards and the OTA cost comparison. OTA bookings
 * themselves are applied by OtaBookingsService.
 */
@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);
  private readonly cipher: FieldCipher;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly rates: RatesService,
    private readonly entitlements: EntitlementsService,
    @Inject(CHANNEL_PROVIDER) readonly provider: ChannelProvider,
  ) {
    this.cipher = new FieldCipher(config.get('GUEST_DATA_KEY'));
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async providerConnection(tx: Tx, c: ChannelConnection): Promise<ProviderConnection> {
    const roomTypes = await tx.roomType.findMany({ where: { tenantId: c.tenantId, propertyId: c.propertyId }, orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } });
    const ratePlans = await tx.ratePlan.findMany({ where: { tenantId: c.tenantId, propertyId: c.propertyId, active: true }, select: { id: true, code: true, name: true, roomTypeIds: true } });
    return {
      id: c.id,
      apiKey: c.apiKeyEnc ? this.cipher.decrypt(c.apiKeyEnc, c.tenantId) : null,
      externalPropertyId: c.externalPropertyId,
      local: { roomTypes, ratePlans },
    };
  }

  async log(tx: Tx, c: { id: string; tenantId: string; propertyId: string }, e: { direction: SyncDirection; kind: SyncKind; status: SyncStatus; summary: string; items?: number; error?: string | null; payload?: unknown; startedAt?: Date }) {
    await tx.channelSyncLog.create({
      data: {
        tenantId: c.tenantId,
        propertyId: c.propertyId,
        connectionId: c.id,
        direction: e.direction,
        kind: e.kind,
        status: e.status,
        summary: e.summary,
        items: e.items ?? 0,
        error: e.error ?? null,
        payload: (e.payload ?? undefined) as Prisma.InputJsonValue | undefined,
        startedAt: e.startedAt ?? new Date(),
        finishedAt: new Date(),
      },
    });
  }

  private async load(tx: Tx, tenantId: string, id: string) {
    const c = await tx.channelConnection.findFirst({ where: { id, tenantId } });
    if (!c) throw AppException.notFound('Channel connection');
    return c;
  }

  async connectionView(tx: Tx, c: ChannelConnection) {
    const [mappings, totalRoomTypes, bookings30d] = await Promise.all([
      tx.channelMapping.findMany({ where: { connectionId: c.id }, select: { roomTypeId: true, externalRatePlanId: true } }),
      tx.roomType.count({ where: { tenantId: c.tenantId, propertyId: c.propertyId } }),
      tx.channelBooking.count({ where: { connectionId: c.id, receivedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } } }),
    ]);
    const feeds = c.provider === 'ICAL' ? await tx.icalFeed.findMany({ where: { connectionId: c.id }, select: { roomTypeId: true } }) : [];
    const mappedTypes = new Set(c.provider === 'ICAL' ? feeds.map((f) => f.roomTypeId) : mappings.map((m) => m.roomTypeId));
    const s = settingsOf(c);
    return {
      id: c.id,
      propertyId: c.propertyId,
      provider: c.provider,
      name: c.name,
      channel: c.channel,
      status: c.status,
      mock: c.mock,
      externalPropertyId: c.externalPropertyId,
      settings: { ...s, commissionBps: c.provider === 'ICAL' && c.channel ? { [c.channel]: commissionBpsFor(c, c.channel) } : { ...DEFAULT_COMMISSION_BPS, ...s.commissionBps } },
      lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
      lastError: c.lastError,
      lastErrorAt: c.lastErrorAt?.toISOString() ?? null,
      pendingPush: !!c.ariDirtySince,
      mapping: {
        mappedRoomTypes: mappedTypes.size,
        totalRoomTypes,
        mappedRatePlans: mappings.filter((m) => m.externalRatePlanId).length,
        pct: totalRoomTypes ? Math.round((Math.min(mappedTypes.size, totalRoomTypes) * 100) / totalRoomTypes) : 0,
      },
      bookings30d,
      createdAt: c.createdAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Connections
  // ---------------------------------------------------------------------------

  list(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.channelConnection.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: 'asc' } });
      return Promise.all(rows.map((c) => this.connectionView(tx, c)));
    });
  }

  get(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => this.connectionView(tx, await this.load(tx, user.tenantId, id)));
  }

  async create(
    user: AuthUser,
    dto: { provider: 'ICAL' | 'CHANNEX'; channel?: OtaChannel; name?: string; stopSellBuffer?: number; commissionBps?: number | Partial<Record<OtaChannel, number>>; apiKey?: string; externalPropertyId?: string },
    ip?: string,
  ) {
    if (dto.provider === 'ICAL' && !dto.channel) throw Err.validation('channel', 'Choose the OTA this iCal connection is for');
    const mock = dto.provider === 'CHANNEX' && this.provider.name === 'mock';
    if (dto.provider === 'CHANNEX' && !mock && !dto.apiKey) throw Err.validation('apiKey', 'Give your Channex API key');
    return this.db.tenant(user.tenantId, async (tx) => {
      const p = await primaryProperty(tx, user.tenantId);
      if (dto.provider === 'CHANNEX' && (await tx.channelConnection.findFirst({ where: { tenantId: user.tenantId, propertyId: p.id, provider: 'CHANNEX' } }))) {
        throw appError(HttpStatus.CONFLICT, 'CONFLICT', `${p.name} already has a Channex connection`);
      }
      const commission =
        typeof dto.commissionBps === 'number' ? (dto.channel ? { [dto.channel]: dto.commissionBps } : {}) : (dto.commissionBps ?? {});
      const c = await tx.channelConnection.create({
        data: {
          tenantId: user.tenantId,
          propertyId: p.id,
          provider: dto.provider,
          name: dto.name ?? (dto.provider === 'ICAL' ? `${CHANNEL_LABEL[dto.channel!]} (iCal)` : 'Channex'),
          channel: dto.provider === 'ICAL' ? dto.channel! : null,
          mock,
          externalPropertyId: dto.externalPropertyId ?? null,
          apiKeyEnc: dto.apiKey ? this.cipher.encrypt(dto.apiKey, user.tenantId) : null,
          settings: { stopSellBuffer: dto.stopSellBuffer ?? 0, commissionBps: commission, pushRates: true, pushRestrictions: true, horizonDays: 365 } as Prisma.InputJsonValue,
        },
      });
      if (dto.provider === 'CHANNEX') {
        try {
          const check = await this.provider.checkConnection(await this.providerConnection(tx, c));
          await tx.channelConnection.update({ where: { id: c.id }, data: { externalPropertyId: check.externalPropertyId } });
          await this.log(tx, c, { direction: 'PULL', kind: 'CONNECT', status: 'OK', summary: `Connected to ${check.title}${mock ? ' (mock)' : ''}` });
        } catch (e) {
          if (e instanceof ChannelProviderError) throw appError(HttpStatus.BAD_GATEWAY, 'CHANNEL_PROVIDER_ERROR', e.message, { provider: 'channex', status: e.status });
          throw e;
        }
      }
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'channel.connected', entityType: 'channel_connection', entityId: c.id, metadata: { provider: c.provider, channel: c.channel, mock }, ip });
      return this.connectionView(tx, await this.load(tx, user.tenantId, c.id));
    });
  }

  update(user: AuthUser, id: string, dto: { name?: string; status?: 'ACTIVE' | 'PAUSED'; stopSellBuffer?: number; commissionBps?: number | Partial<Record<OtaChannel, number>>; pushRates?: boolean; pushRestrictions?: boolean; horizonDays?: number; apiKey?: string }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const c = await this.load(tx, user.tenantId, id);
      const s = settingsOf(c);
      const commission =
        dto.commissionBps === undefined ? s.commissionBps : typeof dto.commissionBps === 'number' ? (c.channel ? { ...s.commissionBps, [c.channel]: dto.commissionBps } : s.commissionBps) : { ...s.commissionBps, ...dto.commissionBps };
      const next: ConnectionSettings = {
        stopSellBuffer: dto.stopSellBuffer ?? s.stopSellBuffer,
        commissionBps: commission,
        pushRates: dto.pushRates ?? s.pushRates,
        pushRestrictions: dto.pushRestrictions ?? s.pushRestrictions,
        horizonDays: dto.horizonDays ?? s.horizonDays,
      };
      const reactivated = dto.status === 'ACTIVE' && c.status !== 'ACTIVE';
      await tx.channelConnection.update({
        where: { id },
        data: {
          ...(dto.name && { name: dto.name }),
          ...(dto.status && { status: dto.status }),
          ...(dto.apiKey && { apiKeyEnc: this.cipher.encrypt(dto.apiKey, user.tenantId) }),
          settings: next as unknown as Prisma.InputJsonValue,
          // Reactivating or changing what is pushed: re-send the whole horizon.
          ...((reactivated || dto.pushRates !== undefined || dto.pushRestrictions !== undefined) && { ariState: {}, ariDirtySince: new Date(), ariDirtyFrom: dbDate(lagosDate()), ariDirtyTo: dbDate(addDays(lagosDate(), next.horizonDays)) }),
        },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'channel.updated', entityType: 'channel_connection', entityId: id, metadata: { changes: Object.keys(dto).filter((x) => x !== 'apiKey') }, ip });
      return this.connectionView(tx, await this.load(tx, user.tenantId, id));
    });
  }

  remove(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const c = await this.load(tx, user.tenantId, id);
      await tx.channelConnection.delete({ where: { id } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'channel.disconnected', entityType: 'channel_connection', entityId: id, metadata: { name: c.name }, ip });
      return { success: true };
    });
  }

  // ---------------------------------------------------------------------------
  // iCal feeds and exports
  // ---------------------------------------------------------------------------

  private icalToken(c: ChannelConnection, roomTypeId: string, roomId: string | null) {
    const p: IcalTokenPayload = { exp: 4_102_444_800, tid: c.tenantId, pid: c.propertyId, c: c.id, v: c.icalVersion, rt: roomTypeId, r: roomId };
    return signToken(this.config.get('SHARE_TOKEN_SECRET'), 'ical-export', p);
  }

  private icalUrl(token: string) {
    return `${this.config.get('API_PUBLIC_URL')}/api/v1/public/ical/${token}.ics`;
  }

  async exportsFor(tx: Tx, c: ChannelConnection) {
    const types = await tx.roomType.findMany({ where: { tenantId: c.tenantId, propertyId: c.propertyId }, orderBy: { sortOrder: 'asc' }, include: { rooms: { orderBy: { number: 'asc' } } } });
    const out = [];
    for (const t of types) {
      out.push({ scope: 'ROOM_TYPE' as const, room: null, roomType: { id: t.id, name: t.name }, url: this.icalUrl(this.icalToken(c, t.id, null)) });
      for (const r of t.rooms) out.push({ scope: 'ROOM' as const, room: { id: r.id, number: r.number }, roomType: { id: t.id, name: t.name }, url: this.icalUrl(this.icalToken(c, t.id, r.id)) });
    }
    return out;
  }

  exports(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const c = await this.load(tx, user.tenantId, id);
      if (c.provider !== 'ICAL') throw appError(HttpStatus.CONFLICT, 'CONFLICT', 'Export feeds belong to iCal connections');
      return this.exportsFor(tx, c);
    });
  }

  rotate(user: AuthUser, id: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const c = await this.load(tx, user.tenantId, id);
      const u = await tx.channelConnection.update({ where: { id }, data: { icalVersion: { increment: 1 } } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'channel.ical_rotated', entityType: 'channel_connection', entityId: id, metadata: { name: c.name }, ip });
      return this.exportsFor(tx, u);
    });
  }

  /**
   * GET /public/ical/:token.ics: blocked nights for a room or room type.
   * Room feed: nights with a stay assigned to the room or a block, plus
   * nights the type is sold out. Type feed: nights with free rooms <= the
   * connection's stop-sell buffer.
   */
  async icalFeed(token: string): Promise<string> {
    const res = verifyToken<IcalTokenPayload>(this.config.get('SHARE_TOKEN_SECRET'), 'ical-export', token.replace(/\.ics$/, ''));
    if (!res.ok) throw AppException.notFound('Calendar');
    const t = res.payload;
    const ent = await this.entitlements.getEntitlements(t.tid).catch(() => null);
    if (!ent || !ent.features.includes('channel_manager') || ent.subscription.status === 'SUSPENDED') throw AppException.notFound('Calendar');
    return runInProperty(t.tid, t.pid, () =>
      this.db.tenant(t.tid, async (tx) => {
        const c = await tx.channelConnection.findFirst({ where: { id: t.c, tenantId: t.tid } });
        if (!c || c.icalVersion !== t.v) throw AppException.notFound('Calendar');
        const p = await tx.property.findFirstOrThrow({ where: { id: t.pid } });
        const rt = await tx.roomType.findFirst({ where: { id: t.rt, propertyId: p.id } });
        if (!rt) throw AppException.notFound('Calendar');
        const from = lagosDate();
        const to = addDays(from, 365);
        const nights = dateRange(from, addDays(to, -1));
        const cap = (await loadCapacity(tx, t.tid, [rt.id], lagosDateTime(from, p.checkInTime), lagosDateTime(to, p.checkOutTime))).get(rt.id)!;
        const buffer = settingsOf(c).stopSellBuffer;
        const blocked = new Set<string>();
        for (const n of nights) {
          const free = freeRoomsOverWindow(cap, lagosDateTime(n, p.checkInTime), lagosDateTime(addDays(n, 1), p.checkOutTime));
          if (t.r ? free < 1 : free <= buffer) blocked.add(n);
        }
        let label = rt.name;
        if (t.r) {
          const room = await tx.room.findFirst({ where: { id: t.r } });
          if (!room) throw AppException.notFound('Calendar');
          label = `${rt.name}, room ${room.number}`;
          const stays = await tx.reservation.findMany({
            where: { tenantId: t.tid, roomId: room.id, status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] }, departureAt: { gt: lagosStartOfDay(from) } },
            select: { arrivalAt: true, departureAt: true },
          });
          const blocks = await tx.roomBlock.findMany({ where: { roomId: room.id, endsAt: { gt: lagosStartOfDay(from) }, releasedAt: null }, select: { startsAt: true, endsAt: true } });
          for (const n of nights) {
            const ws = lagosDateTime(n, p.checkInTime);
            const we = lagosDateTime(addDays(n, 1), p.checkOutTime);
            if ([...stays.map((s) => ({ a: s.arrivalAt, b: s.departureAt })), ...blocks.map((b) => ({ a: b.startsAt, b: b.endsAt }))].some((x) => x.a < we && x.b > ws)) blocked.add(n);
          }
          if (room.status === 'OUT_OF_ORDER' && !blocks.length) blocked.add(from);
        }
        return buildIcs({ prodId: this.config.get('APP_NAME'), calName: `${p.name}: ${label}`, feedKey: `${c.id.slice(0, 8)}-${(t.r ?? t.rt).slice(0, 8)}`, ranges: nightsToRanges([...blocked]) });
      }),
    );
  }

  private feedView(f: Prisma.IcalFeedGetPayload<object>, names: Map<string, string>, rooms: Map<string, string>) {
    return {
      id: f.id,
      scope: f.roomId ? ('ROOM' as const) : ('ROOM_TYPE' as const),
      room: f.roomId ? { id: f.roomId, number: rooms.get(f.roomId) ?? '' } : null,
      roomType: { id: f.roomTypeId, name: names.get(f.roomTypeId) ?? '' },
      url: f.url,
      lastFetchedAt: f.lastFetchedAt?.toISOString() ?? null,
      lastStatus: f.lastStatus,
      lastError: f.lastError,
      eventsCount: f.eventsCount,
    };
  }

  private async feedViews(tx: Tx, connectionId: string) {
    const feeds = await tx.icalFeed.findMany({ where: { connectionId }, orderBy: { createdAt: 'asc' } });
    const types = new Map((await tx.roomType.findMany({ where: { id: { in: feeds.map((f) => f.roomTypeId) } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]));
    const roomIds = feeds.map((f) => f.roomId).filter((x): x is string => !!x);
    const rooms = new Map((roomIds.length ? await tx.room.findMany({ where: { id: { in: roomIds } }, select: { id: true, number: true } }) : []).map((r) => [r.id, r.number]));
    return feeds.map((f) => this.feedView(f, types, rooms));
  }

  feeds(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      await this.load(tx, user.tenantId, id);
      return this.feedViews(tx, id);
    });
  }

  addFeed(user: AuthUser, id: string, dto: { roomId?: string; roomTypeId?: string; url: string }, ip?: string) {
    if (!dto.roomId && !dto.roomTypeId) throw Err.validation('roomTypeId', 'Give a room or a room type');
    return this.db.tenant(user.tenantId, async (tx) => {
      const c = await this.load(tx, user.tenantId, id);
      if (c.provider !== 'ICAL') throw appError(HttpStatus.CONFLICT, 'CONFLICT', 'Import feeds belong to iCal connections');
      let roomTypeId = dto.roomTypeId ?? null;
      if (dto.roomId) {
        const room = await tx.room.findFirst({ where: { id: dto.roomId, tenantId: user.tenantId } });
        if (!room) throw AppException.notFound('Room');
        roomTypeId = room.roomTypeId;
      } else if (!(await tx.roomType.findFirst({ where: { id: roomTypeId!, tenantId: user.tenantId } }))) {
        throw AppException.notFound('Room type');
      }
      const f = await tx.icalFeed.create({ data: { tenantId: user.tenantId, propertyId: c.propertyId, connectionId: c.id, roomId: dto.roomId ?? null, roomTypeId: roomTypeId!, url: dto.url } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'channel.ical_feed_added', entityType: 'ical_feed', entityId: f.id, metadata: { connection: c.name }, ip });
      return (await this.feedViews(tx, c.id)).find((x) => x.id === f.id)!;
    });
  }

  removeFeed(user: AuthUser, id: string, feedId: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      await this.load(tx, user.tenantId, id);
      const f = await tx.icalFeed.findFirst({ where: { id: feedId, connectionId: id } });
      if (!f) throw AppException.notFound('Feed');
      await tx.icalFeed.delete({ where: { id: feedId } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'channel.ical_feed_removed', entityType: 'ical_feed', entityId: feedId, metadata: {}, ip });
      return { success: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Channex mapping
  // ---------------------------------------------------------------------------

  remote(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const c = await this.load(tx, user.tenantId, id);
      if (c.provider !== 'CHANNEX') throw appError(HttpStatus.CONFLICT, 'CONFLICT', 'Mapping belongs to Channex connections');
      try {
        return await this.provider.catalogue(await this.providerConnection(tx, c));
      } catch (e) {
        if (e instanceof ChannelProviderError) throw appError(HttpStatus.BAD_GATEWAY, 'CHANNEL_PROVIDER_ERROR', e.message, { provider: 'channex', status: e.status });
        throw e;
      }
    });
  }

  private async mappingViews(tx: Tx, connectionId: string) {
    const rows = await tx.channelMapping.findMany({ where: { connectionId }, orderBy: { createdAt: 'asc' } });
    const types = new Map((await tx.roomType.findMany({ where: { id: { in: rows.map((r) => r.roomTypeId) } }, select: { id: true, name: true } })).map((r) => [r.id, r]));
    const planIds = rows.map((r) => r.ratePlanId).filter((x): x is string => !!x);
    const plans = new Map((planIds.length ? await tx.ratePlan.findMany({ where: { id: { in: planIds } }, select: { id: true, name: true, code: true } }) : []).map((p) => [p.id, p]));
    return rows.map((m) => ({
      id: m.id,
      roomType: types.get(m.roomTypeId) ?? { id: m.roomTypeId, name: '' },
      ratePlan: m.ratePlanId ? (plans.get(m.ratePlanId) ?? null) : null,
      externalRoomTypeId: m.externalRoomTypeId,
      externalRoomTypeName: m.externalRoomTypeName,
      externalRatePlanId: m.externalRatePlanId,
      externalRatePlanName: m.externalRatePlanName,
    }));
  }

  mappings(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      await this.load(tx, user.tenantId, id);
      return this.mappingViews(tx, id);
    });
  }

  setMappings(user: AuthUser, id: string, list: { roomTypeId: string; ratePlanId?: string | null; externalRoomTypeId: string; externalRatePlanId?: string | null }[], ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const c = await this.load(tx, user.tenantId, id);
      if (c.provider !== 'CHANNEX') throw appError(HttpStatus.CONFLICT, 'CONFLICT', 'Mapping belongs to Channex connections');
      const remote = await this.provider.catalogue(await this.providerConnection(tx, c)).catch(() => ({ roomTypes: [], ratePlans: [] }));
      const rtNames = new Map(remote.roomTypes.map((r) => [r.id, r.title]));
      const rpNames = new Map(remote.ratePlans.map((r) => [r.id, r.title]));
      const seenType = new Map<string, string>();
      const seenPlan = new Set<string>();
      for (const m of list) {
        if (!(await tx.roomType.findFirst({ where: { id: m.roomTypeId, tenantId: user.tenantId } }))) throw AppException.notFound('Room type');
        if (m.ratePlanId && !(await tx.ratePlan.findFirst({ where: { id: m.ratePlanId, tenantId: user.tenantId } }))) throw AppException.notFound('Rate plan');
        const prev = seenType.get(m.roomTypeId);
        if (prev && prev !== m.externalRoomTypeId) throw Err.validation('mappings', 'A room type maps to one remote room type');
        seenType.set(m.roomTypeId, m.externalRoomTypeId);
        const key = `${m.roomTypeId}|${m.ratePlanId ?? 'BAR'}`;
        if (seenPlan.has(key)) throw Err.validation('mappings', 'Each room type and rate plan maps once');
        seenPlan.add(key);
      }
      await tx.channelMapping.deleteMany({ where: { connectionId: id } });
      await tx.channelMapping.createMany({
        data: list.map((m) => ({
          tenantId: user.tenantId,
          propertyId: c.propertyId,
          connectionId: id,
          roomTypeId: m.roomTypeId,
          ratePlanId: m.ratePlanId ?? null,
          externalRoomTypeId: m.externalRoomTypeId,
          externalRoomTypeName: rtNames.get(m.externalRoomTypeId) ?? null,
          externalRatePlanId: m.externalRatePlanId ?? null,
          externalRatePlanName: m.externalRatePlanId ? (rpNames.get(m.externalRatePlanId) ?? null) : null,
        })),
      });
      // A new mapping pushes the whole horizon.
      await tx.channelConnection.update({
        where: { id },
        data: { ariState: {}, ariDirtySince: new Date(), ariDirtyFrom: dbDate(lagosDate()), ariDirtyTo: dbDate(addDays(lagosDate(), settingsOf(c).horizonDays)) },
      });
      await this.log(tx, c, { direction: 'PUSH', kind: 'MAPPING', status: 'OK', summary: `Mapped ${seenType.size} room type${seenType.size === 1 ? '' : 's'} and ${list.filter((m) => m.externalRatePlanId).length} rate plans`, items: list.length });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'channel.mapped', entityType: 'channel_connection', entityId: id, metadata: { mappings: list.length }, ip });
      return this.mappingViews(tx, id);
    });
  }

  // ---------------------------------------------------------------------------
  // ARI: compute, diff, push
  // ---------------------------------------------------------------------------

  /** Availability per mapped remote room type and rate plan values per mapped remote rate plan, for [from, to]. */
  async computeAri(tx: Tx, c: ChannelConnection, from: string, to: string) {
    const mappings = await tx.channelMapping.findMany({ where: { connectionId: c.id } });
    const p = await tx.property.findFirstOrThrow({ where: { id: c.propertyId } });
    const nights = dateRange(from, to);
    const typeIds = [...new Set(mappings.map((m) => m.roomTypeId))];
    const avail = new Map<string, Map<string, number>>();
    const restr = new Map<string, Map<string, Omit<RestrictionValue, 'externalRatePlanId' | 'dateFrom' | 'dateTo'>>>();
    if (!typeIds.length) return { avail, restr };
    const caps = await loadCapacity(tx, c.tenantId, typeIds, lagosDateTime(from, p.checkInTime), lagosDateTime(addDays(to, 1), p.checkOutTime));
    const features = (await this.entitlements.getEntitlements(c.tenantId, tx)).features;
    const ctx = await this.rates.context(tx, c.tenantId, from, to, features, c.propertyId);
    const types = new Map((await tx.roomType.findMany({ where: { id: { in: typeIds } } })).map((t) => [t.id, t]));
    for (const m of mappings) {
      if (!avail.has(m.externalRoomTypeId)) {
        const cap = caps.get(m.roomTypeId)!;
        avail.set(m.externalRoomTypeId, new Map(nights.map((n) => [n, freeRoomsOverWindow(cap, lagosDateTime(n, p.checkInTime), lagosDateTime(addDays(n, 1), p.checkOutTime))])));
      }
      if (!m.externalRatePlanId) continue;
      const rt = types.get(m.roomTypeId)!;
      const plan = m.ratePlanId ? (ctx.plans.find((x) => x.id === m.ratePlanId) ?? ctx.bar) : ctx.bar;
      const priced = resolveNights({ roomType: rt, plan, dates: nights, rules: ctx.rules, overrides: ctx.overrides }) ?? [];
      const byDate = new Map(priced.map((n) => [n.date, n.rateKobo]));
      const values = new Map<string, Omit<RestrictionValue, 'externalRatePlanId' | 'dateFrom' | 'dateTo'>>();
      for (const n of nights) {
        const r = ctx.restrictions.filter((x) => x.date === n && (x.roomTypeId === null || x.roomTypeId === m.roomTypeId));
        values.set(n, {
          rateKobo: byDate.get(n) ?? null,
          stopSell: r.some((x) => x.stopSell) || !plan.active,
          closedToArrival: r.some((x) => x.closedToArrival),
          closedToDeparture: r.some((x) => x.closedToDeparture),
          minStayArrival: Math.max(1, plan.minNights ?? 1, ...r.map((x) => x.minNights ?? 1)),
        });
      }
      restr.set(m.externalRatePlanId, values);
    }
    return { avail, restr };
  }

  /**
   * Pushes what changed in [from, to] since the last push (per value hash
   * kept on the connection). Returns the sync log summary.
   */
  async pushAri(tenantId: string, connectionId: string, range?: { from: string; to: string }, force = false) {
    return this.db.tenant(tenantId, async (tx) => {
      const c = await tx.channelConnection.findFirst({ where: { id: connectionId, tenantId } });
      if (!c || c.provider !== 'CHANNEX') return null;
      return runInProperty(tenantId, c.propertyId, () => this.pushAriTx(tx, c, range, force));
    });
  }

  private async pushAriTx(tx: Tx, c: ChannelConnection, range?: { from: string; to: string }, force = false) {
    const started = new Date();
    const s = settingsOf(c);
    const today = lagosDate();
    const horizonEnd = addDays(today, s.horizonDays);
    let from = range?.from ?? (c.ariDirtyFrom ? fromDbDate(c.ariDirtyFrom) : today);
    let to = range?.to ?? (c.ariDirtyTo ? fromDbDate(c.ariDirtyTo) : horizonEnd);
    if (from < today) from = today;
    if (to > horizonEnd) to = horizonEnd;
    const clear = { ariDirtySince: null, ariDirtyFrom: null, ariDirtyTo: null };
    if (c.status === 'PAUSED' || to < from) {
      await tx.channelConnection.update({ where: { id: c.id }, data: clear });
      return { pushed: 0, summary: 'Nothing to push' };
    }
    const { avail, restr } = await this.computeAri(tx, c, from, to);
    const state = { ...((c.ariState ?? {}) as Record<string, string>) };
    const hash = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12);
    const availValues: AvailabilityValue[] = [];
    for (const [ext, byDate] of avail) {
      const changed = [...byDate.keys()].filter((d) => force || state[`a|${ext}|${d}`] !== hash(byDate.get(d)));
      for (const run of runsOf(changed, (d) => byDate.get(d)!, (a, b) => a === b)) {
        availValues.push({ externalRoomTypeId: ext, dateFrom: run.from, dateTo: run.to, availability: run.value });
      }
      for (const d of changed) state[`a|${ext}|${d}`] = hash(byDate.get(d));
    }
    const restrValues: RestrictionValue[] = [];
    if (s.pushRates || s.pushRestrictions) {
      for (const [ext, byDate] of restr) {
        const shaped = (d: string) => {
          const v = byDate.get(d)!;
          return {
            rateKobo: s.pushRates ? v.rateKobo : null,
            stopSell: s.pushRestrictions && v.stopSell,
            closedToArrival: s.pushRestrictions && v.closedToArrival,
            closedToDeparture: s.pushRestrictions && v.closedToDeparture,
            minStayArrival: s.pushRestrictions ? v.minStayArrival : 1,
          };
        };
        const changed = [...byDate.keys()].filter((d) => force || state[`r|${ext}|${d}`] !== hash(shaped(d)));
        for (const run of runsOf(changed, shaped, (a, b) => JSON.stringify(a) === JSON.stringify(b))) {
          restrValues.push({ externalRatePlanId: ext, dateFrom: run.from, dateTo: run.to, ...run.value });
        }
        for (const d of changed) state[`r|${ext}|${d}`] = hash(shaped(d));
      }
    }
    // Forget values for dates that have passed.
    for (const key of Object.keys(state)) if (key.slice(-10) < today) delete state[key];
    const pc = await this.providerConnection(tx, c);
    try {
      await this.provider.pushAvailability(pc, availValues);
      await this.provider.pushRestrictions(pc, restrValues);
    } catch (e) {
      const msg = (e as Error).message;
      await tx.channelConnection.update({ where: { id: c.id }, data: { lastError: msg, lastErrorAt: new Date(), status: 'ERROR' } });
      await this.log(tx, c, { direction: 'PUSH', kind: 'ARI', status: 'ERROR', summary: 'Availability and rates could not be pushed', error: msg, startedAt: started });
      return { pushed: 0, summary: msg };
    }
    const items = availValues.length + restrValues.length;
    const summary = items
      ? `Pushed ${availValues.length} availability and ${restrValues.length} rate ranges for ${humanDate(from)} - ${humanDate(to)}`
      : `Nothing changed for ${humanDate(from)} - ${humanDate(to)}`;
    await tx.channelConnection.update({ where: { id: c.id }, data: { ...clear, ariState: state as Prisma.InputJsonValue, lastSyncAt: new Date(), ...(c.status === 'ERROR' && { status: 'ACTIVE' }), lastError: null } });
    await this.log(tx, c, {
      direction: 'PUSH',
      kind: 'ARI',
      status: items ? 'OK' : 'SKIPPED',
      summary,
      items,
      payload: items ? { availability: availValues.slice(0, 50), restrictions: restrValues.slice(0, 50) } : undefined,
      startedAt: started,
    });
    return { pushed: items, summary };
  }

  /** Job: pushes connections whose changes have been quiet for `debounceMs`. */
  async flushDirty(debounceMs = 30_000, now = new Date()) {
    const due = await this.db.system((tx) =>
      tx.channelConnection.findMany({ where: { provider: 'CHANNEX', status: { in: ['ACTIVE', 'ERROR'] }, ariDirtySince: { lte: new Date(now.getTime() - debounceMs) } }, select: { id: true, tenantId: true } }),
    );
    let pushed = 0;
    for (const c of due) {
      try {
        const r = await this.pushAri(c.tenantId, c.id);
        pushed += r?.pushed ?? 0;
      } catch (e) {
        this.logger.error(`ARI push failed for ${c.id}: ${(e as Error).message}`);
      }
    }
    return { connections: due.length, pushed };
  }

  /** Job: safety sweep every 15 minutes (pushes only what changed over the horizon). */
  async sweepAll() {
    const all = await this.db.system((tx) => tx.channelConnection.findMany({ where: { provider: 'CHANNEX', status: { in: ['ACTIVE', 'ERROR'] } }, select: { id: true, tenantId: true, settings: true, channel: true } }));
    let pushed = 0;
    for (const c of all) {
      try {
        const ent = await this.entitlements.getEntitlements(c.tenantId);
        if (!ent.features.includes('channel_manager')) continue;
        const r = await this.pushAri(c.tenantId, c.id, { from: lagosDate(), to: addDays(lagosDate(), settingsOf(c).horizonDays) });
        pushed += r?.pushed ?? 0;
      } catch (e) {
        this.logger.error(`ARI sweep failed for ${c.id}: ${(e as Error).message}`);
      }
    }
    return { connections: all.length, pushed };
  }

  // ---------------------------------------------------------------------------
  // Logs, bookings, summary, cost
  // ---------------------------------------------------------------------------

  logs(user: AuthUser, q: { connectionId?: string; status?: string; page?: number; pageSize?: number }) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const where: Prisma.ChannelSyncLogWhereInput = {
        tenantId: user.tenantId,
        ...(q.connectionId && { connectionId: q.connectionId }),
        ...(q.status && { status: q.status as SyncStatus }),
      };
      const [rows, total] = await Promise.all([tx.channelSyncLog.findMany({ where, orderBy: { startedAt: 'desc' }, skip: pg.skip, take: pg.take }), tx.channelSyncLog.count({ where })]);
      return {
        items: rows.map((l) => ({ id: l.id, connectionId: l.connectionId, direction: l.direction, kind: l.kind, status: l.status, summary: l.summary, items: l.items, error: l.error, startedAt: l.startedAt.toISOString(), finishedAt: l.finishedAt?.toISOString() ?? null })),
        total,
        page: pg.page,
        pageSize: pg.pageSize,
      };
    });
  }

  bookings(user: AuthUser, q: { channel?: string; status?: string; from?: string; to?: string; page?: number; pageSize?: number }) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const resWhere: Prisma.ReservationWhereInput | undefined =
        q.from || q.to ? { arrivalAt: { ...(q.from && { gte: lagosStartOfDay(q.from) }), ...(q.to && { lt: lagosStartOfDay(addDays(q.to, 1)) }) } } : undefined;
      let resIds: string[] | undefined;
      if (resWhere) resIds = (await tx.reservation.findMany({ where: { tenantId: user.tenantId, source: 'OTA', ...resWhere }, select: { id: true } })).map((r) => r.id);
      const where: Prisma.ChannelBookingWhereInput = {
        tenantId: user.tenantId,
        ...(q.channel && { channel: q.channel as OtaChannel }),
        ...(q.status && { status: q.status as 'NEW' | 'MODIFIED' | 'CANCELLED' }),
        ...(resIds && { reservationId: { in: resIds } }),
      };
      const [rows, total] = await Promise.all([tx.channelBooking.findMany({ where, orderBy: { receivedAt: 'desc' }, skip: pg.skip, take: pg.take }), tx.channelBooking.count({ where })]);
      const res = await tx.reservation.findMany({ where: { id: { in: rows.map((r) => r.reservationId).filter((x): x is string => !!x) } }, include: { guest: { select: { fullName: true } }, room: { select: { number: true } } } });
      const byId = new Map(res.map((r) => [r.id, r]));
      return {
        items: rows.map((b) => {
          const r = b.reservationId ? byId.get(b.reservationId) : undefined;
          return {
            id: b.id,
            connectionId: b.connectionId,
            provider: b.provider,
            channel: b.channel,
            externalId: b.externalId,
            status: b.status,
            reservation: r
              ? { id: r.id, code: r.code, status: r.status, arrivalDate: lagosDate(r.arrivalAt), departureDate: lagosDate(r.departureAt), guestName: r.guest.fullName, roomNumber: r.room?.number ?? null }
              : null,
            grossKobo: b.grossKobo === null ? null : k(b.grossKobo),
            commissionKobo: b.commissionKobo === null ? null : k(b.commissionKobo),
            commissionBps: b.commissionBps,
            overbooked: b.overbooked,
            receivedAt: b.receivedAt.toISOString(),
            updatedAt: b.updatedAt.toISOString(),
          };
        }),
        total,
        page: pg.page,
        pageSize: pg.pageSize,
      };
    });
  }

  /** "You paid N to OTAs this month; direct bookings would have saved about M." */
  async costTx(tx: Tx, tenantId: string, month: string) {
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`;
    const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const window = { gte: lagosStartOfDay(from), lt: lagosStartOfDay(nextMonth) };
    const stays = await tx.reservation.findMany({
      where: { tenantId, arrivalAt: window, status: { notIn: ['CANCELLED'] } },
      select: { id: true, source: true, otaChannel: true, otaCommissionKobo: true, nightlyRates: true, rateKobo: true, arrivalAt: true, departureAt: true, stayType: true, quotedTotalKobo: true },
    });
    const commission = await tx.commissionEntry.findMany({ where: { tenantId, reservationId: { in: stays.map((s) => s.id) } }, select: { kind: true, amountKobo: true, accrual: true } });
    const revenue = (s: (typeof stays)[number]) => {
      const nights = Array.isArray(s.nightlyRates) ? (s.nightlyRates as { rateKobo: number }[]) : [];
      if (nights.length) return nights.reduce((a, n) => a + n.rateKobo, 0);
      if (s.quotedTotalKobo !== null) return k(s.quotedTotalKobo);
      const n = Math.max(1, Math.round((s.departureAt.getTime() - s.arrivalAt.getTime()) / 86_400_000));
      return k(s.rateKobo) * n;
    };
    const nightsOf = (s: (typeof stays)[number]) => (s.stayType === 'NIGHTLY' ? Math.max(1, Math.round((s.departureAt.getTime() - s.arrivalAt.getTime()) / 86_400_000)) : 0);
    const ota = stays.filter((s) => s.source === 'OTA');
    const byChannel = new Map<OtaChannel, { channel: OtaChannel; bookings: number; roomNights: number; revenueKobo: number; commissionKobo: number; effectiveBps: number }>();
    for (const s of ota) {
      const ch = s.otaChannel ?? 'OTHER';
      const row = byChannel.get(ch) ?? { channel: ch, bookings: 0, roomNights: 0, revenueKobo: 0, commissionKobo: 0, effectiveBps: 0 };
      row.bookings++;
      row.roomNights += nightsOf(s);
      row.revenueKobo += revenue(s);
      row.commissionKobo += k(s.otaCommissionKobo);
      byChannel.set(ch, row);
    }
    for (const r of byChannel.values()) r.effectiveBps = r.revenueKobo ? Math.round((r.commissionKobo * 10_000) / r.revenueKobo) : 0;
    const direct = stays.filter((s) => s.source !== 'OTA');
    const site = direct.filter((s) => s.source === 'BOOKING_SITE');
    const market = direct.filter((s) => s.source === 'MARKETPLACE');
    const marketCommission =
      commission.filter((c) => c.kind === 'COLLECTED' || c.kind === 'ACCRUED').reduce((a, c) => a + k(c.amountKobo), 0) - commission.filter((c) => c.kind === 'REVERSED').reduce((a, c) => a + k(c.amountKobo), 0);
    const otaRevenue = ota.reduce((a, s) => a + revenue(s), 0);
    const otaCommission = ota.reduce((a, s) => a + k(s.otaCommissionKobo), 0);
    // Paystack local cards: 1.5% + N100, capped at N2,000 per transaction.
    const directCost = ota.reduce((a, s) => a + Math.min(200_000, Math.round(revenue(s) * 0.015) + 10_000), 0);
    const savings = Math.max(0, otaCommission - directCost);
    const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const fmt = (kobo: number) => `₦${Math.round(kobo / 100).toLocaleString('en-NG')}`;
    return {
      month,
      ota: { bookings: ota.length, roomNights: ota.reduce((a, s) => a + nightsOf(s), 0), revenueKobo: otaRevenue, commissionKobo: otaCommission, byChannel: [...byChannel.values()].sort((a, b) => b.commissionKobo - a.commissionKobo) },
      direct: {
        bookings: direct.length,
        revenueKobo: direct.reduce((a, s) => a + revenue(s), 0),
        bookingSite: { bookings: site.length, revenueKobo: site.reduce((a, s) => a + revenue(s), 0) },
        marketplace: { bookings: market.length, revenueKobo: market.reduce((a, s) => a + revenue(s), 0), commissionKobo: Math.max(0, marketCommission) },
      },
      directCostEstimateKobo: directCost,
      savingsKobo: savings,
      headline: otaCommission
        ? `You paid ${fmt(otaCommission)} to OTAs in ${monthName}. The same bookings on your booking site would have saved about ${fmt(savings)}.`
        : `No OTA commission in ${monthName}.`,
    };
  }

  cost(user: AuthUser, month?: string) {
    const m = month ?? lagosDate().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw Err.validation('month', 'month must be YYYY-MM');
    return this.db.tenant(user.tenantId, (tx) => this.costTx(tx, user.tenantId, m));
  }

  summary(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.channelConnection.findMany({ where: { tenantId: user.tenantId }, orderBy: { createdAt: 'asc' } });
      const connections = await Promise.all(rows.map((c) => this.connectionView(tx, c)));
      const since = new Date(Date.now() - 30 * 86_400_000);
      const bookings = await tx.reservation.findMany({
        where: { tenantId: user.tenantId, source: 'OTA', createdAt: { gte: since }, status: { notIn: ['CANCELLED'] } },
        select: { otaChannel: true, otaCommissionKobo: true, nightlyRates: true, arrivalAt: true, departureAt: true },
      });
      const by = new Map<OtaChannel, { channel: OtaChannel; bookings: number; roomNights: number; revenueKobo: number; commissionKobo: number }>();
      for (const b of bookings) {
        const ch = b.otaChannel ?? 'OTHER';
        const row = by.get(ch) ?? { channel: ch, bookings: 0, roomNights: 0, revenueKobo: 0, commissionKobo: 0 };
        const nights = Array.isArray(b.nightlyRates) ? (b.nightlyRates as { rateKobo: number }[]) : [];
        row.bookings++;
        row.roomNights += Math.max(1, Math.round((b.departureAt.getTime() - b.arrivalAt.getTime()) / 86_400_000));
        row.revenueKobo += nights.reduce((a, n) => a + n.rateKobo, 0);
        row.commissionKobo += k(b.otaCommissionKobo);
        by.set(ch, row);
      }
      const errors24h = await tx.channelSyncLog.count({ where: { tenantId: user.tenantId, status: 'ERROR', startedAt: { gte: new Date(Date.now() - 86_400_000) } } });
      const last = rows.map((r) => r.lastSyncAt).filter((x): x is Date => !!x).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      return {
        connections,
        bookingsByChannel30d: [...by.values()],
        errors24h,
        lastSyncAt: last?.toISOString() ?? null,
        cost: await this.costTx(tx, user.tenantId, lagosDate().slice(0, 7)),
      };
    });
  }
}
