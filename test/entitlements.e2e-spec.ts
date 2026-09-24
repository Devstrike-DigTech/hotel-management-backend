import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  API,
  createApp,
  createRoomType,
  platformAuth,
  signup,
  uniq,
  type SignedUp,
} from './helpers.js';

describe('Entitlements', () => {
  let app: INestApplication;
  let platform: { Authorization: string };

  beforeAll(async () => {
    app = await createApp();
    platform = await platformAuth(app);
  });
  afterAll(async () => {
    await app.close();
  });

  const setPlan = (t: SignedUp, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(`${API}/platform/tenants/${t.tenantId}/subscription`)
      .set(platform)
      .send(body)
      .expect(200);

  describe('limits', () => {
    it('POST /rooms returns LIMIT_REACHED once max_rooms is used up', async () => {
      const t = await signup(app, 'Limits');
      const typeId = await createRoomType(app, t.auth);
      const server = app.getHttpServer();

      // Growth trial: 60 rooms.
      const bulk = await request(server)
        .post(`${API}/rooms/bulk`)
        .set(t.auth)
        .send({ roomTypeId: typeId, floor: 1, from: 1, to: 60 })
        .expect(201);
      expect(bulk.body).toHaveLength(60);

      const res = await request(server)
        .post(`${API}/rooms`)
        .set(t.auth)
        .send({ roomTypeId: typeId, number: '61', floor: 1 })
        .expect(403);
      expect(res.body).toEqual({
        statusCode: 403,
        code: 'LIMIT_REACHED',
        message: expect.any(String),
        details: { limit: 'max_rooms', max: 60, current: 60, upgradePlan: 'pro' },
      });
    });

    it('bulk creation that would overshoot the limit is rejected as a whole', async () => {
      const t = await signup(app, 'Bulk');
      await setPlan(t, { planCode: 'starter' });
      const typeId = await createRoomType(app, t.auth);
      const res = await request(app.getHttpServer())
        .post(`${API}/rooms/bulk`)
        .set(t.auth)
        .send({ roomTypeId: typeId, floor: 1, from: 101, to: 121 })
        .expect(403);
      expect(res.body.code).toBe('LIMIT_REACHED');
      expect(res.body.details).toMatchObject({ limit: 'max_rooms', max: 20, current: 0, upgradePlan: 'growth' });
      const rooms = await request(app.getHttpServer()).get(`${API}/rooms`).set(t.auth).expect(200);
      expect(rooms.body).toHaveLength(0);
    });

    it('POST /staff returns LIMIT_REACHED at max_staff', async () => {
      const t = await signup(app, 'Staff');
      await setPlan(t, { planCode: 'starter' }); // 3 staff including the owner
      const server = app.getHttpServer();
      const add = () =>
        request(server)
          .post(`${API}/staff`)
          .set(t.auth)
          .send({ fullName: 'Desk', email: `desk-${uniq()}@e2e.test`, phone: '+2348000000001', role: 'FRONT_DESK', password: 'Passw0rd!x' });
      await add().expect(201);
      await add().expect(201);
      const res = await add().expect(403);
      expect(res.body.code).toBe('LIMIT_REACHED');
      expect(res.body.details).toEqual({ limit: 'max_staff', max: 3, current: 3, upgradePlan: 'growth' });
    });
  });

  describe('features', () => {
    it('Growth includes housekeeping', async () => {
      const t = await signup(app, 'Growth');
      const res = await request(app.getHttpServer()).get(`${API}/housekeeping/tasks`).set(t.auth).expect(200);
      expect(res.body).toEqual([]);
    });

    it('Starter gets FEATURE_LOCKED with the required plan', async () => {
      const t = await signup(app, 'Starter');
      await setPlan(t, { planCode: 'starter' });
      const res = await request(app.getHttpServer()).get(`${API}/housekeeping/tasks`).set(t.auth).expect(403);
      expect(res.body).toEqual({
        statusCode: 403,
        code: 'FEATURE_LOCKED',
        message: expect.any(String),
        details: { feature: 'housekeeping', requiredPlan: 'growth' },
      });
    });

    it('a platform add-on override unlocks the feature for one tenant', async () => {
      const t = await signup(app, 'Addon');
      await setPlan(t, { planCode: 'starter' });
      await request(app.getHttpServer())
        .put(`${API}/platform/tenants/${t.tenantId}/features`)
        .set(platform)
        .send({ featureCode: 'housekeeping', enabled: true })
        .expect(200);
      await request(app.getHttpServer()).get(`${API}/housekeeping/tasks`).set(t.auth).expect(200);
      const me = await request(app.getHttpServer()).get(`${API}/me`).set(t.auth).expect(200);
      expect(me.body.entitlements.features).toContain('housekeeping');
    });

    it('branding fields on PATCH /property follow brand_kit (M7: on every plan; booking_site_branding is its alias)', async () => {
      const t = await signup(app, 'Brand');
      await setPlan(t, { planCode: 'starter' });
      await request(app.getHttpServer()).patch(`${API}/property`).set(t.auth).send({ accentColor: '#B4452A' }).expect(200);
      const me = await request(app.getHttpServer()).get(`${API}/me`).set(t.auth).expect(200);
      expect(me.body.entitlements.features).toEqual(expect.arrayContaining(['brand_kit', 'booking_site_branding']));
      // Removing the old name removes both, and the gate still answers with the old code.
      await request(app.getHttpServer()).put(`${API}/platform/tenants/${t.tenantId}/features`).set(platform).send({ featureCode: 'booking_site_branding', enabled: false }).expect(200);
      const locked = await request(app.getHttpServer()).patch(`${API}/property`).set(t.auth).send({ accentColor: '#1D3557' }).expect(403);
      expect(locked.body.details).toEqual({ feature: 'booking_site_branding', requiredPlan: 'starter' });
      await request(app.getHttpServer()).patch(`${API}/property`).set(t.auth).send({ tagline: 'Fine' }).expect(200);
    });
  });

  describe('subscription state', () => {
    it('READ_ONLY blocks writes with 402 but allows reads and checkout', async () => {
      const t = await signup(app, 'ReadOnly');
      const typeId = await createRoomType(app, t.auth);
      await setPlan(t, { status: 'READ_ONLY' });
      const server = app.getHttpServer();
      const res = await request(server)
        .post(`${API}/rooms`)
        .set(t.auth)
        .send({ roomTypeId: typeId, number: '1', floor: 1 })
        .expect(402);
      expect(res.body.code).toBe('SUBSCRIPTION_READ_ONLY');
      await request(server).get(`${API}/rooms`).set(t.auth).expect(200);
      await request(server).get(`${API}/me`).set(t.auth).expect(200);
    });

    it('the dunning job moves an expired trial to READ_ONLY', async () => {
      const t = await signup(app, 'Trial');
      await setPlan(t, { trialEndsAt: new Date(Date.now() - 60_000).toISOString() });
      const run = await request(app.getHttpServer())
        .post(`${API}/platform/jobs/dunning/run`)
        .set(platform)
        .expect(200);
      expect(run.body.transitions).toContainEqual({ tenantId: t.tenantId, from: 'TRIALING', to: 'READ_ONLY' });
      const me = await request(app.getHttpServer()).get(`${API}/me`).set(t.auth).expect(200);
      expect(me.body.subscription.status).toBe('READ_ONLY');
    });
  });

  describe('roles', () => {
    it('front desk staff cannot manage staff or create rooms', async () => {
      const t = await signup(app, 'Roles');
      const email = `fd-${uniq()}@e2e.test`;
      await request(app.getHttpServer())
        .post(`${API}/staff`)
        .set(t.auth)
        .send({ fullName: 'Desk', email, phone: '+2348000000002', role: 'FRONT_DESK', password: 'Passw0rd!x' })
        .expect(201);
      const login = await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email, password: 'Passw0rd!x' })
        .expect(200);
      const fd = { Authorization: `Bearer ${login.body.accessToken}` };
      const res = await request(app.getHttpServer()).get(`${API}/staff`).set(fd).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      await request(app.getHttpServer()).get(`${API}/rooms`).set(fd).expect(200);
    });
  });
});
