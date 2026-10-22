/**
 * Automatic lifecycle emails (aperture-tykv8): welcome, list ready, D−5
 * reminder and gift received. The operator's four PDFs are the reference;
 * this module only renders, it never sends or resolves data.
 *
 * Email-client robustness:
 *   - 600px presentation tables at width 100%, every style inline, no flex/grid,
 *     scripts, forms or CSS variables. A small <style> block only adds optional
 *     mobile stacking; without it the two-column cards still fit at 320px.
 *   - Patrick Hand (the brand handwriting) renders where installed, with web-safe
 *     handwriting fallbacks; no webfont is fetched, so opening the email makes no
 *     third-party request (only our hosted logo). Body text is Arial.
 *   - Outlook (MSO) gets a fixed 600px ghost table; everyone else a fluid table
 *     capped by max-width.
 *   - The purple→pink→orange hero declares a solid `bgcolor` + background-color
 *     BEFORE the gradient, so Outlook and gradient-less clients keep white-text
 *     contrast. Radius/shadow are cosmetic.
 *   - Light-only colour scheme with explicit colours on every cell, so dark-mode
 *     clients either leave it alone or invert it consistently.
 *   - The logo is the hosted site asset (absolute URL) with alt text and size.
 *
 * Every caller-provided string is escaped. URLs are built by the backend from
 * the configured origin and signed tokens; they are rendered, never logged.
 */

export const LIFECYCLE_EMAIL_TYPES = [
  'welcome',
  'list_ready',
  'event_reminder',
  'payment_received',
  'new_message',
  'presence_confirmed',
] as const;

export type LifecycleEmailRenderType = (typeof LIFECYCLE_EMAIL_TYPES)[number];

export interface LifecycleEmailCommonVars {
  /** nomeExibicao of the person receiving this email. */
  recipientName: string;
  /** Logged-in painel of the campaign ("Ver meu chá"). */
  dashboardUrl: string;
  /** All-types preferences page (token without a type scope). */
  preferencesUrl: string;
  /** One-type opt-out page (type-scoped token). */
  unsubscribeUrl: string;
  /** Feedback page with the per-delivery token; `&nota=N` is appended here. */
  feedbackUrl: string;
  /** Origin that serves /public/logo-landing.png. */
  assetBaseUrl: string;
}

export interface LifecycleEmailVars {
  new_message: LifecycleEmailCommonVars;
  presence_confirmed: LifecycleEmailCommonVars;
  welcome: LifecycleEmailCommonVars & {
    startUrl: string;
    /** Real number of contribuições on the campaign; null hides the line. */
    giftCount: number | null;
  };
  list_ready: LifecycleEmailCommonVars & {
    /** Invitation panel of the campaign (copy/share controls). */
    shareUrl: string;
  };
  event_reminder: LifecycleEmailCommonVars & {
    /** Already formatted in America/Sao_Paulo, e.g. "sábado, 25 de outubro". */
    eventDate?: string | null;
  };
  payment_received: LifecycleEmailCommonVars & {
    /** nomeExibicao of the campaign owner ({{nome_mamae}}). */
    ownerName?: string | null;
    guestName?: string | null;
    guestMessage?: string | null;
    gifts: readonly { name: string; quantity: number }[];
    /** false for members with extrato:ver — neutral third-person copy. */
    recipientIsOwner: boolean;
  };
}

export interface RenderedLifecycleEmail {
  subject: string;
  html: string;
  text: string;
}

export const EUNENEM_CONTACT = {
  email: 'oi@eunenem.com',
  whatsappDisplay: '+55 31 99601-1432',
  whatsappUrl: 'https://wa.me/5531996011432',
  instagramUrl: 'https://www.instagram.com/eu_nenem',
} as const;

// Brand tokens sampled from the PDFs (hex-inlined — no CSS variables in email).
const C = {
  page: '#efece9',
  card: '#ffffff',
  soft: '#f8f7f6',
  line: '#efe2e9',
  ink: '#6b3c5e',
  body: '#5c3a4f',
  muted: '#a18a99',
  accent: '#a77bc0',
  heroSolid: '#9a68ad',
  white: '#ffffff',
  pink: '#fde4ec',
  lilac: '#ece1f5',
  green: '#eef4d6',
  blue: '#dcecef',
  peach: '#fde9d4',
  yellow: '#f7d560',
  teal: '#a5dbe0',
} as const;

const HAND = "'Patrick Hand','Comic Sans MS','Segoe Print','Bradley Hand',cursive";
const SANS = 'Arial,Helvetica,sans-serif';
const HERO_GRADIENT =
  'linear-gradient(135deg,#9061a9 0%,#a77bc0 32%,#c87594 68%,#e0a862 100%)';
const BUTTON_GRADIENT = 'linear-gradient(90deg,#c8a4d7 0%,#a77bc0 100%)';
const RATING_COLOURS = [
  ['#fbe0ea', C.ink],
  ['#e78fa7', C.ink],
  ['#f7d560', C.ink],
  ['#c7dc6e', C.ink],
  ['#8aa53a', C.white],
] as const;

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escaped, with newlines as <br> (guest messages). */
function escMultiline(value: string): string {
  return esc(value.replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>');
}

function upper(value: string): string {
  return value.toLocaleUpperCase('pt-BR');
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function withQuery(url: string, key: string, value: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
}

// ── building blocks ──────────────────────────────────────────────────────────

/** Small caps label. Takes plain text (escaped here); uppercase is literal so
 *  clients that ignore text-transform still match the design. */
function eyebrow(label: string, align: 'left' | 'center' = 'left', pad = '0 0 12px'): string {
  return `<div style="margin:0;padding:${pad};font-family:${SANS};font-size:11px;line-height:16px;letter-spacing:2px;font-weight:bold;color:${C.muted};text-align:${align}">${esc(upper(label))}</div>`;
}

function handTitle(text: string, size = 26, colour: string = C.ink, align = 'left'): string {
  return `<div style="margin:0 0 10px;font-family:${HAND};font-size:${size}px;line-height:1.2;font-weight:normal;color:${colour};text-align:${align}">${text}</div>`;
}

function para(text: string, extra = ''): string {
  return `<p style="margin:0 0 14px;font-family:${SANS};font-size:15px;line-height:24px;color:${C.body};${extra}">${text}</p>`;
}

function card(inner: string, padding = '32px 40px'): string {
  return `<tr><td style="padding:0 0 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="background-color:${C.card};border:1px solid ${C.line};border-radius:24px;border-collapse:separate"><tr><td class="pad" style="padding:${padding}">${inner}</td></tr></table></td></tr>`;
}

function iconTile(glyph: string, bg: string, colour: string = C.ink): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="40" height="40" align="center" valign="middle" bgcolor="${bg}" style="width:40px;height:40px;background-color:${bg};border-radius:10px;font-family:${SANS};font-size:18px;line-height:40px;color:${colour}">${glyph}</td></tr></table>`;
}

function button(label: string, href: string, caption?: string): string {
  return `<tr><td align="center" style="padding:8px 0 ${caption ? '8px' : '24px'}">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${C.accent}" style="background-color:${C.accent};background-image:${BUTTON_GRADIENT};border-radius:999px">
<a href="${esc(href)}" target="_blank" style="display:inline-block;padding:16px 40px;font-family:${SANS};font-size:14px;line-height:18px;font-weight:bold;letter-spacing:2px;color:${C.white};text-decoration:none;border-radius:999px">${esc(upper(label))}</a>
</td></tr></table></td></tr>${
    caption
      ? `<tr><td align="center" style="padding:0 16px 28px;font-family:${SANS};font-size:12px;line-height:18px;color:${C.muted}">${caption}</td></tr>`
      : ''
  }`;
}

/** Two cards side by side; stacks on narrow screens where <style> is honoured. */
function twoColumns(left: string, right: string): string {
  const cell = (inner: string, side: 'l' | 'r') =>
    `<td class="col" width="50%" valign="top" style="padding:0 ${side === 'l' ? '8px' : '0'} 16px ${side === 'r' ? '8px' : '0'}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="background-color:${C.card};border:1px solid ${C.line};border-radius:24px;border-collapse:separate"><tr><td style="padding:24px">${inner}</td></tr></table></td>`;
  return `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cell(left, 'l')}${cell(right, 'r')}</tr></table></td></tr>`;
}

function featureCard(icon: string, label: string, title: string, body: string): string {
  return `${icon}<div style="height:16px;line-height:16px;font-size:0">&nbsp;</div>${eyebrow(label, 'left', '0 0 6px')}${handTitle(title, 22)}<div style="font-family:${SANS};font-size:14px;line-height:22px;color:${C.body}">${body}</div>`;
}

function hero(opts: { eyebrow?: string; title: string; subtitle?: string; align: 'left' | 'center' }): string {
  const { align } = opts;
  return `<tr><td style="padding:0 0 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="pad" align="${align}" bgcolor="${C.heroSolid}" style="background-color:${C.heroSolid};background-image:${HERO_GRADIENT};border-radius:24px;padding:${align === 'center' ? '56px 48px' : '44px 44px'};text-align:${align}">
${opts.eyebrow ? `<div style="margin:0 0 18px;font-family:${SANS};font-size:12px;line-height:16px;letter-spacing:2px;color:${C.white}">${esc(upper(opts.eyebrow))}</div>` : ''}
<h1 style="margin:0 0 ${opts.subtitle ? '18px' : '0'};font-family:${HAND};font-size:${align === 'center' ? 44 : 40}px;line-height:1.15;font-weight:normal;color:${C.white}">${opts.title}</h1>
${opts.subtitle ? `<p style="margin:0${align === 'center' ? ' auto' : ''};max-width:${align === 'center' ? 400 : 480}px;font-family:${SANS};font-size:16px;line-height:26px;color:${C.white}">${opts.subtitle}</p>` : ''}
</td></tr></table></td></tr>`;
}

function contactCard(intro: string): string {
  const link = `font-family:${SANS};font-size:15px;line-height:26px;color:${C.accent};text-decoration:underline`;
  return card(
    `${eyebrow('estamos aqui')}${handTitle('qualquer dúvida, é só chamar', 26)}${para(intro)}
<a href="mailto:${EUNENEM_CONTACT.email}" style="${link}">${EUNENEM_CONTACT.email}</a><br>
<a href="${EUNENEM_CONTACT.whatsappUrl}" target="_blank" style="${link}">${EUNENEM_CONTACT.whatsappDisplay}</a>
<div style="height:24px;line-height:24px;font-size:0">&nbsp;</div>
${handTitle('com carinho,<br>time EuNeném', 22, C.ink)}`,
  );
}

function feedbackSection(feedbackUrl: string): string {
  const squares = RATING_COLOURS.map(
    ([bg, fg], i) =>
      `<td align="center" style="padding:0 5px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="52" height="52" align="center" valign="middle" bgcolor="${bg}" style="width:52px;height:52px;background-color:${bg};border-radius:14px"><a href="${esc(withQuery(feedbackUrl, 'nota', String(i + 1)))}" target="_blank" style="display:block;font-family:${HAND};font-size:24px;line-height:52px;color:${fg};text-decoration:none">${i + 1}</a></td></tr></table></td>`,
  ).join('');
  const small = `font-family:${SANS};font-size:11px;line-height:16px;letter-spacing:1px;color:${C.muted}`;
  return `<tr><td style="padding:16px 8px 0">${eyebrow('avalie sua experiência')}</td></tr>${card(
    `${handTitle('como foi montar o seu chá?', 28, C.ink, 'center')}
${para('leva um segundinho e ajuda a gente a cuidar melhor das próximas mamães.', 'text-align:center')}
<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:8px auto 0"><tr>${squares}</tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px"><tr><td align="left" style="${small}">PODERIA SER MELHOR</td><td align="right" style="${small}">AMEI</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.soft}" style="background-color:${C.soft};border:1px solid ${C.line};border-radius:16px;border-collapse:separate"><tr><td style="padding:20px 24px">
${eyebrow('deixe um comentário', 'left', '0 0 6px')}${handTitle('conta pra gente: o que foi fácil, o que faltou? ♡', 22)}
<a href="${esc(feedbackUrl)}" target="_blank" style="font-family:${SANS};font-size:13px;line-height:18px;font-weight:bold;letter-spacing:2px;color:${C.accent};text-decoration:none">ESCREVER MEU COMENTÁRIO &rarr;</a>
</td></tr></table>`,
  )}`;
}

function footer(opts: {
  logo: string;
  reason: string;
  unsubscribeUrl: string;
  preferencesUrl: string;
  tagline?: string;
}): string {
  const link = `color:${C.muted};text-decoration:underline`;
  return `<tr><td align="center" style="padding:24px 16px 8px">${opts.logo}</td></tr>
<tr><td align="center" style="padding:0 16px 16px;${
    opts.tagline
      ? `font-family:${SANS};font-size:11px;line-height:16px;letter-spacing:2px;color:${C.muted}">${esc(upper(opts.tagline))}`
      : `font-family:${HAND};font-size:20px;line-height:24px;color:${C.ink}">EuNeném`
  }</td></tr>
<tr><td align="center" style="padding:16px 16px 0;border-top:1px solid ${C.line};font-family:${SANS};font-size:12px;line-height:20px;color:${C.muted}">${opts.reason}<br>
<a href="${esc(opts.unsubscribeUrl)}" target="_blank" style="${link}">descadastrar</a> &middot; <a href="${esc(opts.preferencesUrl)}" target="_blank" style="${link}">preferências de e-mail</a></td></tr>
<tr><td align="center" style="padding:16px 16px 40px;font-family:${SANS};font-size:12px;line-height:18px;color:${C.muted}">&copy; EuNeném</td></tr>`;
}

function logo(base: string, width: number): string {
  const height = Math.round((width * 160) / 478);
  return `<img src="${esc(`${base.replace(/\/+$/, '')}/public/logo-landing.png`)}" width="${width}" height="${height}" alt="EuNeném" style="display:block;border:0;outline:none;width:${width}px;height:${height}px;font-family:${HAND};font-size:22px;color:${C.ink}">`;
}

function header(base: string, withNav: boolean): string {
  const nav = `font-family:${SANS};font-size:11px;line-height:16px;letter-spacing:2px;color:${C.muted};text-decoration:none`;
  return `<tr><td style="padding:32px 8px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left" valign="middle">${logo(base, 132)}</td>
${withNav ? `<td align="right" valign="middle" style="${nav}"><a href="${EUNENEM_CONTACT.instagramUrl}" target="_blank" style="${nav}">INSTAGRAM</a> &nbsp;&middot;&nbsp; <a href="${EUNENEM_CONTACT.whatsappUrl}" target="_blank" style="${nav}">AJUDA</a></td>` : ''}
</tr></table></td></tr>`;
}

function documentShell(opts: { subject: string; preheader: string; rows: string }): string {
  return `<!doctype html>
<html lang="pt-BR" xmlns="http://www.w3.org/1999/xhtml"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(opts.subject)}</title>
<style>
:root{color-scheme:light only;supported-color-schemes:light only}
@media only screen and (max-width:520px){
.col{display:block!important;width:100%!important;padding-left:0!important;padding-right:0!important}
.pad{padding-left:24px!important;padding-right:24px!important}
}
</style>
</head>
<body bgcolor="${C.page}" style="margin:0;padding:0;background-color:${C.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page}">${esc(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background-color:${C.page}"><tr><td align="center" style="padding:0 12px">
<!--[if mso]><table role="presentation" align="center" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto">
${opts.rows}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`;
}

// ── plain-text helpers ──────────────────────────────────────────────────────

function textFooter(v: LifecycleEmailCommonVars, reason: string, withFeedback = true): string {
  return [
    ...(withFeedback
      ? [
          'avalie sua experiência — como foi montar o seu chá?',
          `de 1 (poderia ser melhor) a 5 (amei): ${v.feedbackUrl}`,
          '',
        ]
      : []),
    '—',
    reason,
    `descadastrar: ${v.unsubscribeUrl}`,
    `preferências de e-mail: ${v.preferencesUrl}`,
    '© EuNeném',
  ].join('\n');
}

const TEXT_CONTACT = [
  'qualquer dúvida, é só chamar',
  `email: ${EUNENEM_CONTACT.email}`,
  `WhatsApp: ${EUNENEM_CONTACT.whatsappDisplay}`,
  `Instagram: ${EUNENEM_CONTACT.instagramUrl}`,
].join('\n');

// ── templates ───────────────────────────────────────────────────────────────

function mimosLine(count: number): string {
  if (count === 0) return '0 mimos por enquanto';
  return `${count} ${count === 1 ? 'mimo' : 'mimos'} na sua lista`;
}

function renderWelcome(v: LifecycleEmailVars['welcome']): RenderedLifecycleEmail {
  const subject = 'bem-vinda, que alegria ♡';
  const reason = 'você recebeu este e-mail porque criou uma conta na EuNeném.';
  const count = typeof v.giftCount === 'number' && v.giftCount >= 0 ? Math.floor(v.giftCount) : null;
  const progress = count === null ? 0 : Math.min(100, Math.round((count / 20) * 100));
  const listBox =
    count === null
      ? ''
      : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.soft}" style="background-color:${C.soft};border:1px solid ${C.line};border-radius:16px;border-collapse:separate;margin:0 0 20px"><tr><td style="padding:20px 24px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="left" style="font-family:${SANS};font-size:11px;line-height:16px;letter-spacing:2px;color:${C.muted}">SUA LISTA</td><td align="right" style="font-family:${HAND};font-size:18px;line-height:22px;color:${C.accent}">${mimosLine(count)}</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px"><tr>${
          progress > 0
            ? `<td width="${progress}%" height="8" bgcolor="${C.accent}" style="height:8px;font-size:0;line-height:8px;background-color:${C.accent};border-radius:8px">&nbsp;</td>`
            : ''
        }${progress < 100 ? `<td height="8" bgcolor="${C.line}" style="height:8px;font-size:0;line-height:8px;background-color:${C.line};border-radius:8px">&nbsp;</td>` : ''}</tr></table>
</td></tr></table>`;

  const rows = [
    header(v.assetBaseUrl, true),
    hero({
      eyebrow: 'olá, mamãe ♡',
      title: 'bem-vinda,<br>que alegria',
      subtitle: 'agora você pode organizar seu chá de bebê de um jeito simples, bonito e sem complicação.',
      align: 'center',
    }),
    `<tr><td align="center">${eyebrow('tudo o que dá pra fazer', 'center', '0 0 16px')}</td></tr>`,
    twoColumns(
      featureCard(iconTile('&#9825;', C.pink), 'sua lista', 'monte sua lista de mimos', 'do essencial ao sonho grande: fraldas, enxoval, carrinho e muito mais.'),
      featureCard(iconTile('&#10035;', C.lilac, C.accent), 'personalização', 'deixe com a sua cara', 'nome do bebê, recadinho, cores e foto na página do seu chá.'),
    ),
    twoColumns(
      featureCard(iconTile('&rarr;', C.green, '#7c9a2e'), 'convidados', 'compartilhe um link só', 'manda no zap, no story ou no convite. eles escolhem e presenteiam em poucos cliques.'),
      featureCard(iconTile('&#10003;', C.blue, '#4f8a92'), 'recebimento', 'receba tudo online', 'com segurança, e você acompanha cada presente recebido no seu painel.'),
    ),
    button('começar meu chá de bebê', v.startUrl, 'leva uns 5 minutinhos — e dá pra editar quando quiser'),
    card(
      `${eyebrow('por onde começar')}${handTitle('adicione presentes personalizados ou lista pronta', 26)}${listBox}${para(
        'abra sua lista com o que você mais quer e acrescente o resto no seu tempo. quando estiver pronta, compartilhe o link com quem você ama — a gente cuida de pagamentos, avisos e do painel onde você acompanha tudo.',
        'margin:0',
      )}`,
    ),
    contactCard('entre em contato com a gente via WhatsApp ou email'),
    feedbackSection(v.feedbackUrl),
    footer({ logo: logo(v.assetBaseUrl, 112), reason, unsubscribeUrl: v.unsubscribeUrl, preferencesUrl: v.preferencesUrl }),
  ].join('\n');

  const text = [
    'olá, mamãe ♡',
    '',
    'bem-vinda, que alegria',
    'agora você pode organizar seu chá de bebê de um jeito simples, bonito e sem complicação.',
    '',
    'tudo o que dá pra fazer',
    '- sua lista: monte sua lista de mimos — do essencial ao sonho grande: fraldas, enxoval, carrinho e muito mais.',
    '- personalização: deixe com a sua cara — nome do bebê, recadinho, cores e foto na página do seu chá.',
    '- convidados: compartilhe um link só — manda no zap, no story ou no convite.',
    '- recebimento: receba tudo online — com segurança, e você acompanha cada presente recebido no seu painel.',
    '',
    `Começar meu chá de bebê: ${v.startUrl}`,
    'leva uns 5 minutinhos — e dá pra editar quando quiser',
    '',
    'por onde começar: adicione presentes personalizados ou lista pronta',
    ...(count === null ? [] : [`sua lista: ${mimosLine(count)}`]),
    'abra sua lista com o que você mais quer e acrescente o resto no seu tempo.',
    '',
    TEXT_CONTACT,
    '',
    'com carinho,',
    'time EuNeném',
    '',
    textFooter(v, reason),
  ].join('\n');

  return { subject, html: documentShell({ subject, preheader: 'agora você pode organizar seu chá de bebê de um jeito simples, bonito e sem complicação.', rows }), text };
}

function renderListReady(v: LifecycleEmailVars['list_ready']): RenderedLifecycleEmail {
  const subject = 'seu chá já está pronto!';
  const reason = 'você recebeu este e-mail porque criou uma lista de presentes na EuNeném.';
  const step = (n: number, colour: string, body: string) =>
    `<td class="col" width="33%" valign="top" style="padding:0 10px">${handTitle(String(n), 28, colour)}<div style="font-family:${SANS};font-size:13px;line-height:20px;color:${C.body}">${body}</div></td>`;

  const rows = [
    header(v.assetBaseUrl, false),
    hero({
      eyebrow: 'olá, mamãe ♡',
      title: 'seu chá já está pronto!',
      subtitle:
        'agora é hora de deixar as pessoas que você ama fazerem parte desse momento. a lista está montada, os mimos escolhidos — só falta o link chegar até elas.',
      align: 'left',
    }),
    `<tr><td style="padding:0 8px">${eyebrow('onde compartilhar', 'left', '0 0 16px')}</td></tr>`,
    twoColumns(
      featureCard(iconTile('&#9990;', '#c7dc6e'), 'whatsapp', 'no grupo da família', 'cola o link com um “olha o nosso chá aqui ♡”. em minutos todo mundo já sabe.'),
      featureCard(iconTile('&#9678;', C.pink, '#e78fa7'), 'instagram', 'num story fofo', 'uma foto da barriguinha, o link no sticker e pronto — quem quiser participar acha sozinho.'),
    ),
    twoColumns(
      featureCard(iconTile('&#9993;', C.yellow), 'no convite', 'junto do convite', 'crie um convite personalizado e envie junto com o link. o convidado já cai na sua lista de presentes.'),
      featureCard(iconTile('&#9749;', C.teal), 'pessoalmente', 'no cafezinho', 'contou pra alguém no corredor? manda o link depois, no privado. simples assim.'),
    ),
    button('compartilhar meu chá', v.shareUrl, 'a gente já deixa o texto prontinho pra você só colar ♡'),
    `<tr><td style="padding:0 8px">${eyebrow('como funciona pra quem recebe', 'left', '0 0 16px')}</td></tr>`,
    card(
      `${handTitle('três toques e o mimo é seu', 26)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.soft}" style="background-color:${C.soft};border-radius:16px"><tr><td style="padding:20px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
${step(1, '#c8607f', 'o convidado abre o seu link e vê a lista do jeitinho que você montou.')}
${step(2, C.accent, 'escolhe um mimo e deixa um recadinho pro bebê.')}
${step(3, '#7c9a2e', 'você recebe o valor em sua conta, sem presente repetido e sem correria.')}
</tr></table></td></tr></table>`,
      '28px 28px',
    ),
    card(
      `${eyebrow('sem pressa', 'left', '0 0 6px')}${handTitle('compartilhe do seu jeito, no seu tempo', 26)}${para(
        'o link fica sempre disponível — hoje, semana que vem, ou quando bater aquela vontade de contar. pode mandar pra uma pessoa só ou pra todo mundo de uma vez. não tem certo nem errado aqui.',
        'margin:0',
      )}`,
      '28px 28px',
    ),
    feedbackSection(v.feedbackUrl),
    `<tr><td align="center" style="padding:24px 24px 8px">${handTitle('quando você compartilha, você abre a porta pra quem te ama esperar esse bebê junto com você ♡', 30, C.ink, 'center')}</td></tr>
<tr><td align="center" style="padding:0 24px 24px">${para('e no fim, cada mimo que chegar vai ter o nome de alguém que quis fazer parte.', 'text-align:center;margin:0')}</td></tr>`,
    footer({
      logo: logo(v.assetBaseUrl, 132),
      tagline: 'chá de bebê online, feito com carinho',
      reason,
      unsubscribeUrl: v.unsubscribeUrl,
      preferencesUrl: v.preferencesUrl,
    }),
  ].join('\n');

  const text = [
    'olá, mamãe ♡',
    '',
    'seu chá já está pronto!',
    'agora é hora de deixar as pessoas que você ama fazerem parte desse momento. a lista está montada, os mimos escolhidos — só falta o link chegar até elas.',
    '',
    'onde compartilhar',
    '- whatsapp: no grupo da família',
    '- instagram: num story fofo',
    '- no convite: junto do convite personalizado',
    '- pessoalmente: no cafezinho',
    '',
    `Compartilhar meu chá: ${v.shareUrl}`,
    '',
    'três toques e o mimo é seu',
    '1. o convidado abre o seu link e vê a lista do jeitinho que você montou.',
    '2. escolhe um mimo e deixa um recadinho pro bebê.',
    '3. você recebe o valor em sua conta, sem presente repetido e sem correria.',
    '',
    'sem pressa: o link fica sempre disponível. não tem certo nem errado aqui.',
    '',
    textFooter(v, reason),
  ].join('\n');

  return { subject, html: documentShell({ subject, preheader: 'agora é hora de deixar as pessoas que você ama fazerem parte desse momento.', rows }), text };
}

const CHECKLIST = [
  ['&#9825;', C.pink, '#e78fa7', 'dar uma última olhada na lista de convidados'],
  ['&rarr;', C.lilac, C.accent, 'mandar o convite para quem ainda não recebeu'],
  ['&#10035;', C.green, '#7c9a2e', 'conferir se a lista de presentes está do seu jeito'],
  ['&#10003;', C.blue, '#4f8a92', 'ver quem já confirmou presença'],
  ['&#9788;', C.peach, '#d98a3d', 'separar os últimos detalhes do evento'],
] as const;

function renderEventReminder(v: LifecycleEmailVars['event_reminder']): RenderedLifecycleEmail {
  const subject = 'respira, está tudo caminhando ♡';
  const reason = 'você recebeu este e-mail porque tem um chá de bebê na EuNeném.';
  const date = clean(v.eventDate);
  const items = CHECKLIST.map(
    ([glyph, bg, fg, label], i) =>
      `<tr><td style="padding:12px 0;${i < CHECKLIST.length - 1 ? `border-bottom:1px solid ${C.line}` : ''}"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="24" height="24" align="center" valign="middle" bgcolor="${bg}" style="width:24px;height:24px;background-color:${bg};border-radius:6px;font-family:${SANS};font-size:13px;line-height:24px;color:${fg}">${glyph}</td><td style="padding-left:12px;font-family:${SANS};font-size:15px;line-height:22px;color:${C.body}">${label}</td></tr></table></td></tr>`,
  ).join('');

  const rows = [
    header(v.assetBaseUrl, true),
    hero({
      eyebrow: 'falta pouco ♡',
      title: 'respira, está<br>tudo caminhando',
      subtitle: `o dia do seu chá está logo aí e a parte mais importante já está pronta.${date ? `<br><span style="font-family:${HAND};font-size:20px">seu chá é ${esc(date)} ♡</span>` : ''}`,
      align: 'center',
    }),
    `<tr><td align="center">${eyebrow('só uma passada de olho', 'center', '0 0 16px')}</td></tr>`,
    card(
      `${handTitle('cinco detalhes, no seu tempo', 28)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.soft}" style="background-color:${C.soft};border:1px solid ${C.line};border-radius:16px;border-collapse:separate;margin:8px 0 20px"><tr><td style="padding:8px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items}</table></td></tr></table>
${para('não precisa ser hoje, nem tudo de uma vez. está tudo salvo na sua página — você entra, ajusta o que quiser e volta quando der.', 'margin:0')}`,
    ),
    button('ver meu chá', v.dashboardUrl, 'tudo em um lugar só — convidados, presentes e confirmações'),
    contactCard('a gente responde rapidinho, no WhatsApp ou por email'),
    feedbackSection(v.feedbackUrl),
    footer({ logo: logo(v.assetBaseUrl, 112), reason, unsubscribeUrl: v.unsubscribeUrl, preferencesUrl: v.preferencesUrl }),
  ].join('\n');

  const text = [
    'falta pouco ♡',
    '',
    'respira, está tudo caminhando',
    'o dia do seu chá está logo aí e a parte mais importante já está pronta.',
    ...(date ? [`seu chá é ${date}.`] : []),
    '',
    'cinco detalhes, no seu tempo',
    ...CHECKLIST.map(([, , , label]) => `- ${label}`),
    '',
    'não precisa ser hoje, nem tudo de uma vez. está tudo salvo na sua página.',
    '',
    `Ver meu chá: ${v.dashboardUrl}`,
    '',
    TEXT_CONTACT,
    '',
    'com carinho,',
    'time EuNeném',
    '',
    textFooter(v, reason),
  ].join('\n');

  return { subject, html: documentShell({ subject, preheader: 'o dia do seu chá está logo aí e a parte mais importante já está pronta.', rows }), text };
}

function renderPaymentReceived(v: LifecycleEmailVars['payment_received']): RenderedLifecycleEmail {
  const isOwner = v.recipientIsOwner;
  // The owner's name only ever comes from ownerName; for a member we never
  // fall back to the member's own name (that would address them as the mother).
  const ownerName = clean(v.ownerName);
  const owner = ownerName ?? (isOwner ? (clean(v.recipientName) ?? '') : null);
  const recipient = clean(v.recipientName) ?? owner ?? '';
  const ofOwner = owner ? ` de ${owner}` : '';
  const guest = clean(v.guestName);
  const guestLabel = guest ?? 'alguém';
  const message = clean(v.guestMessage);
  const gifts = v.gifts
    .map((g) => ({ name: g.name.trim(), quantity: Math.max(1, Math.floor(g.quantity)) }))
    .filter((g) => g.name.length > 0);

  const subject = isOwner
    ? 'hoje alguém escolheu fazer parte da história do seu bebê'
    : `hoje alguém escolheu fazer parte da história do bebê${ofOwner}`;
  const heroTitle = isOwner
    ? 'hoje alguém escolheu<br>fazer parte da história<br>do seu bebê'
    : `hoje alguém escolheu<br>fazer parte da história<br>do bebê${esc(ofOwner)}`;
  const reason = isOwner
    ? 'você recebeu este e-mail porque tem um chá de bebê na EuNeném.'
    : 'você recebeu este e-mail porque tem acesso a um chá de bebê na EuNeném.';
  const greeting = isOwner
    ? `${owner}, aconteceu uma coisa bonita hoje.`
    : `${recipient}, aconteceu uma coisa bonita hoje no chá${ofOwner}.`;
  const visited = isOwner
    ? 'passou pela sua lista, olhou com calma cada item que você escolheu com tanto cuidado — e decidiu presentear o seu bebê.'
    : `passou pela lista ${owner ? `de ${owner}` : 'do chá'}, olhou com calma cada item escolhido com tanto cuidado — e decidiu presentear o bebê.`;
  const registered = isOwner
    ? 'já deixamos tudo registrado na sua lista — você pode acompanhar por lá, com calma, sempre que quiser.'
    : 'já deixamos tudo registrado na lista do chá — dá pra acompanhar por lá, com calma, sempre que quiser.';
  const giftLabel = (g: { name: string; quantity: number }) =>
    g.quantity > 1 ? `${g.name} × ${g.quantity}` : g.name;
  const noSnapshot = isOwner ? 'um presente da sua lista' : 'um presente da lista';
  const giftsHtml =
    gifts.length === 0
      ? noSnapshot
      : gifts.length === 1
        ? esc(giftLabel(gifts[0] as { name: string; quantity: number }))
        : gifts.map((g) => `&bull; ${esc(giftLabel(g))}`).join('<br>');

  const recadinho = message
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.soft}" style="background-color:${C.soft};border:1px solid ${C.line};border-radius:16px;border-collapse:separate;margin:8px 0 20px"><tr><td style="padding:20px 24px">
${eyebrow(guest ? `recadinho de ${guest}` : 'recadinho', 'left', '0 0 8px')}
<div style="font-family:${HAND};font-size:22px;line-height:1.35;color:${C.ink}">“${escMultiline(message)}”</div>
</td></tr></table>`
    : '';

  const rows = [
    header(v.assetBaseUrl, true),
    hero({ title: heroTitle, align: 'center' }),
    card(
      `${para(esc(greeting))}
${para(`<strong style="color:${C.ink}">${esc(guestLabel)}</strong> ${esc(visited)}`)}
${para('não é só um presente. é alguém dizendo, do jeito mais simples, que quer estar perto quando esse neném chegar.')}
${recadinho}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:${message ? '0' : '8px'} 0 20px"><tr>
<td valign="top" style="padding-right:14px">${iconTile('&#9825;', C.pink, '#e78fa7')}</td>
<td valign="top">${eyebrow(gifts.length > 1 ? 'presentes recebidos' : 'presente recebido', 'left', '2px 0 4px')}<div style="font-family:${SANS};font-size:15px;line-height:22px;color:${C.body}">${giftsHtml}</div></td>
</tr></table>
${para(registered, `color:${C.muted};font-size:14px`)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${button('ver meu chá', v.dashboardUrl)}</table>
${handTitle('feliz por você,<br>time EuNeném', 22)}`,
      '40px 44px',
    ),
    // Members did not build this chá, so "como foi montar o seu chá?" is owner-only.
    ...(isOwner ? [feedbackSection(v.feedbackUrl)] : []),
    footer({ logo: logo(v.assetBaseUrl, 112), reason, unsubscribeUrl: v.unsubscribeUrl, preferencesUrl: v.preferencesUrl }),
  ].join('\n');

  const text = [
    subject,
    '',
    greeting,
    '',
    `${guestLabel} ${visited}`,
    '',
    'não é só um presente. é alguém dizendo, do jeito mais simples, que quer estar perto quando esse neném chegar.',
    ...(message ? ['', guest ? `recadinho de ${guest}:` : 'recadinho:', `“${message}”`] : []),
    '',
    gifts.length > 1 ? 'presentes recebidos:' : 'presente recebido:',
    ...(gifts.length === 0 ? [`- ${noSnapshot}`] : gifts.map((g) => `- ${giftLabel(g)}`)),
    '',
    registered,
    `Ver meu chá: ${v.dashboardUrl}`,
    '',
    'feliz por você,',
    'time EuNeném',
    '',
    textFooter(v, reason, isOwner),
  ].join('\n');

  return { subject, html: documentShell({ subject, preheader: `${guestLabel} escolheu um presente pro bebê ♡`, rows }), text };
}

export function renderLifecycleEmail<T extends LifecycleEmailRenderType>(
  type: T,
  vars: LifecycleEmailVars[T],
): RenderedLifecycleEmail {
  switch (type) {
    case 'new_message':
    case 'presence_confirmed': {
      const v = vars as LifecycleEmailCommonVars;
      const subject = type === 'new_message' ? 'Você recebeu um novo recado ♡' : 'Nova confirmação de presença ♡';
      const reason = 'Você escolheu receber atualizações do seu chá.';
      const rows = header(v.assetBaseUrl, false) + card(handTitle(esc(subject)) + para('Confira a atualização no painel da sua página.') + button('Ver no painel', v.dashboardUrl)) + footer({ logo: logo(v.assetBaseUrl, 100), reason: esc(reason), unsubscribeUrl: v.unsubscribeUrl, preferencesUrl: v.preferencesUrl });
      return { subject, html: documentShell({ subject, preheader: subject, rows }), text: `${subject}\n${v.dashboardUrl}\n${textFooter(v, reason)}` };
    }
    case 'welcome':
      return renderWelcome(vars as LifecycleEmailVars['welcome']);
    case 'list_ready':
      return renderListReady(vars as LifecycleEmailVars['list_ready']);
    case 'event_reminder':
      return renderEventReminder(vars as LifecycleEmailVars['event_reminder']);
    case 'payment_received':
      return renderPaymentReceived(vars as LifecycleEmailVars['payment_received']);
    default:
      throw new Error(`unknown lifecycle email type: ${String(type)}`);
  }
}
