import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/setup-app.js';

export const API = '/api/v1';

export async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: ['error'] });
  setupApp(app);
  await app.init();
  return app;
}

export interface SignedUp {
  accessToken: string;
  refreshToken: string;
  userId: string;
  tenantId: string;
  email: string;
  auth: { Authorization: string };
}

export function uniq(): string {
  return randomBytes(4).toString('hex');
}

/** Signs up a brand-new hotel (Growth trial) and returns its tokens. */
export async function signup(app: INestApplication, name = 'Test Hotel'): Promise<SignedUp> {
  const email = `owner-${uniq()}@e2e.test`;
  const res = await request(app.getHttpServer())
    .post(`${API}/auth/signup`)
    .send({
      hotelName: `${name} ${uniq()}`,
      city: 'Lagos',
      state: 'Lagos',
      fullName: 'Test Owner',
      email,
      phone: '+2348000000000',
      password: 'Passw0rd!x',
    })
    .expect(201);
  const me = await request(app.getHttpServer())
    .get(`${API}/me`)
    .set('Authorization', `Bearer ${res.body.accessToken}`)
    .expect(200);
  return {
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    userId: res.body.user.id,
    tenantId: me.body.tenant.id,
    email,
    auth: { Authorization: `Bearer ${res.body.accessToken}` },
  };
}

export async function platformAuth(app: INestApplication) {
  const res = await request(app.getHttpServer())
    .post(`${API}/platform/auth/login`)
    .send({ email: 'admin@devstrike.ng', password: 'Admin1234!' })
    .expect(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

export async function createRoomType(app: INestApplication, auth: { Authorization: string }) {
  const res = await request(app.getHttpServer())
    .post(`${API}/room-types`)
    .set(auth)
    .send({ name: `Standard ${uniq()}`, basePriceKobo: 5_000_000, capacity: 2, bedType: 'Queen', sizeSqm: 20 })
    .expect(201);
  return res.body.id as string;
}

/** Direct connection as the runtime role, for database-level RLS assertions. */
export function appRoleClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.DATABASE_URL });
}

/** Direct connection as the owner/superuser role. */
export function ownerClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
}
