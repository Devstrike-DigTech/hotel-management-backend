import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { API, createApp, platformAuth } from './helpers.js';

describe('Public API', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(`${API}${path}`);

  it('GET /health', async () => {
    await get('/health').expect(200, { status: 'ok' });
  });

  it('GET /public/app reads the product name from env', async () => {
    await get('/public/app').expect(200, {
      appName: 'HotelOS',
      appDomain: 'hotelos.test',
      supportEmail: 'support@hotelos.test',
    });
  });

  it('GET /public/plans returns the four seeded plans in order', async () => {
    const res = await get('/public/plans').expect(200);
    expect(res.body.map((p: { code: string }) => p.code)).toEqual(['starter', 'growth', 'pro', 'enterprise']);
    const growth = res.body[1];
    expect(growth).toMatchObject({
      priceMonthlyKobo: 7_500_000,
      priceYearlyKobo: 75_000_000,
      limits: { max_rooms: 60, max_staff: 15, max_properties: 1 },
      commissionBps: 800,
      highlighted: true,
    });
    expect(growth.features).toContain('housekeeping');
    expect(res.body[3]).toMatchObject({ priceMonthlyKobo: null, commissionBps: null, limits: { max_rooms: -1 } });
  });

  it('GET /public/features lists 37 features in the five categories (M7 added eight)', async () => {
    const res = await get('/public/features').expect(200);
    expect(res.body).toHaveLength(37);
    const cats = new Set<string>(res.body.map((f: { category: string }) => f.category));
    expect([...cats].sort((x, y) => x.localeCompare(y))).toEqual(['Growth', 'Guests', 'Operations', 'Platform', 'Revenue']);
  });

  it('GET /public/hotels filters and paginates', async () => {
    const all = await get('/public/hotels').expect(200);
    expect(all.body).toMatchObject({ page: 1, pageSize: 12 });
    expect(all.body.total).toBeGreaterThanOrEqual(9);
    const lagos = await get('/public/hotels?city=lagos&pageSize=2').expect(200);
    expect(lagos.body.items).toHaveLength(2);
    expect(lagos.body.items.every((h: { city: string }) => h.city === 'Lagos')).toBe(true);
    const cheap = await get('/public/hotels?maxPriceKobo=4000000').expect(200);
    for (const h of cheap.body.items) expect(h.startingRateKobo).toBeLessThanOrEqual(4_000_000);
  });

  it('GET /public/hotels/:slug returns the detail shape', async () => {
    const res = await get('/public/hotels/palmwine-house').expect(200);
    expect(res.body).toMatchObject({
      slug: 'palmwine-house',
      name: 'The Palmwine House',
      area: 'Lekki Phase 1',
      // M4: cheapest one-night plan over the next 60 days, the seeded Non-refundable rate (BAR 55,000 less 10%).
      startingRateKobo: 4_950_000,
      branding: { accentColor: '#B4452A', logoUrl: null },
    });
    expect(res.body.roomTypes).toHaveLength(3);
    expect(res.body.roomTypes[0]).toEqual(
      expect.objectContaining({ availableCount: expect.any(Number), images: expect.any(Array) }),
    );
  });

  it('GET /public/resolve-host maps subdomains and rejects reserved hosts', async () => {
    // M5: the demo group has two properties, so its own subdomain is the group root.
    const group = await get('/public/resolve-host?host=palmwine-house.hotelos.test').expect(200);
    expect(group.body).toMatchObject({ slug: 'palmwine-house', kind: 'GROUP', groupSlug: 'palmwine-house' });
    const ikoyi = await get('/public/resolve-host?host=palmwine-house-ikoyi.hotelos.test').expect(200);
    expect(ikoyi.body).toMatchObject({ slug: 'palmwine-house-ikoyi', kind: 'PROPERTY', groupSlug: 'palmwine-house' });
    await get('/public/resolve-host?host=www.hotelos.test').expect(404);
    await get('/public/resolve-host?host=unknown.example.com').expect(404);
  });

  it('suspended hotels disappear from the marketplace', async () => {
    const platform = await platformAuth(app);
    const list = await request(app.getHttpServer())
      .get(`${API}/platform/tenants?q=marina-creek`)
      .set(platform)
      .expect(200);
    const id = list.body.items[0].id;
    await request(app.getHttpServer())
      .patch(`${API}/platform/tenants/${id}/subscription`)
      .set(platform)
      .send({ status: 'SUSPENDED' })
      .expect(200);
    await get('/public/hotels/marina-creek').expect(404);
    const res = await get('/public/hotels?city=Calabar').expect(200);
    expect(res.body.items).toHaveLength(0);
    await request(app.getHttpServer())
      .patch(`${API}/platform/tenants/${id}/subscription`)
      .set(platform)
      .send({ status: 'ACTIVE' })
      .expect(200);
    await get('/public/hotels/marina-creek').expect(200);
  });
});
