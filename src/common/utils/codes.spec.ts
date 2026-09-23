import { CODE_ALPHABET, codePrefix, reservationCode } from './codes.js';
import { amountInWords } from './money-words.js';
import { addDays, billableHours, humanDate, humanDateTime, lagosDate, lagosDateTime, nightsBetween, roomNightLabel } from '../time/lagos.js';

describe('reservation codes', () => {
  it('derives a prefix from the hotel name', () => {
    expect(codePrefix('The Palmwine House')).toBe('PWH');
    expect(codePrefix('Ikoyi Lantern Suites Hotel')).toBe('ILS');
    expect(codePrefix('Ikoyi')).toBe('IKO');
    expect(codePrefix('')).toBe('HTL');
  });
  it('uses only unambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      const code = reservationCode('PWH');
      expect(code).toMatch(/^PWH-[A-Z0-9]{4}$/);
      for (const ch of code.slice(4)) expect(CODE_ALPHABET).toContain(ch);
      expect(code.slice(4)).not.toMatch(/[01OILSZB258]/);
    }
  });
});

describe('amountInWords', () => {
  it('spells naira and kobo', () => {
    expect(amountInWords(5_000_000)).toBe('Fifty thousand naira only');
    expect(amountInWords(5_025_050)).toBe('Fifty thousand, two hundred and fifty naira, fifty kobo only');
    expect(amountInWords(123_456_700)).toBe('One million, two hundred and thirty-four thousand, five hundred and sixty-seven naira only');
  });
});

describe('Lagos time', () => {
  it('uses UTC+1 for dates and times', () => {
    expect(lagosDate(new Date('2026-09-22T23:30:00Z'))).toBe('2026-09-23');
    expect(lagosDateTime('2026-09-23', '14:00').toISOString()).toBe('2026-09-23T13:00:00.000Z');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('counts nights and billable hours', () => {
    expect(nightsBetween(lagosDateTime('2026-09-23', '14:00'), lagosDateTime('2026-09-26', '12:00'))).toBe(3);
    expect(billableHours(new Date('2026-09-23T10:00:00Z'), new Date('2026-09-23T13:10:00Z'))).toBe(4);
  });
});

describe('human dates for guest-facing text', () => {
  it('formats dates the Nigerian way, in Lagos time', () => {
    expect(humanDate('2026-09-22')).toBe('Tue 22 Sep 2026');
    expect(humanDate('2027-01-01')).toBe('Fri 1 Jan 2027');
    // 23:30 UTC is already the next day in Lagos.
    expect(humanDateTime(new Date('2026-09-22T23:30:00Z'))).toBe('Wed 23 Sep 2026, 00:30');
    expect(roomNightLabel('101', '2026-09-22')).toBe('Room 101, night of Tue 22 Sep 2026');
  });
});
