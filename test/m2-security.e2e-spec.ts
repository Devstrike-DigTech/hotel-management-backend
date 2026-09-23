import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { API, appRoleClient, createApp, platformRoleClient, setSignedTenant, signup, type SignedUp } from './helpers.js';
import { guestInput } from './m2-helpers.js';

/**
 * M2 security fix: the runtime role cannot widen its access by setting any
 * GUC. Cross-tenant access exists only for the separate hotel_platform role.
 */
describe('hotel_app cannot escalate across tenants (signed context, platform role)', () => {
  let app: INestApplication;
  let a: SignedUp;
  let b: SignedUp;
  const client = appRoleClient();

  beforeAll(async () => {
    app = await createApp();
    a = await signup(app, 'Alpha');
    b = await signup(app, 'Bravo');
    for (const t of [a, b]) {
      await request(app.getHttpServer()).post(`${API}/guests`).set(t.auth).send(guestInput()).expect(201);
    }
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  async function inTx<T>(fn: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try {
      return await fn();
    } finally {
      await client.query('ROLLBACK');
    }
  }

  const count = async (table: string, tenantId?: string) =>
    (await client.query(`SELECT count(*)::int AS n FROM ${table}${tenantId ? ' WHERE tenant_id = $1' : ''}`, tenantId ? [tenantId] : [])).rows[0].n as number;

  it('sees nothing after setting every app.* GUC it likes, without a valid signature', async () => {
    await inTx(async () => {
      await client.query(`SELECT set_config('app.context', 'system', true)`);
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [b.tenantId]);
      await client.query(`SELECT set_config('app.context_sig', 'deadbeef', true)`);
      await client.query(`SELECT set_config('app.role', 'platform', true), set_config('app.bypass', 'on', true)`);
      for (const t of ['guests', 'users', 'rooms', 'reservations', 'folio_entries', 'audit_logs', 'subscriptions', 'tenants']) {
        expect(await count(t)).toBe(0);
      }
    });
  });

  it("a correctly signed tenant A context stays inside A even after set_config('app.context', 'system')", async () => {
    await inTx(async () => {
      await setSignedTenant(client, a.tenantId);
      expect(await count('guests', a.tenantId)).toBe(1);
      await client.query(`SELECT set_config('app.context', 'system', true)`);
      expect(await count('guests', b.tenantId)).toBe(0);
      expect(await count('users', b.tenantId)).toBe(0);
      // Re-using A's signature with B's id does not verify.
      const sig = (await client.query(`SELECT current_setting('app.context_sig') AS s`)).rows[0].s as string;
      await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.context_sig', $2, true)`, [b.tenantId, sig]);
      expect(await count('guests')).toBe(0);
      expect(await count('guests', a.tenantId)).toBe(0);
    });
  });

  it('cannot read the signing key or install its own', async () => {
    await inTx(async () => {
      await expect(client.query('SELECT key FROM app_private.context_keys')).rejects.toThrow(/permission denied/);
    });
    await inTx(async () => {
      await expect(client.query(`SELECT app_install_context_key('attacker-controlled-key-0123456789abcdef')`)).rejects.toThrow(/permission denied/);
    });
  });

  it('cannot write the plan catalogue or read platform tables any more', async () => {
    await inTx(async () => {
      await expect(client.query(`UPDATE plans SET name = 'x'`)).rejects.toThrow(/permission denied/);
    });
    await inTx(async () => {
      await expect(client.query('SELECT count(*) FROM platform_users')).rejects.toThrow(/permission denied/);
    });
  });

  it('the forged public context exposes no marketplace rows either', async () => {
    await inTx(async () => {
      await client.query(`SELECT set_config('app.context', 'public', true)`);
      expect(await count('properties')).toBe(0);
    });
  });

  it('hotel_platform (no BYPASSRLS) reaches every tenant through its own policies', async () => {
    const p = platformRoleClient();
    await p.connect();
    try {
      const role = await p.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const n = (await p.query('SELECT count(DISTINCT tenant_id)::int AS n FROM guests WHERE tenant_id = ANY($1)', [[a.tenantId, b.tenantId]])).rows[0].n;
      expect(n).toBe(2);
    } finally {
      await p.end();
    }
  });

  it('the platform console still works through the new role', async () => {
    const res = await request(app.getHttpServer())
      .post(`${API}/platform/auth/login`)
      .send({ email: 'admin@devstrike.ng', password: 'Admin1234!' })
      .expect(200);
    const t = await request(app.getHttpServer()).get(`${API}/platform/tenants/${a.tenantId}`).set('Authorization', `Bearer ${res.body.accessToken}`).expect(200);
    expect(t.body.id).toBe(a.tenantId);
  });
});
