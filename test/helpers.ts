import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { Redis } from 'ioredis';
import { totp } from '../src/modules/platform/security/totp.js';
import { PLATFORM_USERS } from '../prisma/seed-data/platform-users.js';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/setup-app.js';
import { signContext } from '../src/prisma/db.service.js';

export const API = '/api/v1';

/** e2e must only ever talk to the throwaway test database. */
export function assertTestDatabase(): void {
  const db = process.env.E2E_DB_NAME ?? 'hotel_test';
  for (const key of ['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'DATABASE_PLATFORM_URL']) {
    const name = new URL(process.env[key] ?? 'postgresql://x/none').pathname.slice(1);
    if (name !== db || !/test/.test(name)) throw new Error(`${key} points at "${name}", not the e2e database "${db}"; refusing to run`);
  }
}

export async function createApp(): Promise<INestApplication> {
  assertTestDatabase();
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

/** Dev TOTP secrets of the seeded platform users (see prisma/seed-data/platform-users.ts). */
export const PLATFORM_TOTP: Record<string, string> = Object.fromEntries(PLATFORM_USERS.map((u) => [u.email, u.totpSecret]));

const platformCache = new WeakMap<INestApplication, Map<string, PlatformSession>>();

export interface PlatformSession {
  Authorization: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
  sessionId: string;
}

/**
 * Clears the TOTP replay guard of a platform user (Redis), so a test can use
 * the current code again. Production never does this.
 */
export async function resetTotpReplay(userId: string): Promise<void> {
  const redis = new Redis(process.env.REDIS_URL!);
  try {
    const used = await redis.keys(`platform:totp-used:${userId}:*`);
    if (used.length) await redis.del(...used);
  } finally {
    redis.disconnect();
  }
}

/** Current TOTP code for a seeded platform user. */
export function platformCode(email = 'admin@devstrike.ng', at = new Date()): string {
  return totp(PLATFORM_TOTP[email]!, at);
}

/** Password + TOTP sign-in of a seeded platform user (fresh session every call). */
export async function platformLogin(app: INestApplication, email = 'admin@devstrike.ng', password = 'Admin1234!'): Promise<PlatformSession> {
  const server = app.getHttpServer();
  const step1 = await request(server).post(`${API}/platform/auth/login`).send({ email, password }).expect(200);
  const sub = JSON.parse(Buffer.from(String(step1.body.mfaToken).split('.')[1]!, 'base64url').toString('utf8')).sub as string;
  await resetTotpReplay(sub);
  const res = await request(server).post(`${API}/platform/auth/mfa/verify`).send({ mfaToken: step1.body.mfaToken, code: platformCode(email) }).expect(200);
  return {
    Authorization: `Bearer ${res.body.accessToken}`,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    userId: res.body.user.id,
    sessionId: res.body.user.session.id,
  };
}

/** Authorization header of the platform super admin (one session per app instance). */
export async function platformAuth(app: INestApplication, email = 'admin@devstrike.ng') {
  let byEmail = platformCache.get(app);
  if (!byEmail) platformCache.set(app, (byEmail = new Map()));
  let s = byEmail.get(email);
  if (!s) byEmail.set(email, (s = await platformLogin(app, email)));
  return { Authorization: s.Authorization };
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

/** Sets a correctly signed tenant context in the current transaction (as DbService does). */
export async function setSignedTenant(client: pg.Client, tenantId: string): Promise<void> {
  const sig = signContext(process.env.DB_CONTEXT_SECRET!, `tenant:${tenantId.toLowerCase()}`);
  await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.context_sig', $2, true)`, [
    tenantId.toLowerCase(),
    sig,
  ]);
}

/** Sets a correctly signed public marketplace context in the current transaction. */
export async function setSignedPublic(client: pg.Client): Promise<void> {
  const sig = signContext(process.env.DB_CONTEXT_SECRET!, 'public');
  await client.query(`SELECT set_config('app.context', 'public', true), set_config('app.context_sig', $1, true)`, [sig]);
}

/** Direct connection as the platform role. */
export function platformRoleClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.DATABASE_PLATFORM_URL });
}
