/**
 * Concierge content screen (M8): the denylist every service text and every
 * guest request is checked against. Keep this file the ONE place to maintain
 * it; `denylist.spec.ts` pins the behaviour (hits, near misses, false
 * positives we deliberately avoid).
 *
 * The concierge arranges lawful services only. A hit does not reject
 * anything by itself: a flagged service waits for the platform's review
 * (PENDING_REVIEW, hidden from guests) and a flagged guest request waits for
 * a manager (never auto-confirmed or sent to a vendor). So the list may be
 * a little broad (e.g. "escort" also catches a lawful security escort, which
 * a reviewer then approves), but it must not be so broad that ordinary
 * hotel requests trip it.
 *
 * Syntax of `term`:
 * - words are matched on Unicode word boundaries, case-insensitively, with
 *   diacritics folded ("séx" = "sex");
 * - a trailing `*` matches any word ending (`prostitut*` = prostitute,
 *   prostitution ...);
 * - a space matches any run of spaces, hyphens, dots or underscores
 *   (`happy ending` = "happy-ending", "happy  ending"); `hook up` also
 *   matches "hookup" when listed twice.
 *
 * Every text is checked as written and in a normalised form where common
 * digit / symbol substitutions are undone (`s3x`, `3sc0rt`, `c0ca1ne`) and
 * spaced-out letters are joined (`e s c o r t`, `s.e.x`).
 *
 * Deliberately NOT listed (too many lawful meanings in a Nigerian hotel):
 * "igbo" (the language and the people), "coke" (the drink), "loud",
 * "colorado", "molly" (a first name), "nude" (a make-up shade),
 * "naked" (a cake style), "massage", "adult" (adult ticket), "companion" alone
 * ("travel companion"), "date" / "date night" (a romantic dinner is a
 * lawful ROMANCE_AND_CELEBRATION service), "armed" (licensed security).
 */

export type DenyCategory = 'SEXUAL_SERVICES' | 'DRUGS' | 'WEAPONS' | 'GAMBLING' | 'ILLEGAL';

export interface DenyTerm {
  term: string;
  category: DenyCategory;
}

export const DENYLIST: readonly DenyTerm[] = [
  // Sexual services, escorts, companionship for hire, dating.
  { term: 'escort', category: 'SEXUAL_SERVICES' },
  { term: 'escorts', category: 'SEXUAL_SERVICES' },
  { term: 'escorting', category: 'SEXUAL_SERVICES' },
  { term: 'sex', category: 'SEXUAL_SERVICES' },
  { term: 'sexual', category: 'SEXUAL_SERVICES' },
  { term: 'sexy', category: 'SEXUAL_SERVICES' },
  { term: 'hookup', category: 'SEXUAL_SERVICES' },
  { term: 'hook up', category: 'SEXUAL_SERVICES' },
  { term: 'happy ending', category: 'SEXUAL_SERVICES' },
  { term: 'call girl*', category: 'SEXUAL_SERVICES' },
  { term: 'runs girl*', category: 'SEXUAL_SERVICES' },
  { term: 'prostitut*', category: 'SEXUAL_SERVICES' },
  { term: 'brothel*', category: 'SEXUAL_SERVICES' },
  { term: 'ashawo', category: 'SEXUAL_SERVICES' },
  { term: 'olosho', category: 'SEXUAL_SERVICES' },
  { term: 'erotic*', category: 'SEXUAL_SERVICES' },
  { term: 'stripper*', category: 'SEXUAL_SERVICES' },
  { term: 'striptease', category: 'SEXUAL_SERVICES' },
  { term: 'lap dance*', category: 'SEXUAL_SERVICES' },
  { term: 'girlfriend experience', category: 'SEXUAL_SERVICES' },
  { term: 'gfe', category: 'SEXUAL_SERVICES' },
  { term: 'companionship', category: 'SEXUAL_SERVICES' },
  { term: 'companion for hire', category: 'SEXUAL_SERVICES' },
  { term: 'paid companion*', category: 'SEXUAL_SERVICES' },
  { term: 'sugar daddy', category: 'SEXUAL_SERVICES' },
  { term: 'sugar mummy', category: 'SEXUAL_SERVICES' },
  { term: 'sugar baby', category: 'SEXUAL_SERVICES' },
  { term: 'dating', category: 'SEXUAL_SERVICES' },
  { term: 'booty call', category: 'SEXUAL_SERVICES' },
  { term: 'one night stand', category: 'SEXUAL_SERVICES' },
  { term: 'adult entertainment', category: 'SEXUAL_SERVICES' },
  { term: 'porn*', category: 'SEXUAL_SERVICES' },
  { term: 'xxx', category: 'SEXUAL_SERVICES' },
  { term: 'girls for the night', category: 'SEXUAL_SERVICES' },
  { term: 'hot girls', category: 'SEXUAL_SERVICES' },
  // Drugs.
  { term: 'weed', category: 'DRUGS' },
  { term: 'marijuana', category: 'DRUGS' },
  { term: 'cannabis', category: 'DRUGS' },
  { term: 'skunk', category: 'DRUGS' },
  { term: 'cocaine', category: 'DRUGS' },
  { term: 'crack cocaine', category: 'DRUGS' },
  { term: 'heroin', category: 'DRUGS' },
  { term: 'methamphetamine', category: 'DRUGS' },
  { term: 'crystal meth', category: 'DRUGS' },
  { term: 'mkpuru mmiri', category: 'DRUGS' },
  { term: 'codeine', category: 'DRUGS' },
  { term: 'tramadol', category: 'DRUGS' },
  { term: 'mdma', category: 'DRUGS' },
  { term: 'ecstasy pill*', category: 'DRUGS' },
  { term: 'lsd', category: 'DRUGS' },
  // Weapons.
  { term: 'gun', category: 'WEAPONS' },
  { term: 'guns', category: 'WEAPONS' },
  { term: 'firearm*', category: 'WEAPONS' },
  { term: 'pistol*', category: 'WEAPONS' },
  { term: 'ammunition', category: 'WEAPONS' },
  { term: 'ammo', category: 'WEAPONS' },
  { term: 'ak 47', category: 'WEAPONS' },
  { term: 'explosive*', category: 'WEAPONS' },
  // Gambling facilitation.
  { term: 'gambling', category: 'GAMBLING' },
  { term: 'betting', category: 'GAMBLING' },
  { term: 'bookie*', category: 'GAMBLING' },
  // Other illegal services.
  { term: 'fake id', category: 'ILLEGAL' },
  { term: 'fake passport', category: 'ILLEGAL' },
  { term: 'forged', category: 'ILLEGAL' },
  { term: 'forgery', category: 'ILLEGAL' },
  { term: 'underage', category: 'ILLEGAL' },
  { term: 'trafficking', category: 'ILLEGAL' },
  { term: 'money laundering', category: 'ILLEGAL' },
  { term: 'black market dollar*', category: 'ILLEGAL' },
];

export interface DenyMatch {
  term: string;
  category: DenyCategory;
  /** A short piece of the text around the hit (for the reviewer). */
  excerpt: string;
}

export interface ScreenResult {
  flagged: boolean;
  matches: DenyMatch[];
  terms: string[];
  categories: DenyCategory[];
}

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i', '|': 'l' };

/** Lower case, diacritics folded, whitespace collapsed. */
export function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Undoes digit / symbol substitutions inside words (`s3x` -> `sex`) and joins
 * runs of three or more single letters separated by one space, dot, hyphen or
 * underscore (`e s c o r t` -> `escort`).
 */
export function deobfuscate(folded: string): string {
  const unleet = folded.replace(/[\p{L}\p{N}@$!|]+/gu, (w) => (/\p{L}/u.test(w) ? w.replace(/[0-9@$!|]/g, (c) => LEET[c] ?? c) : w));
  return unleet.replace(/(?<![\p{L}\p{N}])(?:[\p{L}\p{N}][ ._-]){2,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu, (run) => run.replace(/[ ._-]/g, ''));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The regular expression of one term (see the syntax in the module comment). */
export function termPattern(term: string): RegExp {
  const prefix = term.endsWith('*');
  const words = (prefix ? term.slice(0, -1) : term).trim().split(/\s+/).map(escapeRe);
  const body = words.join('[\\s._-]+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${prefix ? '[\\p{L}\\p{N}]*' : ''}(?![\\p{L}\\p{N}])`, 'giu');
}

const COMPILED = DENYLIST.map((t) => ({ ...t, re: termPattern(t.term) }));

function excerptAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  return `${start > 0 ? '...' : ''}${text.slice(start, end).trim()}${end < text.length ? '...' : ''}`;
}

/**
 * Screens one or more texts. Every distinct term is reported once (with the
 * first excerpt found), in list order.
 */
export function screen(texts: (string | null | undefined)[]): ScreenResult {
  const matches: DenyMatch[] = [];
  const seen = new Set<string>();
  for (const raw of texts) {
    if (!raw || typeof raw !== 'string') continue;
    const folded = fold(raw);
    if (!folded) continue;
    const variants = [folded];
    const clean = deobfuscate(folded);
    if (clean !== folded) variants.push(clean);
    for (const t of COMPILED) {
      if (seen.has(t.term)) continue;
      for (const v of variants) {
        t.re.lastIndex = 0;
        const m = t.re.exec(v);
        if (m) {
          seen.add(t.term);
          matches.push({ term: t.term, category: t.category, excerpt: excerptAt(v, m.index, m[0].length) });
          break;
        }
      }
    }
  }
  return {
    flagged: matches.length > 0,
    matches,
    terms: matches.map((m) => m.term),
    categories: [...new Set(matches.map((m) => m.category))],
  };
}
