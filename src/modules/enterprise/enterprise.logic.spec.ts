import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { couponDiscount, couponProblem, monthsAfter } from '../billing/coupons.logic.js';
import { announcementState, inAudience, parseAudience } from '../platform/console/announcements.service.js';
import { slaState, supportNumber } from '../platform/console/support.service.js';
import { churnedAt, monthlyRevenueKobo, statusChange, weekStart } from '../platform/platform.service.js';
import { decodeCursor, displayKey, encodeCursor, formatApiKey, keyStatus, parseApiKey, permissionsForScopes, rateLimitsFor } from './api-keys/api-keys.logic.js';
import { emailDomainOf, IdTokenError, pkcePair, verifyIdToken } from './sso/oidc.js';
import { fontByName, mockEmailRecords, validSenderId, COLOR_RE } from './white-label/white-label.logic.js';
import { AUDIT_EVENT_MAP, matchesEvents, MAX_ATTEMPTS, nextAttemptAt, shouldDisable, signatureHeader, verifySignature } from './webhooks/webhooks.logic.js';

const DAY = 86_400_000;

describe('API keys', () => {
  const secret = 'A'.repeat(36) + 'b9Zq';
  it('formats, parses and displays keys', () => {
    const raw = formatApiKey('LIVE', 'ab12cd34ef', secret);
    expect(raw).toBe(`hk_live_ab12cd34ef_${secret}`);
    expect(parseApiKey(raw)).toEqual({ environment: 'LIVE', prefix: 'ab12cd34ef', secret });
    expect(parseApiKey(` hk_test_ab12cd34ef_${secret} `)?.environment).toBe('TEST');
    expect(parseApiKey('hk_live_short_x')).toBeNull();
    expect(parseApiKey(undefined)).toBeNull();
    expect(displayKey('LIVE', 'ab12cd34ef', 'b9Zq')).toBe('hk_live_ab12cd34ef_...b9Zq');
  });
  it('derives status, permissions and limits', () => {
    const now = new Date();
    expect(keyStatus({ revokedAt: null, expiresAt: null }, now)).toBe('ACTIVE');
    expect(keyStatus({ revokedAt: null, expiresAt: new Date(now.getTime() - 1) }, now)).toBe('EXPIRED');
    expect(keyStatus({ revokedAt: now, expiresAt: null }, now)).toBe('REVOKED');
    const perms = permissionsForScopes(['reservations:write', 'rooms:read']);
    expect(perms.has('reservations.create')).toBe(true);
    expect(perms.has('rates.manage')).toBe(false);
    expect(rateLimitsFor('enterprise')).toEqual({ perMinute: 600, perSecond: 50 });
    expect(rateLimitsFor('pro')).toEqual({ perMinute: 120, perSecond: 20 });
  });
  it('round-trips cursors and rejects garbage', () => {
    const at = new Date('2026-09-24T10:00:00.000Z');
    const id = '6f1c3a52-7d7b-4f5e-9a42-1f6c2c9a1b33';
    expect(decodeCursor(encodeCursor(at, id))).toEqual({ createdAt: at, id });
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
});

describe('webhooks', () => {
  it('signs and verifies (with the rotation overlap)', () => {
    const body = '{"id":"evt_1"}';
    const t = Math.floor(Date.now() / 1000);
    const header = signatureHeader(['whsec_new', 'whsec_old'], t, body);
    expect(header.split(',')).toHaveLength(3);
    expect(verifySignature(header, 'whsec_new', body)).toBe(true);
    expect(verifySignature(header, 'whsec_old', body)).toBe(true);
    expect(verifySignature(header, 'whsec_other', body)).toBe(false);
    expect(verifySignature(header, 'whsec_new', `${body} `)).toBe(false);
    expect(verifySignature(header, 'whsec_new', body, (t + 600) * 1000)).toBe(false);
  });
  it('retries with backoff from the first attempt, then gives up', () => {
    const first = new Date('2026-09-24T10:00:00Z');
    expect(nextAttemptAt(first, 1)!.getTime() - first.getTime()).toBe(60_000);
    expect(nextAttemptAt(first, 2)!.getTime() - first.getTime()).toBe(5 * 60_000);
    expect(nextAttemptAt(first, 7)!.getTime() - first.getTime()).toBe(24 * 3_600_000);
    expect(nextAttemptAt(first, MAX_ATTEMPTS)).toBeNull();
    expect(MAX_ATTEMPTS).toBe(8);
  });
  it('disables after a day of failures and at least 10 attempts', () => {
    const now = new Date();
    expect(shouldDisable(new Date(now.getTime() - 25 * 3_600_000), 10, now)).toBe(true);
    expect(shouldDisable(new Date(now.getTime() - 25 * 3_600_000), 9, now)).toBe(false);
    expect(shouldDisable(new Date(now.getTime() - 3_600_000), 50, now)).toBe(false);
    expect(shouldDisable(null, 50, now)).toBe(false);
  });
  it('maps audit actions and subscriptions', () => {
    expect(AUDIT_EVENT_MAP['reservation.booked_online']).toBe('reservation.created');
    expect(AUDIT_EVENT_MAP['folio.payment_recorded']).toBe('payment.received');
    expect(matchesEvents(['*'], 'room.status_changed')).toBe(true);
    expect(matchesEvents(['reservation.created'], 'reservation.cancelled')).toBe(false);
    expect(matchesEvents([], 'webhook.ping')).toBe(true);
  });
});

describe('OIDC ID tokens', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1' };
  const make = (claims: Record<string, unknown>, alg = 'RS256') => {
    const h = Buffer.from(JSON.stringify({ alg, kid: 'k1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: 'https://idp.test', aud: 'client', sub: 's', exp: now + 300, nonce: 'n1', email: 'a@harmattanhotels.com', email_verified: true };
  const expect_ = { issuer: 'https://idp.test', audience: 'client', nonce: 'n1' };
  it('verifies a good token', () => {
    expect(verifyIdToken(make(good), { keys: [jwk] }, expect_).email).toBe('a@harmattanhotels.com');
  });
  it('rejects bad signature, issuer, audience, nonce, expiry and alg', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const otherJwk = { ...(other.publicKey.export({ format: 'jwk' }) as object), kid: 'k1' };
    expect(() => verifyIdToken(make(good), { keys: [otherJwk] }, expect_)).toThrow(IdTokenError);
    expect(() => verifyIdToken(make({ ...good, iss: 'https://evil' }), { keys: [jwk] }, expect_)).toThrow(/Issuer/);
    expect(() => verifyIdToken(make({ ...good, aud: 'other' }), { keys: [jwk] }, expect_)).toThrow(/Audience/);
    expect(() => verifyIdToken(make({ ...good, nonce: 'x' }), { keys: [jwk] }, expect_)).toThrow(/Nonce/);
    expect(() => verifyIdToken(make({ ...good, exp: now - 3600 }), { keys: [jwk] }, expect_)).toThrow(/expired/);
    expect(() => verifyIdToken(make(good, 'none'), { keys: [jwk] }, expect_)).toThrow(/algorithm/);
  });
  it('makes S256 PKCE pairs', () => {
    const { verifier, challenge } = pkcePair();
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
    expect(emailDomainOf('Chuka@HarmattanHotels.com')).toBe('harmattanhotels.com');
  });
});

describe('white-label', () => {
  it('knows the curated fonts, colours and sender IDs', () => {
    expect(fontByName('cormorant garamond')?.category).toBe('serif');
    expect(fontByName('Comic Sans')).toBeNull();
    expect(COLOR_RE.test('#7A2E12')).toBe(true);
    expect(COLOR_RE.test('red')).toBe(false);
    expect(validSenderId('HARMATTAN')).toBe(true);
    expect(validSenderId('12345')).toBe(false);
    expect(validSenderId('TOOLONGSENDERID')).toBe(false);
    expect(mockEmailRecords('mail.x.com').map((r) => r.purpose)).toEqual(['SPF', 'SPF', 'DKIM', 'DMARC']);
  });
});

describe('coupons', () => {
  const base = { code: 'X', name: 'X', durationMonths: null, active: true, validFrom: null, validUntil: null, maxRedemptions: null, redemptions: 0, planCodes: [] as string[], intervals: [] as string[], percentOff: 50, amountOffKobo: null };
  it('checks eligibility', () => {
    expect(couponProblem(base, 'pro', 'MONTHLY')).toBeNull();
    expect(couponProblem({ ...base, planCodes: ['growth'] }, 'pro', 'MONTHLY')).toMatch(/pro plan/);
    expect(couponProblem({ ...base, intervals: ['YEARLY'] }, 'pro', 'MONTHLY')).toMatch(/monthly/);
    expect(couponProblem({ ...base, maxRedemptions: 1, redemptions: 1 }, 'pro', 'MONTHLY')).toMatch(/used up/);
    expect(couponProblem({ ...base, validUntil: new Date(Date.now() - 1) }, 'pro', 'MONTHLY')).toMatch(/expired/);
  });
  it('computes discounts and remaining months', () => {
    expect(couponDiscount({ percentOff: 50, amountOffKobo: null }, 1_000_001)).toBe(500_001);
    expect(couponDiscount({ percentOff: null, amountOffKobo: 5_000_000 }, 1_000_000)).toBe(1_000_000);
    expect(monthsAfter(3, 'MONTHLY')).toBe(2);
    expect(monthsAfter(3, 'YEARLY')).toBe(0);
    expect(monthsAfter(null, 'MONTHLY')).toBeNull();
  });
});

describe('platform console logic', () => {
  it('uses the Enterprise custom price for MRR', () => {
    const plan = { priceMonthlyKobo: 5_000_000, priceYearlyKobo: 48_000_000 };
    expect(monthlyRevenueKobo(plan, 'MONTHLY')).toBe(5_000_000);
    expect(monthlyRevenueKobo(plan, 'YEARLY')).toBe(4_000_000);
    expect(monthlyRevenueKobo(plan, 'MONTHLY', 125_000_000)).toBe(125_000_000);
    expect(monthlyRevenueKobo(plan, 'YEARLY', 120_000_000)).toBe(10_000_000);
  });
  it('dates churn and status changes', () => {
    const at = new Date();
    expect(churnedAt({ status: 'CANCELLED', cancelledAt: at, suspendedAt: null })).toBe(at);
    expect(churnedAt({ status: 'ACTIVE', cancelledAt: at, suspendedAt: null })).toBeNull();
    const d = statusChange({ currentPeriodEnd: null }, 'ACTIVE', at);
    expect(d.suspendedAt).toBeNull();
    expect((d.currentPeriodEnd as Date).getTime() - at.getTime()).toBe(30 * DAY);
    expect(statusChange({ currentPeriodEnd: null }, 'SUSPENDED', at).suspendedAt).toBe(at);
    expect(weekStart(new Date('2026-09-24T12:00:00Z'))).toBe('2026-09-21');
  });
  it('targets announcements and derives their state', () => {
    const t = { id: 't1', planCode: 'pro', cities: ['Lagos'] };
    expect(inAudience({ kind: 'ALL' }, t)).toBe(true);
    expect(inAudience(parseAudience({ kind: 'PLANS', planCodes: ['pro'] }), t)).toBe(true);
    expect(inAudience(parseAudience({ kind: 'CITIES', cities: [' lagos '] }), t)).toBe(true);
    expect(inAudience(parseAudience({ kind: 'TENANTS', tenantIds: ['t2'] }), t)).toBe(false);
    expect(parseAudience({ kind: 'WHAT' })).toEqual({ kind: 'ALL' });
    const now = new Date();
    const base = { archivedAt: null, publishedAt: now, endedAt: null, endsAt: null, startsAt: new Date(now.getTime() - 1000) };
    expect(announcementState(base, now)).toBe('ACTIVE');
    expect(announcementState({ ...base, publishedAt: null }, now)).toBe('DRAFT');
    expect(announcementState({ ...base, startsAt: new Date(now.getTime() + DAY) }, now)).toBe('SCHEDULED');
    expect(announcementState({ ...base, endsAt: new Date(now.getTime() - 1) }, now)).toBe('ENDED');
  });
  it('tracks support SLAs', () => {
    const createdAt = new Date('2026-09-24T08:00:00Z');
    const due = new Date('2026-09-24T10:00:00Z');
    expect(slaState({ createdAt, firstResponseDue: due, firstRespondedAt: null }, new Date('2026-09-24T08:30:00Z'))).toBe('ON_TRACK');
    expect(slaState({ createdAt, firstResponseDue: due, firstRespondedAt: null }, new Date('2026-09-24T09:45:00Z'))).toBe('DUE_SOON');
    expect(slaState({ createdAt, firstResponseDue: due, firstRespondedAt: null }, new Date('2026-09-24T11:00:00Z'))).toBe('BREACHED');
    expect(slaState({ createdAt, firstResponseDue: due, firstRespondedAt: new Date('2026-09-24T09:00:00Z') })).toBe('MET');
    expect(slaState({ createdAt, firstResponseDue: due, firstRespondedAt: new Date('2026-09-24T12:00:00Z') })).toBe('MISSED');
    expect(supportNumber(123)).toBe('SR-000123');
  });
});
