import type { AppConfigService } from '../../config/app-config.service.js';
import { BookingTokens } from './booking-tokens.service.js';

const config = { get: (k: string) => ({ GUEST_TOKEN_SECRET: 'unit-guest-token-secret-0123456789abcdef', WEB_URL: 'http://web', API_PUBLIC_URL: 'http://api' })[k] } as unknown as AppConfigService;
const tokens = new BookingTokens(config);
const TID = '11111111-1111-1111-1111-111111111111';
const RID = '22222222-2222-2222-2222-222222222222';

describe('BookingTokens', () => {
  it('round-trips a quote and rejects tampering', () => {
    const { token } = tokens.signQuote({ tid: TID, pid: TID, rt: RID, ch: 'MARKETPLACE', st: 'NIGHTLY', a: 'x', d: 'y', day: '2026-10-01', u: 2, ad: 2, cd: 0, rate: 100, tax: [], total: 200 });
    expect(tokens.verifyQuote(token).total).toBe(200);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), total: 1 })).toString('base64url');
    expect(() => tokens.verifyQuote(`${forged}.${sig}`)).toThrow(expect.objectContaining({ code: 'QUOTE_INVALID' }));
  });

  it('reports an expired quote as QUOTE_EXPIRED', () => {
    const old = new Date(Date.now() - 16 * 60_000);
    const { token } = tokens.signQuote({ tid: TID, pid: TID, rt: RID, ch: 'MARKETPLACE', st: 'NIGHTLY', a: 'x', d: 'y', day: '2026-10-01', u: 1, ad: 1, cd: 0, rate: 1, tax: [], total: 1 }, old);
    expect(() => tokens.verifyQuote(token)).toThrow(expect.objectContaining({ code: 'QUOTE_EXPIRED' }));
  });

  it('binds a trip token to its booking code and keeps kinds apart', () => {
    const t = tokens.signTrip(TID, RID, 'PWH-7K3Q', new Date(Date.now() + 86_400_000));
    expect(tokens.verifyTrip(t, 'pwh-7k3q')).toEqual({ tenantId: TID, reservationId: RID });
    expect(() => tokens.verifyTrip(t, 'PWH-AAAA')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => tokens.verifyQuote(t)).toThrow(expect.objectContaining({ code: 'QUOTE_INVALID' }));
    const expired = tokens.signTrip(TID, RID, 'PWH-7K3Q', new Date(Date.now() - 100 * 86_400_000));
    expect(() => tokens.verifyTrip(expired, 'PWH-7K3Q')).toThrow(expect.objectContaining({ code: 'LINK_EXPIRED' }));
  });

  it('still identifies the stay behind an expired review link', () => {
    const { token } = tokens.signReview(TID, RID, new Date(Date.now() - 40 * 86_400_000));
    expect(tokens.readReview(token)).toEqual({ tenantId: TID, reservationId: RID, expired: true });
  });
});
