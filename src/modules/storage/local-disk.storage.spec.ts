import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDiskStorage } from './local-disk.storage.js';

describe('LocalDiskStorage', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'storage-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('puts, gets and deletes with content type', async () => {
    const s = new LocalDiskStorage(dir);
    await s.put('tenants/t1/guests/g1/id.png', Buffer.from('png-bytes'), 'image/png');
    const got = await s.get('tenants/t1/guests/g1/id.png');
    expect(got?.body.toString()).toBe('png-bytes');
    expect(got?.contentType).toBe('image/png');
    await s.delete('tenants/t1/guests/g1/id.png');
    expect(await s.get('tenants/t1/guests/g1/id.png')).toBeNull();
  });

  it('rejects keys that escape the root', async () => {
    const s = new LocalDiskStorage(dir);
    await expect(s.put('../evil', Buffer.from('x'), 'text/plain')).rejects.toThrow();
    await expect(s.get('/etc/passwd')).rejects.toThrow();
  });
});
