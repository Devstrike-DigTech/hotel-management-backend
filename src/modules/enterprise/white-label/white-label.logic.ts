/** White-label (M6): curated fonts and input checks. Pure, unit tested. */

export interface FontChoice {
  family: string;
  category: 'serif' | 'sans' | 'display';
  weights: number[];
  googleFontsUrl: string;
}

const font = (family: string, category: FontChoice['category'], weights: number[]): FontChoice => ({
  family,
  category,
  weights,
  googleFontsUrl: `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:wght@${weights.join(';')}&display=swap`,
});

export const FONTS: FontChoice[] = [
  font('Fraunces', 'serif', [400, 600, 700]),
  font('Playfair Display', 'serif', [400, 600, 700]),
  font('Cormorant Garamond', 'serif', [400, 500, 600, 700]),
  font('DM Serif Display', 'display', [400]),
  font('Libre Baskerville', 'serif', [400, 700]),
  font('Lora', 'serif', [400, 500, 600, 700]),
  font('Marcellus', 'display', [400]),
  font('Schibsted Grotesk', 'sans', [400, 500, 600, 700]),
  font('Work Sans', 'sans', [400, 500, 600, 700]),
  font('Manrope', 'sans', [400, 500, 600, 700]),
  font('Karla', 'sans', [400, 500, 600, 700]),
  font('Figtree', 'sans', [400, 500, 600, 700]),
  font('Libre Franklin', 'sans', [400, 500, 600, 700]),
  font('Source Sans 3', 'sans', [400, 600, 700]),
  font('IBM Plex Sans', 'sans', [400, 500, 600, 700]),
  font('Space Grotesk', 'sans', [400, 500, 600, 700]),
];

export function fontByName(name: string | null | undefined): FontChoice | null {
  if (!name) return null;
  return FONTS.find((f) => f.family.toLowerCase() === name.toLowerCase()) ?? null;
}

export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function isHttpsUrl(v: string): boolean {
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

/** SMS sender IDs: 3..11 letters or digits, at least one letter (operator rule). */
export function validSenderId(v: string): boolean {
  return /^[A-Za-z0-9]{3,11}$/.test(v) && /[A-Za-z]/.test(v);
}

/** DNS records a sending domain needs (dev mock; Resend returns its own). */
export function mockEmailRecords(domain: string) {
  return [
    { purpose: 'SPF' as const, type: 'MX' as const, name: `send.${domain}`, value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10, ttl: 'Auto', status: 'pending' as const },
    { purpose: 'SPF' as const, type: 'TXT' as const, name: `send.${domain}`, value: 'v=spf1 include:amazonses.com ~all', priority: null, ttl: 'Auto', status: 'pending' as const },
    { purpose: 'DKIM' as const, type: 'TXT' as const, name: `resend._domainkey.${domain}`, value: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDmockdkimkeyfordevelopmentonly', priority: null, ttl: 'Auto', status: 'pending' as const },
    { purpose: 'DMARC' as const, type: 'TXT' as const, name: `_dmarc.${domain}`, value: 'v=DMARC1; p=none;', priority: null, ttl: 'Auto', status: 'pending' as const },
  ];
}
