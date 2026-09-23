const ONES = [
  '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];

function belowThousand(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) parts.push(`${ONES[h]} hundred`);
  if (r) {
    const words = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? `-${ONES[r % 10]}` : ''}`;
    parts.push(h ? `and ${words}` : words);
  }
  return parts.join(' ');
}

function integerWords(n: number): string {
  if (n === 0) return 'zero';
  const groups: string[] = [];
  let i = 0;
  while (n > 0) {
    const g = n % 1000;
    if (g) groups.unshift(`${belowThousand(g)}${SCALES[i] ? ` ${SCALES[i]}` : ''}`);
    n = Math.floor(n / 1000);
    i++;
  }
  return groups.join(', ');
}

/** 5_025_050 kobo -> "Fifty thousand, two hundred and fifty naira, fifty kobo only". */
export function amountInWords(kobo: number): string {
  const abs = Math.abs(Math.trunc(kobo));
  const naira = Math.floor(abs / 100);
  const k = abs % 100;
  let s = `${integerWords(naira)} naira`;
  if (k) s += `, ${integerWords(k)} kobo`;
  s += ' only';
  if (kobo < 0) s = `minus ${s}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
