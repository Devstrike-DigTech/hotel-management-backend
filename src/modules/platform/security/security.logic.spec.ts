import { base32Decode, base32Encode, totp, verifyTotp, newRecoveryCodes, normaliseRecoveryCode, otpauthUri } from './totp.js';
import { ipAllowed, isValidCidr, normaliseIp } from './cidr.js';
import { platformPermissionsFor, PLATFORM_ROLES } from './platform-permissions.js';
import { allowedOrigins, surfaceOf } from '../../../common/http/surfaces.js';

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 appendix B, SHA-1 secret "12345678901234567890", 8 digits -> last 6 digits here.
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it('round-trips base32', () => {
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(base32Decode(secret.toLowerCase().replace(/(.{4})/g, '$1 ')).toString()).toBe('12345678901234567890');
  });

  it('matches the RFC test vectors (6 digits)', () => {
    expect(totp(secret, new Date(59 * 1000))).toBe('287082');
    expect(totp(secret, new Date(1111111109 * 1000))).toBe('081804');
    expect(totp(secret, new Date(1234567890 * 1000))).toBe('005924');
  });

  it('accepts +-1 step and rejects older codes', () => {
    const at = new Date(1_700_000_000_000);
    const prev = totp(secret, new Date(at.getTime() - 30_000));
    expect(verifyTotp(secret, prev, at)).not.toBeNull();
    expect(verifyTotp(secret, totp(secret, new Date(at.getTime() - 90_000)), at)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', at)).toBeNull();
  });

  it('makes recovery codes and otpauth URIs', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
    expect(normaliseRecoveryCode(' ABCD 1234 ')).toBe(normaliseRecoveryCode('abcd-1234'));
    expect(otpauthUri('ABC', 'a@b.ng', 'HotelOS Console')).toMatch(/^otpauth:\/\/totp\/.+secret=ABC.*issuer=HotelOS/);
  });
});

describe('CIDR allowlists', () => {
  it('validates CIDRs and single addresses', () => {
    expect(isValidCidr('102.89.0.0/16')).toBe(true);
    expect(isValidCidr('41.58.10.4/32')).toBe(true);
    expect(isValidCidr('2001:db8::/32')).toBe(true);
    expect(isValidCidr('300.1.1.1/8')).toBe(false);
    expect(isValidCidr('10.0.0.0/33')).toBe(false);
  });

  it('matches IPv4, IPv4-mapped IPv6 and empty lists', () => {
    expect(ipAllowed('102.89.40.12', ['102.89.0.0/16'])).toBe(true);
    expect(ipAllowed('::ffff:102.89.40.12', ['102.89.0.0/16'])).toBe(true);
    expect(ipAllowed('41.58.10.5', ['41.58.10.4/32'])).toBe(false);
    expect(ipAllowed('8.8.8.8', [])).toBe(true);
    expect(normaliseIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
  });
});

describe('platform roles', () => {
  it('gives SUPER_ADMIN everything and SALES_READONLY only reads', () => {
    const all = platformPermissionsFor('SUPER_ADMIN');
    expect(all.size).toBe(15);
    expect([...platformPermissionsFor('SALES_READONLY')].sort()).toEqual(['billing.view', 'tenants.view']);
    expect(platformPermissionsFor('SUPPORT').has('impersonate')).toBe(true);
    expect(platformPermissionsFor('FINANCE').has('impersonate')).toBe(false);
    expect(platformPermissionsFor('NOPE').size).toBe(0);
    expect(PLATFORM_ROLES.map((r) => r.role)).toEqual(['SUPER_ADMIN', 'OPERATIONS', 'SUPPORT', 'FINANCE', 'SALES_READONLY']);
  });
});

describe('API surfaces (origin separation)', () => {
  const hotel = ['http://localhost:3000', 'http://localhost:3001'];
  const platform = ['http://localhost:3002'];
  it('classifies paths', () => {
    expect(surfaceOf('/api/v1/platform/tenants')).toBe('platform');
    expect(surfaceOf('/api/v1/public/hotels')).toBe('public');
    expect(surfaceOf('/api/partner/v1/me')).toBe('partner');
    expect(surfaceOf('/api/v1/reservations')).toBe('hotel');
  });
  it('allows the right origins per surface', () => {
    expect(allowedOrigins('platform', hotel, platform)).toEqual(platform);
    expect(allowedOrigins('hotel', hotel, platform)).toEqual(hotel);
    expect(allowedOrigins('public', hotel, platform)).toEqual([...hotel, ...platform]);
    expect(allowedOrigins('partner', hotel, platform)).toEqual([]);
  });
});
