import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUP_PROHIBITED, AUP_SUMMARY, AUP_TEXT, AUP_VERSION } from './aup.js';
import { screen } from './denylist.js';

const doc = readFileSync(join(process.cwd(), 'docs/concierge-acceptable-use.md'), 'utf8');

describe('concierge acceptable-use policy', () => {
  it('is documented word for word in docs/concierge-acceptable-use.md', () => {
    expect(doc).toContain(`Version: \`${AUP_VERSION}\``);
    for (const line of AUP_SUMMARY) expect(doc).toContain(line);
    for (const p of AUP_PROHIBITED) expect(doc).toContain(p.label);
    for (const para of AUP_TEXT.split('\n\n')) expect(doc).toContain(para);
  });

  it('names what is prohibited, including sexual services and escorts', () => {
    expect(AUP_PROHIBITED.map((p) => p.code)).toEqual(expect.arrayContaining(['SEXUAL_SERVICES', 'DRUGS', 'WEAPONS', 'GAMBLING', 'ILLEGAL']));
    expect(AUP_TEXT).toMatch(/sexual services/i);
    expect(AUP_TEXT).toMatch(/escorts/i);
    expect(AUP_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('contains no emoji', () => {
    expect(`${AUP_TEXT}${AUP_SUMMARY.join('')}${doc}`).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('the policy text itself would be screened (it is never a service text)', () => {
    // The policy names prohibited things on purpose; the screen applies to services and requests only.
    expect(screen([AUP_TEXT]).flagged).toBe(true);
  });
});
