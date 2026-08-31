import { describe, expect, it } from 'vitest';
import { renderPixPaymentReceiptEmail } from '../../../apps/eunenem-server/server/auth/pix-payment-receipt-email.js';
import { makePagamento } from '../../helpers/pagamento-repository.conformance.js';

describe('PIX proof-of-payment email', () => {
  it('renders the authoritative PIX amount for the payer', () => {
    const pagamento = makePagamento({
      metodo: 'pix',
      contribuinte: { nome: 'Ana & Bia', email: 'payer@example.com' },
      status: 'aprovado',
    });

    const message = renderPixPaymentReceiptEmail(pagamento);

    expect(message).not.toBeNull();
    expect(message?.to).toBe('payer@example.com');
    expect(message?.subject).toContain('Pagamento PIX confirmado');
    expect(message?.text).toContain('R$ 84,00');
    expect(message?.html).toContain('Ana &amp; Bia');
  });

  it('does not render a receipt for card payments', () => {
    const pagamento = makePagamento({
      metodo: 'credit_card',
      contribuinte: { nome: 'Ana', email: 'payer@example.com' },
      status: 'aprovado',
    });

    expect(renderPixPaymentReceiptEmail(pagamento)).toBeNull();
  });
});
