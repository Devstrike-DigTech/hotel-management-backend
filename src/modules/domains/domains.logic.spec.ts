import { MockDnsResolver } from './dns.js';
import { domainProblem, expectedRecords, isApex, normaliseDomain, readCheck, verifyPrefix } from './domains.logic.js';

describe('custom domains', () => {
  it('normalises what owners type and refuses apex domains', () => {
    expect(normaliseDomain('https://Book.TheirHotel.com/rooms?x=1')).toBe('book.theirhotel.com');
    expect(normaliseDomain('book.theirhotel.com.')).toBe('book.theirhotel.com');
    expect(normaliseDomain('not a domain')).toBeNull();
    expect(normaliseDomain('localhost')).toBeNull();
    expect(isApex('theirhotel.com')).toBe(true);
    expect(isApex('theirhotel.com.ng')).toBe(true);
    expect(isApex('book.theirhotel.com.ng')).toBe(false);
    expect(domainProblem('theirhotel.ng')).toEqual({ domain: 'theirhotel.ng', problem: 'APEX' });
    expect(domainProblem('stay.theirhotel.ng')).toEqual({ domain: 'stay.theirhotel.ng', problem: null });
  });

  it('builds the TXT and CNAME records and reads a check', async () => {
    const e = expectedRecords('book.x.ng', 'tok', verifyPrefix('HotelOS'), 'sites.hotelos.ng');
    expect(e.txt).toEqual({ type: 'TXT', name: '_hotelos-verify.book.x.ng', value: 'hotelos-verify=tok' });
    expect(e.cname).toEqual({ type: 'CNAME', name: 'book.x.ng', value: 'sites.hotelos.ng' });
    const dns = new MockDnsResolver();
    expect(readCheck(e, { txt: await dns.txt(e.txt.name), cname: await dns.cname(e.cname.name) }).failures).toEqual(['TXT_MISSING', 'CNAME_MISSING']);
    MockDnsResolver.set(e.txt.name, 'TXT', 'something-else');
    MockDnsResolver.set(e.cname.name, 'CNAME', 'other.example.com.');
    expect(readCheck(e, { txt: await dns.txt(e.txt.name), cname: await dns.cname(e.cname.name) }).failures).toEqual(['TXT_MISMATCH', 'CNAME_MISMATCH']);
    MockDnsResolver.set(e.txt.name, 'TXT', e.txt.value);
    MockDnsResolver.set(e.cname.name, 'CNAME', 'SITES.hotelos.ng.');
    expect(readCheck(e, { txt: await dns.txt(e.txt.name), cname: await dns.cname(e.cname.name) })).toEqual({ txtOk: true, cnameOk: true, failures: [] });
    expect(readCheck(e, null).failures).toEqual(['DNS_ERROR']);
    MockDnsResolver.clear('book.x.ng');
  });
});
