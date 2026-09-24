import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assertSafeKey, type ObjectStorage, type StoredObject } from './object-storage.js';

/** Stores objects as files under a root directory; content type in a sidecar. */
export class LocalDiskStorage implements ObjectStorage {
  readonly driver = 'local' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    assertSafeKey(key);
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root)) throw new Error('Storage key escapes the root');
    return p;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body, { mode: 0o600 });
    await writeFile(`${p}.meta`, JSON.stringify({ contentType }), { mode: 0o600 });
  }

  async get(key: string): Promise<StoredObject | null> {
    const p = this.path(key);
    try {
      const body = await readFile(p);
      let contentType: string | null = null;
      try {
        contentType = (JSON.parse(await readFile(`${p}.meta`, 'utf8')) as { contentType?: string }).contentType ?? null;
      } catch {
        contentType = null;
      }
      return { body, contentType };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    const p = this.path(key);
    await rm(p, { force: true });
    await rm(`${p}.meta`, { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/$/.test(prefix)) throw new Error(`Refusing to delete prefix ${prefix}`);
    const p = this.path(prefix.replace(/\/$/, ''));
    await rm(p, { recursive: true, force: true });
    return 1;
  }
}
