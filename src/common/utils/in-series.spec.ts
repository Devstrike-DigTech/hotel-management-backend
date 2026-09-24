import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { inSeries, mapInSeries } from './in-series.js';

describe('inSeries / mapInSeries', () => {
  it('runs one step at a time, in order, with typed results', async () => {
    const log: string[] = [];
    const step = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      return name.length;
    };
    const [a, b] = await inSeries(step('slow', 20), step('ab', 1));
    expect([a, b]).toEqual([4, 2]);
    expect(log).toEqual(['start slow', 'end slow', 'start ab', 'end ab']);
    expect(await mapInSeries([3, 1, 2], async (n, i) => n * 10 + i)).toEqual([30, 11, 22]);
  });

  it('stops at the first failure', async () => {
    const ran: number[] = [];
    await expect(inSeries(async () => ran.push(1), async () => { throw new Error('boom'); }, async () => ran.push(3))).rejects.toThrow('boom');
    expect(ran).toEqual([1]);
  });
});

/** Every `Promise.all(...)` in src whose argument mentions a transaction client `tx`. */
function txPromiseAlls(root: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== 'generated') walk(p);
        continue;
      }
      if (!p.endsWith('.ts') || p.endsWith('.spec.ts')) continue;
      const src = readFileSync(p, 'utf8');
      let at = src.indexOf('Promise.all(');
      while (at >= 0) {
        let i = at + 'Promise.all('.length;
        let depth = 1;
        while (depth && i < src.length) {
          if (src[i] === '(') depth++;
          else if (src[i] === ')') depth--;
          i++;
        }
        const arg = src.slice(at, i);
        const line = src.slice(src.lastIndexOf('\n', at) + 1, at).trim();
        const comment = line.startsWith('*') || line.startsWith('//');
        // `db.system((tx) => ...)` inside the list opens its own transaction (its own connection): allowed.
        const ownTransactions = /\(\s*tx\b[^)]*\)\s*=>/.test(arg);
        if (!comment && !ownTransactions && /\btx\b/.test(arg)) hits.push(`${relative(root, p)}:${src.slice(0, at).split('\n').length}`);
        at = src.indexOf('Promise.all(', i);
      }
    }
  };
  walk(root);
  return hits;
}

describe('no Promise.all over a transaction client', () => {
  it('src uses inSeries / mapInSeries where the steps share a tx (one pg connection)', () => {
    expect(txPromiseAlls(join(__dirname, '..', '..'))).toEqual([]);
  });
});
