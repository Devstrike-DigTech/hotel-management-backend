import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';

/**
 * Client IP for rate limiting. The web app's server (SSR fetches and its
 * /api/v1 gateway) sends the visitor's IP in X-Client-IP together with
 * X-Proxy-Auth = TRUSTED_PROXY_SECRET. Only when that secret matches
 * (constant-time) and the value is a real IP address is it used; otherwise
 * the socket / trusted-proxy IP (`req.ip`), so a spoofed X-Client-IP from a
 * browser changes nothing.
 */
export function rateLimitIp(req: Pick<Request, 'ip' | 'headers'>, secret: string | undefined): string {
  const fallback = req.ip ?? 'unknown';
  if (!secret) return fallback;
  const auth = header(req, 'x-proxy-auth');
  const claimed = header(req, 'x-client-ip')?.trim();
  if (!auth || !claimed) return fallback;
  const a = Buffer.from(auth);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return fallback;
  const ip = claimed.replace(/^::ffff:/, '');
  return isIP(ip) ? ip : fallback;
}

function header(req: Pick<Request, 'headers'>, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
