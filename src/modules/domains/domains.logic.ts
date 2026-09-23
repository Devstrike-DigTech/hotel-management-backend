/**
 * Custom domain rules (pure): normalising what the owner typed, refusing
 * apex domains, the DNS records to publish and reading the check results.
 */

/** Second-level public suffixes common for Nigerian and international hotels. */
const TWO_LEVEL_SUFFIXES = new Set([
  'com.ng', 'org.ng', 'net.ng', 'gov.ng', 'edu.ng', 'name.ng', 'mil.ng', 'sch.ng', 'mobi.ng', 'i.ng',
  'co.uk', 'org.uk', 'co.za', 'com.gh', 'co.ke', 'com.au', 'co.in',
]);

export type DomainProblem = 'INVALID' | 'APEX';

/** "https://Book.TheirHotel.com/path" -> "book.theirhotel.com" (or null when it is not a hostname). */
export function normaliseDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0]!.replace(/:\d+$/, '').replace(/\.$/, '');
  if (s.length > 253 || !s.includes('.')) return null;
  const labels = s.split('.');
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  if (!/^[a-z]{2,}$/.test(labels[labels.length - 1]!)) return null;
  return s;
}

/** True for a registrable domain with no subdomain ("theirhotel.com", "theirhotel.com.ng"). */
export function isApex(domain: string): boolean {
  const labels = domain.split('.');
  const suffix2 = labels.slice(-2).join('.');
  const suffixLabels = TWO_LEVEL_SUFFIXES.has(suffix2) ? 2 : 1;
  return labels.length <= suffixLabels + 1;
}

export function domainProblem(input: string): { domain: string | null; problem: DomainProblem | null } {
  const domain = normaliseDomain(input);
  if (!domain) return { domain: null, problem: 'INVALID' };
  if (isApex(domain)) return { domain, problem: 'APEX' };
  return { domain, problem: null };
}

/** "HotelOS" -> "hotelos" */
export function verifyPrefix(appName: string): string {
  return appName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site';
}

export function expectedRecords(domain: string, token: string, prefix: string, target: string) {
  return {
    txt: { type: 'TXT' as const, name: `_${prefix}-verify.${domain}`, value: `${prefix}-verify=${token}` },
    cname: { type: 'CNAME' as const, name: domain, value: target.toLowerCase() },
  };
}

export type DomainCheckFailure = 'TXT_MISSING' | 'TXT_MISMATCH' | 'CNAME_MISSING' | 'CNAME_MISMATCH' | 'DNS_ERROR';

export function readCheck(expect: ReturnType<typeof expectedRecords>, found: { txt: string[]; cname: string[] } | null): { txtOk: boolean | null; cnameOk: boolean | null; failures: DomainCheckFailure[] } {
  if (!found) return { txtOk: null, cnameOk: null, failures: ['DNS_ERROR'] };
  const failures: DomainCheckFailure[] = [];
  const txtOk = found.txt.some((v) => v.trim() === expect.txt.value);
  if (!txtOk) failures.push(found.txt.length ? 'TXT_MISMATCH' : 'TXT_MISSING');
  const cnameOk = found.cname.some((v) => v.replace(/\.$/, '') === expect.cname.value);
  if (!cnameOk) failures.push(found.cname.length ? 'CNAME_MISMATCH' : 'CNAME_MISSING');
  return { txtOk, cnameOk, failures };
}

export const PENDING_GIVE_UP_MS = 72 * 3_600_000;
export const VERIFIED_GRACE_MS = 3 * 24 * 3_600_000;
export const VERIFIED_RECHECK_MS = 24 * 3_600_000;
