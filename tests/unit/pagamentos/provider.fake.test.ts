import { describe, expect, it } from 'vitest';
import { PagamentoProviderFake } from '../../../src/adapters/pagamentos/provider.fake.js';

const idPagamento = '550e8400-e29b-41d4-a716-446655440301';
const idIntencaoPagamento = '550e8400-e29b-41d4-a716-446655440302';
const idTransacaoExterna = '550e8400-e29b-41d4-a716-446655440303';
const fixedDate = new Date('2026-05-01T12:00:00.000Z');

describe('PagamentoProviderFake', () => {
  it('returns an approved external transaction by default', async () => {
    const provider = new PagamentoProviderFake({
      idTransacaoFactory: () => idTransacaoExterna,
      clock: () => fixedDate,
    });

    const transacao = await provider.solicitarPagamento({
      idPagamento,
      idIntencaoPagamento,
      amountCents: 8400,
      metodo: 'pix',
    });

    expect(transacao).toEqual({
      id: idTransacaoExterna,
      provedor: 'fake-provider',
      status: 'aprovado',
      amountCents: 8400,
      criadaEm: fixedDate,
      statusBruto: 'aprovado',
    });
  });

  it('can return a rejected external transaction', async () => {
    const provider = new PagamentoProviderFake({
      statusResultado: 'rejeitado',
      idTransacaoFactory: () => idTransacaoExterna,
      clock: () => fixedDate,
    });

    const transacao = await provider.solicitarPagamento({
      idPagamento,
      idIntencaoPagamento,
      amountCents: 8400,
      metodo: 'credit_card',
    });

    expect(transacao.status).toBe('rejeitado');
    expect(transacao.statusBruto).toBe('rejeitado');
  });

  it('can simulate an amount mismatch from the provider', async () => {
    const provider = new PagamentoProviderFake({
      idTransacaoFactory: () => idTransacaoExterna,
      amountCentsTransacao: 8500,
      clock: () => fixedDate,
    });

    const transacao = await provider.solicitarPagamento({
      idPagamento,
      idIntencaoPagamento,
      amountCents: 8400,
      metodo: 'pix',
    });

    expect(transacao.amountCents).toBe(8500);
  });
});
