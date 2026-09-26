import { validateEnv, withoutBlankValues } from './env.schema.js';

const base = {
  APP_NAME: 'HotelOS',
  APP_DOMAIN: 'hotelos.ng',
  SUPPORT_EMAIL: 'support@hotelos.ng',
  DATABASE_URL: 'postgresql://hotel_app:hotel_app@localhost:5432/hotel',
  DATABASE_PLATFORM_URL: 'postgresql://hotel_platform:hotel_platform@localhost:5432/hotel',
  DB_CONTEXT_SECRET: 'x'.repeat(40),
  GUEST_DATA_KEY: 'g'.repeat(40),
  SHARE_TOKEN_SECRET: 's'.repeat(40),
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_PLATFORM_SECRET: 'p'.repeat(40),
  JWT_REFRESH_SECRET: 'r'.repeat(40),
  ADMIN_URL: 'http://localhost:3001',
  WEB_URL: 'http://localhost:3000',
  GUEST_JWT_SECRET: 'j'.repeat(40),
  GUEST_TOKEN_SECRET: 't'.repeat(40),
};

describe('env schema: blank values mean "not set"', () => {
  it('drops empty and whitespace-only values', () => {
    expect(withoutBlankValues({ A: '', B: '  ', C: 'x', D: 0 })).toEqual({ C: 'x', D: 0 });
  });

  it('boots with the empty optional values of .env.example', () => {
    const env = validateEnv({
      ...base,
      PLATFORM_DATA_KEY: '',
      PLATFORM_ALERT_EMAIL: '',
      CUSTOM_DOMAIN_TARGET: '',
      STAFF_PORTAL_TARGET: '',
      SMTP_PASS: '',
      DATABASE_ADMIN_URL: '',
      PLATFORM_APP_URL: '',
      TRUSTED_PROXY_SECRET: '',
      DNS_PROVIDER: '',
      OIDC_MOCK_ENABLED: '',
      PORT: '',
    });
    expect(env.PLATFORM_DATA_KEY).toBeUndefined();
    expect(env.PLATFORM_ALERT_EMAIL).toBeUndefined();
    expect(env.CUSTOM_DOMAIN_TARGET).toBeUndefined();
    expect(env.STAFF_PORTAL_TARGET).toBeUndefined();
    expect(env.SMTP_PASS).toBeUndefined();
    expect(env.DATABASE_ADMIN_URL).toBeUndefined();
    expect(env.PORT).toBe(4000);
  });

  it('still reports an empty required value as missing', () => {
    expect(() => validateEnv({ ...base, GUEST_DATA_KEY: '' })).toThrow(/GUEST_DATA_KEY/);
  });
});
