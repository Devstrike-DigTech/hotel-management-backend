import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { API, appRoleClient, createApp, ownerClient, setSignedTenant } from './helpers.js';
import { checkedInStay, openShift, setupHotel, type Hotel } from './m2-helpers.js';

describe('Folios, payments, shifts, voids, invoices and idempotency', () => {
  let app: INestApplication;
  let h: Hotel;
  let stay: { id: string; folioId: string };
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createApp();
    h = await setupHotel(app, 4);
    stay = await checkedInStay(app, h.desk, h, h.rooms[0].id, 2);
  });

  afterAll(async () => {
    await app.close();
  });

  const folio = async (id = stay.folioId) => (await request(server()).get(`${API}/folios/${id}`).set(h.owner.auth).expect(200)).body;

  it('posts the room charge with a separate VAT line', async () => {
    const f = await folio();
    const room = f.entries.find((e: { type: string }) => e.type === 'ROOM');
    const vat = f.entries.find((e: { type: string }) => e.type === 'TAX');
    expect(room.amountKobo).toBe(5_000_000);
    expect(vat).toMatchObject({ taxCode: 'VAT', rateBps: 750, amountKobo: 375_000, parentEntryId: room.id });
    expect(f.totals.balanceKobo).toBe(5_375_000);
  });

  it('refuses cash, transfer and POS payments without an open shift', async () => {
    for (const method of ['CASH', 'TRANSFER', 'POS']) {
      const res = await request(server()).post(`${API}/folios/${stay.folioId}/payments`).set(h.desk).send({ method, amountKobo: 1000 }).expect(409);
      expect(res.body.code).toBe('SHIFT_REQUIRED');
    }
  });

  it('takes payments inside a shift and issues numbered receipts', async () => {
    await openShift(app, h.desk, 2_000_000);
    const again = await request(server()).post(`${API}/shifts/open`).set(h.desk).send({ openingFloatKobo: 0 }).expect(409);
    expect(again.body.code).toBe('SHIFT_ALREADY_OPEN');
    const res = await request(server()).post(`${API}/folios/${stay.folioId}/payments`).set(h.desk).send({ method: 'CASH', amountKobo: 3_000_000 }).expect(201);
    expect(res.body.receipt.number).toMatch(/^RCT-\d{4}-000001$/);
    expect(res.body.receipt.amountInWords).toBe('Thirty thousand naira only');
    expect(res.body.folio.totals.balanceKobo).toBe(2_375_000);
  });

  it('replays an Idempotency-Key request without paying twice', async () => {
    const key = `offline-${Date.now()}`;
    const send = (body: Record<string, unknown>) =>
      request(server()).post(`${API}/folios/${stay.folioId}/payments`).set(h.desk).set('Idempotency-Key', key).send(body);
    const first = await send({ method: 'POS', amountKobo: 375_000, reference: 'POS-1' }).expect(201);
    const second = await send({ reference: 'POS-1', amountKobo: 375_000, method: 'POS' }).expect(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    const f = await folio();
    expect(f.entries.filter((e: { paymentRef: string }) => e.paymentRef === 'POS-1')).toHaveLength(1);
    const conflict = await send({ method: 'POS', amountKobo: 999, reference: 'POS-1' }).expect(422);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('releases the key when the request fails, so a retry can succeed', async () => {
    const other = await checkedInStay(app, h.owner.auth, h, h.rooms[1].id);
    const key = `retry-${Date.now()}`;
    const send = () => request(server()).post(`${API}/folios/${other.folioId}/payments`).set(h.manager).set('Idempotency-Key', key).send({ method: 'CASH', amountKobo: 100_000 });
    expect((await send().expect(409)).body.code).toBe('SHIFT_REQUIRED');
    await openShift(app, h.manager);
    await send().expect(201);
  });

  it('keeps the shift blind until the count is in, then flags a variance beyond ₦500', async () => {
    const cur = await request(server()).get(`${API}/shifts/current`).set(h.desk).expect(200);
    expect(cur.body.blind).toBe(true);
    expect(cur.body.expectedCashKobo).toBeNull();
    const asDesk = await request(server()).get(`${API}/shifts/${cur.body.id}`).set(h.desk).expect(200);
    expect(asDesk.body.payments).toBeNull();
    // Expected cash: 20,000 float + 30,000 cash. Count ₦1,000 short.
    const closed = await request(server())
      .post(`${API}/shifts/${cur.body.id}/close`)
      .set(h.desk)
      .send({ countedCashKobo: 4_900_000, declaredPosKobo: 375_000, declaredTransferKobo: 0, denominations: { '1000': 49 } })
      .expect(200);
    expect(closed.body).toMatchObject({
      status: 'CLOSED',
      blind: false,
      expectedCashKobo: 5_000_000,
      expectedPosKobo: 375_000,
      varianceCashKobo: -100_000,
      variancePosKobo: 0,
    });
    const flags = await request(server()).get(`${API}/guard/flags`).query({ rule: 'SHIFT_VARIANCE' }).set(h.owner.auth).expect(200);
    const flag = flags.body.items.find((f: { shiftId: string }) => f.shiftId === cur.body.id);
    expect(flag).toMatchObject({ severity: 'MEDIUM', status: 'OPEN', amountKobo: 100_000 });
    // Manager approves; a manager cannot approve their own shift.
    await request(server()).post(`${API}/shifts/${cur.body.id}/approve`).set(h.manager).send({ notes: 'Explained' }).expect(200);
  });

  it('voiding a payment posts a VOID entry and raises VOIDED_PAYMENT', async () => {
    await openShift(app, h.desk);
    const pay = await request(server()).post(`${API}/folios/${stay.folioId}/payments`).set(h.desk).send({ method: 'TRANSFER', amountKobo: 500_000, reference: 'TRF-DUP' }).expect(201);
    const entry = pay.body.folio.entries.find((e: { paymentRef: string }) => e.paymentRef === 'TRF-DUP');
    await request(server()).post(`${API}/folios/${stay.folioId}/entries/${entry.id}/void`).set(h.desk).send({ reason: 'Duplicate' }).expect(403);
    const voided = await request(server()).post(`${API}/folios/${stay.folioId}/entries/${entry.id}/void`).set(h.manager).send({ reason: 'Duplicate transfer' }).expect(200);
    const original = voided.body.entries.find((e: { id: string }) => e.id === entry.id);
    expect(original).toMatchObject({ voided: true, voidReason: 'Duplicate transfer' });
    expect(voided.body.entries.find((e: { refEntryId: string }) => e.refEntryId === entry.id).amountKobo).toBe(500_000);
    const again = await request(server()).post(`${API}/folios/${stay.folioId}/entries/${entry.id}/void`).set(h.manager).send({ reason: 'x again' }).expect(409);
    expect(again.body.code).toBe('ALREADY_VOIDED');
    const flags = await request(server()).get(`${API}/guard/flags`).query({ rule: 'VOIDED_PAYMENT' }).set(h.owner.auth).expect(200);
    expect(flags.body.items[0]).toMatchObject({ rule: 'VOIDED_PAYMENT', amountKobo: 500_000, status: 'OPEN' });
  });

  it('folio entries are immutable in the database, for every role', async () => {
    const owner = ownerClient();
    await owner.connect();
    try {
      await expect(owner.query(`UPDATE folio_entries SET amount_kobo = 1 WHERE folio_id = $1`, [stay.folioId])).rejects.toThrow(/append-only/);
      await expect(owner.query(`DELETE FROM folio_entries WHERE folio_id = $1`, [stay.folioId])).rejects.toThrow(/append-only/);
    } finally {
      await owner.end();
    }
    const c = appRoleClient();
    await c.connect();
    try {
      await c.query('BEGIN');
      await setSignedTenant(c, h.owner.tenantId);
      await expect(c.query(`DELETE FROM folio_entries WHERE folio_id = $1`, [stay.folioId])).rejects.toThrow(/permission denied|append-only/);
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
  });

  it('discounts above the threshold need a manager PIN (second key)', async () => {
    await request(server()).put(`${API}/me/approval-pin`).set(h.manager).send({ pin: '4826', currentPassword: 'Passw0rd!x' }).expect(200);
    const approvers = await request(server()).get(`${API}/staff/approvers`).set(h.desk).expect(200);
    expect(approvers.body.map((a: { id: string }) => a.id)).toContain(h.managerId);
    const url = `${API}/folios/${stay.folioId}/discounts`;
    const small = await request(server()).post(url).set(h.desk).send({ mode: 'PERCENT', value: 500, reason: 'Loyal guest' }).expect(200);
    expect(small.body.totals.discountsKobo).toBe(250_000);
    const need = await request(server()).post(url).set(h.desk).send({ mode: 'PERCENT', value: 2000, reason: 'Complaint' }).expect(403);
    expect(need.body.code).toBe('APPROVAL_REQUIRED');
    expect(need.body.details).toMatchObject({ thresholdBps: 1000, discountBps: 2000 });
    const wrong = await request(server()).post(url).set(h.desk).send({ mode: 'PERCENT', value: 2000, reason: 'Complaint', approval: { approverId: h.managerId, pin: '1111' } }).expect(403);
    expect(wrong.body.code).toBe('APPROVAL_INVALID');
    expect(wrong.body.details.attemptsLeft).toBe(4);
    const ok = await request(server()).post(url).set(h.desk).send({ mode: 'PERCENT', value: 2000, reason: 'Complaint', approval: { approverId: h.managerId, pin: '4826' } }).expect(200);
    const d = ok.body.entries.filter((e: { type: string }) => e.type === 'DISCOUNT').pop();
    expect(d.approvedBy.id).toBe(h.managerId);
    // The discount carries a matching negative VAT line.
    const dTax = ok.body.entries.find((e: { parentEntryId: string; type: string }) => e.parentEntryId === d.id && e.type === 'TAX');
    expect(dTax.amountKobo).toBe(Math.round(d.amountKobo * 0.075));
  });

  it('issues gapless invoice numbers under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => request(server()).post(`${API}/folios/${stay.folioId}/invoices`).set(h.owner.auth).send({ kind: 'PROFORMA' })),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const seqs = results.map((r) => Number(r.body.number.slice(-6))).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  });

  it('receipt numbers stay gapless when payments race across folios', async () => {
    await request(server()).post(`${API}/shifts/open`).set(h.owner.auth).send({ openingFloatKobo: 0 }).expect(201);
    const before = await request(server()).get(`${API}/receipts`).query({ pageSize: 100 }).set(h.owner.auth).expect(200);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => request(server()).post(`${API}/folios/${stay.folioId}/payments`).set(h.owner.auth).send({ method: 'CASH', amountKobo: 1000 + i })),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const after = await request(server()).get(`${API}/receipts`).query({ pageSize: 100 }).set(h.owner.auth).expect(200);
    const nums = after.body.items.map((r: { number: string }) => Number(r.number.slice(-6))).sort((a: number, b: number) => a - b);
    expect(nums).toEqual(Array.from({ length: before.body.total + 8 }, (_, i) => i + 1));
  });

  it('check-out needs a zero balance; a manager can move the balance to the city ledger (flagged)', async () => {
    const f = await folio();
    expect(f.totals.balanceKobo).toBeGreaterThan(0);
    const refused = await request(server()).post(`${API}/reservations/${stay.id}/check-out`).set(h.desk).send({}).expect(409);
    expect(refused.body).toMatchObject({ code: 'BALANCE_OUTSTANDING', details: { balanceKobo: f.totals.balanceKobo } });
    await request(server()).post(`${API}/reservations/${stay.id}/check-out`).set(h.desk).send({ override: { reason: 'Front desk tries' } }).expect(403);
    const out = await request(server()).post(`${API}/reservations/${stay.id}/check-out`).set(h.manager).send({ override: { reason: 'Company will settle by invoice' } }).expect(200);
    expect(out.body.reservation.status).toBe('CHECKED_OUT');
    expect(out.body.reservation.room.status).toBe('VACANT_DIRTY');
    expect(out.body.invoice).toMatchObject({ kind: 'FINAL', number: expect.stringMatching(/^INV-\d{4}-000001$/) });
    expect(out.body.invoice.totals.balanceKobo).toBe(0);
    const flags = await request(server()).get(`${API}/guard/flags`).query({ rule: 'CHECKOUT_WITH_BALANCE' }).set(h.owner.auth).expect(200);
    expect(flags.body.total).toBe(1);
    const tasks = await request(server()).get(`${API}/housekeeping/tasks`).set(h.owner.auth).expect(200);
    expect(tasks.body.some((t: { room: { id: string } }) => t.room.id === h.rooms[0].id)).toBe(true);
  });

  it('shares an invoice through a signed public link', async () => {
    const inv = await request(server()).get(`${API}/invoices`).query({ kind: 'FINAL' }).set(h.owner.auth).expect(200);
    const share = await request(server()).post(`${API}/invoices/${inv.body.items[0].id}/share`).set(h.desk).send({ expiresInHours: 1 }).expect(200);
    expect(share.body.url).toContain('/share/');
    const pub = await request(server()).get(`${API}/public/documents/${share.body.token}`).expect(200);
    expect(pub.body).toMatchObject({ type: 'INVOICE', document: { number: inv.body.items[0].number } });
    await request(server()).get(`${API}/public/documents/${share.body.token}x`).expect(404);
  });

  it('payments and the night audit feed the reports', async () => {
    const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
    const daily = await request(server()).get(`${API}/reports/daily`).query({ date: today }).set(h.owner.auth).expect(200);
    expect(daily.body.live).toBe(true);
    expect(daily.body.roomsSold).toBeGreaterThanOrEqual(1);
    expect(daily.body.paymentsByMethod.CASH).toBeGreaterThan(0);
    const run = await request(server()).post(`${API}/night-audit/run`).set(h.owner.auth).send({}).expect(200);
    expect(run.body.status).toBe('COMPLETED');
    const rerun = await request(server()).post(`${API}/night-audit/run`).set(h.owner.auth).send({}).expect(200);
    expect(rerun.body).toMatchObject({ id: run.body.id, alreadyRun: true });
  });
});
