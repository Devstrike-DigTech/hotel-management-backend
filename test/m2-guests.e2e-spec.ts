import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { API, createApp, ownerClient } from './helpers.js';
import { guestInput, lagosDay, REGISTRATION, setupHotel, type Hotel } from './m2-helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

describe('Guests: encryption at rest, register, NDPA export and anonymisation', () => {
  let app: INestApplication;
  let h: Hotel;
  let guestId: string;
  let reservationId: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createApp();
    h = await setupHotel(app, 2);
  });

  afterAll(async () => {
    await app.close();
  });

  it('normalises phones, dedupes by phone and masks the ID number', async () => {
    const res = await request(server())
      .post(`${API}/guests`)
      .set(h.desk)
      .send({ fullName: 'Adaeze Nwankwo', phone: '0803 555 7777', idType: 'NIN', idNumber: '98765434821', address: '4 Ogui Road, Enugu', consent: true })
      .expect(201);
    guestId = res.body.id;
    expect(res.body).toMatchObject({ phone: '+2348035557777', idNumberMasked: '••••••4821', nationality: 'Nigerian' });
    expect(res.body.consentAt).not.toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('98765434821');
    const dup = await request(server()).post(`${API}/guests`).set(h.desk).send({ fullName: 'Someone Else', phone: '+234 803 555 7777' }).expect(409);
    expect(dup.body).toMatchObject({ code: 'GUEST_EXISTS', details: { guestId } });
    const found = await request(server()).get(`${API}/guests/lookup`).query({ phone: '08035557777' }).set(h.desk).expect(200);
    expect(found.body.id).toBe(guestId);
  });

  it('stores the ID number encrypted (AES-256-GCM), never in clear', async () => {
    const owner = ownerClient();
    await owner.connect();
    try {
      const { rows } = await owner.query('SELECT id_number_enc, id_number_last4 FROM guests WHERE id = $1', [guestId]);
      expect(rows[0].id_number_enc).toMatch(/^v1:/);
      expect(rows[0].id_number_enc).not.toContain('98765434821');
      expect(rows[0].id_number_last4).toBe('4821');
    } finally {
      await owner.end();
    }
    const reveal = await request(server()).get(`${API}/guests/${guestId}/id-document`).set(h.desk).expect(200);
    expect(reveal.body.idNumber).toBe('98765434821');
    const audit = await request(server()).get(`${API}/audit-logs`).set(h.owner.auth).expect(200);
    expect(audit.body.items.some((i: { action: string }) => i.action === 'guest.id_revealed')).toBe(true);
  });

  it('uploads an ID image and serves it through a short-lived signed URL', async () => {
    const up = await request(server()).post(`${API}/guests/${guestId}/id-image`).set(h.desk).attach('file', PNG, { filename: 'id.png', contentType: 'image/png' }).expect(200);
    expect(up.body.hasIdImage).toBe(true);
    const path = new URL(up.body.idImageUrl).pathname;
    const file = await request(server()).get(path).expect(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(file.body as Buffer, PNG)).toBe(0);
    await request(server()).get(`${path}x`).expect(404);
    const fake = await request(server()).post(`${API}/guests/${guestId}/id-image`).set(h.desk).attach('file', Buffer.from('not an image'), { filename: 'x.png', contentType: 'image/png' }).expect(400);
    expect(fake.body.code).toBe('VALIDATION_ERROR');
  });

  it('writes the guest register and exports it as CSV', async () => {
    const res = await request(server())
      .post(`${API}/reservations`)
      .set(h.desk)
      .send({ guestId, roomTypeId: h.typeId, roomId: h.rooms[0].id, arrivalDate: lagosDay(0), departureDate: lagosDay(1) })
      .expect(201);
    reservationId = res.body.id;
    await request(server())
      .post(`${API}/reservations/${reservationId}/check-in`)
      .set(h.desk)
      .send({ registration: { ...REGISTRATION, vehiclePlate: 'lnd-123aa' } })
      .expect(200);
    const json = await request(server()).get(`${API}/guest-register`).query({ from: lagosDay(0), to: lagosDay(0) }).set(h.desk).expect(200);
    expect(json.body.items[0]).toMatchObject({ guestName: 'Adaeze Nwankwo', idNumber: '••••••4821', arrivingFrom: 'Abuja', purpose: 'BUSINESS', roomNumber: '101' });
    const csv = await request(server()).get(`${API}/guest-register`).query({ from: lagosDay(0), to: lagosDay(0), format: 'csv' }).set(h.desk).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\r\n')[0]).toContain('checkedInAt,checkedOutAt,roomNumber');
    expect(csv.text).toContain('Adaeze Nwankwo');
    await request(server()).get(`${API}/guest-register`).query({ from: lagosDay(0), to: lagosDay(0), includeIdNumbers: 'true' }).set(h.desk).expect(403);
    const full = await request(server()).get(`${API}/guest-register`).query({ from: lagosDay(0), to: lagosDay(0), includeIdNumbers: 'true' }).set(h.manager).expect(200);
    expect(full.body.items[0].idNumber).toBe('98765434821');
  });

  it('exports all personal data (NDPA) for managers only', async () => {
    await request(server()).get(`${API}/guests/${guestId}/export`).set(h.desk).expect(403);
    const exp = await request(server()).get(`${API}/guests/${guestId}/export`).set(h.manager).expect(200);
    expect(exp.body.guest).toMatchObject({ fullName: 'Adaeze Nwankwo', idNumber: '98765434821' });
    expect(exp.body.reservations[0].registration.arrivingFrom).toBe('Abuja');
    expect(exp.body.folios[0].entries.length).toBeGreaterThan(0);
  });

  it('anonymises on request: personal data wiped, financial records kept', async () => {
    const early = await request(server()).post(`${API}/guests/${guestId}/anonymise`).set(h.manager).send({ reason: 'Subject request' }).expect(409);
    expect(early.body.code).toBe('CONFLICT');
    await request(server()).post(`${API}/folios/${(await request(server()).get(`${API}/reservations/${reservationId}`).set(h.manager)).body.folioId}/payments`).set(h.manager).send({ method: 'COMPLIMENTARY', amountKobo: 5_375_000 }).expect(201);
    await request(server()).post(`${API}/reservations/${reservationId}/check-out`).set(h.manager).send({}).expect(200);

    const anon = await request(server()).post(`${API}/guests/${guestId}/anonymise`).set(h.manager).send({ reason: 'Subject request by email, ref NDPA-0042' }).expect(200);
    expect(anon.body).toMatchObject({ fullName: 'Anonymised guest', phone: null, email: null, idType: null, idNumberMasked: null, hasIdImage: false, address: null });
    expect(anon.body.anonymisedAt).not.toBeNull();

    const owner = ownerClient();
    await owner.connect();
    try {
      const g = await owner.query('SELECT full_name, phone, id_number_enc, id_image_key FROM guests WHERE id = $1', [guestId]);
      expect(g.rows[0]).toEqual({ full_name: 'Anonymised guest', phone: null, id_number_enc: null, id_image_key: null });
      const r = await owner.query('SELECT reg_arriving_from, reg_vehicle_plate, status FROM reservations WHERE id = $1', [reservationId]);
      expect(r.rows[0]).toEqual({ reg_arriving_from: null, reg_vehicle_plate: null, status: 'CHECKED_OUT' });
      const money = await owner.query(
        `SELECT count(*)::int AS n, sum(e.amount_kobo)::bigint AS s FROM folio_entries e JOIN folios f ON f.id = e.folio_id WHERE f.reservation_id = $1`,
        [reservationId],
      );
      expect(money.rows[0].n).toBeGreaterThan(0);
      expect(Number(money.rows[0].s)).toBe(0);
      const inv = await owner.query(`SELECT count(*)::int AS n FROM guest_invoices i JOIN folios f ON f.id = i.folio_id WHERE f.reservation_id = $1`, [reservationId]);
      expect(inv.rows[0].n).toBe(1);
    } finally {
      await owner.end();
    }
    const audit = await request(server()).get(`${API}/audit-logs`).set(h.owner.auth).expect(200);
    expect(audit.body.items.some((i: { action: string }) => i.action === 'guest.anonymised')).toBe(true);
    const again = await request(server()).patch(`${API}/guests/${guestId}`).set(h.manager).send({ fullName: 'Back Again' }).expect(409);
    expect(again.body.code).toBe('GUEST_ANONYMISED');
  });

  it('a housekeeper may only turn a dirty room clean', async () => {
    const hk = await import('./m2-helpers.js').then((m) => m.addStaff(app, h.owner.auth, 'HOUSEKEEPING'));
    const room = h.rooms[0].id; // dirty after the check-out above
    await request(server()).patch(`${API}/rooms/${room}/status`).set(hk.auth).send({ status: 'OCCUPIED' }).expect(403);
    const ok = await request(server()).patch(`${API}/rooms/${room}/status`).set(hk.auth).send({ status: 'VACANT_CLEAN' }).expect(200);
    expect(ok.body.status).toBe('VACANT_CLEAN');
    await request(server()).patch(`${API}/rooms/${room}/status`).set(hk.auth).send({ status: 'VACANT_DIRTY' }).expect(403);
  });

  it('flags a room set to occupied with nobody checked in, and an occupied room flipped to dirty', async () => {
    const room = h.rooms[1].id;
    await request(server()).patch(`${API}/rooms/${room}/status`).set(h.desk).send({ status: 'OCCUPIED' }).expect(200);
    await request(server()).patch(`${API}/rooms/${room}/status`).set(h.desk).send({ status: 'VACANT_DIRTY' }).expect(200);
    const flags = await request(server()).get(`${API}/guard/flags`).set(h.owner.auth).expect(200);
    const rules = flags.body.items.filter((f: { room: { id: string } }) => f.room?.id === room).map((f: { rule: string }) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(['OCCUPIED_WITHOUT_STAY', 'ROOM_STATUS_FLIP']));
  });

  it('guest phone input must be valid', async () => {
    const res = await request(server()).post(`${API}/guests`).set(h.desk).send(guestInput({ phone: '12345' })).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
