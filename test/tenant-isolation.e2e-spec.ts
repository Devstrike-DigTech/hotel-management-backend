import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  API,
  appRoleClient,
  createApp,
  createRoomType,
  ownerClient,
  signup,
  type SignedUp,
} from './helpers.js';

describe('Tenant isolation (RLS)', () => {
  let app: INestApplication;
  let a: SignedUp;
  let b: SignedUp;
  let roomA: string;
  let roomB: string;
  let typeB: string;

  beforeAll(async () => {
    app = await createApp();
    a = await signup(app, 'Alpha');
    b = await signup(app, 'Bravo');
    const typeA = await createRoomType(app, a.auth);
    typeB = await createRoomType(app, b.auth);
    roomA = (
      await request(app.getHttpServer())
        .post(`${API}/rooms`)
        .set(a.auth)
        .send({ roomTypeId: typeA, number: '101', floor: 1 })
        .expect(201)
    ).body.id;
    roomB = (
      await request(app.getHttpServer())
        .post(`${API}/rooms`)
        .set(b.auth)
        .send({ roomTypeId: typeB, number: '101', floor: 1 })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('through the API', () => {
    it('tenant A only sees its own rooms', async () => {
      const res = await request(app.getHttpServer()).get(`${API}/rooms`).set(a.auth).expect(200);
      const ids = res.body.map((r: { id: string }) => r.id);
      expect(ids).toContain(roomA);
      expect(ids).not.toContain(roomB);
    });

    it("tenant A filtering by tenant B's room type gets nothing", async () => {
      const res = await request(app.getHttpServer())
        .get(`${API}/rooms`)
        .query({ roomTypeId: typeB })
        .set(a.auth)
        .expect(200);
      expect(res.body).toEqual([]);
    });

    it("tenant A cannot update, change status of or delete tenant B's room", async () => {
      const server = app.getHttpServer();
      await request(server).patch(`${API}/rooms/${roomB}`).set(a.auth).send({ notes: 'x' }).expect(404);
      await request(server).patch(`${API}/rooms/${roomB}/status`).set(a.auth).send({ status: 'OCCUPIED' }).expect(404);
      await request(server).delete(`${API}/rooms/${roomB}`).set(a.auth).expect(404);
      const still = await request(server).get(`${API}/rooms`).set(b.auth).expect(200);
      expect(still.body.find((r: { id: string }) => r.id === roomB).status).toBe('VACANT_CLEAN');
    });

    it("tenant A cannot create a room on tenant B's room type", async () => {
      await request(app.getHttpServer())
        .post(`${API}/rooms`)
        .set(a.auth)
        .send({ roomTypeId: typeB, number: '999', floor: 9 })
        .expect(404);
    });

    it("tenant A's staff list and audit log contain only tenant A", async () => {
      const staff = await request(app.getHttpServer()).get(`${API}/staff`).set(a.auth).expect(200);
      expect(staff.body.map((s: { email: string }) => s.email)).toEqual([a.email]);
      const audit = await request(app.getHttpServer()).get(`${API}/audit-logs`).set(a.auth).expect(200);
      expect(audit.body.items.every((i: { entityId: string | null }) => i.entityId !== roomB)).toBe(true);
    });
  });

  describe('at the database level (runtime role hotel_app)', () => {
    const client = appRoleClient();
    beforeAll(() => client.connect());
    afterAll(() => client.end());

    async function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
      await client.query('BEGIN');
      try {
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        return await fn();
      } finally {
        await client.query('ROLLBACK');
      }
    }

    it('the runtime role is not a superuser and cannot bypass RLS', async () => {
      const r = await client.query(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });

    it('with no tenant set, tenant tables look empty (fail closed)', async () => {
      const r = await client.query('SELECT count(*)::int AS n FROM rooms');
      expect(r.rows[0].n).toBe(0);
      const u = await client.query('SELECT count(*)::int AS n FROM users');
      expect(u.rows[0].n).toBe(0);
    });

    it("tenant A's context cannot read tenant B's rows even when asking by id", async () => {
      const n = await inTenant(a.tenantId, async () => {
        const r = await client.query('SELECT count(*)::int AS n FROM rooms WHERE id = $1', [roomB]);
        return r.rows[0].n;
      });
      expect(n).toBe(0);
    });

    it("tenant A's context cannot insert rows for tenant B", async () => {
      await expect(
        inTenant(a.tenantId, () =>
          client.query(
            `INSERT INTO audit_logs (id, tenant_id, action, entity_type) VALUES (gen_random_uuid(), $1, 'x', 'y')`,
            [b.tenantId],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("tenant A's context cannot move its own room into tenant B", async () => {
      await expect(
        inTenant(a.tenantId, () =>
          client.query('UPDATE rooms SET tenant_id = $1 WHERE id = $2', [b.tenantId, roomA]),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('the public context can read hotels but never staff or tokens', async () => {
      await client.query('BEGIN');
      try {
        await client.query(`SELECT set_config('app.context', 'public', true)`);
        const props = await client.query('SELECT count(*)::int AS n FROM properties');
        const users = await client.query('SELECT count(*)::int AS n FROM users');
        const tokens = await client.query('SELECT count(*)::int AS n FROM refresh_tokens');
        expect(props.rows[0].n).toBeGreaterThan(0);
        expect(users.rows[0].n).toBe(0);
        expect(tokens.rows[0].n).toBe(0);
        await expect(client.query(`UPDATE properties SET name = 'x'`)).resolves.toMatchObject({ rowCount: 0 });
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });

  describe('append-only audit log', () => {
    it('blocks UPDATE and DELETE even for the owner role', async () => {
      const owner = ownerClient();
      await owner.connect();
      try {
        await expect(owner.query(`UPDATE audit_logs SET action = 'tampered'`)).rejects.toThrow(/append-only/);
        await expect(owner.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
        await expect(owner.query('TRUNCATE audit_logs')).rejects.toThrow(/append-only/);
      } finally {
        await owner.end();
      }
    });

    it('the runtime role has no UPDATE/DELETE privilege on audit_logs', async () => {
      const c = appRoleClient();
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenantId]);
        await expect(c.query(`DELETE FROM audit_logs`)).rejects.toThrow(/permission denied/);
      } finally {
        await c.query('ROLLBACK');
        await c.end();
      }
    });
  });
});
