import { randomInt } from 'node:crypto';

/** Unambiguous alphabet: no 0/O, 1/I/L, 2/Z, 5/S, 8/B. */
export const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';

/** Prefix from a hotel name: initials of up to three significant words. */
export function codePrefix(hotelName: string): string {
  const words = hotelName
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !['THE', 'AND', 'OF', 'A'].includes(w));
  if (words.length === 0) return 'HTL';
  if (words.length >= 3) return words.slice(0, 3).map((w) => w[0]).join('');
  const first = words[0];
  if (words.length === 2) {
    // "Palmwine House" -> P + first consonant of the second half of "PALMWINE" (W) + H
    const half = first.slice(Math.ceil(first.length / 2));
    const mid = half.match(/[B-DF-HJ-NP-TV-Z]/)?.[0] ?? first[1] ?? 'X';
    return `${first[0]}${mid}${words[1][0]}`;
  }
  return first.slice(0, 3).padEnd(3, 'X');
}

/** e.g. "PWH-7K3Q". Uniqueness is enforced by the database; callers retry. */
export function reservationCode(prefix: string, length = 4): string {
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${prefix}-${s}`;
}
