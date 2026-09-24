import { readZip, ZipWriter } from './zip.js';

describe('ZipWriter', () => {
  it('writes entries that read back byte for byte', () => {
    const z = new ZipWriter();
    z.add('README.txt', 'Harmattan Hotels & Suites export\n');
    z.add('json/guests.json', JSON.stringify([{ fullName: 'Ada Obi', idNumber: '12345678901' }]));
    z.add('csv/rooms.csv', 'number,floor\r\n101,1\r\n'.repeat(200));
    const buf = z.toBuffer();
    expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304');
    const files = readZip(buf);
    expect([...files.keys()]).toEqual(['README.txt', 'json/guests.json', 'csv/rooms.csv']);
    expect(files.get('README.txt')!.toString()).toBe('Harmattan Hotels & Suites export\n');
    expect(JSON.parse(files.get('json/guests.json')!.toString())[0].idNumber).toBe('12345678901');
    expect(files.get('csv/rooms.csv')!.length).toBe('number,floor\r\n101,1\r\n'.length * 200);
  });
});
