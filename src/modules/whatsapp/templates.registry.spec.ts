import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanParam, fillTemplate, WHATSAPP_TEMPLATES } from './templates.registry.js';

const doc = readFileSync(join(process.cwd(), 'docs/whatsapp-templates.md'), 'utf8');

describe('WhatsApp template registry', () => {
  it.each(WHATSAPP_TEMPLATES.map((t) => [t.name, t] as const))('%s has numbered placeholders matching its parameters', (_n, t) => {
    const used = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    expect([...new Set(used)].sort((a, b) => a - b)).toEqual(t.params.map((p) => p.index));
    expect(t.params.map((p) => p.index)).toEqual(t.params.map((_p, i) => i + 1));
    expect(t.name).toMatch(/^[a-z0-9_]+$/);
  });

  it.each(WHATSAPP_TEMPLATES.map((t) => [t.name, t] as const))('%s is documented word for word in docs/whatsapp-templates.md', (_n, t) => {
    expect(doc).toContain(`## ${t.name}`);
    expect(doc).toContain(t.body);
    for (const p of t.params) expect(doc).toContain(`| \`{{${p.index}}}\` | ${p.name} | ${p.example} |`);
  });

  it('fills placeholders and cleans parameters Meta would reject', () => {
    expect(fillTemplate('otp_code', ['482913'])).toBe('482913 is your verification code. For your security, do not share this code.');
    expect(cleanParam('line one\nline two\tend')).toBe('line one line two end');
    expect(cleanParam('')).toBe('-');
    expect(cleanParam(null)).toBe('-');
    expect(cleanParam('x'.repeat(1200))).toHaveLength(1000);
  });

  it('contains no emoji', () => {
    expect(doc).not.toMatch(/\p{Extended_Pictographic}/u);
    for (const t of WHATSAPP_TEMPLATES) expect(t.body).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
