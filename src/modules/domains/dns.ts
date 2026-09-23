import { resolveCname, resolveTxt } from 'node:dns/promises';

/** DNS lookups used to verify custom domains (mockable in development and tests). */
export interface DnsResolver {
  readonly kind: 'system' | 'mock';
  txt(name: string): Promise<string[]>;
  cname(name: string): Promise<string[]>;
}

export const DNS_RESOLVER = Symbol('DNS_RESOLVER');

/** A lookup error that is not "no such record" (the check is retried later). */
export class DnsLookupError extends Error {}

const MISSING = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

async function lookup<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (MISSING.has(code)) return [];
    throw new DnsLookupError(`${code || 'DNS'}: ${(e as Error).message}`);
  }
}

const clean = (s: string) => s.trim().toLowerCase().replace(/\.$/, '');

export class SystemDnsResolver implements DnsResolver {
  readonly kind = 'system' as const;

  async txt(name: string) {
    return (await lookup(() => resolveTxt(name))).map((chunks) => chunks.join(''));
  }

  async cname(name: string) {
    return (await lookup(() => resolveCname(name))).map(clean);
  }
}

/** In-memory DNS for development and tests (shared by the process). */
export class MockDnsResolver implements DnsResolver {
  readonly kind = 'mock' as const;
  private static readonly records = new Map<string, string[]>();

  static set(name: string, type: 'TXT' | 'CNAME', value: string) {
    const key = `${type}:${clean(name)}`;
    const cur = MockDnsResolver.records.get(key) ?? [];
    if (type === 'CNAME') MockDnsResolver.records.set(key, [clean(value)]);
    else if (!cur.includes(value)) MockDnsResolver.records.set(key, [...cur, value]);
  }

  static clear(name?: string) {
    if (!name) return MockDnsResolver.records.clear();
    for (const type of ['TXT', 'CNAME']) MockDnsResolver.records.delete(`${type}:${clean(name)}`);
  }

  async txt(name: string) {
    return MockDnsResolver.records.get(`TXT:${clean(name)}`) ?? [];
  }

  async cname(name: string) {
    return MockDnsResolver.records.get(`CNAME:${clean(name)}`) ?? [];
  }
}
