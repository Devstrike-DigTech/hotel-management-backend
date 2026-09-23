import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_MS = 60_000;
export const OTP_LOCK_MS = 15 * 60_000;
export const OTP_PER_HOUR = 5;
export const MAGIC_LINK_TTL_MS = 15 * 60_000;

/** Uniform 6-digit code (leading zeros allowed). */
export function generateOtp(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

/**
 * Keyed hash of a code, bound to its challenge id so a hash cannot be reused
 * across challenges. Only this is stored.
 */
export function hashOtp(secret: string, challengeId: string, code: string): string {
  return createHmac('sha256', secret).update(`otp:${challengeId}:${code}`).digest('hex');
}

export function otpMatches(secret: string, challengeId: string, code: string, storedHash: string): boolean {
  const a = Buffer.from(hashOtp(secret, challengeId, code.trim()), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ChallengeState {
  expiresAt: Date;
  consumedAt: Date | null;
  lockedAt: Date | null;
  attempts: number;
  maxAttempts: number;
}

export type AttemptResult =
  | { kind: 'ok' }
  | { kind: 'expired' }
  | { kind: 'locked' }
  | { kind: 'invalid'; attemptsLeft: number; lockNow: boolean };

/**
 * Decides the outcome of one verification attempt. `matches` is the result
 * of the constant-time comparison. A wrong code consumes an attempt; the last
 * allowed wrong code locks the challenge.
 */
export function evaluateAttempt(c: ChallengeState, matches: boolean, now = new Date()): AttemptResult {
  if (c.lockedAt || c.attempts >= c.maxAttempts) return { kind: 'locked' };
  if (c.consumedAt || c.expiresAt <= now) return { kind: 'expired' };
  if (matches) return { kind: 'ok' };
  const used = c.attempts + 1;
  const left = Math.max(0, c.maxAttempts - used);
  return { kind: 'invalid', attemptsLeft: left, lockNow: left === 0 };
}

/** "+234803•••0001" */
export function maskedPhone(e164: string): string {
  return e164.length < 8 ? '•••' : `${e164.slice(0, 7)}•••${e164.slice(-4)}`;
}
