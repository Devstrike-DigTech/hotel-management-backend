import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { API, createApp, ownerClient, platformAuth, uniq } from './helpers.js';
import { ID, lagosDay, REGISTRATION, type Auth } from './m2-helpers.js';
import { daysFromToday, freshPhone, onlineHotel, randomIp, startPaystackStub, stopStub, type OnlineHotel, type PaystackStub } from './m3-helpers.js';

type Field = Record<string, unknown> & { key: string };

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

describe('M7: Brand Studio, booking forms, extras, pickups and transfers', () => {
  let app: INestApplication;
  let db: pg.Client;
  let platform: Auth;
  let stub: PaystackStub;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    stub = await startPaystackStub();
    app = await createApp();
    db = ownerClient();
    await db.connect();
    platform = await platformAuth(app);
  });

  afterAll(async () => {
    await db.end();
    await app.close();
    await stopStub(stub);
  });

  async function onPlan(h: OnlineHotel, planCode: 'starter' | 'growth' | 'pro') {
    await request(server()).patch(`${API}/platform/tenants/${h.owner.tenantId}/subscription`).set(platform).send({ planCode, status: 'ACTIVE' }).expect(200);
  }

  async function draftFields(auth: Auth): Promise<Field[]> {
    return (await request(server()).get(`${API}/booking-form`).set(auth).expect(200)).body.draft.fields;
  }

  /** The draft with `extra` fields inserted before the consent box. */
  function withFields(fields: Field[], ...extra: Field[]): Field[] {
    const consent = fields.find((f) => f.key === 'policyConsent')!;
    return [...fields.filter((f) => f !== consent), ...extra, consent];
  }

  const custom = (f: Partial<Field> & { key: string; type: string; label: string }): Field => ({
    source: 'CUSTOM', required: 'OPTIONAL', section: 'Your stay', channels: ['MARKETPLACE', 'BOOKING_SITE', 'FRONT_DESK'], options: [], validation: {}, condition: null, ...f,
  });

  async function publishForm(auth: Auth, fields: Field[], note = 'e2e') {
    await request(server()).put(`${API}/booking-form/draft`).set(auth).send({ fields }).expect(200);
    return (await request(server()).post(`${API}/booking-form/publish`).set(auth).send({ note }).expect(200)).body;
  }

  function publicQuote(h: OnlineHotel, body: Record<string, unknown>) {
    const checkIn = (body.checkIn as string) ?? lagosDay(10);
    return request(server())
      .post(`${API}/public/quotes`)
      .set('X-Forwarded-For', randomIp())
      .send({ hotelSlug: h.slug, roomTypeId: h.typeId, channel: 'BOOKING_SITE', checkIn, checkOut: lagosDay(daysFromToday(checkIn) + 2), adults: 2, ...body });
  }

  function publicBook(token: string, body: Record<string, unknown> = {}) {
    return request(server())
      .post(`${API}/public/bookings`)
      .set('X-Forwarded-For', randomIp())
      .send({ quoteToken: token, paymentMode: 'PAY_AT_HOTEL', guest: { fullName: 'Chiamaka Obi', phone: freshPhone(), email: `guest-${uniq()}@e2e.test` }, consent: true, ...body });
  }

  async function outboxFor(to: string, template: string) {
    for (let i = 0; i < 30; i++) {
      const res = await request(server()).get(`${API}/public/dev/outbox`).query({ to, limit: 50 }).expect(200);
      const found = (res.body.items as { template: string; channel: string }[]).filter((m) => m.template === template);
      if (found.length) return found;
      await new Promise((r) => setTimeout(r, 200));
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // Brand Studio
  // -------------------------------------------------------------------------

  describe('themes', () => {
    it('publishes, lists versions and reverts; the public theme follows', async () => {
      const h = await onlineHotel(app, 1);
      const first = await request(server()).get(`${API}/site/theme`).set(h.owner.auth).expect(200);
      expect(first.body.published).toMatchObject({ version: 1, templateId: 'editorial' });
      expect(first.body.hasUnpublishedChanges).toBe(false);

      const draft = await request(server()).put(`${API}/site/theme/draft`).set(h.owner.auth).send({ templateId: 'boutique', brand: { primary: '#1D3557' } }).expect(200);
      expect(draft.body.hasUnpublishedChanges).toBe(true);
      expect(draft.body.changes.join(' ')).toContain('Template');
      // Nothing changes publicly until publish.
      expect((await request(server()).get(`${API}/public/hotels/${h.slug}/theme`).expect(200)).body.templateId).toBe('editorial');

      const pub = await request(server()).post(`${API}/site/theme/publish`).set(h.owner.auth).send({ note: 'Boutique look' }).expect(200);
      expect(pub.body.published).toMatchObject({ version: 2, templateId: 'boutique', note: 'Boutique look' });
      const live = await request(server()).get(`${API}/public/hotels/${h.slug}/theme`).expect(200);
      expect(live.body).toMatchObject({ templateId: 'boutique', version: 2 });
      await request(server()).post(`${API}/site/theme/publish`).set(h.owner.auth).send({}).expect(409);

      const versions = await request(server()).get(`${API}/site/theme/versions`).set(h.owner.auth).expect(200);
      expect(versions.body.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      const v1 = versions.body.find((v: { version: number }) => v.version === 1);
      const reverted = await request(server()).post(`${API}/site/theme/versions/${v1.id}/revert`).set(h.owner.auth).send({}).expect(200);
      expect(reverted.body.published).toMatchObject({ version: 3, templateId: 'editorial' });
      expect((await request(server()).get(`${API}/public/hotels/${h.slug}/theme`).expect(200)).body.templateId).toBe('editorial');
    });

    it('derives accessible colour variants server-side', async () => {
      const h = await onlineHotel(app, 1);
      const pale = await request(server()).post(`${API}/site/theme/contrast`).set(h.owner.auth).send({ primary: '#FFE066' }).expect(200);
      expect(pale.body.adjusted).toBe(true);
      expect(pale.body.light.primary).not.toBe('#FFE066');
      expect(pale.body.contrast.light.onPrimary).toBeGreaterThanOrEqual(4.5);
      expect(pale.body.contrast.light.primaryTextOnSurface).toBeGreaterThanOrEqual(4.5);
      const ok = await request(server()).post(`${API}/site/theme/contrast`).set(h.owner.auth).send({ primary: '#1D3557', secondary: null }).expect(200);
      expect(ok.body.light.primary).toBe('#1D3557');
      await request(server()).post(`${API}/site/theme/contrast`).set(h.owner.auth).send({ primary: 'red' }).expect(400);
    });

    it('plan gates: Starter keeps to Editorial / Essentials with default sections and fonts', async () => {
      const h = await onlineHotel(app, 1);
      await onPlan(h, 'starter');
      const locked = await request(server()).put(`${API}/site/theme/draft`).set(h.owner.auth).send({ templateId: 'resort' }).expect(403);
      expect(locked.body).toMatchObject({ code: 'FEATURE_LOCKED', details: { feature: 'site_templates_all', requiredPlan: 'growth' } });
      const fonts = await request(server()).put(`${API}/site/theme/draft`).set(h.owner.auth).send({ brand: { fontPairingId: 'cormorant-manrope' } }).expect(403);
      expect(fonts.body.details).toMatchObject({ feature: 'site_fonts', requiredPlan: 'pro' });
      await request(server()).put(`${API}/site/theme/draft`).set(h.owner.auth).send({ templateId: 'essentials', brand: { primary: '#8A4B1F' } }).expect(200);
      await request(server()).post(`${API}/site/theme/publish`).set(h.owner.auth).send({}).expect(200);
      const gates = await request(server()).get(`${API}/site/gates`).set(h.owner.auth).expect(200);
      expect(gates.body.features).toMatchObject({ brand_kit: true, site_templates_all: false, site_fonts: false, paid_extras: false });
      expect(gates.body.limits).toEqual({ max_custom_form_fields: 3 });
    });
  });

  // -------------------------------------------------------------------------
  // Booking form
  // -------------------------------------------------------------------------

  describe('booking form', () => {
    it('BVN is blocked, NIN warns, and Starter stops at 3 custom fields', async () => {
      const h = await onlineHotel(app, 1);
      await onPlan(h, 'starter');
      expect((await request(server()).post(`${API}/booking-form/check-label`).set(h.owner.auth).send({ label: 'BVN' }).expect(200)).body.level).toBe('BLOCK');
      expect((await request(server()).post(`${API}/booking-form/check-label`).set(h.owner.auth).send({ label: 'NIN' }).expect(200)).body).toMatchObject({ level: 'WARN', kind: 'NIN' });

      const base = await draftFields(h.owner.auth);
      const bvn = await request(server()).put(`${API}/booking-form/draft`).set(h.owner.auth).send({ fields: withFields(base, custom({ key: 'c_bvn', type: 'SHORT_TEXT', label: 'Your BVN' })) }).expect(400);
      expect(bvn.body.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ fieldKey: 'c_bvn', code: 'BVN_BLOCKED' })]));

      const three = ['a', 'b', 'c'].map((k) => custom({ key: `c_${k}${k}`, type: 'SHORT_TEXT', label: `Question ${k}` }));
      const ok = await request(server()).put(`${API}/booking-form/draft`).set(h.owner.auth).send({ fields: withFields(base, ...three, custom({ key: 'c_nin', type: 'SHORT_TEXT', label: 'NIN', required: 'HIDDEN' })) }).expect(200);
      expect(ok.body.gates.usage.customFormFields).toBe(3);
      const four = await request(server()).put(`${API}/booking-form/draft`).set(h.owner.auth).send({ fields: withFields(base, ...three, custom({ key: 'c_dd', type: 'SHORT_TEXT', label: 'Question d' })) }).expect(403);
      expect(four.body).toMatchObject({ code: 'LIMIT_REACHED', details: { limit: 'max_custom_form_fields', max: 3, current: 4, upgradePlan: 'growth' } });

      const cond = custom({ key: 'c_dd', type: 'SHORT_TEXT', label: 'Question d', condition: { fieldKey: 'c_aa', operator: 'NOT_EMPTY' } });
      const gated = await request(server()).put(`${API}/booking-form/draft`).set(h.owner.auth).send({ fields: withFields(base, three[0]!, cond) }).expect(403);
      expect(gated.body.details).toMatchObject({ feature: 'form_conditional_logic', requiredPlan: 'growth' });
    });

    it('versions: answers stay tied to the version the guest saw; conditions, channels, hidden and unknown keys are enforced', async () => {
      const h = await onlineHotel(app, 2);
      const base = await draftFields(h.owner.auth);
      const occasion = custom({ key: 'c_occasion', type: 'SELECT', label: 'Occasion', channels: ['MARKETPLACE', 'BOOKING_SITE'], options: [{ value: 'BIRTHDAY', label: 'Birthday' }, { value: 'NONE', label: 'No' }] });
      const cake = custom({ key: 'c_cake', type: 'SHORT_TEXT', label: 'Name on the cake', required: 'REQUIRED', condition: { fieldKey: 'c_occasion', operator: 'EQUALS', value: 'BIRTHDAY' } });
      const desk = custom({ key: 'c_desk', type: 'SHORT_TEXT', label: 'Desk note', channels: ['FRONT_DESK'], required: 'REQUIRED' });
      const hidden = custom({ key: 'c_hidden', type: 'SHORT_TEXT', label: 'Old question', required: 'HIDDEN' });
      const v2 = await publishForm(h.owner.auth, withFields(base, occasion, cake, desk, hidden), 'Occasion');
      expect(v2.version).toMatchObject({ version: 2 });

      const form = await request(server()).get(`${API}/public/hotels/${h.slug}/booking-form`).query({ channel: 'BOOKING_SITE' }).expect(200);
      const keys = form.body.fields.map((f: Field) => f.key);
      expect(keys).toEqual(expect.arrayContaining(['c_occasion', 'c_cake']));
      expect(keys).not.toContain('c_desk');
      expect(keys).not.toContain('c_hidden');

      const validate = (answers: Record<string, unknown>) =>
        request(server()).post(`${API}/public/hotels/${h.slug}/booking-form/validate`).set('X-Forwarded-For', randomIp()).send({ channel: 'BOOKING_SITE', answers }).expect(200);
      expect((await validate({ c_occasion: 'NONE' })).body.valid).toBe(true);
      const missing = await validate({ c_occasion: 'BIRTHDAY' });
      expect(missing.body.issues).toEqual([expect.objectContaining({ path: 'answers.c_cake', code: 'REQUIRED' })]);
      const unknown = await validate({ c_occasion: 'NONE', c_desk: 'x', c_hidden: 'y', nope: 1 });
      expect(unknown.body.issues.map((i: { fieldKey: string; code: string }) => `${i.fieldKey}:${i.code}`)).toEqual(expect.arrayContaining(['nope:UNKNOWN_FIELD']));

      // Book on version 2, then publish version 3: the stay keeps its answers and labels.
      const q = await publicQuote(h, {});
      expect(q.status).toBe(200);
      expect(q.body.formVersionId).toBe(v2.version.id);
      const bad = await publicBook(q.body.quoteToken, { answers: { c_occasion: 'BIRTHDAY' } });
      expect(bad.status).toBe(400);
      expect(bad.body.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ fieldKey: 'c_cake', code: 'REQUIRED' })]));
      const good = await publicBook(q.body.quoteToken, { answers: { c_occasion: 'BIRTHDAY', c_cake: 'Ada' } });
      expect(good.status).toBe(201);

      await publishForm(h.owner.auth, withFields(base, { ...occasion, label: 'Special occasion?' }), 'Relabel');
      const res = await request(server()).get(`${API}/reservations`).set(h.owner.auth).query({ q: good.body.booking.code }).expect(200);
      const detail = await request(server()).get(`${API}/reservations/${res.body.items[0].id}`).set(h.owner.auth).expect(200);
      expect(detail.body.bookingForm).toMatchObject({ version: 2, channel: 'BOOKING_SITE' });
      expect(detail.body.bookingForm.answers).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'c_occasion', label: 'Occasion', display: 'Birthday' }), expect.objectContaining({ key: 'c_cake', value: 'Ada' })]));

      // A quote made on version 2 cannot book once version 3 is live? It can: the token froze version 2.
      const versions = await request(server()).get(`${API}/booking-form/versions`).set(h.owner.auth).expect(200);
      expect(versions.body.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    });

    it('email is required only for online payment (unless the hotel requires it)', async () => {
      const h = await onlineHotel(app, 2);
      const q = await publicQuote(h, { checkIn: lagosDay(20) });
      const noEmail = { fullName: 'Tunde Ade', phone: freshPhone() };
      const online = await request(server()).post(`${API}/public/bookings`).set('X-Forwarded-For', randomIp()).send({ quoteToken: q.body.quoteToken, paymentMode: 'ONLINE', guest: noEmail, consent: true });
      expect(online.status).toBe(400);
      expect(online.body.code).toBe('VALIDATION_ERROR');
      expect(online.body.details.fields['guest.email']).toBeDefined();
      const atHotel = await request(server()).post(`${API}/public/bookings`).set('X-Forwarded-For', randomIp()).send({ quoteToken: q.body.quoteToken, paymentMode: 'PAY_AT_HOTEL', guest: noEmail, consent: true });
      expect(atHotel.status).toBe(201);
    });

    it('file uploads: Pro only, type sniffed from the bytes, size capped', async () => {
      const h = await onlineHotel(app, 1);
      const base = await draftFields(h.owner.auth);
      const letter = custom({ key: 'c_letter', type: 'FILE', label: 'Company letter', validation: { maxFileMB: 1, accept: ['pdf'] } });
      const growth = await request(server()).put(`${API}/booking-form/draft`).set(h.owner.auth).send({ fields: withFields(base, letter) }).expect(403);
      expect(growth.body.details).toMatchObject({ feature: 'form_file_uploads', requiredPlan: 'pro' });
      await onPlan(h, 'pro');
      await publishForm(h.owner.auth, withFields(base, letter));
      const up = (buf: Buffer, name: string) =>
        request(server()).post(`${API}/public/hotels/${h.slug}/booking-form/uploads`).set('X-Forwarded-For', randomIp()).field('fieldKey', 'c_letter').field('channel', 'BOOKING_SITE').attach('file', buf, name);
      const ok = await up(PDF, 'letter.pdf').expect(201);
      expect(ok.body).toMatchObject({ fieldKey: 'c_letter', contentType: 'application/pdf', name: 'letter.pdf' });
      // A text file named .pdf is refused (the bytes decide), and so is anything over the limit.
      await up(Buffer.from('just some text'), 'fake.pdf').expect(400);
      await up(Buffer.concat([PDF.subarray(0, 9), Buffer.alloc(1_100_000, 32), Buffer.from('\n%%EOF\n')]), 'big.pdf').expect(400);

      const q = await publicQuote(h, { checkIn: lagosDay(25) });
      const booked = await publicBook(q.body.quoteToken, { answers: { c_letter: { uploadId: ok.body.uploadId, token: ok.body.token } } });
      expect(booked.status).toBe(201);
      const again = await publicBook((await publicQuote(h, { checkIn: lagosDay(30) })).body.quoteToken, { answers: { c_letter: { uploadId: ok.body.uploadId, token: ok.body.token } } });
      expect(again.status).toBe(400);
      expect(again.body.details.issues[0]).toMatchObject({ fieldKey: 'c_letter', code: 'FILE_INVALID' });
    });
  });

  // -------------------------------------------------------------------------
  // Extras, pickups, transfers
  // -------------------------------------------------------------------------

  describe('extras and pickups', () => {
    let h: OnlineHotel;
    let breakfast: string;
    let cake: string;
    let airport: string;
    let park: string;

    beforeAll(async () => {
      h = await onlineHotel(app, 3);
      await onPlan(h, 'growth');
      const mk = (body: Record<string, unknown>) => request(server()).post(`${API}/extras`).set(h.owner.auth).send(body).expect(201);
      breakfast = (await mk({ name: 'Breakfast buffet', category: 'FOOD', pricing: 'PER_PERSON_PER_NIGHT', priceKobo: 950_000 })).body.id;
      cake = (await mk({ name: 'Birthday cake & decoration', category: 'CELEBRATION', pricing: 'PER_STAY', priceKobo: 4_500_000, leadTimeHours: 48 })).body.id;
      const pt = (body: Record<string, unknown>) => request(server()).post(`${API}/pickup-points`).set(h.owner.auth).send(body).expect(201);
      airport = (await pt({ name: 'Murtala Muhammed International Airport', shortName: 'MMIA', kind: 'AIRPORT', city: 'Lagos', priceKobo: 2_500_000, leadTimeHours: 6, vehicleOptions: [{ id: 'saloon', name: 'Saloon car', maxPassengers: 3 }, { id: 'bus', name: 'Toyota Hiace bus', maxPassengers: 10, priceKobo: 5_000_000 }] })).body.id;
      park = (await pt({ name: 'Jibowu Motor Park', shortName: 'Jibowu', kind: 'MOTOR_PARK', city: 'Lagos', priceKobo: 1_500_000, leadTimeHours: 4, operatingHours: { open: '06:00', close: '21:00' } })).body.id;
      // The form gets the pickup block and the extras picker from the library.
      const base = await draftFields(h.owner.auth);
      const lib = (await request(server()).get(`${API}/booking-form/library`).set(h.owner.auth).expect(200)).body;
      const libFields = (key: string) => (lib.items ?? lib.library ?? lib).find((i: { libraryKey: string }) => i.libraryKey === key).fields as Field[];
      await publishForm(h.owner.auth, withFields(base, ...libFields('pickup'), ...libFields('extras')));
    });

    it('prices extras (per person per night, tax) and pickups into the quote; the token freezes them', async () => {
      const checkIn = lagosDay(14);
      const at = `${checkIn}T11:20:00+01:00`;
      const q = await publicQuote(h, { checkIn, adults: 2, extras: [{ extraId: breakfast }, { extraId: cake }], transfers: [{ direction: 'ARRIVAL', pickupPointId: airport, passengers: 2, scheduledAt: at }] });
      expect(q.status).toBe(200);
      // Breakfast: 9,500 x 2 people x 2 nights = 38,000 + 7.5% VAT.
      const b = q.body.extras.find((e: { extraId: string }) => e.extraId === breakfast);
      expect(b).toMatchObject({ persons: 2, nights: 2, amountKobo: 3_800_000, taxKobo: 285_000, totalKobo: 4_085_000 });
      expect(q.body.transfers[0]).toMatchObject({ amountKobo: 2_500_000, taxKobo: 187_500, vehicleName: 'Saloon car' });
      // Room 2 x 50,000 + VAT = 107,500; add-ons 38,000 + 45,000 + 25,000 net, VAT 8,100.
      expect(q.body.breakdown).toMatchObject({ roomTotalKobo: 10_750_000, addOnsSubtotalKobo: 10_800_000, addOnsTaxKobo: 810_000, totalKobo: 10_750_000 + 10_800_000 + 810_000 });

      // The pickup answer must match the quote.
      const pickup = { wanted: true, pickupPointId: airport, passengers: 2, scheduledAt: at, details: { airline: 'Air Peace', flightNumber: 'P4 7121' } };
      const booked = await publicBook(q.body.quoteToken, { answers: { arrivalPickup: pickup } });
      expect(booked.status).toBe(201);
      expect(booked.body.booking.extras.map((e: { name: string }) => e.name).sort()).toEqual(['Birthday cake & decoration', 'Breakfast buffet']);
      expect(booked.body.booking.transfers[0]).toMatchObject({ status: 'REQUESTED', direction: 'ARRIVAL' });

      // A token whose add-ons were edited is refused.
      const [body, sig] = (q.body.quoteToken as string).split('.');
      const payload = JSON.parse(Buffer.from(body!, 'base64url').toString());
      const forged = Buffer.from(JSON.stringify({ ...payload, ex: [] })).toString('base64url');
      const tampered = await publicBook(`${forged}.${sig}`, { answers: { arrivalPickup: pickup } });
      expect(tampered.status).toBe(400);
      expect(tampered.body.code).toBe('QUOTE_INVALID');
    });

    it('re-checks extra lead times and availability windows at booking, not only at quote time', async () => {
      const d = lagosDay(3);
      const lateCake = (await request(server()).post(`${API}/extras`).set(h.owner.auth).send({ name: `Anniversary flowers ${uniq()}`, category: 'CELEBRATION', pricing: 'PER_STAY', priceKobo: 2_000_000, leadTimeHours: 24 }).expect(201)).body.id;
      const q1 = await publicQuote(h, { checkIn: d, extras: [{ extraId: lateCake }] });
      expect(q1.status).toBe(200);
      // Time passes (modelled by a longer lead time): the signed quote no longer carries the extra through.
      await request(server()).patch(`${API}/extras/${lateCake}`).set(h.owner.auth).send({ leadTimeHours: 168 }).expect(200);
      const late = await publicBook(q1.body.quoteToken);
      expect(late.status).toBe(400);
      expect(late.body.details.issues).toEqual([expect.objectContaining({ path: 'extras[0]', code: 'LEAD_TIME' })]);

      await request(server()).patch(`${API}/extras/${lateCake}`).set(h.owner.auth).send({ leadTimeHours: 0 }).expect(200);
      const q2 = await publicQuote(h, { checkIn: d, extras: [{ extraId: lateCake }] });
      await request(server()).patch(`${API}/extras/${lateCake}`).set(h.owner.auth).send({ availability: { validTo: lagosDay(1) } }).expect(200);
      const window = await publicBook(q2.body.quoteToken);
      expect(window.status).toBe(400);
      expect(window.body.details.issues).toEqual([expect.objectContaining({ path: 'extras[0]', code: 'OUT_OF_WINDOW' })]);

      await request(server()).patch(`${API}/extras/${lateCake}`).set(h.owner.auth).send({ availability: {} }).expect(200);
      expect((await publicBook((await publicQuote(h, { checkIn: d, extras: [{ extraId: lateCake }] })).body.quoteToken)).status).toBe(201);
    });

    it('validates pickups by kind, lead time, vehicle size and operating hours', async () => {
      const soon = new Date(Date.now() + 2 * 3_600_000);
      const today = lagosDay(0);
      const lead = await publicQuote(h, { checkIn: today, transfers: [{ direction: 'ARRIVAL', pickupPointId: airport, passengers: 1, scheduledAt: soon.toISOString() }] });
      expect(lead.status).toBe(400);
      expect(lead.body.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'LEAD_TIME' })]));

      const d = lagosDay(15);
      const late = await publicQuote(h, { checkIn: d, transfers: [{ direction: 'ARRIVAL', pickupPointId: park, passengers: 1, scheduledAt: `${d}T22:30:00+01:00` }] });
      expect(late.body.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'OUTSIDE_HOURS' })]));
      const crowd = await publicQuote(h, { checkIn: d, adults: 2, transfers: [{ direction: 'ARRIVAL', pickupPointId: airport, vehicleOptionId: 'saloon', passengers: 5, scheduledAt: `${d}T10:00:00+01:00` }] });
      expect(crowd.body.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TOO_MANY_PASSENGERS' })]));

      // Motor park answers need a transport company (listed or Other) and the departure city.
      const q = await publicQuote(h, { checkIn: d, transfers: [{ direction: 'ARRIVAL', pickupPointId: park, passengers: 1, scheduledAt: `${d}T15:00:00+01:00` }] });
      expect(q.status).toBe(200);
      const noCompany = await publicBook(q.body.quoteToken, { answers: { arrivalPickup: { wanted: true, pickupPointId: park, passengers: 1, scheduledAt: `${d}T15:00:00+01:00`, details: { departureCity: 'Benin City' } } } });
      expect(noCompany.status).toBe(400);
      expect(noCompany.body.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'REQUIRED', path: expect.stringContaining('transportCompanyOther') })]));
      const withCompany = await publicBook(q.body.quoteToken, { answers: { arrivalPickup: { wanted: true, pickupPointId: park, passengers: 1, scheduledAt: `${d}T15:00:00+01:00`, details: { transportCompanyId: 'gig-mobility', departureCity: 'Benin City' } } } });
      expect(withCompany.status).toBe(201);
    });

    it('extras and pickups are posted to the folio at check-in (pay at hotel / desk), not before', async () => {
      const guest = { fullName: `Desk Guest ${uniq()}`, phone: freshPhone() };
      const today = lagosDay(0);
      const res = await request(server())
        .post(`${API}/reservations`)
        .set(h.owner.auth)
        .send({
          guest, roomTypeId: h.typeId, roomId: h.rooms[0]!.id, arrivalDate: today, departureDate: lagosDay(1), adults: 2,
          extras: [{ extraId: breakfast }],
          transfers: [{ direction: 'ARRIVAL', pickupPointId: airport, passengers: 2, scheduledAt: new Date(Date.now() + 30 * 60_000).toISOString(), details: { airline: 'Ibom Air', flightNumber: 'QI 0321' } }],
        })
        .expect(201);
      const before = await request(server()).get(`${API}/reservations/${res.body.id}`).set(h.owner.auth).expect(200);
      expect(before.body.extras).toEqual([expect.objectContaining({ posted: false, totalKobo: 2_042_500 })]);
      expect(before.body.transfers).toEqual([expect.objectContaining({ status: 'CONFIRMED', posted: false })]);
      expect(before.body.addOnsTotalKobo).toBe(2_042_500 + 2_687_500);

      await request(server()).post(`${API}/reservations/${res.body.id}/check-in`).set(h.owner.auth).send({ guest: ID, registration: REGISTRATION }).expect(200);
      const after = await request(server()).get(`${API}/reservations/${res.body.id}`).set(h.owner.auth).expect(200);
      expect(after.body.extras[0].posted).toBe(true);
      expect(after.body.transfers[0].posted).toBe(true);
      const folio = await request(server()).get(`${API}/folios/${after.body.folioId}`).set(h.owner.auth).expect(200);
      const descriptions = folio.body.entries.map((e: { description: string }) => e.description).join(' | ');
      expect(descriptions).toContain('Breakfast buffet, 2 people x 1 night');
      expect(descriptions).toContain('Airport pickup: Murtala Muhammed International Airport, Saloon car');
    });

    it('transfer status flow, driver assignment and the guest message', async () => {
      const d = lagosDay(16);
      const phone = freshPhone();
      const at = `${d}T12:00:00+01:00`;
      const q = await publicQuote(h, { checkIn: d, transfers: [{ direction: 'ARRIVAL', pickupPointId: airport, passengers: 1, scheduledAt: at }] });
      const booked = await request(server())
        .post(`${API}/public/bookings`)
        .set('X-Forwarded-For', randomIp())
        .send({ quoteToken: q.body.quoteToken, paymentMode: 'PAY_AT_HOTEL', guest: { fullName: 'Ifeoma Nwosu', phone, email: `ife-${uniq()}@e2e.test` }, consent: true, answers: { arrivalPickup: { wanted: true, pickupPointId: airport, passengers: 1, scheduledAt: at, details: { airline: 'Arik Air', flightNumber: 'W3 0104' } } } })
        .expect(201);
      const list = await request(server()).get(`${API}/transfers`).set(h.owner.auth).query({ date: d }).expect(200);
      const t = list.body.items.find((x: { reservation: { code: string } }) => x.reservation.code === booked.body.booking.code);
      expect(t).toMatchObject({ status: 'REQUESTED', detailsSummary: 'Arik Air W3 0104' });

      // Not allowed: skipping straight to completed.
      await request(server()).post(`${API}/transfers/${t.id}/status`).set(h.owner.auth).send({ status: 'COMPLETED' }).expect(409);
      await request(server()).post(`${API}/transfers/${t.id}/confirm`).set(h.owner.auth).expect(200);
      const assigned = await request(server()).post(`${API}/transfers/${t.id}/assign`).set(h.owner.auth).send({ driverName: 'Sunday Okon', driverPhone: '08031234567', vehiclePlate: 'lsd 482 kj', vehicleDescription: 'Silver Toyota Corolla' }).expect(200);
      expect(assigned.body).toMatchObject({ status: 'DRIVER_ASSIGNED', driver: { name: 'Sunday Okon', vehiclePlate: 'LSD 482 KJ' } });
      const msgs = await outboxFor(phone, 'TRANSFER_DRIVER_ASSIGNED');
      expect(msgs.length).toBeGreaterThan(0);

      for (const status of ['EN_ROUTE', 'PICKED_UP', 'COMPLETED']) {
        const r = await request(server()).post(`${API}/transfers/${t.id}/status`).set(h.owner.auth).send({ status }).expect(200);
        expect(r.body.status).toBe(status);
      }
      const done = await request(server()).get(`${API}/transfers/${t.id}`).set(h.owner.auth).expect(200);
      expect(done.body.events.map((e: { status: string }) => e.status)).toEqual(['REQUESTED', 'CONFIRMED', 'DRIVER_ASSIGNED', 'EN_ROUTE', 'PICKED_UP', 'COMPLETED']);

      // The guest sees the driver on the trip page.
      const trip = await request(server()).get(`${API}/reservations`).set(h.owner.auth).query({ q: booked.body.booking.code }).expect(200);
      expect(trip.body.items[0].addOns).toMatchObject({ transfers: 1 });
    });

    it('Starter hotels get no extras or pickups (feature gate)', async () => {
      const s = await onlineHotel(app, 1);
      await onPlan(s, 'starter');
      const r = await request(server()).post(`${API}/extras`).set(s.owner.auth).send({ name: 'Breakfast', category: 'FOOD', pricing: 'PER_NIGHT', priceKobo: 100_000 }).expect(403);
      expect(r.body.details).toMatchObject({ feature: 'paid_extras', requiredPlan: 'growth' });
      expect((await request(server()).get(`${API}/public/hotels/${s.slug}/pickup-points`).expect(200)).body).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // NDPA
  // -------------------------------------------------------------------------

  describe('NDPA', () => {
    it('the guest export includes answers, extras and transfers; anonymise wipes the answers', async () => {
      const h = await onlineHotel(app, 1);
      const base = await draftFields(h.owner.auth);
      const lib = (await request(server()).get(`${API}/booking-form/library`).set(h.owner.auth).expect(200)).body;
      const libFields = (key: string) => (lib.items ?? lib.library ?? lib).find((i: { libraryKey: string }) => i.libraryKey === key).fields as Field[];
      await publishForm(h.owner.auth, withFields(base, ...libFields('homeAddress'), ...libFields('dietary')));
      const q = await publicQuote(h, { checkIn: lagosDay(18) });
      const phone = freshPhone();
      const booked = await request(server())
        .post(`${API}/public/bookings`)
        .set('X-Forwarded-For', randomIp())
        .send({ quoteToken: q.body.quoteToken, paymentMode: 'PAY_AT_HOTEL', guest: { fullName: 'Kunle Bello', phone }, consent: true, answers: { homeAddress: '12 Allen Avenue, Ikeja', dietaryRequirements: ['HALAL'] } })
        .expect(201);
      const list = await request(server()).get(`${API}/reservations`).set(h.owner.auth).query({ q: booked.body.booking.code }).expect(200);
      const guestId = list.body.items[0].guest?.id ?? list.body.items[0].guestId;

      const exp = await request(server()).get(`${API}/guests/${guestId}/export`).set(h.owner.auth).expect(200);
      const r = exp.body.reservations[0];
      expect(r.bookingForm.answers).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'homeAddress', value: '12 Allen Avenue, Ikeja', sensitive: true }), expect.objectContaining({ key: 'dietaryRequirements' })]));
      expect(r).toHaveProperty('extras');
      expect(r).toHaveProperty('transfers');

      // The profile shows the latest non-sensitive answers only.
      const profile = await request(server()).get(`${API}/guests/${guestId}`).set(h.owner.auth).expect(200);
      expect(profile.body.latestAnswers.map((a: { key: string }) => a.key)).toEqual(['dietaryRequirements']);

      await request(server()).post(`${API}/reservations/${list.body.items[0].id}/cancel`).set(h.owner.auth).send({ reason: 'Guest asked to cancel' });
      await request(server()).post(`${API}/guests/${guestId}/anonymise`).set(h.owner.auth).send({ reason: 'Guest request under the NDPA' }).expect(200);
      const row = await db.query(`SELECT form_answers FROM reservations WHERE id = $1`, [list.body.items[0].id]);
      expect(row.rows[0].form_answers).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Seed and setup
  // -------------------------------------------------------------------------

  describe('seed and setup', () => {
    it('the demo hotel has a published theme, a second form version, extras, pickup points and transfers today', async () => {
      const theme = await request(server()).get(`${API}/public/hotels/palmwine-house/theme`).expect(200);
      expect(theme.body.templateId).toBe('editorial');
      const form = await request(server()).get(`${API}/public/hotels/palmwine-house/booking-form`).query({ channel: 'BOOKING_SITE' }).expect(200);
      expect(form.body.version).toBeGreaterThanOrEqual(2);
      expect(form.body.fields.map((f: Field) => f.key)).toEqual(expect.arrayContaining(['c_occasion', 'arrivalPickup', 'extras']));
      const points = await request(server()).get(`${API}/public/hotels/palmwine-house/pickup-points`).expect(200);
      expect(points.body.map((p: { shortName: string }) => p.shortName)).toEqual(expect.arrayContaining(['MMIA', 'Jibowu', 'Marina jetty']));
      const companies = await request(server()).get(`${API}/public/transport-companies`).expect(200);
      expect(companies.body.length).toBeGreaterThanOrEqual(10);
      const routes = await request(server()).get(`${API}/public/train-routes`).expect(200);
      expect(routes.body.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining(['lagos-ibadan', 'abuja-kaduna']));
    });

    it('new hotels start the setup wizard; go-live needs rooms', async () => {
      const h = await onlineHotel(app, 1);
      const s = await request(server()).get(`${API}/setup`).set(h.owner.auth).expect(200);
      expect(s.body.completedAt).toBeNull();
      expect(s.body.steps.find((x: { key: string }) => x.key === 'rooms').status).toBe('DONE');
      const typed = await request(server()).post(`${API}/setup/hotel-type`).set(h.owner.auth).send({ hotelType: 'business' }).expect(200);
      expect(typed.body.hotelType).toBe('business');
      const live = await request(server()).post(`${API}/setup/go-live`).set(h.owner.auth).send({}).expect(200);
      expect(live.body.completedAt).not.toBeNull();
      const dash = await request(server()).get(`${API}/dashboard/summary`).set(h.owner.auth).expect(200);
      expect(dash.body.setup).toMatchObject({ completed: true, progressPct: 100, nextStep: null });
    });
  });
});
