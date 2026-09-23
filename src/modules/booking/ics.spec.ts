import { buildIcs, icsText } from './ics.js';

describe('buildIcs', () => {
  const ics = buildIcs(
    {
      uid: 'PWH-7K3Q.abc@hotelos.ng',
      start: new Date('2026-10-01T13:00:00.000Z'),
      end: new Date('2026-10-03T11:00:00.000Z'),
      summary: 'Stay at The Palmwine House (PWH-7K3Q)',
      location: '14 Fola Osibo Road, Lekki Phase 1, Lagos',
      description: 'Booking PWH-7K3Q; check-in from 14:00.\nManage: https://hotelos.ng/trips/PWH-7K3Q?t=' + 'x'.repeat(120),
      stamp: new Date('2026-09-23T10:00:00.000Z'),
    },
    'HotelOS',
  );

  it('is a CRLF calendar with UTC times and a day-before alarm', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics).toContain('DTSTART:20261001T130000Z');
    expect(ics).toContain('DTEND:20261003T110000Z');
    expect(ics).toContain('TRIGGER:-PT24H');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('escapes text values and folds long lines at 75 octets', () => {
    expect(icsText('a;b,c\nd\\e')).toBe('a\\;b\\,c\\nd\\\\e');
    expect(ics).toContain('LOCATION:14 Fola Osibo Road\\, Lekki Phase 1\\, Lagos');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  });
});
