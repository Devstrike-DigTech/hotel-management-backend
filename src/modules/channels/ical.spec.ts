import { channexSignature } from './channel-provider.js';
import { buildIcs, guestNameFrom, isOtaBlock, nightsToRanges, parseIcs } from './ical.js';

describe('iCal', () => {
  it('groups blocked nights into ranges and round-trips through build and parse', () => {
    const ranges = nightsToRanges(['2026-10-03', '2026-10-01', '2026-10-02', '2026-10-07']);
    expect(ranges).toEqual([
      { from: '2026-10-01', to: '2026-10-04' },
      { from: '2026-10-07', to: '2026-10-08' },
    ]);
    const ics = buildIcs({ prodId: 'HotelOS', calName: 'Room 101, The Palmwine House', feedKey: 'r101', ranges, now: new Date('2026-09-23T10:00:00Z') });
    expect(ics).toContain('X-WR-CALNAME:Room 101\\, The Palmwine House');
    expect(ics.endsWith('\r\n')).toBe(true);
    const events = parseIcs(ics);
    expect(events.map((e) => [e.uid, e.start, e.end])).toEqual([
      ['r101-20261001-20261004', '2026-10-01', '2026-10-04'],
      ['r101-20261007-20261008', '2026-10-07', '2026-10-08'],
    ]);
    expect(events.every(isOtaBlock)).toBe(true);
  });

  it('reads OTA feeds: folded lines, date-times in UTC and missing DTEND', () => {
    const feed = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:1418fb94e984-f4e0ec5b0f7b@airbnb.com',
      'DTSTART;VALUE=DATE:20261010',
      'DTEND;VALUE=DATE:20261013',
      'SUMMARY:Reserved - Adaeze Okafor',
      'DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/de',
      ' tails/HMABC',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:x2',
      'DTSTART:20261020T230000Z',
      'SUMMARY:Airbnb (Not available)',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const [a, b] = parseIcs(feed);
    expect(a).toMatchObject({ start: '2026-10-10', end: '2026-10-13', summary: 'Reserved - Adaeze Okafor' });
    expect(a.description).toContain('details/HMABC');
    expect(guestNameFrom(a)).toBe('Adaeze Okafor');
    // 23:00 UTC is midnight in Lagos: the next day, one night.
    expect(b).toMatchObject({ start: '2026-10-21', end: '2026-10-22' });
    expect(isOtaBlock(b)).toBe(true);
    expect(guestNameFrom({ summary: 'Reserved' })).toBeNull();
  });

  it('signs Channex webhooks with HMAC-SHA256 of the raw body', () => {
    expect(channexSignature('secret', '{"a":1}')).toBe(channexSignature('secret', Buffer.from('{"a":1}')));
    expect(channexSignature('secret', 'x')).toMatch(/^[0-9a-f]{64}$/);
    expect(channexSignature('secret', 'x')).not.toBe(channexSignature('other', 'x'));
  });
});
