/**
 * Outbound requests to URLs that users supply (OTA iCal feeds). Guards
 * against server-side request forgery:
 *
 * - https only in production (http also allowed outside production);
 * - the hostname is resolved and EVERY address must be public: loopback,
 *   private, link-local (incl. cloud metadata 169.254.169.254), CGNAT,
 *   multicast, reserved and documentation ranges are refused for IPv4 and
 *   IPv6, with IPv4-mapped / NAT64 / 6to4 addresses checked as IPv4;
 * - the connection is pinned to the vetted address (no second DNS lookup, so
 *   DNS rebinding cannot swap in an internal address), TLS still verifies the
 *   hostname;
 * - redirects are followed only after re-validating each hop (at most 3);
 * - a response size cap (default 2 MB), an overall timeout (default 10 s)
 *   and an allowed content-type list.
 *
 * `allowPrivateHosts` (development and tests only) exempts named hosts from
 * the address check, e.g. `localhost` for a local feed stub.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

export type UnsafeUrlReason =
  | 'INVALID_URL'
  | 'SCHEME_NOT_ALLOWED'
  | 'CREDENTIALS_NOT_ALLOWED'
  | 'HOST_NOT_ALLOWED'
  | 'DNS_FAILED'
  | 'TOO_MANY_REDIRECTS'
  | 'BAD_STATUS'
  | 'BAD_CONTENT_TYPE'
  | 'TOO_LARGE'
  | 'TIMEOUT';

export class UnsafeUrlError extends Error {
  constructor(
    readonly reason: UnsafeUrlReason,
    message: string,
  ) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface SafeFetchOptions {
  production: boolean;
  /** Hostnames (lowercase) exempt from the private-address check. Never in production. */
  allowPrivateHosts?: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Allowed media types (without parameters). */
  accept?: readonly string[];
  /** DNS resolution (injectable for tests). */
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
}

const V4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  V4.addSubnet(net, prefix, 'ipv4');
}

const V6 = new BlockList();
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback (::1), IPv4-compatible
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments (Teredo etc.)
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local (incl. fd00:ec2::254 metadata)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  V6.addSubnet(net, prefix, 'ipv6');
}

/** Eight 16-bit groups of an IPv6 address (handles "::" and a dotted IPv4 tail). */
function ipv6Groups(address: string): number[] | null {
  let a = address.toLowerCase().split('%')[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (dotted) {
    const p = dotted[1]!.split('.').map(Number);
    if (p.some((n) => n > 255)) return null;
    a = a.slice(0, -dotted[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(':').map((h) => parseInt(h, 16)) : []);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...Array<number>(fill).fill(0), ...tail];
  return groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4From = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/** True when an address must not be contacted (anything not plainly public). */
export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return V4.check(address, 'ipv4');
  if (kind !== 6) return true;
  const g = ipv6Groups(address);
  if (!g) return true;
  // IPv4-mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embed an IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isBlockedAddress(v4From(g[6]!, g[7]!));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isBlockedAddress(v4From(g[6]!, g[7]!));
  if (g[0] === 0x2002) return isBlockedAddress(v4From(g[1]!, g[2]!));
  const canonical = g.map((x) => x.toString(16)).join(':');
  return V6.check(canonical, 'ipv6');
}

async function systemResolve(host: string): Promise<ResolvedAddress[]> {
  const all = await dnsLookup(host, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

/** Parses and checks a URL without network access (scheme, credentials, IP literals). */
export function checkUrlSyntax(raw: string, o: Pick<SafeFetchOptions, 'production' | 'allowPrivateHosts'>): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('INVALID_URL', 'Not a valid URL');
  }
  const schemes = o.production ? ['https:'] : ['https:', 'http:'];
  if (!schemes.includes(url.protocol)) throw new UnsafeUrlError('SCHEME_NOT_ALLOWED', o.production ? 'Only https:// URLs are allowed' : 'Only http(s):// URLs are allowed');
  if (url.username || url.password) throw new UnsafeUrlError('CREDENTIALS_NOT_ALLOWED', 'URLs with a user name or password are not allowed');
  const host = hostOf(url);
  if (!host) throw new UnsafeUrlError('INVALID_URL', 'The URL has no host');
  if (isIP(host) && isBlockedAddress(host) && !exempt(host, o)) throw new UnsafeUrlError('HOST_NOT_ALLOWED', 'That address is not reachable from the internet');
  return url;
}

const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
const exempt = (host: string, o: Pick<SafeFetchOptions, 'production' | 'allowPrivateHosts'>) => !o.production && (o.allowPrivateHosts ?? []).includes(host);

/** Checks the URL and resolves it to a vetted public address. */
export async function vetUrl(raw: string, o: SafeFetchOptions): Promise<{ url: URL; pinned: ResolvedAddress }> {
  const url = checkUrlSyntax(raw, o);
  const host = hostOf(url);
  const literal = isIP(host);
  let addresses: ResolvedAddress[];
  if (literal) addresses = [{ address: host, family: literal === 6 ? 6 : 4 }];
  else {
    try {
      addresses = await (o.resolve ?? systemResolve)(host);
    } catch (e) {
      throw new UnsafeUrlError('DNS_FAILED', `Could not resolve ${host}: ${(e as Error).message}`);
    }
  }
  if (!addresses.length) throw new UnsafeUrlError('DNS_FAILED', `Could not resolve ${host}`);
  // Every address must be public: an attacker's name may list a private one next to a public one.
  if (!exempt(host, o) && addresses.some((a) => isBlockedAddress(a.address))) {
    throw new UnsafeUrlError('HOST_NOT_ALLOWED', `${host} resolves to an address that is not reachable from the internet`);
  }
  return { url, pinned: addresses[0]! };
}

function requestOnce(url: URL, pinned: ResolvedAddress, o: Required<Pick<SafeFetchOptions, 'maxBytes'>> & { signal: AbortSignal; headers: Record<string, string>; method?: string; payload?: string | Buffer }): Promise<{ res: IncomingMessage; body: () => Promise<Buffer> }> {
  const lookup: LookupFunction = (_hostname, options, cb) => {
    if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: pinned.address, family: pinned.family }]);
    else cb(null, pinned.address, pinned.family);
  };
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      { method: o.method ?? 'GET', headers: o.headers, lookup, signal: o.signal, agent: false },
      (res) => {
        resolve({
          res,
          body: () =>
            new Promise<Buffer>((ok, fail) => {
              const chunks: Buffer[] = [];
              let size = 0;
              res.on('data', (c: Buffer) => {
                size += c.length;
                if (size > o.maxBytes) {
                  res.destroy();
                  fail(new UnsafeUrlError('TOO_LARGE', `The response is larger than ${Math.round(o.maxBytes / 1024)} KB`));
                  return;
                }
                chunks.push(c);
              });
              res.on('end', () => ok(Buffer.concat(chunks)));
              res.on('error', fail);
            }),
        });
      },
    );
    req.on('error', reject);
    req.end(o.payload);
  });
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  /** Response body (truncated to maxBytes; never throws for size). */
  body: string;
  durationMs: number;
}

/**
 * One request (webhook deliveries, OIDC token calls) under the same guards:
 * vetted and pinned address, no redirects followed (a 3xx is returned as
 * is), timeout. The body is read up to `maxBytes` and truncated silently.
 */
export async function safeRequest(
  raw: string,
  req: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
  opts: SafeFetchOptions,
): Promise<SafeResponse> {
  const o = { maxBytes: 64 * 1024, timeoutMs: 10_000, ...opts };
  const signal = AbortSignal.timeout(o.timeoutMs);
  const started = Date.now();
  const { url, pinned } = await vetUrl(raw, o);
  const headers = { ...req.headers, ...(req.body !== undefined && { 'content-length': String(Buffer.byteLength(req.body)) }) };
  try {
    const { res } = await requestOnce(url, pinned, { maxBytes: o.maxBytes, signal, headers, method: req.method, payload: req.body });
    const chunks: Buffer[] = [];
    let size = 0;
    await new Promise<void>((ok, fail) => {
      res.on('data', (c: Buffer) => {
        if (size < o.maxBytes) chunks.push(c.subarray(0, o.maxBytes - size));
        size += c.length;
      });
      res.on('end', () => ok());
      res.on('error', fail);
    });
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : String(v);
    return { status: res.statusCode ?? 0, headers: out, body: Buffer.concat(chunks).toString('utf8'), durationMs: Date.now() - started };
  } catch (e) {
    if (signal.aborted) throw new UnsafeUrlError('TIMEOUT', `No complete answer within ${Math.round(o.timeoutMs / 1000)} s`);
    throw e;
  }
}

/** GETs a user-supplied URL as text under the guards above. */
export async function safeFetchText(raw: string, opts: SafeFetchOptions): Promise<string> {
  const o = { maxBytes: 2 * 1024 * 1024, timeoutMs: 10_000, maxRedirects: 3, accept: ['text/calendar', 'text/plain'], ...opts };
  const signal = AbortSignal.timeout(o.timeoutMs);
  let current = raw;
  try {
    for (let hop = 0; ; hop++) {
      const { url, pinned } = await vetUrl(current, o);
      const { res, body } = await requestOnce(url, pinned, { maxBytes: o.maxBytes, signal, headers: { accept: o.accept.join(', '), 'user-agent': 'hotel-calendar-sync/1.0' } });
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hop >= o.maxRedirects) throw new UnsafeUrlError('TOO_MANY_REDIRECTS', `More than ${o.maxRedirects} redirects`);
        current = new URL(res.headers.location, url).toString();
        continue;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        throw new UnsafeUrlError('BAD_STATUS', `HTTP ${status}`);
      }
      const type = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (!o.accept.includes(type)) {
        res.resume();
        throw new UnsafeUrlError('BAD_CONTENT_TYPE', `Unexpected content type ${type || '(none)'}; expected ${o.accept.join(' or ')}`);
      }
      return (await body()).toString('utf8');
    }
  } catch (e) {
    if (e instanceof UnsafeUrlError) throw e;
    if (signal.aborted) throw new UnsafeUrlError('TIMEOUT', `No complete answer within ${Math.round(o.timeoutMs / 1000)} s`);
    throw e;
  }
}
