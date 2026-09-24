/**
 * OpenAPI 3.1 document of the partner API (API-M6 12). Hand-written so it
 * describes exactly the stable surface (the app API has its own Swagger).
 */
import { API_SCOPES } from '../api-keys/api-keys.logic.js';
import { WEBHOOK_EVENTS } from '../webhooks/webhooks.logic.js';

export const PARTNER_API_VERSION = '2026-09-24';

type Schema = Record<string, unknown>;
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const str = (extra: Schema = {}): Schema => ({ type: 'string', ...extra });
const int = (extra: Schema = {}): Schema => ({ type: 'integer', ...extra });
const bool: Schema = { type: 'boolean' };
const nullable = (s: Schema): Schema => ({ oneOf: [s, { type: 'null' }] });
const date = str({ format: 'date', description: 'YYYY-MM-DD (Africa/Lagos)' });
const dateTime = str({ format: 'date-time' });
const uuid = str({ format: 'uuid' });
const kobo = int({ description: 'Amount in kobo (NGN x 100)' });
const obj = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required });

const schemas: Record<string, Schema> = {
  Error: obj(
    { statusCode: int(), code: str({ examples: ['VALIDATION_ERROR', 'INVALID_API_KEY', 'INSUFFICIENT_SCOPE', 'ROOM_UNAVAILABLE', 'RATE_LIMITED'] }), message: str(), details: { type: 'object' }, requestId: str() },
    ['statusCode', 'code', 'message', 'requestId'],
  ),
  Pagination: obj({ nextCursor: nullable(str()), limit: int() }),
  Key: obj({
    keyId: uuid,
    name: str(),
    environment: str({ enum: ['LIVE', 'TEST'] }),
    scopes: { type: 'array', items: str({ enum: API_SCOPES.map((s) => s.scope) }) },
    propertyIds: nullable({ type: 'array', items: uuid }),
    tenant: obj({ id: uuid, name: str() }),
  }),
  Property: obj({
    id: uuid, name: str(), slug: str(), city: str(), state: str(), area: str(), address: str(), phone: str(), email: str(),
    timezone: str({ const: 'Africa/Lagos' }), checkInTime: str({ examples: ['14:00'] }), checkOutTime: str({ examples: ['12:00'] }), currency: str({ const: 'NGN' }),
  }),
  RoomType: obj({
    id: uuid, propertyId: uuid, name: str(), description: str(), capacity: int(), bedType: str(), sizeSqm: int(), basePriceKobo: kobo,
    amenities: { type: 'array', items: str() }, roomCount: int(),
  }),
  RoomStatus: str({ enum: ['VACANT_CLEAN', 'VACANT_DIRTY', 'OCCUPIED', 'RESERVED', 'OUT_OF_ORDER'] }),
  Room: obj({ id: uuid, propertyId: uuid, roomTypeId: uuid, number: str(), floor: int(), status: ref('RoomStatus'), updatedAt: dateTime }),
  Availability: obj({ propertyId: uuid, roomTypeId: uuid, date, available: int(), sellable: int(), booked: int(), blocked: int() }),
  Rate: obj({
    propertyId: uuid, roomTypeId: uuid, ratePlanId: str(), ratePlanName: str(), date, rateKobo: kobo,
    source: str({ enum: ['BASE', 'SEASON', 'OVERRIDE', 'PRICING'] }),
    restrictions: obj({ stopSell: bool, closedToArrival: bool, closedToDeparture: bool, minNights: nullable(int()) }),
  }),
  Reservation: obj({
    id: uuid, code: str(), propertyId: uuid,
    status: str({ enum: ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW'] }),
    source: str(), stayType: str({ enum: ['NIGHTLY', 'DAY_USE'] }),
    arrivalDate: date, departureDate: date, arrivalAt: dateTime, departureAt: dateTime, nights: int(), adults: int(), children: int(),
    roomType: obj({ id: uuid, name: str() }), room: nullable(obj({ id: uuid, number: str() })), ratePlan: nullable(obj({ id: uuid, name: str() })),
    rateKobo: kobo, nightlyRates: { type: 'array', items: obj({ date, rateKobo: kobo }) },
    guest: obj({ id: uuid, fullName: str() }), notes: nullable(str()), externalRef: nullable(str()),
    createdAt: dateTime, updatedAt: dateTime, cancelledAt: nullable(dateTime),
  }),
  Guest: obj({ id: uuid, fullName: str(), phone: nullable(str()), email: nullable(str()), nationality: nullable(str()), vip: bool, createdAt: dateTime }),
  Folio: obj({
    reservationId: uuid, folioId: uuid, status: str(), currency: str({ const: 'NGN' }), balanceKobo: kobo, chargesKobo: kobo, paymentsKobo: kobo,
    entries: { type: 'array', items: obj({ id: uuid, type: str(), description: str(), amountKobo: kobo, paymentMethod: nullable(str()), createdAt: dateTime, voided: bool }) },
  }),
  HousekeepingTask: obj({
    id: uuid, propertyId: uuid, roomId: uuid, roomNumber: str(), type: str(), status: str(), priority: str(),
    assignee: nullable(obj({ id: uuid, fullName: str() })), dueAt: nullable(dateTime), completedAt: nullable(dateTime), createdAt: dateTime,
  }),
  DailyStats: obj({
    propertyId: uuid, date, roomsAvailable: int(), roomsSold: int(), occupancyPct: { type: 'number' }, adrKobo: kobo, revparKobo: kobo,
    roomRevenueKobo: kobo, totalRevenueKobo: kobo, arrivals: int(), departures: int(), noShows: int(),
  }),
  WebhookEndpoint: obj({
    id: uuid, url: str({ format: 'uri' }), description: nullable(str()), events: { type: 'array', items: str() }, propertyIds: nullable({ type: 'array', items: uuid }),
    status: str({ enum: ['ACTIVE', 'DISABLED'] }), disabledReason: nullable(str()), secretPreview: str(), createdAt: dateTime,
  }),
  CreateReservation: obj(
    {
      propertyId: uuid, roomTypeId: uuid, arrivalDate: date, departureDate: date, adults: int({ minimum: 1, maximum: 10 }), children: int({ minimum: 0, maximum: 10 }),
      ratePlanId: uuid, guest: obj({ fullName: str(), phone: str(), email: str({ format: 'email' }) }, ['fullName', 'phone']), notes: str({ maxLength: 1000 }), externalRef: str({ maxLength: 120 }),
    },
    ['propertyId', 'roomTypeId', 'arrivalDate', 'departureDate', 'adults', 'guest'],
  ),
  UpdateReservation: obj({ arrivalDate: date, departureDate: date, adults: int(), children: int(), notes: str(), externalRef: nullable(str()) }, []),
  Event: obj({
    id: str({ examples: ['evt_4f1c...'] }), type: str({ enum: WEBHOOK_EVENTS.map((e) => e.type) }), createdAt: dateTime, apiVersion: str({ const: PARTNER_API_VERSION }),
    livemode: bool, tenantId: uuid, propertyId: nullable(uuid), data: obj({ object: { type: 'object' } }),
  }),
};

const rateHeaders = {
  'RateLimit-Limit': { schema: int(), description: 'Requests allowed per minute for this key' },
  'RateLimit-Remaining': { schema: int(), description: 'Requests left in the current minute' },
  'RateLimit-Reset': { schema: int(), description: 'Seconds until the minute window resets' },
  'RateLimit-Policy': { schema: str(), description: 'e.g. "600;w=60, 50;w=1"' },
  'X-Request-Id': { schema: str(), description: 'Request id (echoes a client X-Request-Id)' },
};

const errors = Object.fromEntries(
  [
    ['400', 'Validation error (VALIDATION_ERROR, IDEMPOTENCY_KEY_REQUIRED)'],
    ['401', 'INVALID_API_KEY'],
    ['402', 'SUBSCRIPTION_READ_ONLY (writes)'],
    ['403', 'INSUFFICIENT_SCOPE, IP_NOT_ALLOWED, FEATURE_LOCKED, PROPERTY_ACCESS_DENIED'],
    ['404', 'NOT_FOUND'],
    ['409', 'ROOM_UNAVAILABLE, INVALID_STATE, TENANT_MIGRATING'],
    ['422', 'IDEMPOTENCY_CONFLICT'],
    ['429', 'RATE_LIMITED (see Retry-After)'],
  ].map(([code, description]) => [code, { description, content: { 'application/json': { schema: ref('Error') } } }]),
);

const one = (schema: Schema, description = 'OK') => ({
  description,
  headers: rateHeaders,
  content: { 'application/json': { schema: obj({ data: schema, dryRun: { type: 'boolean', description: 'Present (true) on writes made with a test key' } }, ['data']) } },
});
const many = (schema: Schema) => ({
  description: 'OK',
  headers: rateHeaders,
  content: { 'application/json': { schema: obj({ data: { type: 'array', items: schema }, pagination: ref('Pagination') }) } },
});
const list = (schema: Schema) => ({ description: 'OK', headers: rateHeaders, content: { 'application/json': { schema: obj({ data: { type: 'array', items: schema } }) } } });

const q = (name: string, schema: Schema, required = false, description?: string) => ({ name, in: 'query', required, schema, ...(description && { description }) });
const p = (name: string) => ({ name, in: 'path', required: true, schema: str() });
const idem = { name: 'Idempotency-Key', in: 'header', required: true, schema: str({ minLength: 8, maxLength: 128 }), description: 'Required on every write; retries replay the first response for 72 hours' };
const pageParams = [q('limit', int({ minimum: 1, maximum: 200, default: 50 })), q('cursor', str())];
const body = (schema: Schema) => ({ required: true, content: { 'application/json': { schema } } });

function op(summary: string, scope: string | null, responses: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    summary,
    ...(scope && { description: `Scope: \`${scope}\`` }),
    security: [{ bearerAuth: [] }],
    responses: { ...responses, ...errors },
    ...extra,
  };
}

export function partnerOpenApi(serverUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Hotel partner API',
      version: PARTNER_API_VERSION,
      description:
        'Versioned API for integrations (PMS bridges, channel tools, BI). JSON, camelCase, money in kobo, dates in Africa/Lagos. ' +
        'Authenticate with an API key from the hotel admin (Settings > Integrations): `Authorization: Bearer hk_live_...`. ' +
        'Test keys (`hk_test_...`) validate writes fully and roll them back; responses carry `dryRun: true`.',
    },
    'x-changelog': [{ date: PARTNER_API_VERSION, changes: ['First release: properties, room types, rooms, availability, rates, reservations, guests, folios, housekeeping, daily reports, webhook endpoints.'] }],
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'hk_live_<prefix>_<secret>', description: 'API key (or header X-Api-Key)' } },
      schemas,
    },
    paths: {
      '/me': { get: op('The API key and its hotel', null, { '200': one(ref('Key')) }) },
      '/properties': { get: op('Properties the key may access', null, { '200': many(ref('Property')) }, { parameters: pageParams }) },
      '/properties/{id}': { get: op('One property', null, { '200': one(ref('Property')) }, { parameters: [p('id')] }) },
      '/room-types': { get: op('Room types', null, { '200': many(ref('RoomType')) }, { parameters: [q('propertyId', uuid), ...pageParams] }) },
      '/room-types/{id}': { get: op('One room type', null, { '200': one(ref('RoomType')) }, { parameters: [p('id')] }) },
      '/rooms': { get: op('Rooms', 'rooms:read', { '200': many(ref('Room')) }, { parameters: [q('propertyId', uuid), q('status', ref('RoomStatus')), q('roomTypeId', uuid), ...pageParams] }) },
      '/rooms/{id}': { get: op('One room', 'rooms:read', { '200': one(ref('Room')) }, { parameters: [p('id')] }) },
      '/rooms/{id}/status': {
        patch: op('Change a room status', 'rooms:write', { '200': one(ref('Room')) }, { parameters: [p('id'), idem], requestBody: body(obj({ status: ref('RoomStatus'), note: str() }, ['status'])) }),
      },
      '/availability': {
        get: op('Availability per room type and night (max 180 nights)', 'availability:read', { '200': list(ref('Availability')) }, {
          parameters: [q('propertyId', uuid, true), q('from', date, true), q('to', date, true), q('roomTypeId', uuid)],
        }),
      },
      '/rates': {
        get: op('Resolved nightly rates (max 180 nights)', 'rates:read', { '200': list(ref('Rate')) }, {
          parameters: [q('propertyId', uuid, true), q('from', date, true), q('to', date, true), q('roomTypeId', uuid), q('ratePlanId', str())],
        }),
      },
      '/rates/overrides': {
        put: op('Set a date override per night (inclusive range, max 366)', 'rates:write', { '200': one(obj({ updated: int() })) }, {
          parameters: [idem],
          requestBody: body(obj({ propertyId: uuid, roomTypeId: uuid, ratePlanId: str(), from: date, to: date, rateKobo: kobo }, ['propertyId', 'roomTypeId', 'from', 'to', 'rateKobo'])),
        }),
        delete: op('Clear date overrides', 'rates:write', { '200': one(obj({ deleted: int() })) }, {
          parameters: [idem, q('propertyId', uuid, true), q('roomTypeId', uuid, true), q('from', date, true), q('to', date, true)],
        }),
      },
      '/reservations': {
        get: op('Reservations (ordered by createdAt, id)', 'reservations:read', { '200': many(ref('Reservation')) }, {
          parameters: [q('propertyId', uuid), q('status', str()), q('arrivalFrom', date), q('arrivalTo', date), q('updatedSince', dateTime), ...pageParams],
        }),
        post: op('Create a reservation (NIGHTLY, CONFIRMED, source API)', 'reservations:write', { '201': one(ref('Reservation'), 'Created') }, { parameters: [idem], requestBody: body(ref('CreateReservation')) }),
      },
      '/reservations/{id}': {
        get: op('One reservation (id or code)', 'reservations:read', { '200': one(ref('Reservation')) }, { parameters: [p('id')] }),
        patch: op('Change dates, guests, notes or external reference (availability re-checked)', 'reservations:write', { '200': one(ref('Reservation')) }, {
          parameters: [p('id'), idem],
          requestBody: body(ref('UpdateReservation')),
        }),
      },
      '/reservations/{id}/cancel': {
        post: op('Cancel a reservation', 'reservations:write', { '200': one(ref('Reservation')) }, { parameters: [p('id'), idem], requestBody: { content: { 'application/json': { schema: obj({ reason: str() }, []) } } } }),
      },
      '/reservations/{id}/folio': { get: op('Folio of a reservation', 'folios:read', { '200': one(ref('Folio')) }, { parameters: [p('id')] }) },
      '/guests': { get: op('Guests (limited PII)', 'guests:read', { '200': many(ref('Guest')) }, { parameters: [q('updatedSince', dateTime), ...pageParams] }) },
      '/guests/{id}': { get: op('One guest', 'guests:read', { '200': one(ref('Guest')) }, { parameters: [p('id')] }) },
      '/housekeeping/tasks': {
        get: op('Housekeeping tasks', 'housekeeping:read', { '200': many(ref('HousekeepingTask')) }, { parameters: [q('propertyId', uuid), q('status', str()), q('date', date), ...pageParams] }),
      },
      '/housekeeping/tasks/{id}/complete': {
        post: op('Mark a task done', 'housekeeping:write', { '200': one(ref('HousekeepingTask')) }, { parameters: [p('id'), idem], requestBody: { content: { 'application/json': { schema: obj({ note: str() }, []) } } } }),
      },
      '/reports/daily': {
        get: op('Daily stats for one date or a range', 'reports:read', { '200': one({ oneOf: [ref('DailyStats'), { type: 'array', items: ref('DailyStats') }] }) }, {
          parameters: [q('propertyId', uuid, true), q('date', date), q('from', date), q('to', date)],
        }),
      },
      '/webhook-endpoints': {
        get: op('Webhook endpoints', 'webhooks:manage', { '200': list(ref('WebhookEndpoint')) }),
        post: op('Create a webhook endpoint (the secret is returned once)', 'webhooks:manage', { '201': one(obj({ endpoint: ref('WebhookEndpoint'), secret: str() }), 'Created') }, {
          parameters: [idem],
          requestBody: body(obj({ url: str({ format: 'uri' }), events: { type: 'array', items: str() }, description: str(), propertyIds: nullable({ type: 'array', items: uuid }) }, ['url', 'events'])),
        }),
      },
      '/webhook-endpoints/{id}': {
        patch: op('Change a webhook endpoint', 'webhooks:manage', { '200': one(ref('WebhookEndpoint')) }, { parameters: [p('id'), idem], requestBody: body({ type: 'object' }) }),
        delete: op('Delete a webhook endpoint', 'webhooks:manage', { '200': one(obj({ success: bool })) }, { parameters: [p('id'), idem] }),
      },
    },
    webhooks: Object.fromEntries(
      WEBHOOK_EVENTS.map((e) => [
        e.type,
        {
          post: {
            summary: e.description,
            description:
              'Headers: X-Webhook-Id, X-Event-Id, X-Event-Type, X-Signature `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` (a second v1 during secret rotation). ' +
              'Answer 2xx within 10 s. Retries after 1 min, 5 min, 30 min, 2 h, 5 h, 10 h and 24 h.',
            requestBody: { content: { 'application/json': { schema: ref('Event') } } },
            responses: { '200': { description: 'Received' } },
          },
        },
      ]),
    ),
  };
}
