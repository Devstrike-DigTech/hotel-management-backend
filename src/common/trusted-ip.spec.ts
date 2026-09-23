import { rateLimitIp } from './trusted-ip.js';

const SECRET = 'proxy-secret-0123456789abcdef';
const req = (headers: Record<string, string>, ip = '10.0.0.5') => ({ ip, headers });

describe('rateLimitIp', () => {
  it('uses X-Client-IP when X-Proxy-Auth matches the secret', () => {
    expect(rateLimitIp(req({ 'x-client-ip': '102.89.4.7', 'x-proxy-auth': SECRET }), SECRET)).toBe('102.89.4.7');
    expect(rateLimitIp(req({ 'x-client-ip': '::ffff:102.89.4.7', 'x-proxy-auth': SECRET }), SECRET)).toBe('102.89.4.7');
    expect(rateLimitIp(req({ 'x-client-ip': '2c0f:f4c0::1', 'x-proxy-auth': SECRET }), SECRET)).toBe('2c0f:f4c0::1');
  });

  it('ignores a spoofed X-Client-IP without the secret', () => {
    expect(rateLimitIp(req({ 'x-client-ip': '1.2.3.4' }), SECRET)).toBe('10.0.0.5');
    expect(rateLimitIp(req({ 'x-client-ip': '1.2.3.4', 'x-proxy-auth': 'wrong' }), SECRET)).toBe('10.0.0.5');
    expect(rateLimitIp(req({ 'x-client-ip': '1.2.3.4', 'x-proxy-auth': `${SECRET}x` }), SECRET)).toBe('10.0.0.5');
  });

  it('ignores the headers entirely when no secret is configured', () => {
    expect(rateLimitIp(req({ 'x-client-ip': '1.2.3.4', 'x-proxy-auth': '' }), undefined)).toBe('10.0.0.5');
    expect(rateLimitIp(req({ 'x-client-ip': '1.2.3.4', 'x-proxy-auth': SECRET }), '')).toBe('10.0.0.5');
  });

  it('rejects values that are not IP addresses', () => {
    expect(rateLimitIp(req({ 'x-client-ip': 'evil, 1.2.3.4', 'x-proxy-auth': SECRET }), SECRET)).toBe('10.0.0.5');
    expect(rateLimitIp(req({ 'x-client-ip': 'localhost', 'x-proxy-auth': SECRET }), SECRET)).toBe('10.0.0.5');
  });
});

describe('TRUSTED_PROXY_SECRET validation', () => {
  it('is off when empty and must be at least 16 characters when set', async () => {
    const { envSchema } = await import('../config/env.schema.js');
    const field = envSchema.shape.TRUSTED_PROXY_SECRET;
    expect(field.parse(undefined)).toBeUndefined();
    expect(field.parse('  ')).toBeUndefined();
    expect(field.parse(' dev-trusted-proxy-secret ')).toBe('dev-trusted-proxy-secret');
    expect(field.safeParse('too-short').success).toBe(false);
  });
});
