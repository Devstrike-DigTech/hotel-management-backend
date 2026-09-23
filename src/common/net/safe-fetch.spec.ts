import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkUrlSyntax, isBlockedAddress, safeFetchText, UnsafeUrlError, vetUrl } from './safe-fetch.js';

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return e instanceof UnsafeUrlError ? e.reason : `other: ${(e as Error).message}`;
  }
};

describe('outbound URL guard', () => {
  it('blocks every non-public IPv4 range', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.254', '0.0.0.0', '224.0.0.1', '239.255.255.250', '255.255.255.255', '192.0.2.10', '198.18.0.1']) {
      expect([a, isBlockedAddress(a)]).toEqual([a, true]);
    }
    for (const a of ['8.8.8.8', '41.58.0.1', '172.32.0.1', '100.128.0.1', '52.95.110.1']) expect([a, isBlockedAddress(a)]).toEqual([a, false]);
  });

  it('blocks non-public IPv6, including IPv4 embedded in mapped, NAT64 and 6to4 addresses', () => {
    for (const a of ['::1', '::', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'fe80::1%eth0', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:0a00:0001::1', '::127.0.0.1', 'not-an-ip']) {
      expect([a, isBlockedAddress(a)]).toEqual([a, true]);
    }
    for (const a of ['2a00:1450:4001:80b::200e', '2606:4700::6810:84e5', '::ffff:8.8.8.8', '64:ff9b::808:808']) expect([a, isBlockedAddress(a)]).toEqual([a, false]);
  });

  it('checks the scheme, credentials and IP literals before any network access', () => {
    expect(() => checkUrlSyntax('http://calendar.example.com/a.ics', { production: true })).toThrow('Only https:// URLs are allowed');
    expect(checkUrlSyntax('http://calendar.example.com/a.ics', { production: false }).hostname).toBe('calendar.example.com');
    for (const u of ['file:///etc/passwd', 'gopher://x', 'ftp://example.com/a.ics']) expect(() => checkUrlSyntax(u, { production: false })).toThrow(UnsafeUrlError);
    expect(() => checkUrlSyntax('https://user:pw@example.com/a.ics', { production: true })).toThrow('user name or password');
    for (const u of ['https://169.254.169.254/latest/meta-data', 'https://[::1]/', 'https://[::ffff:10.0.0.1]/', 'https://2130706433/', 'https://0x7f.1/']) {
      expect(() => checkUrlSyntax(u, { production: true })).toThrow(UnsafeUrlError);
    }
  });

  it('refuses a name when any of its addresses is private', async () => {
    const resolve = async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '10.0.0.5', family: 4 as const },
    ];
    expect(await reason(vetUrl('https://feed.example.com/a.ics', { production: true, resolve }))).toBe('HOST_NOT_ALLOWED');
    const ok = await vetUrl('https://feed.example.com/a.ics', { production: true, resolve: async () => [{ address: '93.184.216.34', family: 4 }] });
    expect(ok.pinned.address).toBe('93.184.216.34');
    expect(await reason(vetUrl('https://nx.example.com/', { production: true, resolve: async () => Promise.reject(new Error('ENOTFOUND')) }))).toBe('DNS_FAILED');
    // The development exemption never applies in production.
    expect(await reason(vetUrl('https://localhost/a.ics', { production: true, allowPrivateHosts: ['localhost'] }))).toBe('HOST_NOT_ALLOWED');
  });

  describe('fetching', () => {
    let server: Server;
    let base: string;
    const routes: Record<string, (res: import('node:http').ServerResponse) => void> = {};
    beforeAll(async () => {
      server = createServer((req, res) => (routes[req.url ?? ''] ?? ((r) => ((r.statusCode = 404), r.end())))(res));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://localhost:${(server.address() as AddressInfo).port}`;
      const port = (server.address() as AddressInfo).port;
      routes['/ok.ics'] = (res) => res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' }).end('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
      routes['/html'] = (res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html>');
      routes['/big.ics'] = (res) => res.writeHead(200, { 'content-type': 'text/calendar' }).end('x'.repeat(3 * 1024 * 1024));
      routes['/slow.ics'] = (res) => setTimeout(() => res.writeHead(200, { 'content-type': 'text/calendar' }).end('late'), 1500);
      routes['/to-ok'] = (res) => res.writeHead(302, { location: '/ok.ics' }).end();
      routes['/to-private'] = (res) => res.writeHead(302, { location: `http://127.0.0.1:${port}/ok.ics` }).end();
      routes['/to-metadata'] = (res) => res.writeHead(301, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
      routes['/loop'] = (res) => res.writeHead(302, { location: '/loop' }).end();
      routes['/500'] = (res) => res.writeHead(500).end();
    });
    afterAll(() => new Promise((r) => server.close(r)));
    const dev = { production: false, allowPrivateHosts: ['localhost'] };

    it('reads a calendar from an allowed host and follows a vetted redirect', async () => {
      expect(await safeFetchText(`${base}/ok.ics`, dev)).toContain('BEGIN:VCALENDAR');
      expect(await safeFetchText(`${base}/to-ok`, dev)).toContain('BEGIN:VCALENDAR');
    });

    it('refuses private hosts, redirects into private space, loops and odd answers', async () => {
      expect(await reason(safeFetchText(`${base}/ok.ics`, { production: false }))).toBe('HOST_NOT_ALLOWED');
      expect(await reason(safeFetchText(`${base}/to-private`, dev))).toBe('HOST_NOT_ALLOWED');
      expect(await reason(safeFetchText(`${base}/to-metadata`, dev))).toBe('HOST_NOT_ALLOWED');
      expect(await reason(safeFetchText(`${base}/loop`, dev))).toBe('TOO_MANY_REDIRECTS');
      expect(await reason(safeFetchText(`${base}/html`, dev))).toBe('BAD_CONTENT_TYPE');
      expect(await reason(safeFetchText(`${base}/500`, dev))).toBe('BAD_STATUS');
      expect(await reason(safeFetchText(`${base}/big.ics`, dev))).toBe('TOO_LARGE');
      expect(await reason(safeFetchText(`${base}/slow.ics`, { ...dev, timeoutMs: 300 }))).toBe('TIMEOUT');
    });

    it('connects to the vetted address without a second DNS lookup (no rebinding)', async () => {
      let calls = 0;
      // "feed.invalid" does not exist in DNS: the request can only reach the stub through the pinned address.
      const resolve = async () => {
        calls++;
        return [{ address: '127.0.0.1', family: 4 as const }];
      };
      const port = new URL(base).port;
      expect(await safeFetchText(`http://feed.invalid:${port}/ok.ics`, { production: false, allowPrivateHosts: ['feed.invalid'], resolve })).toContain('BEGIN:VCALENDAR');
      expect(calls).toBe(1);
      // Without the exemption the same answer is refused before any connection.
      expect(await reason(safeFetchText(`http://feed.invalid:${port}/ok.ics`, { production: false, resolve }))).toBe('HOST_NOT_ALLOWED');
    });
  });
});
