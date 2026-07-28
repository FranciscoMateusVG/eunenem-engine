import type { EmailMessage } from '../../../../src/index.js';

/**
 * Render the magic-link sign-in email (aperture-lwx2k; branded aperture-lqcgb).
 *
 * Security/privacy notes:
 *   - The `url` is built by BetterAuth from the configured baseURL + the
 *     single-use, hashed-at-rest, 5-min token. We only render it.
 *   - No PII beyond the recipient's own address (which they already own) is
 *     embedded. No tokens are logged by the caller.
 *   - Plain-text alternative included for deliverability + no-HTML clients.
 *
 * `escapeHtml` guards the (server-built, but defensively treated) URL before
 * interpolation into HTML attributes/text — belt-and-suspenders against any
 * future change that lets a caller-influenced value reach the template.
 *
 * Email-client robustness (aperture-lqcgb — branded restyle):
 *   - Table-based layout + fully INLINE CSS. No flexbox/grid, no transforms,
 *     no background-images — the fragile things Gmail/Outlook choke on.
 *   - The handwritten "EuNeném ♡" wordmark uses Caveat via a <link> as
 *     progressive enhancement; Gmail & co strip web fonts and fall back to a
 *     cursive stack, which still reads warm. Body uses a system-font stack.
 *   - Button is a bulletproof-ish pill: bgcolor on the <td> gives Outlook a
 *     solid (square-cornered) button; border-radius rounds it everywhere else.
 *   - Copy + security language are UNCHANGED from the original plain version.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// EuNeném brand tokens (hex-inlined — email clients don't read CSS custom
// properties). Sourced from tailwind.css :root.
const CREAM = '#f8f7f6';
const CREAM_2 = '#efece9';
const PLUM = '#6b3c5e';
const INK = '#5c3a4f';
const INK_SOFT = '#7a5a6c';
const INK_MUTE = '#a18a99';
const LILAC_SOFT = '#e8d5f0';
const LILAC_DEEP = '#a77bbe';
const CORAL_PINK = '#e78fa7';

const SCRIPT_STACK = "'Caveat','Segoe Script','Bradley Hand',cursive";
const BODY_STACK =
  "'DM Sans',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function renderMagicLinkEmail(to: string, url: string): EmailMessage {
  const safeUrl = escapeHtml(url);
  const subject = 'Seu link de acesso ao EuNeném ♡';

  const html = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <meta name="supported-color-schemes" content="light" />
    <title>Entrar no EuNeném</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=Caveat:wght@600;700&amp;family=DM+Sans:wght@400;500;600&amp;display=swap" rel="stylesheet" />
    <style>
      @media (max-width:520px){
        .en-card{ width:100% !important; border-radius:0 !important; }
        .en-pad{ padding-left:24px !important; padding-right:24px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:${CREAM};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CREAM};border-collapse:collapse;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" class="en-card" width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px;max-width:480px;background:#ffffff;border-radius:20px;border:1px solid ${CREAM_2};border-collapse:separate;overflow:hidden;">
            <tr>
              <td align="center" style="background:${LILAC_SOFT};padding:28px 24px 24px;">
                <div style="font-family:${SCRIPT_STACK};font-size:36px;line-height:1;font-weight:700;color:${PLUM};">EuNeném <span style="color:${CORAL_PINK};">&#9825;</span></div>
              </td>
            </tr>
            <tr>
              <td class="en-pad" style="padding:32px;font-family:${BODY_STACK};color:${INK};">
                <h1 style="margin:0 0 14px;font-family:${BODY_STACK};font-size:21px;font-weight:600;color:${PLUM};">Entrar no EuNeném</h1>
                <p style="margin:0 0 26px;font-size:15px;line-height:1.6;color:${INK};">
                  Toque no botão abaixo para entrar. O link vale por <strong style="color:${PLUM};">5 minutos</strong> e só pode ser usado uma vez.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px;border-collapse:separate;">
                  <tr>
                    <td align="center" bgcolor="${PLUM}" style="border-radius:999px;">
                      <a href="${safeUrl}" style="display:inline-block;padding:14px 30px;font-family:${BODY_STACK};font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:999px;">Entrar agora <span style="color:#ffffff;">&#8594;</span></a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:${INK_SOFT};">
                  Se o botão não funcionar, copie e cole este endereço no navegador:
                </p>
                <p style="margin:0 0 26px;font-size:13px;line-height:1.5;word-break:break-all;color:${LILAC_DEEP};">
                  ${safeUrl}
                </p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                  <tr><td style="border-top:1px solid ${CREAM_2};padding-top:18px;">
                    <p style="margin:0;font-size:13px;line-height:1.5;color:${INK_MUTE};">
                      Se você não pediu este link, pode ignorar este email com segurança.
                    </p>
                  </td></tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="background:${CREAM};padding:18px 24px;">
                <div style="font-family:${SCRIPT_STACK};font-size:17px;color:${INK_MUTE};">EuNeném <span style="color:${CORAL_PINK};">&#9825;</span></div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    'Entrar no EuNeném',
    '',
    'Use o link abaixo para entrar. Ele vale por 5 minutos e só pode ser usado uma vez:',
    '',
    url,
    '',
    'Se você não pediu este link, pode ignorar este email com segurança.',
  ].join('\n');

  return { to, subject, html, text };
}
