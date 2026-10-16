import type { EmailMessage } from '../../../../src/index.js';

/** Invitations carry no bearer secret: the recipient must authenticate with
 * this verified email. The normal login entrypoint is the only link. */
export function renderCampaignInviteEmail(to: string, publicOrigin: string): EmailMessage {
  const url = new URL('/login', publicOrigin).href;
  const safeUrl = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return {
    to,
    subject: 'Uma campanha foi compartilhada com você no EuNeném',
    text: `Você recebeu acesso a uma campanha. Entre com este e-mail verificado em ${url}. O convite expira em 7 dias. O acesso não transfere a titularidade financeira.`,
    html: `<p>Uma campanha foi compartilhada com você no EuNeném.</p><p><a href="${safeUrl}">Entrar no EuNeném</a> com este e-mail usando Google ou link de acesso.</p><p>O convite expira em 7 dias. O acesso não transfere a titularidade financeira.</p>`,
  };
}
