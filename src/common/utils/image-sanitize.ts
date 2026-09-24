/**
 * Brand image checks without a native image library (M6 white-label logos and
 * favicons): the type is sniffed from the bytes (the declared type is
 * ignored), dimensions are read from the headers, and metadata (EXIF, XMP,
 * comments, text chunks) is stripped structurally while the pixel data is
 * kept byte for byte. Anything that does not parse cleanly is refused.
 */

export type ImageKind = 'png' | 'jpeg' | 'webp' | 'ico';

export interface SanitizedImage {
  kind: ImageKind;
  contentType: string;
  width: number;
  height: number;
  body: Buffer;
  /** Bytes removed (metadata). */
  stripped: number;
}

export class ImageRejected extends Error {}

const CONTENT_TYPES: Record<ImageKind, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon' };

export function sniffImage(buf: Buffer): ImageKind | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.length >= 6 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1 && buf.readUInt16LE(4) > 0) return 'ico';
  return null;
}

/** PNG: keep critical chunks and the few ancillary ones that affect rendering. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'pHYs']);

function sanitizePng(buf: Buffer): { body: Buffer; width: number; height: number } {
  const out: Buffer[] = [buf.subarray(0, 8)];
  let off = 8;
  let width = 0;
  let height = 0;
  let sawEnd = false;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    const end = off + 12 + len;
    if (end > buf.length) throw new ImageRejected('Truncated PNG');
    if (type === 'IHDR') {
      width = buf.readUInt32BE(off + 8);
      height = buf.readUInt32BE(off + 12);
    }
    if (PNG_KEEP.has(type)) out.push(buf.subarray(off, end));
    off = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd || !width || !height) throw new ImageRejected('Not a complete PNG');
  return { body: Buffer.concat(out), width, height };
}

/** JPEG: drop APP1..APP15 (EXIF, XMP, ICC kept out) and COM segments; keep APP0 (JFIF) and APP14 (Adobe colour). */
function sanitizeJpeg(buf: Buffer): { body: Buffer; width: number; height: number } {
  const out: Buffer[] = [buf.subarray(0, 2)];
  let off = 2;
  let width = 0;
  let height = 0;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) throw new ImageRejected('Malformed JPEG');
    const marker = buf[off + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(buf.subarray(off, off + 2));
      off += 2;
      continue;
    }
    const len = buf.readUInt16BE(off + 2);
    const end = off + 2 + len;
    if (len < 2 || end > buf.length) throw new ImageRejected('Truncated JPEG');
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      height = buf.readUInt16BE(off + 5);
      width = buf.readUInt16BE(off + 7);
    }
    const isApp = marker >= 0xe1 && marker <= 0xef && marker !== 0xee;
    if (!isApp && marker !== 0xfe) out.push(buf.subarray(off, end));
    off = end;
    if (marker === 0xda) {
      // Start of scan: the entropy-coded data and the rest of the file are kept as they are.
      out.push(buf.subarray(off));
      break;
    }
  }
  if (!width || !height) throw new ImageRejected('JPEG without a frame header');
  return { body: Buffer.concat(out), width, height };
}

/** WebP: drop EXIF and XMP chunks and clear their VP8X flags. */
function sanitizeWebp(buf: Buffer): { body: Buffer; width: number; height: number } {
  const chunks: Buffer[] = [];
  let off = 12;
  let width = 0;
  let height = 0;
  while (off + 8 <= buf.length) {
    const type = buf.subarray(off, off + 4).toString('ascii');
    const len = buf.readUInt32LE(off + 4);
    const end = off + 8 + len + (len % 2);
    if (off + 8 + len > buf.length) throw new ImageRejected('Truncated WebP');
    let chunk = buf.subarray(off, Math.min(end, buf.length));
    if (type === 'VP8X') {
      chunk = Buffer.from(chunk);
      chunk[8] = chunk[8]! & ~0x0c; // EXIF (0x08) and XMP (0x04) flags
      width = 1 + chunk.readUIntLE(12, 3);
      height = 1 + chunk.readUIntLE(15, 3);
    } else if (type === 'VP8 ' && !width) {
      width = buf.readUInt16LE(off + 14) & 0x3fff;
      height = buf.readUInt16LE(off + 16) & 0x3fff;
    } else if (type === 'VP8L' && !width) {
      const b = buf.readUInt32LE(off + 9);
      width = (b & 0x3fff) + 1;
      height = ((b >> 14) & 0x3fff) + 1;
    }
    if (type !== 'EXIF' && type !== 'XMP ') chunks.push(chunk);
    off = end;
  }
  if (!width || !height) throw new ImageRejected('WebP without an image');
  const payload = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(payload.length + 4, 4);
  header.write('WEBP', 8, 'ascii');
  return { body: Buffer.concat([header, payload]), width, height };
}

function icoSize(buf: Buffer): { width: number; height: number } {
  const n = buf.readUInt16LE(4);
  if (buf.length < 6 + n * 16) throw new ImageRejected('Truncated ICO');
  let width = 0;
  let height = 0;
  for (let i = 0; i < n; i++) {
    const w = buf[6 + i * 16] || 256;
    const h = buf[7 + i * 16] || 256;
    const size = buf.readUInt32LE(6 + i * 16 + 8);
    const at = buf.readUInt32LE(6 + i * 16 + 12);
    if (at + size > buf.length) throw new ImageRejected('Truncated ICO');
    width = Math.max(width, w);
    height = Math.max(height, h);
  }
  return { width, height };
}

export function sanitizeImage(buf: Buffer, opts: { allowed: ImageKind[]; maxBytes: number; maxSide: number; minSide?: number }): SanitizedImage {
  if (buf.length > opts.maxBytes) throw new ImageRejected(`The image is larger than ${Math.round(opts.maxBytes / 1024)} KB`);
  const kind = sniffImage(buf);
  if (!kind || !opts.allowed.includes(kind)) throw new ImageRejected(`Use ${opts.allowed.map((k) => k.toUpperCase()).join(', ')}`);
  const r = kind === 'png' ? sanitizePng(buf) : kind === 'jpeg' ? sanitizeJpeg(buf) : kind === 'webp' ? sanitizeWebp(buf) : { body: buf, ...icoSize(buf) };
  if (r.width > opts.maxSide || r.height > opts.maxSide) throw new ImageRejected(`The image may be at most ${opts.maxSide} x ${opts.maxSide} pixels`);
  if (opts.minSide && (r.width < opts.minSide || r.height < opts.minSide)) throw new ImageRejected(`The image must be at least ${opts.minSide} x ${opts.minSide} pixels`);
  return { kind, contentType: CONTENT_TYPES[kind], width: r.width, height: r.height, body: r.body, stripped: buf.length - r.body.length };
}
