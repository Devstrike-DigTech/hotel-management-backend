import { alertSchedule, DEFAULT_GUARD_ALERTS, guardAlertSettings, inQuietHours, isUrgent, parseCommand, quietHours, quietHoursEnd } from './alerts.logic.js';

/** A Lagos wall-clock time on 23 Sep 2026 (UTC+1). */
const lagos = (hhmm: string) => new Date(`2026-09-23T${hhmm}:00+01:00`);
const q = quietHours({ enabled: true, start: '23:30', end: '06:00' });

describe('owner alert rules', () => {
  it('fills settings from defaults', () => {
    expect(guardAlertSettings({ debounceMinutes: 5, recipients: { managers: true } })).toMatchObject({
      enabled: true,
      debounceMinutes: 5,
      recipients: { owners: true, managers: true, userIds: [] },
    });
    expect(guardAlertSettings(null)).toEqual(DEFAULT_GUARD_ALERTS);
  });

  it('knows quiet hours that wrap past midnight', () => {
    expect(inQuietHours(lagos('23:45'), q)).toBe(true);
    expect(inQuietHours(lagos('02:00'), q)).toBe(true);
    expect(inQuietHours(lagos('06:00'), q)).toBe(false);
    expect(inQuietHours(lagos('12:00'), q)).toBe(false);
    expect(inQuietHours(lagos('02:00'), { ...q, enabled: false })).toBe(false);
    expect(inQuietHours(lagos('13:00'), { enabled: true, start: '12:00', end: '14:00' })).toBe(true);
  });

  it('defers normal alerts to the end of quiet hours and sends urgent ones at once', () => {
    const s = guardAlertSettings({});
    expect(quietHoursEnd(lagos('02:10'), q).toISOString()).toBe(lagos('06:00').toISOString());
    expect(alertSchedule(lagos('02:10'), false, s, q)).toEqual({ scheduledFor: lagos('06:00'), deferred: true });
    expect(alertSchedule(lagos('02:10'), true, s, q)).toEqual({ scheduledFor: lagos('02:10'), deferred: false });
    expect(alertSchedule(lagos('14:00'), false, s, q)).toEqual({ scheduledFor: lagos('14:03'), deferred: false });
  });

  it('treats configured rules and large amounts as urgent', () => {
    const s = guardAlertSettings({});
    expect(isUrgent({ rule: 'OCCUPIED_WITHOUT_STAY', amountKobo: null }, s)).toBe(true);
    expect(isUrgent({ rule: 'SHIFT_VARIANCE', amountKobo: 750_000 }, s)).toBe(false);
    expect(isUrgent({ rule: 'SHIFT_VARIANCE', amountKobo: 10_000_000 }, s)).toBe(true);
  });

  it('parses reply commands', () => {
    expect(parseCommand('1')).toBe('ACK');
    expect(parseCommand(' ack. ')).toBe('ACK');
    expect(parseCommand('Digest')).toBe('DIGEST');
    expect(parseCommand('who is this?')).toBe('HELP');
  });
});
