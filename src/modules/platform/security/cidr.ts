import { BlockList, isIP } from 'node:net';

/** "1.2.3.4", "::ffff:1.2.3.4" -> "1.2.3.4"; anything else unchanged. */
export function normaliseIp(ip: string | undefined | null): string {
  if (!ip) return '';
  const s = ip.trim();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m ? m[1]! : s;
}

/** Parses "10.0.0.0/8", "41.58.10.4" or "2001:db8::/32"; null when invalid. */
export function parseCidr(value: string): { network: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const [addr, bits] = value.trim().split('/');
  const v = isIP(addr ?? '');
  if (!v) return null;
  const family = v === 4 ? 'ipv4' : 'ipv6';
  const max = v === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { network: addr!, prefix, family };
}

export function isValidCidr(value: string): boolean {
  return parseCidr(value) !== null;
}

/** True when `ip` is inside one of the CIDRs (an empty list allows everything). */
export function ipAllowed(ip: string | undefined | null, cidrs: readonly string[]): boolean {
  if (!cidrs.length) return true;
  const addr = normaliseIp(ip);
  const v = isIP(addr);
  if (!v) return false;
  const list = new BlockList();
  for (const c of cidrs) {
    const p = parseCidr(c);
    if (p) list.addSubnet(p.network, p.prefix, p.family);
  }
  return list.check(addr, v === 4 ? 'ipv4' : 'ipv6');
}
