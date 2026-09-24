/**
 * M6 platform console: MFA sign-in, lockout, step-up, permissions, origin
 * separation, the append-only audit log, impersonation, Enterprise
 * onboarding, support desk, announcements and offboarding.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { API, createApp, ownerClient, platformAuth, platformCode, platformLogin, resetTotpReplay, signup, uniq } from './helpers.js';

let app: INestApplication;
const http = () => request(app.getHttpServer());

/** Makes a session's last step-up old, so sensitive actions need a new code. */
async function staleStepUp(sessionId: string) {
  const c = ownerClient();
  await c.connect();
  try {
    await c.query(`UPDATE platform_sessions SET step_up_at = now() - interval '1 hour' WHERE id = $1`, [sessionId]);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  app = await createApp();
});

afterAll(async () => {
  await app.close();
});

describe('platform sign-in with TOTP', () => {
  it('returns an MFA challenge, never a token, for the password step', async () => {
    const res = await http().post(`${API}/platform/auth/login`).send({ email: 'ops@devstrike.ng', password: 'Admin1234!' }).expect(200);
    expect(res.body).toMatchObject({ status: 'MFA_REQUIRED' });
    expect(res.body.accessToken).toBeUndefined();
    const bad = await http().post(`${API}/platform/auth/mfa/verify`).send({ mfaToken: res.body.mfaToken, code: '000000' }).expect(401);
    expect(bad.body.code).toBe('INVALID_MFA_CODE');
    expect(bad.body.details.attemptsLeft).toBeGreaterThanOrEqual(0);
  });

  it('signs in with the code and exposes permissions and the session', async () => {
    const s = await platformLogin(app, 'support@devstrike.ng');
    const me = await http().get(`${API}/platform/auth/me`).set({ Authorization: s.Authorization }).expect(200);
    expect(me.body).toMatchObject({ role: 'SUPPORT', mfaEnabled: true });
    expect(me.body.permissions).toContain('impersonate');
    expect(me.body.permissions).not.toContain('billing.manage');
    expect(me.body.session.id).toBe(s.sessionId);
    const sessions = await http().get(`${API}/platform/auth/sessions`).set({ Authorization: s.Authorization }).expect(200);
    expect(sessions.body.some((x: { current: boolean }) => x.current)).toBe(true);
  });

  it('refuses a replayed code with MFA_CODE_ALREADY_USED without counting it toward the lockout', async () => {
    const s = await platformLogin(app, 'finance@devstrike.ng');
    expect(s.accessToken).toBeTruthy();
    const code = platformCode('finance@devstrike.ng');
    for (let i = 0; i < 6; i++) {
      const step1 = await http().post(`${API}/platform/auth/login`).send({ email: 'finance@devstrike.ng', password: 'Admin1234!' }).expect(200);
      const res = await http().post(`${API}/platform/auth/mfa/verify`).send({ mfaToken: step1.body.mfaToken, code });
      if (res.status === 200) continue; // the 30-second step rolled over: a new, unused code
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('MFA_CODE_ALREADY_USED');
    }
    // Six replays later the account is not locked.
    await http().post(`${API}/platform/auth/login`).send({ email: 'finance@devstrike.ng', password: 'Admin1234!' }).expect(200);
  });

  it('accepts a recovery code once', async () => {
    const step1 = await http().post(`${API}/platform/auth/login`).send({ email: 'admin@devstrike.ng', password: 'Admin1234!' }).expect(200);
    await http().post(`${API}/platform/auth/mfa/verify`).send({ mfaToken: step1.body.mfaToken, recoveryCode: 'adm0-0007' }).expect(200);
    const step2 = await http().post(`${API}/platform/auth/login`).send({ email: 'admin@devstrike.ng', password: 'Admin1234!' }).expect(200);
    const again = await http().post(`${API}/platform/auth/mfa/verify`).send({ mfaToken: step2.body.mfaToken, recoveryCode: 'adm0-0007' }).expect(401);
    expect(again.body.code).toBe('INVALID_MFA_CODE');
  });

  it('locks the account after 5 wrong passwords, and an admin can unlock it', async () => {
    for (let i = 0; i < 4; i++) await http().post(`${API}/platform/auth/login`).send({ email: 'sales@devstrike.ng', password: 'wrong-password' }).expect(401);
    const fifth = await http().post(`${API}/platform/auth/login`).send({ email: 'sales@devstrike.ng', password: 'wrong-password' });
    expect([401, 423]).toContain(fifth.status);
    const locked = await http().post(`${API}/platform/auth/login`).send({ email: 'sales@devstrike.ng', password: 'Admin1234!' }).expect(423);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
    const admin = await platformAuth(app);
    const users = await http().get(`${API}/platform/users`).set(admin).expect(200);
    const sales = users.body.find((u: { email: string }) => u.email === 'sales@devstrike.ng');
    expect(sales.lockedUntil).not.toBeNull();
    await http().post(`${API}/platform/users/${sales.id}/unlock`).set(admin).expect(200);
    await http().post(`${API}/platform/auth/login`).send({ email: 'sales@devstrike.ng', password: 'Admin1234!' }).expect(200);
  });

  it('revoked sessions stop working at once', async () => {
    const s = await platformLogin(app, 'finance@devstrike.ng');
    await http().post(`${API}/platform/auth/logout`).set({ Authorization: s.Authorization }).expect(200);
    const res = await http().get(`${API}/platform/auth/me`).set({ Authorization: s.Authorization }).expect(401);
    expect(res.body.code).toBe('SESSION_REVOKED');
  });

  it('requires a fresh code for sensitive actions (step-up)', async () => {
    const s = await platformLogin(app, 'admin@devstrike.ng');
    await staleStepUp(s.sessionId);
    const res = await http().post(`${API}/platform/auth/mfa/recovery-codes`).set({ Authorization: s.Authorization }).expect(403);
    expect(res.body).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { maxAgeSeconds: 600 } });
    await resetTotpReplay(s.userId);
    const up = await http().post(`${API}/platform/auth/step-up`).set({ Authorization: s.Authorization }).send({ code: platformCode('admin@devstrike.ng') }).expect(200);
    expect(new Date(up.body.stepUpUntil).getTime()).toBeGreaterThan(Date.now());
    const codes = await http().post(`${API}/platform/auth/mfa/recovery-codes`).set({ Authorization: s.Authorization }).expect(200);
    expect(codes.body.recoveryCodes).toHaveLength(10);
  });
});

describe('permissions and origins', () => {
  it('refuses actions outside the role with PLATFORM_FORBIDDEN', async () => {
    const sales = await platformAuth(app, 'sales@devstrike.ng');
    await http().get(`${API}/platform/tenants`).set(sales).expect(200);
    const res = await http().post(`${API}/platform/coupons`).set(sales).send({ code: 'NOPE10', name: 'Nope', percentOff: 10 }).expect(403);
    expect(res.body).toMatchObject({ code: 'PLATFORM_FORBIDDEN', details: { permission: 'billing.manage' } });
    await http().get(`${API}/platform/audit`).set(sales).expect(403);
  });

  it('keeps the hotel apps off the platform API and the console off hotel routes', async () => {
    const admin = await platformAuth(app);
    const blocked = await http().get(`${API}/platform/tenants`).set(admin).set('Origin', 'http://localhost:3001').expect(403);
    expect(blocked.body.code).toBe('ORIGIN_NOT_ALLOWED');
    const ok = await http().get(`${API}/platform/tenants`).set(admin).set('Origin', 'http://localhost:3002').expect(200);
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3002');
    const hotel = await http().post(`${API}/auth/login`).set('Origin', 'http://localhost:3002').send({ email: 'x@y.ng', password: 'x' }).expect(403);
    expect(hotel.body.code).toBe('ORIGIN_NOT_ALLOWED');
    const pub = await http().get(`${API}/public/plans`).set('Origin', 'http://localhost:3002').expect(200);
    expect(pub.headers['x-request-id']).toBeTruthy();
  });
});

describe('platform audit log', () => {
  it('records platform writes and refuses UPDATE / DELETE', async () => {
    const admin = await platformAuth(app);
    await http().post(`${API}/platform/coupons`).set(admin).send({ code: `AUD${uniq().slice(0, 6).toUpperCase()}`, name: 'Audit probe', percentOff: 5 }).expect(201);
    const log = await http().get(`${API}/platform/audit?pageSize=200`).set(admin).expect(200);
    const row = log.body.items.find((r: { path: string | null; method: string | null }) => r.method === 'POST' && r.path?.includes('/platform/coupons'));
    expect(row).toBeTruthy();
    expect(row.actor.role).toBe('SUPER_ADMIN');
    const c = ownerClient();
    await c.connect();
    try {
      await expect(c.query(`UPDATE platform_audit_logs SET action = 'tampered' WHERE id = $1`, [row.id])).rejects.toThrow();
      await expect(c.query(`DELETE FROM platform_audit_logs WHERE id = $1`, [row.id])).rejects.toThrow();
    } finally {
      await c.end();
    }
    const csv = await http().get(`${API}/platform/audit/export?from=2026-01-01&to=2026-12-31&format=csv`).set(admin).expect(200);
    expect(csv.headers['content-disposition']).toContain('platform-audit-');
  });
});

describe('impersonation', () => {
  it('starts read-only, blocks writes, enables writes with a reason, mirrors audit, ends', async () => {
    const admin = await platformLogin(app, 'admin@devstrike.ng');
    const A = { Authorization: admin.Authorization };
    const hotel = await signup(app, 'Impersonated Inn');
    const staff = await http().get(`${API}/me`).set(hotel.auth).expect(200);
    const start = await http()
      .post(`${API}/platform/impersonations`)
      .set(A)
      .send({ tenantId: hotel.tenantId, userId: staff.body.user.id, reason: 'Checking why the room grid is empty', durationMinutes: 15 })
      .expect(201);
    expect(start.body.session).toMatchObject({ mode: 'READ_ONLY', staff: { id: staff.body.user.id } });
    const code = String(start.body.handoffUrl).split('#code=')[1]!;
    const ex = await http().post(`${API}/auth/impersonation/exchange`).send({ code }).expect(200);
    const I = { Authorization: `Bearer ${ex.body.accessToken}` };
    await http().post(`${API}/auth/impersonation/exchange`).send({ code }).expect(401);

    const me = await http().get(`${API}/me`).set(I).expect(200);
    expect(me.body.impersonation).toMatchObject({ mode: 'READ_ONLY', platformUserName: 'Devstrike Admin' });
    const ro = await http().post(`${API}/room-types`).set(I).send({ name: 'Blocked', basePriceKobo: 1_000_000, capacity: 2, bedType: 'Queen', sizeSqm: 20 }).expect(403);
    expect(ro.body.code).toBe('IMPERSONATION_READ_ONLY');

    await http().post(`${API}/platform/impersonations/${start.body.session.id}/write-mode`).set(A).send({ enabled: true }).expect(400);
    await http().post(`${API}/platform/impersonations/${start.body.session.id}/write-mode`).set(A).send({ enabled: true, reason: 'Hotel asked us to add the room type' }).expect(200);
    const added = await http().post(`${API}/room-types`).set(I).send({ name: 'Added by support', basePriceKobo: 1_000_000, capacity: 2, bedType: 'Queen', sizeSqm: 20 });
    expect(added.status).toBe(201);
    const audit = await http().get(`${API}/audit-logs?pageSize=20`).set(hotel.auth).expect(200);
    const created = audit.body.items.find((r: { action: string }) => r.action === 'room_type.created');
    expect(created.actor.fullName).toContain('Devstrike support');
    expect(created.metadata.impersonation.sessionId).toBe(start.body.session.id);

    const detail = await http().get(`${API}/platform/impersonations/${start.body.session.id}`).set(A).expect(200);
    expect(detail.body.writes).toBeGreaterThanOrEqual(1);
    const past = await http().get(`${API}/support-sessions`).set(hotel.auth).expect(200);
    expect(past.body.items[0].id).toBe(start.body.session.id);

    await http().post(`${API}/support-sessions/${start.body.session.id}/end`).set(hotel.auth).expect(200);
    const after = await http().get(`${API}/me`).set(I).expect(401);
    expect(after.body.code).toBe('IMPERSONATION_ENDED');
    const log = await http().get(`${API}/platform/audit?action=impersonation.&pageSize=50`).set(A).expect(200);
    expect(log.body.items.some((r: { action: string }) => r.action === 'impersonation.started')).toBe(true);
  });
});

describe('Enterprise onboarding and tenant actions', () => {
  it('creates a tenant with a custom price and an owner set-up link', async () => {
    const admin = await platformAuth(app);
    const email = `owner.${uniq()}@newgroup.ng`;
    const res = await http()
      .post(`${API}/platform/tenants`)
      .set(admin)
      .send({ name: 'New Group Hotels', city: 'Kano', state: 'Kano', owner: { fullName: 'Musa Kabir', email, phone: '+2348030001111' }, customPriceKobo: 90_000_000, contractNotes: 'Pilot' })
      .expect(201);
    expect(res.body.tenant).toMatchObject({ planCode: 'enterprise', status: 'ACTIVE', mrrKobo: 90_000_000 });
    expect(res.body.tenant.subscription.customPriceKobo).toBe(90_000_000);
    const token = new URL(res.body.ownerSetupUrl).searchParams.get('token')!;
    const info = await http().get(`${API}/auth/setup-password/${token}`).expect(200);
    expect(info.body).toMatchObject({ email, hotelName: 'New Group Hotels' });
    await http().post(`${API}/auth/login`).send({ email, password: 'Chosen1234' }).expect(401);
    const signedIn = await http().post(`${API}/auth/setup-password`).send({ token, password: 'Chosen1234' }).expect(200);
    expect(signedIn.body.user.role).toBe('OWNER');
    await http().post(`${API}/auth/setup-password`).send({ token, password: 'Chosen1234' }).expect(404);

    const sales = await platformAuth(app, 'ops@devstrike.ng');
    const money = await http().patch(`${API}/platform/tenants/${res.body.tenant.id}/subscription`).set(sales).send({ customPriceKobo: 1 }).expect(403);
    expect(money.body.details.permission).toBe('billing.manage');

    const suspended = await http().post(`${API}/platform/tenants/${res.body.tenant.id}/suspend`).set(admin).send({ reason: 'Contract paused' }).expect(200);
    expect(suspended.body.status).toBe('SUSPENDED');
    const back = await http().post(`${API}/platform/tenants/${res.body.tenant.id}/reinstate`).set(admin).send({ reason: 'Contract resumed' }).expect(200);
    expect(back.body.status).toBe('ACTIVE');
  });

  it('shows the overview with churn and health', async () => {
    const admin = await platformAuth(app);
    const res = await http().get(`${API}/platform/overview`).set(admin).expect(200);
    expect(res.body.mrrKobo).toBeGreaterThan(0);
    expect(res.body.churn.byMonth).toHaveLength(6);
    expect(['ok', 'degraded', 'down']).toContain(res.body.health.status);
    const list = await http().get(`${API}/platform/tenants?dbMode=DEDICATED`).set(admin).expect(200);
    expect(list.body.items.map((t: { slug: string }) => t.slug)).toContain('harmattan');
  });
});

describe('support desk and announcements', () => {
  it('runs a support request from hotel to console and back', async () => {
    const hotel = await signup(app, 'Support Seeker');
    const created = await http().post(`${API}/support/requests`).set(hotel.auth).send({ subject: 'Cannot print receipts', category: 'TECHNICAL', message: 'The print button does nothing.' }).expect(201);
    expect(created.body).toMatchObject({ status: 'NEW', planCode: 'growth', slaHours: 24 });
    expect(created.body.number).toMatch(/^SR-\d{6}$/);
    const support = await platformAuth(app, 'support@devstrike.ng');
    const inbox = await http().get(`${API}/platform/support/requests?tenantId=${hotel.tenantId}`).set(support).expect(200);
    expect(inbox.body.items[0].id).toBe(created.body.id);
    await http().post(`${API}/platform/support/requests/${created.body.id}/messages`).set(support).send({ body: 'Internal: likely a popup blocker', internal: true }).expect(201);
    await http().post(`${API}/platform/support/requests/${created.body.id}/messages`).set(support).send({ body: 'Please allow pop-ups for the site.' }).expect(201);
    const seen = await http().get(`${API}/support/requests/${created.body.id}`).set(hotel.auth).expect(200);
    expect(seen.body.status).toBe('WAITING_ON_HOTEL');
    expect(seen.body.firstRespondedAt).not.toBeNull();
    expect(seen.body.messages.some((m: { internal: boolean }) => m.internal)).toBe(false);
    // Several statuses at once, or a state.
    const many = await http().get(`${API}/support/requests?status=OPEN,WAITING`).set(hotel.auth).expect(200);
    expect(many.body.items.map((r: { id: string }) => r.id)).toContain(created.body.id);
    expect((await http().get(`${API}/support/requests?state=open`).set(hotel.auth).expect(200)).body.total).toBe(1);
    expect((await http().get(`${API}/support/requests?state=resolved`).set(hotel.auth).expect(200)).body.total).toBe(0);
    await http().get(`${API}/support/requests?status=NOPE`).set(hotel.auth).expect(400);
    const me = await http().get(`${API}/me`).set(hotel.auth).expect(200);
    expect(me.body.permissions).toContain('support.request');
  });

  it('publishes a targeted announcement that hotels can dismiss', async () => {
    const ops = await platformAuth(app, 'ops@devstrike.ng');
    const hotel = await signup(app, 'Announcement Reader');
    const a = await http()
      .post(`${API}/platform/announcements`)
      .set(ops)
      .send({ title: 'Growth tip', body: 'Try promo codes.', severity: 'INFO', audience: { kind: 'TENANTS', tenantIds: [hotel.tenantId] }, startsAt: new Date(Date.now() - 1000).toISOString(), dismissible: true })
      .expect(201);
    expect(a.body.state).toBe('DRAFT');
    await http().post(`${API}/platform/announcements/${a.body.id}/publish`).set(ops).expect(200);
    const list = await http().get(`${API}/announcements`).set(hotel.auth).expect(200);
    expect(list.body.map((x: { id: string }) => x.id)).toContain(a.body.id);
    await http().post(`${API}/announcements/${a.body.id}/dismiss`).set(hotel.auth).expect(200);
    const after = await http().get(`${API}/announcements`).set(hotel.auth).expect(200);
    expect(after.body.map((x: { id: string }) => x.id)).not.toContain(a.body.id);
    const other = await signup(app, 'Not Targeted');
    const none = await http().get(`${API}/announcements`).set(other.auth).expect(200);
    expect(none.body.map((x: { id: string }) => x.id)).not.toContain(a.body.id);
  });
});

describe('offboarding (NDPA)', () => {
  it('suspends, exports, blocks writes and deletes on request', async () => {
    const hotel = await signup(app, 'Closing Down Hotel');
    const name = (await http().get(`${API}/me`).set(hotel.auth).expect(200)).body.tenant.name as string;
    const admin = await platformAuth(app);
    const wrong = await http().post(`${API}/platform/tenants/${hotel.tenantId}/offboard`).set(admin).send({ confirmName: 'Closing Down', reason: 'Owner asked to close' }).expect(400);
    expect(wrong.body.code).toBe('CONFIRMATION_MISMATCH');
    const o = await http().post(`${API}/platform/tenants/${hotel.tenantId}/offboard`).set(admin).send({ confirmName: name, reason: 'Owner asked to close' }).expect(201);
    expect(['EXPORTING', 'GRACE']).toContain(o.body.status);
    const blocked = await http().post(`${API}/room-types`).set(hotel.auth).send({ name: 'Late', basePriceKobo: 100_000, capacity: 2, bedType: 'Queen', sizeSqm: 20 }).expect(409);
    expect(blocked.body.code).toBe('TENANT_OFFBOARDING');
    let status = o.body.status;
    for (let i = 0; i < 40 && status === 'EXPORTING'; i++) {
      await new Promise((r) => setTimeout(r, 250));
      status = (await http().get(`${API}/platform/tenants/${hotel.tenantId}/offboarding`).set(admin).expect(200)).body.status;
      if (status === 'EXPORTING') await http().post(`${API}/platform/jobs/offboarding/run`).set(admin);
    }
    expect(status).toBe('GRACE');
    const done = await http().post(`${API}/platform/offboardings/${o.body.id}/delete-now`).set(admin).expect(200);
    expect(done.body.status).toBe('DELETED');
    expect(done.body.summary.rowsDeleted).toBeGreaterThan(0);
    const t = await http().get(`${API}/platform/tenants/${hotel.tenantId}`).set(admin).expect(200);
    expect(t.body.lifecycle).toBe('DELETED');
    await http().post(`${API}/auth/login`).send({ email: hotel.email, password: 'Passw0rd!x' }).expect(401);
  });
});
