import { defineConfig } from 'vitest/config';

const DB = process.env.E2E_DB_NAME ?? 'hotel_test';
const PG_HOST = process.env.E2E_PG_HOST ?? 'localhost:5432';

const env: Record<string, string> = {
  TZ: 'UTC',
  NODE_ENV: 'test',
  E2E_DB_NAME: DB,
  DATABASE_URL: `postgresql://hotel_app:hotel_app@${PG_HOST}/${DB}`,
  DATABASE_MIGRATION_URL: `postgresql://hotel:hotel@${PG_HOST}/${DB}`,
  DATABASE_PLATFORM_URL: `postgresql://hotel_platform:hotel_platform@${PG_HOST}/${DB}`,
  DB_CONTEXT_SECRET: 'e2e-db-context-secret-0123456789abcdef0123',
  GUEST_DATA_KEY: 'e2e-guest-data-key-0123456789abcdef0123456',
  SHARE_TOKEN_SECRET: 'e2e-share-token-secret-0123456789abcdef012',
  API_PUBLIC_URL: 'http://localhost:4000',
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: `./storage-e2e`,
  JOBS_ENABLED: 'false',
  SWAGGER_ENABLED: 'false',
  AUTH_RATE_LIMIT: '10000',
  PAYSTACK_SECRET_KEY: 'sk_test_e2e_0123456789abcdef',
  PAYSTACK_BASE_URL: 'http://127.0.0.1:48999',
  APP_NAME: 'HotelOS',
  APP_DOMAIN: 'hotelos.test',
  SUPPORT_EMAIL: 'support@hotelos.test',
  JWT_ACCESS_SECRET: 'e2e-access-secret-0123456789abcdef0123',
  JWT_PLATFORM_SECRET: 'e2e-platform-secret-0123456789abcdef0123',
  JWT_REFRESH_SECRET: 'e2e-refresh-secret-0123456789abcdef0123',
  REDIS_URL: 'redis://localhost:6379',
  ADMIN_URL: 'http://localhost:3001',
  WEB_URL: 'http://localhost:3000',
};

// The global setup runs in this (main) process, so it needs the same values.
Object.assign(process.env, env);

/**
 * End-to-end tests run the real Nest app (supertest) against a throwaway
 * database `hotel_test` on the local Postgres, as the restricted runtime role,
 * so RLS is exercised exactly as in production.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env,
  },
});
