import { crc32, deflateSync } from 'node:zlib';
import { ImageRejected, sanitizeImage, sniffImage } from './image-sanitize.js';

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function png(width: number, height: number, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...extra,
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function seg(marker: number, payload: Buffer): Buffer {
  const h = Buffer.from([0xff, marker, 0, 0]);
  h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
}

function jpeg(): Buffer {
  const sof = Buffer.from([8, 0, 2, 0, 3, 1, 1, 0x11, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary')),
    seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'binary'), Buffer.from('GPS 6.5244N 3.3792E camera=Phone')])),
    seg(0xfe, Buffer.from('taken at the owner house')),
    seg(0xc0, sof),
    seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9]),
  ]);
}

describe('brand image sanitising', () => {
  it('sniffs the real type', () => {
    expect(sniffImage(png(1, 1))).toBe('png');
    expect(sniffImage(jpeg())).toBe('jpeg');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });

  it('strips PNG text chunks and keeps the pixels', () => {
    const text = chunk('tEXt', Buffer.from('Author\0Somebody at home'));
    const src = png(4, 3, [text]);
    const out = sanitizeImage(src, { allowed: ['png'], maxBytes: 100_000, maxSide: 64 });
    expect(out).toMatchObject({ kind: 'png', width: 4, height: 3, contentType: 'image/png' });
    expect(out.stripped).toBe(text.length);
    expect(out.body.includes(Buffer.from('Somebody'))).toBe(false);
  });

  it('strips JPEG EXIF (GPS) and comments', () => {
    const out = sanitizeImage(jpeg(), { allowed: ['jpeg'], maxBytes: 100_000, maxSide: 64 });
    expect(out).toMatchObject({ kind: 'jpeg', width: 3, height: 2 });
    expect(out.body.includes(Buffer.from('GPS'))).toBe(false);
    expect(out.body.includes(Buffer.from('owner house'))).toBe(false);
    expect(out.body.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

  it('refuses the wrong type, oversize files and dimensions, and truncated files', () => {
    expect(() => sanitizeImage(jpeg(), { allowed: ['png'], maxBytes: 100_000, maxSide: 64 })).toThrow(ImageRejected);
    expect(() => sanitizeImage(png(1, 1), { allowed: ['png'], maxBytes: 10, maxSide: 64 })).toThrow(/larger/);
    expect(() => sanitizeImage(png(100, 100), { allowed: ['png'], maxBytes: 100_000, maxSide: 64 })).toThrow(/at most/);
    expect(() => sanitizeImage(png(8, 8), { allowed: ['png'], maxBytes: 100_000, maxSide: 64, minSide: 16 })).toThrow(/at least/);
    expect(() => sanitizeImage(png(4, 4).subarray(0, 40), { allowed: ['png'], maxBytes: 100_000, maxSide: 64 })).toThrow(ImageRejected);
  });
});
