import type { EmailMessage } from '../../../../src/index.js';

/**
 * aperture-bqvb5 — thank-you email the list owner sends to people who gave
 * gifts. The body is the owner's own message (written now, her configured
 * default, or the suggested one below); `{nome}` becomes the giver's first
 * name. Reply-To is the owner, so a guest's answer reaches her.
 */
export const MENSAGEM_AGRADECIMENTO_SUGERIDA =
  'Oi, {nome}! Recebemos seu presente com muito carinho. Ter você com a gente nesse momento tão especial faz toda a diferença. Gratidão de coração! ♡';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function semQuebras(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** `{nome}` → the giver's first name ("tudo bem" when the name is blank). */
export function personalizarMensagemAgradecimento(mensagem: string, nome: string): string {
  const primeiro = nome.trim().split(/\s+/)[0] || 'tudo bem';
  return mensagem.replaceAll('{nome}', primeiro);
}

export interface AgradecimentoEmailInput {
  readonly para: { readonly nome: string; readonly email: string };
  readonly titular: { readonly nome: string; readonly email: string };
  readonly tituloLista: string;
  readonly mensagem: string;
}

export function renderAgradecimentoEmail(input: AgradecimentoEmailInput): EmailMessage {
  const titular = semQuebras(input.titular.nome);
  const texto = personalizarMensagemAgradecimento(input.mensagem, input.para.nome).trim();
  const lista = semQuebras(input.tituloLista);
  const htmlTexto = escapeHtml(texto).replace(/\r?\n/g, '<br>');
  const rodape = `Você recebeu este e-mail porque presenteou a lista “${lista}” no EuNeném. Para responder, é só responder este e-mail.`;
  return {
    to: input.para.email,
    replyTo: input.titular.email,
    subject: `Um agradecimento de ${titular} ♡`,
    text: `${texto}\n\n— ${titular}\n\n${rodape}`,
    html: `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f8f7f6;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#5c3a4f">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border:1px solid #efece9;border-radius:20px">
      <tr><td style="padding:32px">
        <p style="margin:0 0 20px;font-size:16px;line-height:1.7">${htmlTexto}</p>
        <p style="margin:0 0 24px;font-size:16px;font-weight:700;color:#6b3c5e">— ${escapeHtml(titular)}</p>
        <p style="margin:0;font-size:12px;line-height:1.5;color:#7a5a6c">${escapeHtml(rodape)}</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`,
  };
}
