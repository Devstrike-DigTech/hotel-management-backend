import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP writer (PKZIP 2.0, deflate, no ZIP64): enough for data exports
 * of a hotel group. Entries are compressed as they are added; `toBuffer()`
 * writes the central directory. Timestamps use the DOS format in UTC.
 */
export class ZipWriter {
  private readonly chunks: Buffer[] = [];
  private readonly central: Buffer[] = [];
  private offset = 0;
  private count = 0;

  add(name: string, content: string | Buffer, at: Date = new Date()): void {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 6 });
    const crc = crc32(data) >>> 0;
    const { time, date } = dosDateTime(at);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE(0, 38); // external attrs
    dir.writeUInt32LE(this.offset, 42);

    this.chunks.push(local, nameBuf, compressed);
    this.central.push(dir, nameBuf);
    this.offset += local.length + nameBuf.length + compressed.length;
    this.count++;
    if (this.offset > 0xfffffff0) throw new Error('Export is too large for a ZIP without ZIP64');
  }

  toBuffer(): Buffer {
    const dir = Buffer.concat(this.central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.count, 8);
    end.writeUInt16LE(this.count, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(this.offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...this.chunks, dir, end]);
  }
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** Reads the file names and contents back (tests). */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('Not a zip');
  const count = buf.readUInt16LE(endAt + 10);
  let p = buf.readUInt32LE(endAt + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lName = buf.readUInt16LE(localAt + 26);
    const lExtra = buf.readUInt16LE(localAt + 28);
    const start = localAt + 30 + lName + lExtra;
    const raw = buf.subarray(start, start + size);
    out.set(name, method === 8 ? inflate(raw) : Buffer.from(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function inflate(b: Buffer): Buffer {
  return inflateRawSync(b);
}
