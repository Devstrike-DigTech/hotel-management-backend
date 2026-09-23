/**
 * Email layout in the "Laterite & Adire" system: paper background, a card
 * with hairline rules, Fraunces headings (Georgia fallback), Schibsted
 * Grotesk body (Helvetica fallback), IBM Plex Mono figures. Table-based with
 * inline CSS for mail clients; a prefers-color-scheme block (plus Outlook's
 * data-ogsc hooks) swaps to the dark palette where supported.
 */

export interface EmailBrand {
  /** Wordmark shown in the header: APP_NAME, or the hotel name for booking-site mail. */
  wordmark: string;
  /** Small line under the wordmark, e.g. "Lekki Phase 1, Lagos". */
  tagline?: string;
  accent: string;
  logoUrl?: string | null;
  /** Footer sign-off, e.g. "Sent by HotelOS on behalf of The Palmwine House". */
  footerNote: string;
  supportEmail: string;
  appName: string;
}

export type EmailBlock =
  | { kind: 'paragraph'; text: string; muted?: boolean }
  | { kind: 'code'; label: string; value: string }
  | { kind: 'rows'; title?: string; rows: { label: string; value: string; mono?: boolean }[] }
  | { kind: 'money'; title?: string; rows: { label: string; value: string; strong?: boolean; muted?: boolean }[] }
  | { kind: 'button'; label: string; url: string }
  | { kind: 'links'; links: { label: string; url: string }[] }
  | { kind: 'callout'; title: string; text: string; tone?: 'accent' | 'palm' | 'ochre' }
  | { kind: 'quote'; text: string }
  | { kind: 'otp'; code: string };

export interface EmailSpec {
  brand: EmailBrand;
  preheader: string;
  eyebrow: string;
  heading: string;
  blocks: EmailBlock[];
}

const C = {
  paper: '#F4EFE6',
  surface: '#FBF8F2',
  well: '#EDE6DA',
  ink: '#1B1A17',
  muted: '#6B645A',
  line: '#E0D7C8',
  laterite: '#B4452A',
  lateriteInk: '#FFF6EF',
  brass: '#B98A2E',
  palm: '#2F5A43',
  ochre: '#C77D1A',
};

const FONT_HEAD = "'Fraunces', Georgia, 'Times New Roman', serif";
const FONT_BODY = "'Schibsted Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const FONT_MONO = "'IBM Plex Mono', 'SFMono-Regular', Menlo, Consolas, monospace";

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Only #rgb / #rrggbb accents are used in CSS; anything else falls back to laterite. */
export function safeAccent(color: string | null | undefined): string {
  return color && /^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{3}$/.test(color) ? color : C.laterite;
}

function safeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? esc(url) : '#';
}

function block(b: EmailBlock, accent: string): string {
  switch (b.kind) {
    case 'paragraph':
      return `<p class="${b.muted ? 'c-muted' : 'c-ink'}" style="margin:0 0 16px;font-family:${FONT_BODY};font-size:15px;line-height:1.6;color:${b.muted ? C.muted : C.ink};">${esc(b.text)}</p>`;
    case 'code':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;border-collapse:collapse;">
  <tr><td class="c-well b-line" style="background:${C.well};border:1px solid ${C.line};border-radius:6px;padding:14px 18px;">
    <div class="c-muted" style="font-family:${FONT_BODY};font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${C.muted};">${esc(b.label)}</div>
    <div class="c-ink" style="font-family:${FONT_MONO};font-size:24px;letter-spacing:0.08em;color:${C.ink};padding-top:4px;">${esc(b.value)}</div>
  </td></tr></table>`;
    case 'otp':
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;border-collapse:collapse;"><tr><td class="c-well b-line c-ink" style="background:${C.well};border:1px solid ${C.line};border-radius:6px;padding:16px 24px;font-family:${FONT_MONO};font-size:32px;letter-spacing:0.35em;color:${C.ink};">${esc(b.code)}</td></tr></table>`;
    case 'rows':
      return `${b.title ? sectionTitle(b.title) : ''}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-collapse:collapse;">
${b.rows
  .map(
    (r) => `  <tr>
    <td class="c-muted b-line" style="padding:9px 0;border-bottom:1px solid ${C.line};font-family:${FONT_BODY};font-size:13px;color:${C.muted};width:38%;vertical-align:top;">${esc(r.label)}</td>
    <td class="c-ink b-line" style="padding:9px 0;border-bottom:1px solid ${C.line};font-family:${r.mono ? FONT_MONO : FONT_BODY};font-size:14px;color:${C.ink};text-align:right;vertical-align:top;">${esc(r.value)}</td>
  </tr>`,
  )
  .join('\n')}
</table>`;
    case 'money':
      return `${b.title ? sectionTitle(b.title) : ''}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-collapse:collapse;">
${b.rows
  .map((r) => {
    const top = r.strong ? `border-top:2px solid ${C.ink};` : '';
    const weight = r.strong ? 'font-weight:600;' : '';
    const colour = r.muted ? C.muted : C.ink;
    const cls = r.muted ? 'c-muted' : 'c-ink';
    return `  <tr>
    <td class="${cls}${r.strong ? ' b-ink' : ''}" style="padding:7px 0;${top}font-family:${FONT_BODY};font-size:14px;color:${colour};${weight}">${esc(r.label)}</td>
    <td class="${cls}${r.strong ? ' b-ink' : ''}" style="padding:7px 0;${top}font-family:${FONT_MONO};font-size:14px;color:${colour};text-align:right;white-space:nowrap;${weight}">${esc(r.value)}</td>
  </tr>`;
  })
  .join('\n')}
</table>`;
    case 'button':
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;border-collapse:separate;"><tr>
  <td style="border-radius:4px;background:${accent};" bgcolor="${accent}">
    <a href="${safeUrl(b.url)}" style="display:inline-block;padding:13px 22px;font-family:${FONT_BODY};font-size:15px;font-weight:600;color:${C.lateriteInk};text-decoration:none;border-radius:4px;">${esc(b.label)}</a>
  </td></tr></table>`;
    case 'links':
      return `<p style="margin:0 0 20px;font-family:${FONT_BODY};font-size:14px;line-height:1.8;">${b.links
        .map((l) => `<a href="${safeUrl(l.url)}" style="color:${accent};text-decoration:underline;text-underline-offset:3px;">${esc(l.label)}</a>`)
        .join('<span class="c-muted" style="color:' + C.muted + ';">&nbsp;&nbsp;/&nbsp;&nbsp;</span>')}</p>`;
    case 'callout': {
      const tone = b.tone === 'palm' ? C.palm : b.tone === 'ochre' ? C.ochre : accent;
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-collapse:collapse;"><tr>
  <td style="width:3px;background:${tone};" bgcolor="${tone}"></td>
  <td class="c-well" style="background:${C.well};padding:12px 16px;">
    <div class="c-ink" style="font-family:${FONT_BODY};font-size:14px;font-weight:600;color:${C.ink};padding-bottom:2px;">${esc(b.title)}</div>
    <div class="c-muted" style="font-family:${FONT_BODY};font-size:14px;line-height:1.55;color:${C.muted};">${esc(b.text)}</div>
  </td></tr></table>`;
    }
    case 'quote':
      return `<p class="c-ink" style="margin:0 0 20px;padding-left:14px;border-left:2px solid ${C.brass};font-family:${FONT_HEAD};font-style:italic;font-size:16px;line-height:1.55;color:${C.ink};">${esc(b.text)}</p>`;
  }
}

function sectionTitle(t: string): string {
  return `<div class="c-muted" style="margin:8px 0 4px;font-family:${FONT_BODY};font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:${C.muted};">${esc(t)}</div>`;
}

/** A quiet adire-style rule: a thin line of small diamonds in the accent colour. */
function adireRule(accent: string): string {
  const cells = Array.from({ length: 24 }, () => `<td style="padding:0 5px;font-size:8px;line-height:8px;color:${accent};">&#9670;</td>`).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto;opacity:0.55;"><tr>${cells}</tr></table>`;
}

export function renderEmail(spec: EmailSpec): string {
  const accent = safeAccent(spec.brand.accent);
  const b = spec.brand;
  const logo = b.logoUrl?.startsWith('https://')
    ? `<img src="${esc(b.logoUrl)}" width="40" height="40" alt="" style="display:block;border:0;border-radius:4px;margin:0 0 10px;">`
    : '';
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(spec.heading)}</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500&family=IBM+Plex+Mono:wght@400;500&family=Schibsted+Grotesk:wght@400;600&display=swap" rel="stylesheet">
<style>
  body { margin:0; padding:0; -webkit-text-size-adjust:100%; }
  a { color:${accent}; }
  @media (max-width: 620px) { .wrap { width:100% !important; } .pad { padding:24px 20px !important; } }
  @media (prefers-color-scheme: dark) {
    .c-paper { background:#13110E !important; }
    .c-surface { background:#1C1915 !important; }
    .c-well { background:#26221D !important; }
    .c-ink { color:#EFE8DC !important; }
    .c-muted { color:#A69D8F !important; }
    .b-line { border-color:#332E27 !important; }
    .b-ink { border-color:#EFE8DC !important; }
  }
  [data-ogsc] .c-paper { background:#13110E !important; }
  [data-ogsc] .c-surface { background:#1C1915 !important; }
  [data-ogsc] .c-ink { color:#EFE8DC !important; }
  [data-ogsc] .c-muted { color:#A69D8F !important; }
</style>
</head>
<body class="c-paper" style="margin:0;padding:0;background:${C.paper};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(spec.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="c-paper" style="background:${C.paper};border-collapse:collapse;">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" class="wrap" style="width:600px;max-width:600px;border-collapse:collapse;">
    <tr><td style="padding:0 4px 18px;">
      ${logo}
      <div class="c-ink" style="font-family:${FONT_HEAD};font-size:22px;letter-spacing:-0.01em;color:${C.ink};">${esc(b.wordmark)}</div>
      ${b.tagline ? `<div class="c-muted" style="font-family:${FONT_BODY};font-size:12px;color:${C.muted};padding-top:2px;">${esc(b.tagline)}</div>` : ''}
    </td></tr>
    <tr><td style="height:3px;line-height:3px;font-size:0;background:${accent};border-radius:6px 6px 0 0;" bgcolor="${accent}">&nbsp;</td></tr>
    <tr><td class="c-surface b-line" style="background:${C.surface};border:1px solid ${C.line};border-top:0;border-radius:0 0 6px 6px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><td class="pad" style="padding:32px 36px;">
        <div style="font-family:${FONT_BODY};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:${accent};padding-bottom:10px;">${esc(spec.eyebrow)}</div>
        <h1 class="c-ink" style="margin:0 0 18px;font-family:${FONT_HEAD};font-weight:500;font-size:28px;line-height:1.2;letter-spacing:-0.015em;color:${C.ink};">${esc(spec.heading)}</h1>
        ${spec.blocks.map((x) => block(x, accent)).join('\n        ')}
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:22px 0 8px;">${adireRule(accent)}</td></tr>
    <tr><td align="center" style="padding:6px 16px 0;">
      <p class="c-muted" style="margin:0 0 6px;font-family:${FONT_BODY};font-size:12px;line-height:1.6;color:${C.muted};">${esc(b.footerNote)}</p>
      <p class="c-muted" style="margin:0;font-family:${FONT_BODY};font-size:12px;line-height:1.6;color:${C.muted};">Questions about this message? <a href="mailto:${esc(b.supportEmail)}" style="color:${accent};">${esc(b.supportEmail)}</a></p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

/** Plain-text alternative built from the same spec. */
export function renderEmailText(spec: EmailSpec): string {
  const out: string[] = [spec.brand.wordmark, '', spec.eyebrow.toUpperCase(), spec.heading, ''];
  for (const b of spec.blocks) {
    switch (b.kind) {
      case 'paragraph':
      case 'quote':
        out.push(b.text, '');
        break;
      case 'code':
        out.push(`${b.label}: ${b.value}`, '');
        break;
      case 'otp':
        out.push(`Code: ${b.code}`, '');
        break;
      case 'rows':
      case 'money':
        if (b.title) out.push(b.title.toUpperCase());
        for (const r of b.rows) out.push(`${r.label}: ${r.value}`);
        out.push('');
        break;
      case 'button':
        out.push(`${b.label}: ${b.url}`, '');
        break;
      case 'links':
        for (const l of b.links) out.push(`${l.label}: ${l.url}`);
        out.push('');
        break;
      case 'callout':
        out.push(`${b.title}. ${b.text}`, '');
        break;
    }
  }
  out.push('--', spec.brand.footerNote, `Support: ${spec.brand.supportEmail}`);
  return out.join('\n');
}
