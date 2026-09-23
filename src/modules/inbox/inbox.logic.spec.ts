import { humanTime, isConfirmation, keywordHits, parseArrivalTime, phoneDigits, renderQuickReply, windowOf } from './inbox.logic.js';

describe('guest inbox rules', () => {
  it('suggests housekeeping and maintenance tasks from keywords (one per kind / category)', () => {
    expect(keywordHits('Please bring two towels and more soap')).toEqual([{ kind: 'HOUSEKEEPING', keyword: 'towel', category: null, summary: 'Towels requested' }]);
    const hits = keywordHits('The AC is not cooling and the shower is leaking. Also the TV remote is dead');
    expect(hits.map((h) => h.category)).toEqual(['AC_HVAC', 'PLUMBING', 'APPLIANCE']);
    expect(keywordHits('WiFi keeps dropping').map((h) => h.category)).toEqual(['IT']);
    expect(keywordHits('Thank you, lovely stay')).toEqual([]);
  });

  it('reads an arrival time, but not the "1" that confirms', () => {
    expect(parseArrivalTime('Around 3pm')).toBe('15:00');
    expect(parseArrivalTime('by 11:30 am')).toBe('11:30');
    expect(parseArrivalTime('15:30')).toBe('15:30');
    expect(parseArrivalTime('12 p.m.')).toBe('12:00');
    expect(parseArrivalTime('noon')).toBe('12:00');
    expect(parseArrivalTime('1')).toBeNull();
    expect(parseArrivalTime('not sure yet')).toBeNull();
    expect(humanTime('15:00')).toBe('3pm');
    expect(humanTime('09:45')).toBe('9:45am');
    expect(isConfirmation(' 1 ')).toBe(true);
    expect(isConfirmation('Yes!')).toBe(true);
    expect(isConfirmation('10')).toBe(false);
  });

  it('opens a 24-hour window after the guest writes', () => {
    const now = new Date('2026-09-23T12:00:00Z');
    expect(windowOf(null, now)).toEqual({ open: false, expiresAt: null });
    expect(windowOf(new Date('2026-09-22T13:00:00Z'), now)).toEqual({ open: true, expiresAt: '2026-09-23T13:00:00.000Z' });
    expect(windowOf(new Date('2026-09-22T11:00:00Z'), now).open).toBe(false);
  });

  it('fills quick-reply placeholders and normalises phones', () => {
    expect(renderQuickReply('Hi {{guest_first_name}}, Wi-Fi {{wifi_name}} / {{wifi_password}}{{unknown}}.', { guest_first_name: 'Ada', wifi_name: 'Palm', wifi_password: 'x1' })).toBe('Hi Ada, Wi-Fi Palm / x1.');
    expect(phoneDigits('0803 555 0100')).toBe('2348035550100');
    expect(phoneDigits('+234 803 555 0100')).toBe('2348035550100');
  });
});
