import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

/** Which API surface a path belongs to (M6 origin separation). */
export type Surface = 'platform' | 'public' | 'partner' | 'hotel';

export function surfaceOf(path: string): Surface {
  if (path.startsWith('/api/partner/')) return 'partner';
  if (path.startsWith('/api/v1/platform/') || path === '/api/v1/platform') return 'platform';
  if (path.startsWith('/api/v1/public/') || path === '/api/v1/health' || path.startsWith('/api/v1/files/') || path.startsWith('/api/v1/dev/')) return 'public';
  return 'hotel';
}

/** Browser origins allowed to call a surface. */
export function allowedOrigins(surface: Surface, hotel: readonly string[], platform: readonly string[]): readonly string[] {
  switch (surface) {
    case 'platform':
      return platform;
    case 'public':
      return [...hotel, ...platform];
    case 'partner':
      return [];
    case 'hotel':
      return hotel;
  }
}

const REQUEST_ID = /^[A-Za-z0-9_.:-]{8,128}$/;

/**
 * X-Request-Id on every response (echoing a well-formed client value), and
 * the origin firewall: a browser request whose Origin may not call the
 * surface is refused with 403 ORIGIN_NOT_ALLOWED before any handler runs,
 * so the hotel apps can never call the platform API (and the other way
 * round), not even with "simple" requests that skip CORS preflight.
 */
export function surfaceMiddleware(hotel: readonly string[], platform: readonly string[]) {
  return (req: Request & { requestId?: string }, res: Response, next: NextFunction) => {
    const given = req.headers['x-request-id'];
    const rid = typeof given === 'string' && REQUEST_ID.test(given) ? given : randomUUID();
    req.requestId = rid;
    res.setHeader('X-Request-Id', rid);
    const origin = req.headers.origin;
    if (origin) {
      const surface = surfaceOf(req.path);
      const blocked =
        (surface === 'platform' && !platform.includes(origin)) ||
        (surface === 'hotel' && platform.includes(origin) && !hotel.includes(origin));
      if (blocked) {
        res.status(403).json({ statusCode: 403, code: 'ORIGIN_NOT_ALLOWED', message: 'This application may not call this API', details: { origin, surface } });
        return;
      }
    }
    next();
  };
}
