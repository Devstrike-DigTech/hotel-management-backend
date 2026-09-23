import { maskPhone, normalisePhone } from './phone.js';

describe('normalisePhone', () => {
  it.each([
    ['0803 123 4567', '+2348031234567'],
    ['08031234567', '+2348031234567'],
    ['8031234567', '+2348031234567'],
    ['2348031234567', '+2348031234567'],
    ['+234 803 123 4567', '+2348031234567'],
    ['+234 (0)803', null],
    ['+44 20 7946 0958', '+442079460958'],
    ['12345', null],
    ['0803-ABC', null],
    ['', null],
  ])('%s -> %s', (input, out) => {
    expect(normalisePhone(input)).toBe(out);
  });

  it('masks for display', () => {
    expect(maskPhone('+2348031234567')).toBe('+234803•••4567');
  });
});
