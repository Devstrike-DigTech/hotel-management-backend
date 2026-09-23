import { createHmac, randomUUID } from 'node:crypto';

/**
 * Channel-manager provider abstraction. `ChannexProvider` talks to the
 * Channex REST API; `MockChannexProvider` behaves the same in process
 * (development and tests, no API key): its remote catalogue mirrors the
 * hotel's room types, pushes are recorded, and booking revisions it creates
 * are delivered through the real signed webhook.
 */

export interface RemoteCatalogue {
  roomTypes: { id: string; title: string }[];
  ratePlans: { id: string; title: string; roomTypeId: string }[];
}

export interface AvailabilityValue {
  externalRoomTypeId: string;
  dateFrom: string;
  dateTo: string; // inclusive
  availability: number;
}

export interface RestrictionValue {
  externalRatePlanId: string;
  dateFrom: string;
  dateTo: string; // inclusive
  rateKobo: number | null;
  stopSell: boolean;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  minStayArrival: number;
}

export interface BookingRevision {
  id: string;
  bookingId: string;
  externalPropertyId: string;
  status: 'new' | 'modified' | 'cancelled';
  otaName: string;
  otaReservationCode: string;
  arrivalDate: string;
  departureDate: string;
  customer: { name: string; surname: string; phone: string | null; mail: string | null };
  rooms: { externalRoomTypeId: string; externalRatePlanId: string | null; days: Record<string, number>; adults: number; children: number }[];
  amountKobo: number;
  otaCommissionKobo: number | null;
  currency: string;
}

/** What a provider needs about a connection. */
export interface ProviderConnection {
  id: string;
  apiKey: string | null;
  externalPropertyId: string | null;
  /** Our catalogue (the mock mirrors it). */
  local: { roomTypes: { id: string; name: string }[]; ratePlans: { id: string; code: string; name: string; roomTypeIds: string[] }[] };
}

export interface ChannelProvider {
  readonly name: 'channex' | 'mock';
  checkConnection(conn: ProviderConnection): Promise<{ externalPropertyId: string; title: string }>;
  catalogue(conn: ProviderConnection): Promise<RemoteCatalogue>;
  pushAvailability(conn: ProviderConnection, values: AvailabilityValue[]): Promise<void>;
  pushRestrictions(conn: ProviderConnection, values: RestrictionValue[]): Promise<void>;
  revision(conn: ProviderConnection, revisionId: string): Promise<BookingRevision>;
  ack(conn: ProviderConnection, revisionId: string): Promise<void>;
  feed(conn: ProviderConnection): Promise<BookingRevision[]>;
}

export class ChannelProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Hex HMAC-SHA256 of a webhook body (X-Channex-Signature). */
export function channexSignature(secret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

const naira = (kobo: number) => (kobo / 100).toFixed(2);

/** Channex REST API v1 (https://docs.channex.io). */
export class ChannexProvider implements ChannelProvider {
  readonly name = 'channex' as const;

  constructor(private readonly baseUrl: string) {}

  private async call<T>(conn: ProviderConnection, method: string, path: string, body?: unknown): Promise<T> {
    if (!conn.apiKey) throw new ChannelProviderError('The connection has no API key');
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'user-api-key': conn.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    }).catch((e: Error) => {
      throw new ChannelProviderError(`Channex is unreachable: ${e.message}`);
    });
    const text = await res.text();
    if (!res.ok) throw new ChannelProviderError(`Channex ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`, res.status);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async checkConnection(conn: ProviderConnection) {
    if (!conn.externalPropertyId) throw new ChannelProviderError('Give the Channex property id');
    const r = await this.call<{ data: { id: string; attributes: { title: string } } }>(conn, 'GET', `/properties/${conn.externalPropertyId}`);
    return { externalPropertyId: r.data.id, title: r.data.attributes.title };
  }

  async catalogue(conn: ProviderConnection): Promise<RemoteCatalogue> {
    const pid = encodeURIComponent(conn.externalPropertyId ?? '');
    const rts = await this.call<{ data: { id: string; attributes: { title: string } }[] }>(conn, 'GET', `/room_types?filter[property_id]=${pid}&pagination[limit]=100`);
    const rps = await this.call<{ data: { id: string; attributes: { title: string }; relationships?: { room_type?: { data?: { id: string } } } }[] }>(
      conn,
      'GET',
      `/rate_plans?filter[property_id]=${pid}&pagination[limit]=100`,
    );
    return {
      roomTypes: rts.data.map((r) => ({ id: r.id, title: r.attributes.title })),
      ratePlans: rps.data.map((r) => ({ id: r.id, title: r.attributes.title, roomTypeId: r.relationships?.room_type?.data?.id ?? '' })),
    };
  }

  async pushAvailability(conn: ProviderConnection, values: AvailabilityValue[]) {
    if (!values.length) return;
    await this.call(conn, 'POST', '/availability', {
      values: values.map((v) => ({ property_id: conn.externalPropertyId, room_type_id: v.externalRoomTypeId, date_from: v.dateFrom, date_to: v.dateTo, availability: v.availability })),
    });
  }

  async pushRestrictions(conn: ProviderConnection, values: RestrictionValue[]) {
    if (!values.length) return;
    await this.call(conn, 'POST', '/restrictions', {
      values: values.map((v) => ({
        property_id: conn.externalPropertyId,
        rate_plan_id: v.externalRatePlanId,
        date_from: v.dateFrom,
        date_to: v.dateTo,
        ...(v.rateKobo !== null && { rate: naira(v.rateKobo) }),
        stop_sell: v.stopSell,
        closed_to_arrival: v.closedToArrival,
        closed_to_departure: v.closedToDeparture,
        min_stay_arrival: v.minStayArrival,
      })),
    });
  }

  private toRevision(d: { id: string; attributes: Record<string, unknown> }): BookingRevision {
    const a = d.attributes as {
      booking_id: string; property_id: string; status: string; ota_name: string; ota_reservation_code: string;
      arrival_date: string; departure_date: string; amount: string; currency: string; ota_commission?: string | null;
      customer?: { name?: string; surname?: string; phone?: string | null; mail?: string | null };
      rooms?: { room_type_id: string; rate_plan_id?: string | null; days?: Record<string, string>; occupancy?: { adults?: number; children?: number } }[];
    };
    const kobo = (s: string | null | undefined) => (s === null || s === undefined || s === '' ? null : Math.round(Number(s) * 100));
    return {
      id: d.id,
      bookingId: a.booking_id,
      externalPropertyId: a.property_id,
      status: (['new', 'modified', 'cancelled'].includes(a.status) ? a.status : 'new') as BookingRevision['status'],
      otaName: a.ota_name,
      otaReservationCode: a.ota_reservation_code,
      arrivalDate: a.arrival_date,
      departureDate: a.departure_date,
      customer: { name: a.customer?.name ?? '', surname: a.customer?.surname ?? '', phone: a.customer?.phone ?? null, mail: a.customer?.mail ?? null },
      rooms: (a.rooms ?? []).map((r) => ({
        externalRoomTypeId: r.room_type_id,
        externalRatePlanId: r.rate_plan_id ?? null,
        days: Object.fromEntries(Object.entries(r.days ?? {}).map(([k, v]) => [k, kobo(v) ?? 0])),
        adults: r.occupancy?.adults ?? 1,
        children: r.occupancy?.children ?? 0,
      })),
      amountKobo: kobo(a.amount) ?? 0,
      otaCommissionKobo: kobo(a.ota_commission),
      currency: a.currency,
    };
  }

  async revision(conn: ProviderConnection, revisionId: string) {
    const r = await this.call<{ data: { id: string; attributes: Record<string, unknown> } }>(conn, 'GET', `/booking_revisions/${revisionId}`);
    return this.toRevision(r.data);
  }

  async ack(conn: ProviderConnection, revisionId: string) {
    await this.call(conn, 'POST', `/booking_revisions/${revisionId}/ack`);
  }

  async feed(conn: ProviderConnection) {
    const pid = encodeURIComponent(conn.externalPropertyId ?? '');
    const r = await this.call<{ data: { id: string; attributes: Record<string, unknown> }[] }>(conn, 'GET', `/booking_revisions/feed?filter[property_id]=${pid}`);
    return r.data.map((d) => this.toRevision(d));
  }
}

/** Remote ids the mock gives our room types and plans (stable, readable). */
export const mockRoomTypeId = (roomTypeId: string) => `mock-rt-${roomTypeId.slice(0, 8)}`;
export const mockRatePlanId = (roomTypeId: string, code: string) => `mock-rp-${roomTypeId.slice(0, 8)}-${code.toLowerCase()}`;

/** In-process Channex stand-in (development and tests). */
export class MockChannexProvider implements ChannelProvider {
  readonly name = 'mock' as const;
  /** Every push, newest last (tests and the sync log read it). */
  readonly pushes: { connectionId: string; kind: 'availability' | 'restrictions'; values: (AvailabilityValue | RestrictionValue)[]; at: Date }[] = [];
  private readonly revisions = new Map<string, BookingRevision>();
  private readonly acked = new Set<string>();

  async checkConnection(conn: ProviderConnection) {
    return { externalPropertyId: conn.externalPropertyId ?? `mock-property-${conn.id.slice(0, 8)}`, title: 'Mock Channex property' };
  }

  async catalogue(conn: ProviderConnection): Promise<RemoteCatalogue> {
    return {
      roomTypes: conn.local.roomTypes.map((r) => ({ id: mockRoomTypeId(r.id), title: `${r.name} (Channex)` })),
      ratePlans: conn.local.roomTypes.flatMap((r) =>
        conn.local.ratePlans
          .filter((p) => !p.roomTypeIds.length || p.roomTypeIds.includes(r.id))
          .map((p) => ({ id: mockRatePlanId(r.id, p.code), title: `${r.name} ${p.name}`, roomTypeId: mockRoomTypeId(r.id) })),
      ),
    };
  }

  async pushAvailability(conn: ProviderConnection, values: AvailabilityValue[]) {
    if (values.length) this.pushes.push({ connectionId: conn.id, kind: 'availability', values, at: new Date() });
  }

  async pushRestrictions(conn: ProviderConnection, values: RestrictionValue[]) {
    if (values.length) this.pushes.push({ connectionId: conn.id, kind: 'restrictions', values, at: new Date() });
  }

  /** Creates a revision the next webhook will announce. */
  addRevision(r: Omit<BookingRevision, 'id'>): BookingRevision {
    const rev = { ...r, id: `rev-${randomUUID()}` };
    this.revisions.set(rev.id, rev);
    return rev;
  }

  async revision(_conn: ProviderConnection, revisionId: string) {
    const r = this.revisions.get(revisionId);
    if (!r) throw new ChannelProviderError(`Unknown booking revision ${revisionId}`, 404);
    return r;
  }

  async ack(_conn: ProviderConnection, revisionId: string) {
    this.acked.add(revisionId);
  }

  async feed(conn: ProviderConnection) {
    return [...this.revisions.values()].filter((r) => r.externalPropertyId === conn.externalPropertyId && !this.acked.has(r.id));
  }

  pushCount(connectionId?: string) {
    return this.pushes.filter((p) => !connectionId || p.connectionId === connectionId).length;
  }
}

export const CHANNEL_PROVIDER = Symbol('CHANNEL_PROVIDER');
