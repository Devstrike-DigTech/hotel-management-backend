import { HttpStatus, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { signToken, verifyToken } from '../../common/crypto/signed-token.js';
import { AppException } from '../../common/errors/app-exception.js';
import { AppConfigService } from '../../config/app-config.service.js';
import type { TaxComponent } from '../folios/tax.logic.js';
import { appError } from '../ops/ops.helpers.js';
import { QUOTE_TTL_MINUTES, REVIEW_WINDOW_DAYS, TRIP_TOKEN_DAYS_AFTER_DEPARTURE, type BookingChannel } from './booking.logic.js';

/** What a quote freezes. Recomputing the price from it gives the same breakdown. */
export interface QuotePayload {
  v: 1;
  /** Nonce: stored on the reservation as quote_ref (idempotent retries). */
  n: string;
  tid: string;
  pid: string;
  rt: string;
  ch: BookingChannel;
  st: 'NIGHTLY' | 'DAY_USE';
  /** arrivalAt / departureAt ISO. */
  a: string;
  d: string;
  /** NIGHTLY: first night + nights. DAY_USE: date + hours. */
  day: string;
  u: number;
  ad: number;
  cd: number;
  rate: number;
  tax: TaxComponent[];
  total: number;
  exp: number;
}

interface TripPayload {
  tid: string;
  rid: string;
  c: string;
  exp: number;
}

interface ReviewPayload {
  tid: string;
  rid: string;
  exp: number;
}

/**
 * Stateless signed tokens for the guest side (GUEST_TOKEN_SECRET), each with
 * its own purpose string so one kind can never be replayed as another.
 * The tenant id inside a token was put there by this API, so services may use
 * it as the RLS context.
 */
@Injectable()
export class BookingTokens {
  constructor(private readonly config: AppConfigService) {}

  private get secret() {
    return this.config.get('GUEST_TOKEN_SECRET');
  }

  signQuote(p: Omit<QuotePayload, 'v' | 'n' | 'exp'>, now = new Date()): { token: string; expiresAt: Date; nonce: string } {
    const expiresAt = new Date(now.getTime() + QUOTE_TTL_MINUTES * 60_000);
    const nonce = randomBytes(9).toString('base64url');
    const token = signToken<QuotePayload>(this.secret, 'quote', { ...p, v: 1, n: nonce, exp: Math.floor(expiresAt.getTime() / 1000) });
    return { token, expiresAt, nonce };
  }

  verifyQuote(token: string): QuotePayload {
    const res = verifyToken<QuotePayload>(this.secret, 'quote', token);
    if (!res.ok) {
      if (res.reason === 'expired') {
        const exp = decodeExp(token);
        throw appError(HttpStatus.GONE, 'QUOTE_EXPIRED', 'This price quote has expired. Check the price again to continue.', {
          expiredAt: exp ? new Date(exp * 1000).toISOString() : null,
        });
      }
      throw appError(HttpStatus.BAD_REQUEST, 'QUOTE_INVALID', 'This price quote is not valid. Check the price again to continue.');
    }
    if (res.payload.v !== 1) throw appError(HttpStatus.BAD_REQUEST, 'QUOTE_INVALID', 'This price quote is not valid.');
    return res.payload;
  }

  signTrip(tenantId: string, reservationId: string, code: string, departureAt: Date): string {
    const exp = Math.floor(departureAt.getTime() / 1000) + TRIP_TOKEN_DAYS_AFTER_DEPARTURE * 86_400;
    return signToken<TripPayload>(this.secret, 'trip', { tid: tenantId, rid: reservationId, c: code, exp });
  }

  /** Throws 404 for a bad token (or code mismatch) and 410 when expired. */
  verifyTrip(token: string | undefined, code: string): { tenantId: string; reservationId: string } {
    if (!token) throw AppException.notFound('Booking');
    const res = verifyToken<TripPayload>(this.secret, 'trip', token);
    if (!res.ok) {
      if (res.reason === 'expired') throw appError(HttpStatus.GONE, 'LINK_EXPIRED', 'This booking link has expired.');
      throw AppException.notFound('Booking');
    }
    if (res.payload.c.toUpperCase() !== code.toUpperCase()) throw AppException.notFound('Booking');
    return { tenantId: res.payload.tid, reservationId: res.payload.rid };
  }

  signReview(tenantId: string, reservationId: string, checkedOutAt: Date): { token: string; deadline: Date } {
    const deadline = new Date(checkedOutAt.getTime() + REVIEW_WINDOW_DAYS * 86_400_000);
    return { token: signToken<ReviewPayload>(this.secret, 'review', { tid: tenantId, rid: reservationId, exp: Math.floor(deadline.getTime() / 1000) }), deadline };
  }

  /** Review tokens: an expired token still identifies the stay (to show "window closed"). */
  readReview(token: string | undefined): { tenantId: string; reservationId: string; expired: boolean } {
    if (!token) throw AppException.notFound('Review link');
    const res = verifyToken<ReviewPayload>(this.secret, 'review', token);
    if (res.ok) return { tenantId: res.payload.tid, reservationId: res.payload.rid, expired: false };
    if (res.reason === 'expired') {
      const body = decodeBody<ReviewPayload>(token);
      if (body) return { tenantId: body.tid, reservationId: body.rid, expired: true };
    }
    throw AppException.notFound('Review link');
  }

  manageUrl(code: string, token: string): string {
    return `${this.config.get('WEB_URL')}/trips/${encodeURIComponent(code)}?t=${encodeURIComponent(token)}`;
  }

  reviewUrl(token: string): string {
    return `${this.config.get('WEB_URL')}/review?t=${encodeURIComponent(token)}`;
  }

  calendarUrl(code: string, token: string): string {
    return `${this.config.get('API_PUBLIC_URL')}/api/v1/public/trips/${encodeURIComponent(code)}/calendar.ics?t=${encodeURIComponent(token)}`;
  }
}

function decodeExp(token: string): number | null {
  return decodeBody<{ exp?: number }>(token)?.exp ?? null;
}

/** Reads the payload of a token whose signature verified but has expired. */
function decodeBody<T>(token: string): T | null {
  try {
    return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}
