import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { ChannelConnection, Prisma, Property } from '../../generated/prisma/client.js';
import type { OtaChannel } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../../common/auth-types.js';
import { safeFetchText } from '../../common/net/safe-fetch.js';
import { AppException } from '../../common/errors/app-exception.js';
import { runInProperty } from '../../common/property-scope.js';
import { normalisePhone } from '../../common/utils/phone.js';
import { reservationCode } from '../../common/utils/codes.js';
import { addDays, dateRange, diffDays, humanDate, lagosDate, lagosDateTime } from '../../common/time/lagos.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, SYSTEM_ACTOR } from '../audit/audit.service.js';
import { GuardService } from '../guard/guard.service.js';
import { advisoryLock, appError, Err, isExclusionViolation } from '../ops/ops.helpers.js';
import { freeRoomsOverWindow, loadCapacity } from '../rates/capacity.js';
import { resolveNights } from '../rates/rates.logic.js';
import { RatesService } from '../rates/rates.service.js';
import { markAriDirty } from './ari-signal.js';
import { channexSignature, ChannelProviderError, MockChannexProvider, type BookingRevision } from './channel-provider.js';
import { CHANNEL_LABEL, ChannelsService, commissionBpsFor, otaChannelOf } from './channels.service.js';
import { guestNameFrom, isOtaBlock, parseIcs } from './ical.js';

/** A booking from any channel, normalised. */
export interface OtaStay {
  externalId: string;
  revisionId: string | null;
  status: 'new' | 'modified' | 'cancelled';
  channel: OtaChannel;
  otaRef: string | null;
  roomTypeId: string;
  roomId: string | null;
  arrivalDate: string;
  departureDate: string;
  guestName: string;
  guestPhone: string | null;
  guestEmail: string | null;
  adults: number;
  children: number;
  /** Price per night (kobo) from the OTA; empty = the hotel's BAR (iCal). */
  nightly: Record<string, number>;
  grossKobo: number | null;
  commissionKobo: number | null;
  raw: unknown;
}

const PER_CODE_ATTEMPTS = 8;

/**
 * Applies OTA bookings (Channex revisions, iCal events) to reservations:
 * create, modify, cancel; records OTA commission; flags OVERBOOKED with
 * relocation suggestions when the room type is sold out.
 */
@Injectable()
export class OtaBookingsService {
  private readonly logger = new Logger(OtaBookingsService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly guard: GuardService,
    private readonly rates: RatesService,
    private readonly channels: ChannelsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Webhook
  // ---------------------------------------------------------------------------

  verifySignature(raw: Buffer | undefined, header: string | undefined): boolean {
    const secret = this.config.get('CHANNEX_WEBHOOK_SECRET');
    if (!secret || !raw || !header) return false;
    const expected = Buffer.from(channexSignature(secret, raw));
    const given = Buffer.from(header.trim().toLowerCase());
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** POST /webhooks/channex (signature already checked). */
  async webhook(body: { event?: string; property_id?: string; payload?: { booking_id?: string; revision_id?: string } }) {
    const revisionId = body.payload?.revision_id;
    const propertyId = body.property_id;
    if (!revisionId || !propertyId) throw Err.validation('payload', 'property_id and payload.revision_id are required');
    const conn = (await this.db.locate((tx, t) => tx.channelConnection.findFirst({ where: { ...t.tenants, provider: 'CHANNEX', externalPropertyId: propertyId } })))?.value;
    if (!conn) return { received: true, ignored: true };
    return runInProperty(conn.tenantId, conn.propertyId, async () => {
      const dup = await this.db.tenant(conn.tenantId, (tx) => tx.channelBooking.findFirst({ where: { connectionId: conn.id, revisionId } }));
      if (dup) return { received: true, duplicate: true };
      const pc = await this.db.tenant(conn.tenantId, (tx) => this.channels.providerConnection(tx, conn));
      let rev: BookingRevision;
      try {
        rev = await this.channels.provider.revision(pc, revisionId);
      } catch (e) {
        const msg = (e as Error).message;
        await this.db.tenant(conn.tenantId, (tx) => this.channels.log(tx, conn, { direction: 'WEBHOOK', kind: 'BOOKING', status: 'ERROR', summary: `Booking revision ${revisionId} could not be fetched`, error: msg }));
        if (e instanceof ChannelProviderError) throw appError(HttpStatus.BAD_GATEWAY, 'CHANNEL_PROVIDER_ERROR', msg, { provider: 'channex', status: e.status });
        throw e;
      }
      const result = await this.applyRevision(conn, rev);
      await this.channels.provider.ack(pc, rev.id).catch((e: Error) => this.logger.warn(`Ack of ${rev.id} failed: ${e.message}`));
      return { received: true, ...result };
    });
  }

  /** Maps a Channex revision to an OtaStay and applies it. */
  async applyRevision(conn: ChannelConnection, rev: BookingRevision) {
    const room = rev.rooms[0];
    const mapping = room
      ? await this.db.tenant(conn.tenantId, (tx) => tx.channelMapping.findFirst({ where: { connectionId: conn.id, externalRoomTypeId: room.externalRoomTypeId } }))
      : null;
    if (!mapping) {
      await this.db.tenant(conn.tenantId, (tx) =>
        this.channels.log(tx, conn, { direction: 'WEBHOOK', kind: 'BOOKING', status: 'ERROR', summary: `Booking ${rev.otaReservationCode} is for an unmapped room type`, error: `CHANNEL_NOT_MAPPED ${room?.externalRoomTypeId ?? ''}` }),
      );
      return { applied: false, error: 'CHANNEL_NOT_MAPPED' };
    }
    const channel = otaChannelOf(rev.otaName);
    const stay: OtaStay = {
      externalId: rev.bookingId,
      revisionId: rev.id,
      status: rev.status,
      channel,
      otaRef: rev.otaReservationCode,
      roomTypeId: mapping.roomTypeId,
      roomId: null,
      arrivalDate: rev.arrivalDate,
      departureDate: rev.departureDate,
      guestName: [rev.customer.name, rev.customer.surname].filter(Boolean).join(' ').trim() || `${CHANNEL_LABEL[channel]} guest`,
      guestPhone: rev.customer.phone,
      guestEmail: rev.customer.mail,
      adults: room?.adults ?? 1,
      children: room?.children ?? 0,
      nightly: room?.days ?? {},
      grossKobo: rev.amountKobo,
      commissionKobo: rev.otaCommissionKobo,
      raw: rev,
    };
    return this.apply(conn, stay);
  }

  // ---------------------------------------------------------------------------
  // Apply
  // ---------------------------------------------------------------------------

  async apply(conn: ChannelConnection, s: OtaStay): Promise<{ applied: boolean; reservationId?: string | null; overbooked?: boolean; status?: string; error?: string }> {
    return runInProperty(conn.tenantId, conn.propertyId, async () => {
      try {
        return await this.db.tenant(conn.tenantId, async (tx) => {
          const existing = await tx.channelBooking.findFirst({ where: { connectionId: conn.id, externalId: s.externalId } });
          if (s.status === 'cancelled') return this.cancel(tx, conn, s, existing);
          if (existing && existing.status !== 'CANCELLED' && existing.reservationId) return this.modify(tx, conn, s, existing);
          if (existing?.status === 'CANCELLED') return { applied: false, status: 'CANCELLED' };
          return this.create(tx, conn, s);
        });
      } catch (e) {
        if (isExclusionViolation(e)) {
          // The feed's room was taken meanwhile: book it unassigned.
          return this.apply(conn, { ...s, roomId: null });
        }
        throw e;
      }
    });
  }

  private async newCode(tx: Tx, tenantId: string, name: string) {
    const prefix = name.replace(/^the\s+/i, '').split(/\s+/).map((w) => w[0]).join('').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'HTL';
    for (let i = 0; i < PER_CODE_ATTEMPTS; i++) {
      const code = reservationCode(prefix, i < 5 ? 4 : 5);
      if (!(await tx.reservation.findFirst({ where: { tenantId, code }, select: { id: true } }))) return code;
    }
    throw new Error('Could not generate a unique reservation code');
  }

  private async guestFor(tx: Tx, tenantId: string, s: OtaStay) {
    const phone = s.guestPhone ? normalisePhone(s.guestPhone) : null;
    if (phone) {
      const g = await tx.guest.findFirst({ where: { tenantId, phone } });
      if (g && !g.anonymisedAt) return g;
    }
    return tx.guest.create({
      data: { tenantId, fullName: s.guestName, phone, email: s.guestEmail, notes: `Booked through ${CHANNEL_LABEL[s.channel]}` },
    });
  }

  /** Nightly rates: the OTA's prices, else the hotel's BAR for each night. */
  private async nights(tx: Tx, conn: ChannelConnection, s: OtaStay) {
    const dates = dateRange(s.arrivalDate, addDays(s.departureDate, -1));
    const rt = await tx.roomType.findFirstOrThrow({ where: { id: s.roomTypeId } });
    if (dates.every((d) => s.nightly[d] !== undefined)) {
      return dates.map((d) => ({ date: d, rateKobo: s.nightly[d], baseRateKobo: s.nightly[d], source: 'MANUAL' as const, ruleId: null, ruleName: null, discountKobo: 0 }));
    }
    const ctx = await this.rates.context(tx, conn.tenantId, s.arrivalDate, addDays(s.departureDate, -1), undefined, conn.propertyId);
    return resolveNights({ roomType: rt, plan: ctx.bar, dates, rules: ctx.rules, overrides: ctx.overrides }) ?? [];
  }

  /** Free rooms of the type for the stay (can be 0: overbooked), serialised with desk bookings. */
  private async free(tx: Tx, tenantId: string, p: Property, roomTypeId: string, arrivalAt: Date, departureAt: Date, excludeReservationId?: string) {
    await advisoryLock(tx, `room-type:${tenantId}:${roomTypeId}`);
    const cap = (await loadCapacity(tx, tenantId, [roomTypeId], arrivalAt, departureAt, { excludeReservationId })).get(roomTypeId)!;
    return freeRoomsOverWindow(cap, arrivalAt, departureAt);
  }

  private async roomFree(tx: Tx, tenantId: string, roomId: string, arrivalAt: Date, departureAt: Date, excludeReservationId?: string) {
    const clash = await tx.reservation.count({
      where: { tenantId, roomId, status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] }, arrivalAt: { lt: departureAt }, departureAt: { gt: arrivalAt }, ...(excludeReservationId && { id: { not: excludeReservationId } }) },
    });
    const block = await tx.roomBlock.count({ where: { roomId, releasedAt: null, startsAt: { lt: departureAt }, endsAt: { gt: arrivalAt } } });
    return clash === 0 && block === 0;
  }

  /**
   * Relocation options when a stay does not fit: other room types of the
   * property free for the whole stay (upgrade), then other properties of
   * the group with a free room.
   */
  async relocationOptions(tx: Tx, tenantId: string, p: Property, roomTypeId: string, arrivalDate: string, departureDate: string): Promise<string[]> {
    const out: string[] = [];
    const span = `${humanDate(arrivalDate)} - ${humanDate(departureDate)}`;
    const types = await tx.roomType.findMany({ where: { tenantId, propertyId: p.id, id: { not: roomTypeId } } });
    if (types.length) {
      const a = lagosDateTime(arrivalDate, p.checkInTime);
      const d = lagosDateTime(departureDate, p.checkOutTime);
      const caps = await loadCapacity(tx, tenantId, types.map((t) => t.id), a, d);
      for (const t of types) {
        const n = freeRoomsOverWindow(caps.get(t.id)!, a, d);
        if (n > 0) out.push(`Move to ${t.name} (${n} free for ${span})`);
      }
    }
    await this.db.withAllProperties(tenantId, async () => {
      const others = await tx.property.findMany({ where: { tenantId, id: { not: p.id } }, include: { roomTypes: true } });
      for (const o of others) {
        if (!o.roomTypes.length) continue;
        const a = lagosDateTime(arrivalDate, o.checkInTime);
        const d = lagosDateTime(departureDate, o.checkOutTime);
        const caps = await loadCapacity(tx, tenantId, o.roomTypes.map((t) => t.id), a, d);
        const free = o.roomTypes.map((t) => ({ t, n: freeRoomsOverWindow(caps.get(t.id)!, a, d) })).filter((x) => x.n > 0).sort((x, y) => x.t.basePriceKobo - y.t.basePriceKobo);
        if (free.length) out.push(`Relocate to ${o.name}: ${free[0].t.name} free for ${span}`);
      }
    });
    return out;
  }

  private async flagOverbooked(tx: Tx, conn: ChannelConnection, p: Property, r: { id: string; code: string; roomTypeId: string }, s: OtaStay) {
    const features = await this.guard.features(tx, conn.tenantId);
    const options = await this.relocationOptions(tx, conn.tenantId, p, s.roomTypeId, s.arrivalDate, s.departureDate);
    const rt = await tx.roomType.findFirst({ where: { id: s.roomTypeId }, select: { name: true } });
    await this.guard.raise(tx, conn.tenantId, features, {
      rule: 'OVERBOOKED',
      title: `${CHANNEL_LABEL[s.channel]} booking ${r.code} is overbooked`,
      detail: `${s.guestName} booked ${rt?.name ?? 'a room'} for ${humanDate(s.arrivalDate)} - ${humanDate(s.departureDate)} on ${CHANNEL_LABEL[s.channel]}, but no room of that type is free. The booking was accepted; relocate a guest.`,
      dedupeKey: `OVERBOOKED:${r.id}`,
      reservationId: r.id,
      amountKobo: s.grossKobo,
      propertyId: p.id,
      evidence: { channel: s.channel, otaRef: s.otaRef, roomTypeId: s.roomTypeId, arrivalDate: s.arrivalDate, departureDate: s.departureDate, options },
      suggestion: options.length ? options.slice(0, 3).join('; ') : 'No free room in the group for these dates: arrange a nearby hotel for the guest.',
    });
  }

  private async create(tx: Tx, conn: ChannelConnection, s: OtaStay) {
    const p = await tx.property.findFirstOrThrow({ where: { id: conn.propertyId } });
    if (diffDays(s.arrivalDate, s.departureDate) < 1) return { applied: false, error: 'VALIDATION_ERROR' };
    const arrivalAt = lagosDateTime(s.arrivalDate, p.checkInTime);
    const departureAt = lagosDateTime(s.departureDate, p.checkOutTime);
    const free = await this.free(tx, conn.tenantId, p, s.roomTypeId, arrivalAt, departureAt);
    const overbooked = free < 1;
    const roomId = s.roomId && !overbooked && (await this.roomFree(tx, conn.tenantId, s.roomId, arrivalAt, departureAt)) ? s.roomId : null;
    const guest = await this.guestFor(tx, conn.tenantId, s);
    const nights = await this.nights(tx, conn, s);
    const gross = s.grossKobo ?? nights.reduce((a, n) => a + n.rateKobo, 0);
    const bps = commissionBpsFor(conn, s.channel);
    const commission = s.commissionKobo ?? Math.round((gross * bps) / 10_000);
    const r = await tx.reservation.create({
      data: {
        tenantId: conn.tenantId,
        propertyId: p.id,
        code: await this.newCode(tx, conn.tenantId, p.name),
        guestId: guest.id,
        roomTypeId: s.roomTypeId,
        roomId,
        stayType: 'NIGHTLY',
        arrivalAt,
        departureAt,
        adults: s.adults,
        children: s.children,
        source: 'OTA',
        status: 'CONFIRMED',
        rateKobo: nights[0]?.rateKobo ?? 0,
        notes: `${CHANNEL_LABEL[s.channel]} reservation${s.otaRef ? ` ${s.otaRef}` : ''}`,
        otaChannel: s.channel,
        otaRef: s.otaRef,
        otaCommissionKobo: commission,
        overbooked,
        nightlyRates: nights as unknown as Prisma.InputJsonValue,
        contactPhone: s.guestPhone,
        contactEmail: s.guestEmail,
      },
    });
    await tx.folio.create({ data: { tenantId: conn.tenantId, propertyId: p.id, kind: 'RESERVATION', reservationId: r.id, guestId: guest.id, name: guest.fullName } });
    await tx.channelBooking.upsert({
      where: { connectionId_externalId: { connectionId: conn.id, externalId: s.externalId } },
      create: {
        tenantId: conn.tenantId,
        propertyId: p.id,
        connectionId: conn.id,
        provider: conn.provider,
        channel: s.channel,
        externalId: s.externalId,
        revisionId: s.revisionId,
        status: 'NEW',
        reservationId: r.id,
        grossKobo: gross,
        commissionKobo: commission,
        commissionBps: s.commissionKobo !== null && gross ? Math.round((s.commissionKobo * 10_000) / gross) : bps,
        overbooked,
        raw: (s.raw ?? {}) as Prisma.InputJsonValue,
      },
      update: { revisionId: s.revisionId, status: 'NEW', reservationId: r.id, grossKobo: gross, commissionKobo: commission, overbooked, raw: (s.raw ?? {}) as Prisma.InputJsonValue },
    });
    if (overbooked) await this.flagOverbooked(tx, conn, p, r, s);
    await markAriDirty(tx, conn.tenantId, p.id, s.arrivalDate, s.departureDate);
    await this.audit.record(tx, {
      tenantId: conn.tenantId,
      actor: SYSTEM_ACTOR,
      action: 'channel.booking_received',
      entityType: 'reservation',
      entityId: r.id,
      metadata: { code: r.code, channel: s.channel, otaRef: s.otaRef, connection: conn.name, overbooked, commissionKobo: commission },
    });
    await this.channels.log(tx, conn, {
      direction: conn.provider === 'ICAL' ? 'PULL' : 'WEBHOOK',
      kind: conn.provider === 'ICAL' ? 'ICAL_IMPORT' : 'BOOKING',
      status: 'OK',
      summary: `New ${CHANNEL_LABEL[s.channel]} booking ${r.code} for ${humanDate(s.arrivalDate)} - ${humanDate(s.departureDate)}${overbooked ? ' (overbooked)' : ''}`,
      items: 1,
    });
    return { applied: true, reservationId: r.id, overbooked, status: 'NEW' };
  }

  private async modify(tx: Tx, conn: ChannelConnection, s: OtaStay, b: { id: string; reservationId: string | null; revisionId: string | null }) {
    const r = await tx.reservation.findFirst({ where: { id: b.reservationId! } });
    if (!r) return this.create(tx, conn, s);
    if (b.revisionId && s.revisionId && b.revisionId === s.revisionId) return { applied: false, reservationId: r.id, status: 'DUPLICATE' };
    const p = await tx.property.findFirstOrThrow({ where: { id: conn.propertyId } });
    const same = lagosDate(r.arrivalAt) === s.arrivalDate && lagosDate(r.departureAt) === s.departureDate && r.roomTypeId === s.roomTypeId;
    if (same && conn.provider === 'ICAL') return { applied: false, reservationId: r.id, status: 'UNCHANGED' };
    if (r.status === 'CHECKED_IN' || r.status === 'CHECKED_OUT') {
      await this.channels.log(tx, conn, { direction: 'WEBHOOK', kind: 'BOOKING', status: 'SKIPPED', summary: `Change to ${r.code} ignored: the guest has already checked in`, items: 0 });
      return { applied: false, reservationId: r.id, status: 'SKIPPED' };
    }
    const arrivalAt = lagosDateTime(s.arrivalDate, p.checkInTime);
    const departureAt = lagosDateTime(s.departureDate, p.checkOutTime);
    const free = await this.free(tx, conn.tenantId, p, s.roomTypeId, arrivalAt, departureAt, r.id);
    const overbooked = free < 1;
    const keepRoom = r.roomId && r.roomTypeId === s.roomTypeId && !overbooked && (await this.roomFree(tx, conn.tenantId, r.roomId, arrivalAt, departureAt, r.id));
    const nights = await this.nights(tx, conn, s);
    const gross = s.grossKobo ?? nights.reduce((a, n) => a + n.rateKobo, 0);
    const commission = s.commissionKobo ?? Math.round((gross * commissionBpsFor(conn, s.channel)) / 10_000);
    const from = [lagosDate(r.arrivalAt), s.arrivalDate].sort()[0];
    const to = [lagosDate(r.departureAt), s.departureDate].sort()[1];
    await tx.reservation.update({
      where: { id: r.id },
      data: {
        roomTypeId: s.roomTypeId,
        roomId: keepRoom ? r.roomId : null,
        arrivalAt,
        departureAt,
        adults: s.adults,
        children: s.children,
        rateKobo: nights[0]?.rateKobo ?? r.rateKobo,
        nightlyRates: nights as unknown as Prisma.InputJsonValue,
        otaCommissionKobo: commission,
        overbooked,
      },
    });
    await tx.channelBooking.update({ where: { id: b.id }, data: { status: 'MODIFIED', revisionId: s.revisionId, grossKobo: gross, commissionKobo: commission, overbooked, raw: (s.raw ?? {}) as Prisma.InputJsonValue } });
    if (overbooked) await this.flagOverbooked(tx, conn, p, r, s);
    await markAriDirty(tx, conn.tenantId, p.id, from, to);
    await this.audit.record(tx, { tenantId: conn.tenantId, actor: SYSTEM_ACTOR, action: 'channel.booking_modified', entityType: 'reservation', entityId: r.id, metadata: { code: r.code, channel: s.channel, arrivalDate: s.arrivalDate, departureDate: s.departureDate, overbooked } });
    await this.channels.log(tx, conn, { direction: conn.provider === 'ICAL' ? 'PULL' : 'WEBHOOK', kind: conn.provider === 'ICAL' ? 'ICAL_IMPORT' : 'BOOKING', status: 'OK', summary: `${CHANNEL_LABEL[s.channel]} changed ${r.code} to ${humanDate(s.arrivalDate)} - ${humanDate(s.departureDate)}`, items: 1 });
    return { applied: true, reservationId: r.id, overbooked, status: 'MODIFIED' };
  }

  private async cancel(tx: Tx, conn: ChannelConnection, s: OtaStay, b: { id: string; reservationId: string | null } | null) {
    if (!b?.reservationId) return { applied: false, status: 'UNKNOWN_BOOKING' };
    const r = await tx.reservation.findFirst({ where: { id: b.reservationId } });
    if (!r) return { applied: false, status: 'UNKNOWN_BOOKING' };
    await tx.channelBooking.update({ where: { id: b.id }, data: { status: 'CANCELLED', ...(s.revisionId && { revisionId: s.revisionId }) } });
    if (!['PENDING', 'CONFIRMED'].includes(r.status)) return { applied: false, reservationId: r.id, status: r.status };
    await tx.reservation.update({
      where: { id: r.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'SYSTEM', cancelReason: conn.provider === 'ICAL' ? `Removed from the ${CHANNEL_LABEL[s.channel]} calendar` : `Cancelled on ${CHANNEL_LABEL[s.channel]}`, roomId: null },
    });
    await markAriDirty(tx, conn.tenantId, r.propertyId, r.arrivalAt, r.departureAt);
    await this.audit.record(tx, { tenantId: conn.tenantId, actor: SYSTEM_ACTOR, action: 'channel.booking_cancelled', entityType: 'reservation', entityId: r.id, metadata: { code: r.code, channel: s.channel } });
    await this.channels.log(tx, conn, { direction: conn.provider === 'ICAL' ? 'PULL' : 'WEBHOOK', kind: conn.provider === 'ICAL' ? 'ICAL_IMPORT' : 'BOOKING', status: 'OK', summary: `${CHANNEL_LABEL[s.channel]} cancelled ${r.code}`, items: 1 });
    return { applied: true, reservationId: r.id, status: 'CANCELLED' };
  }

  // ---------------------------------------------------------------------------
  // iCal import
  // ---------------------------------------------------------------------------

  /** Imports one iCal connection's feeds (fetch + apply + cancel removed events). */
  /** Fetches an OTA feed under the SSRF guard (public https hosts, pinned address, size / time / type caps). */
  fetchFeed(url: string): Promise<string> {
    return safeFetchText(url, { production: this.config.get('NODE_ENV') === 'production', allowPrivateHosts: this.config.get('OUTBOUND_ALLOW_PRIVATE_HOSTS') });
  }

  async importConnection(tenantId: string, connectionId: string, fetchText: (url: string) => Promise<string> = (u) => this.fetchFeed(u)) {
    const conn = await this.db.tenant(tenantId, (tx) => tx.channelConnection.findFirst({ where: { id: connectionId, tenantId } }));
    if (!conn || conn.provider !== 'ICAL' || conn.status === 'PAUSED') return { feeds: 0, created: 0, cancelled: 0, errors: 0 };
    const feeds = await runInProperty(tenantId, conn.propertyId, () => this.db.tenant(tenantId, (tx) => tx.icalFeed.findMany({ where: { connectionId } })));
    let created = 0;
    let cancelled = 0;
    let errors = 0;
    const channel = conn.channel ?? 'OTHER';
    for (const f of feeds) {
      let events;
      try {
        events = parseIcs(await fetchText(f.url)).filter((e) => !isOtaBlock(e) && e.end > lagosDate());
      } catch (e) {
        errors++;
        const msg = (e as Error).message;
        await runInProperty(tenantId, conn.propertyId, () =>
          this.db.tenant(tenantId, async (tx) => {
            await tx.icalFeed.update({ where: { id: f.id }, data: { lastFetchedAt: new Date(), lastStatus: 'ERROR', lastError: msg } });
            await this.channels.log(tx, conn, { direction: 'PULL', kind: 'ICAL_IMPORT', status: 'ERROR', summary: 'An iCal feed could not be read', error: msg });
          }),
        );
        continue;
      }
      const seen = new Set<string>();
      for (const e of events) {
        const externalId = `${f.id}:${e.uid}`;
        seen.add(externalId);
        const r = await this.apply(conn, {
          externalId,
          revisionId: null,
          status: 'new',
          channel,
          otaRef: e.uid.split('@')[0].slice(0, 40),
          roomTypeId: f.roomTypeId,
          roomId: f.roomId,
          arrivalDate: e.start,
          departureDate: e.end,
          guestName: guestNameFrom(e) ?? `${CHANNEL_LABEL[channel]} guest`,
          guestPhone: null,
          guestEmail: null,
          adults: 1,
          children: 0,
          nightly: {},
          grossKobo: null,
          commissionKobo: null,
          raw: { feedId: f.id, uid: e.uid, summary: e.summary },
        });
        if (r.status === 'NEW' && r.applied) created++;
      }
      // Events that left the feed: cancel their future stays.
      const gone = await runInProperty(tenantId, conn.propertyId, () =>
        this.db.tenant(tenantId, (tx) => tx.channelBooking.findMany({ where: { connectionId, externalId: { startsWith: `${f.id}:` }, status: { not: 'CANCELLED' } } })),
      );
      for (const b of gone) {
        if (seen.has(b.externalId)) continue;
        const r = await this.apply(conn, { externalId: b.externalId, revisionId: null, status: 'cancelled', channel, otaRef: null, roomTypeId: f.roomTypeId, roomId: null, arrivalDate: '', departureDate: '', guestName: '', guestPhone: null, guestEmail: null, adults: 1, children: 0, nightly: {}, grossKobo: null, commissionKobo: null, raw: {} });
        if (r.applied) cancelled++;
      }
      await runInProperty(tenantId, conn.propertyId, () =>
        this.db.tenant(tenantId, (tx) => tx.icalFeed.update({ where: { id: f.id }, data: { lastFetchedAt: new Date(), lastStatus: 'OK', lastError: null, eventsCount: events.length } })),
      );
    }
    await runInProperty(tenantId, conn.propertyId, () =>
      this.db.tenant(tenantId, async (tx) => {
        await tx.channelConnection.update({ where: { id: connectionId }, data: { lastSyncAt: new Date(), ...(errors ? { lastError: `${errors} feed(s) failed`, lastErrorAt: new Date() } : { lastError: null }) } });
        await this.channels.log(tx, conn, { direction: 'PULL', kind: 'ICAL_IMPORT', status: errors ? 'ERROR' : 'OK', summary: `Imported ${feeds.length} feed${feeds.length === 1 ? '' : 's'}: ${created} new, ${cancelled} cancelled`, items: created + cancelled });
      }),
    );
    return { feeds: feeds.length, created, cancelled, errors };
  }

  /** Job: every iCal connection (15 minutes). */
  /** Job (every 5 minutes): imports connections not synced for ICAL_POLL_MINUTES. */
  async importAll(now = new Date()) {
    const due = new Date(now.getTime() - this.config.get('ICAL_POLL_MINUTES') * 60_000 + 30_000);
    const conns = (await this.db.systemAll((tx, t) =>
      tx.channelConnection.findMany({ where: { ...t.tenants, provider: 'ICAL', status: { not: 'PAUSED' }, OR: [{ lastSyncAt: null }, { lastSyncAt: { lte: due } }] }, select: { id: true, tenantId: true } }),
    )).flat();
    let created = 0;
    for (const c of conns) {
      try {
        created += (await this.importConnection(c.tenantId, c.id)).created;
      } catch (e) {
        this.logger.error(`iCal import failed for ${c.id}: ${(e as Error).message}`);
      }
    }
    return { connections: conns.length, created };
  }

  /** POST /channels/connections/:id/sync */
  async sync(user: AuthUser, id: string, full = false) {
    const conn = await this.db.tenant(user.tenantId, (tx) => tx.channelConnection.findFirst({ where: { id, tenantId: user.tenantId } }));
    if (!conn) throw AppException.notFound('Channel connection');
    if (conn.provider === 'ICAL') {
      await this.importConnection(user.tenantId, id);
    } else {
      const today = lagosDate();
      await this.channels.pushAri(user.tenantId, id, full ? { from: today, to: addDays(today, 365) } : undefined);
      // Pull bookings not acknowledged yet (a missed webhook).
      const pc = await this.db.tenant(user.tenantId, (tx) => this.channels.providerConnection(tx, conn));
      for (const rev of await this.channels.provider.feed(pc).catch(() => [])) {
        await this.applyRevision(conn, rev);
        await this.channels.provider.ack(pc, rev.id).catch(() => undefined);
      }
    }
    return this.channels.logs(user, { connectionId: id, page: 1, pageSize: 5 }).then((r) => ({ log: r.items }));
  }

  // ---------------------------------------------------------------------------
  // Dev simulator (mock Channex)
  // ---------------------------------------------------------------------------

  async devBooking(
    user: AuthUser,
    dto: { connectionId: string; roomTypeId: string; checkIn: string; checkOut: string; otaChannel?: OtaChannel; guestName?: string; adults?: number; amountKobo?: number; cancelExternalId?: string; modifyExternalId?: string },
    deliver: (rawBody: string, signature: string) => Promise<{ status: number; body: unknown }>,
  ) {
    if (this.config.get('NODE_ENV') === 'production' || !(this.channels.provider instanceof MockChannexProvider)) throw AppException.notFound('Route');
    const mock = this.channels.provider;
    const conn = await this.db.tenant(user.tenantId, (tx) => tx.channelConnection.findFirst({ where: { id: dto.connectionId, tenantId: user.tenantId } }));
    if (!conn || conn.provider !== 'CHANNEX') throw AppException.notFound('Channex connection');
    const mapping = await this.db.tenant(user.tenantId, (tx) => tx.channelMapping.findFirst({ where: { connectionId: conn.id, roomTypeId: dto.roomTypeId } }));
    if (!mapping && !dto.cancelExternalId) throw appError(HttpStatus.CONFLICT, 'CHANNEL_NOT_MAPPED', 'Map this room type first', { roomTypeId: dto.roomTypeId });
    const channel = dto.otaChannel ?? 'BOOKING_COM';
    const nights = dateRange(dto.checkIn, addDays(dto.checkOut, -1));
    const perNight = dto.amountKobo ? Math.round(dto.amountKobo / Math.max(1, nights.length)) : 0;
    let days: Record<string, number> = {};
    if (!perNight && mapping) {
      const rt = await this.db.tenant(user.tenantId, (tx) => tx.roomType.findFirstOrThrow({ where: { id: dto.roomTypeId } }));
      days = Object.fromEntries(nights.map((n) => [n, Math.round(rt.basePriceKobo * 1.1)]));
    } else {
      days = Object.fromEntries(nights.map((n) => [n, perNight]));
    }
    const amount = Object.values(days).reduce((a, b) => a + b, 0);
    const [first, ...rest] = (dto.guestName ?? 'Chioma Eze').split(' ');
    const externalId = dto.cancelExternalId ?? dto.modifyExternalId ?? `BDC-${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`;
    const rev = mock.addRevision({
      bookingId: externalId,
      externalPropertyId: conn.externalPropertyId ?? '',
      status: dto.cancelExternalId ? 'cancelled' : dto.modifyExternalId ? 'modified' : 'new',
      otaName: CHANNEL_LABEL[channel],
      otaReservationCode: externalId.replace(/^BDC-/, ''),
      arrivalDate: dto.checkIn,
      departureDate: dto.checkOut,
      customer: { name: first, surname: rest.join(' '), phone: null, mail: null },
      rooms: mapping ? [{ externalRoomTypeId: mapping.externalRoomTypeId, externalRatePlanId: mapping.externalRatePlanId, days, adults: dto.adults ?? 2, children: 0 }] : [],
      amountKobo: amount,
      otaCommissionKobo: null,
      currency: 'NGN',
    });
    const body = JSON.stringify({ event: dto.cancelExternalId ? 'booking_cancellation' : dto.modifyExternalId ? 'booking_modification' : 'booking_new', property_id: conn.externalPropertyId, payload: { booking_id: externalId, revision_id: rev.id } });
    const secret = this.config.get('CHANNEX_WEBHOOK_SECRET') ?? '';
    const webhook = await deliver(body, secret ? channexSignature(secret, body) : '');
    return { externalId, webhook };
  }
}

