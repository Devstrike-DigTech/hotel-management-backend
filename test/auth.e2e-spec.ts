import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { API, createApp, platformAuth, signup } from './helpers.js';

describe('Auth', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const refresh = (token: string) =>
    request(app.getHttpServer()).post(`${API}/auth/refresh`).send({ refreshToken: token });

  it('signup creates a Growth trial with owner, tenant and entitlements', async () => {
    const t = await signup(app, 'Signup');
    const me = await request(app.getHttpServer()).get(`${API}/me`).set(t.auth).expect(200);
    expect(me.body.user.role).toBe('OWNER');
    expect(me.body.subscription).toMatchObject({ planCode: 'growth', status: 'TRIALING', interval: 'MONTHLY' });
    const trialDays = (Date.parse(me.body.subscription.trialEndsAt) - Date.now()) / 86_400_000;
    expect(trialDays).toBeGreaterThan(13.9);
    expect(trialDays).toBeLessThanOrEqual(14);
    expect(me.body.entitlements.usage).toEqual({ rooms: 0, staff: 1, properties: 1 });
  });

  it('signup rejects a duplicate email with EMAIL_TAKEN', async () => {
    const res = await request(app.getHttpServer())
      .post(`${API}/auth/signup`)
      .send({
        hotelName: 'Dup',
        city: 'Lagos',
        state: 'Lagos',
        fullName: 'Dup',
        email: 'demo@palmwine.ng',
        phone: '+2348000000000',
        password: 'Passw0rd!x',
      })
      .expect(409);
    expect(res.body.code).toBe('EMAIL_TAKEN');
  });

  it('login works for the seeded demo owner and rejects bad passwords', async () => {
    const ok = await request(app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email: 'DEMO@palmwine.ng', password: 'Demo1234!' })
      .expect(200);
    expect(ok.body.user).toMatchObject({ email: 'demo@palmwine.ng', role: 'OWNER' });
    const bad = await request(app.getHttpServer())
      .post(`${API}/auth/login`)
      .send({ email: 'demo@palmwine.ng', password: 'nope' })
      .expect(401);
    expect(bad.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('refresh rotates the token', async () => {
    const t = await signup(app, 'Rotate');
    const r1 = await refresh(t.refreshToken).expect(200);
    expect(r1.body.refreshToken).not.toBe(t.refreshToken);
    expect(r1.body.accessToken).toEqual(expect.any(String));
    await refresh(r1.body.refreshToken).expect(200);
  });

  it('reusing a rotated refresh token is rejected and revokes the whole family', async () => {
    const t = await signup(app, 'Reuse');
    const r1 = await refresh(t.refreshToken).expect(200);

    // The original token was already rotated: presenting it again is reuse.
    const reuse = await refresh(t.refreshToken).expect(401);
    expect(reuse.body.code).toBe('REFRESH_TOKEN_REUSED');

    // The legitimate descendant is now revoked too.
    const after = await refresh(r1.body.refreshToken).expect(401);
    expect(after.body.code).toBe('INVALID_REFRESH_TOKEN');

    // The reuse is recorded in the tenant's audit trail.
    const audit = await request(app.getHttpServer()).get(`${API}/audit-logs`).set(t.auth).expect(200);
    expect(audit.body.items.map((i: { action: string }) => i.action)).toContain('auth.refresh_reuse_detected');
  });

  it('logout revokes the refresh token', async () => {
    const t = await signup(app, 'Logout');
    await request(app.getHttpServer()).post(`${API}/auth/logout`).send({ refreshToken: t.refreshToken }).expect(200);
    const res = await refresh(t.refreshToken).expect(401);
    expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('unknown refresh tokens are rejected', async () => {
    const res = await refresh('not-a-real-token').expect(401);
    expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('hotel and platform tokens are not interchangeable', async () => {
    const t = await signup(app, 'Aud');
    const platform = await platformAuth(app);
    await request(app.getHttpServer()).get(`${API}/platform/metrics`).set(t.auth).expect(401);
    await request(app.getHttpServer()).get(`${API}/me`).set(platform).expect(401);
    await request(app.getHttpServer()).get(`${API}/platform/metrics`).set(platform).expect(200);
  });

  it('validation errors use the error envelope', async () => {
    const res = await request(app.getHttpServer()).post(`${API}/auth/login`).send({ email: 'nope' }).expect(400);
    expect(res.body).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(res.body.details.fields.email).toBeDefined();
  });
});
