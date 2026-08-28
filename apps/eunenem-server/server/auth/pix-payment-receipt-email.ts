import type { EmailMessage, Pagamento } from '../../../../src/index.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBrl(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

/** Render the payer-facing confirmation after an authoritative PIX approval. */
export function renderPixPaymentReceiptEmail(pagamento: Pagamento): EmailMessage | null {
  const contribuinte = pagamento.intencao.contribuinte;
  if (pagamento.intencao.metodo !== 'pix' || contribuinte === null) return null;

  const safeName = escapeHtml(contribuinte.nome);
  const amount = formatBrl(pagamento.intencao.composicaoValoresAggregate.totalPaidCents);
  const date = pagamento.atualizadoEm.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const subject = 'Pagamento PIX confirmado no EuNeném ♡';

  return {
    to: contribuinte.email,
    subject,
    text: `Olá, ${contribuinte.nome}! Seu pagamento PIX de ${amount} foi confirmado em ${date}. Obrigado por presentear pelo EuNeném.`,
    html: `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f8f7f6;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#5c3a4f">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border:1px solid #efece9;border-radius:20px">
      <tr><td style="padding:32px">
        <h1 style="margin:0 0 16px;color:#6b3c5e;font-size:22px">Pagamento confirmado ♡</h1>
        <p style="margin:0 0 16px;line-height:1.6">Olá, ${safeName}!</p>
        <p style="margin:0 0 16px;line-height:1.6">Recebemos seu pagamento via <strong>PIX</strong>.</p>
        <p style="margin:0 0 8px;font-size:13px;color:#7a5a6c">valor pago</p>
        <p style="margin:0 0 20px;font-size:26px;font-weight:700;color:#6b3c5e">${escapeHtml(amount)}</p>
        <p style="margin:0;font-size:13px;color:#7a5a6c">confirmado em ${escapeHtml(date)}</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`,
  };
}
