import type { EmailMessage } from '../../../../src/index.js';

/**
 * Render the magic-link sign-in email (aperture-lwx2k).
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
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderMagicLinkEmail(to: string, url: string): EmailMessage {
  const safeUrl = escapeHtml(url);
  const subject = 'Seu link de acesso ao EuNeném ♡';

  const html = `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;padding:24px;background:#faf7fb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#3a2e3f;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;border:1px solid #efe7f0;">
      <h1 style="font-size:20px;margin:0 0 12px;">Entrar no EuNeném</h1>
      <p style="font-size:15px;line-height:1.5;margin:0 0 24px;">
        Toque no botão abaixo para entrar. O link vale por <strong>5 minutos</strong>
        e só pode ser usado uma vez.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${safeUrl}"
           style="display:inline-block;background:#b85c9e;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:999px;font-size:15px;">
          Entrar agora
        </a>
      </p>
      <p style="font-size:13px;line-height:1.5;color:#7a6b7f;margin:0 0 8px;">
        Se o botão não funcionar, copie e cole este endereço no navegador:
      </p>
      <p style="font-size:13px;word-break:break-all;color:#7a6b7f;margin:0 0 24px;">
        ${safeUrl}
      </p>
      <p style="font-size:13px;line-height:1.5;color:#9a8b9f;margin:0;">
        Se você não pediu este link, pode ignorar este email com segurança.
      </p>
    </div>
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
