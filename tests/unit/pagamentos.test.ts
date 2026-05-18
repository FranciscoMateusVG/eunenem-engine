import { describe, expect, it } from 'vitest';
import {
  aprovarPagamentoPendente,
  criarEventoPagamento,
  criarPagamentoPendente,
  MetodoPagamentoSchema,
  rejeitarPagamentoPendente,
  SnapshotComposicaoValoresSchema,
  type TransacaoExterna,
} from '../../src/domain/pagamentos.js';

const idPagamento = '550e8400-e29b-41d4-a716-446655440101';
const idIntencaoPagamento = '550e8400-e29b-41d4-a716-446655440102';
const idContribuicao = '550e8400-e29b-41d4-a716-446655440103';
const idTransacaoExterna = '550e8400-e29b-41d4-a716-446655440104';
const idEvento = '550e8400-e29b-41d4-a716-446655440105';
const criadoEm = new Date('2026-05-01T12:00:00.000Z');
const atualizadoEm = new Date('2026-05-01T12:05:00.000Z');

const composicaoValores = {
  idContribuicao,
  contributionAmountCents: 8000,
  feeAmountCents: 400,
  totalPaidCents: 8400,
  receiverAmountCents: 8000,
  responsavelTaxa: 'contribuinte' as const,
};

const transacaoAprovada: TransacaoExterna = {
  id: idTransacaoExterna,
  provedor: 'fake-provider',
  status: 'aprovado',
  amountCents: 8400,
  criadaEm: atualizadoEm,
  statusBruto: 'aprovado',
};

describe('SnapshotComposicaoValoresSchema', () => {
  it('accepts the canonical Taxas composition snapshot', () => {
    expect(SnapshotComposicaoValoresSchema.safeParse(composicaoValores).success).toBe(true);
  });
});

describe('MetodoPagamentoSchema', () => {
  it('accepts the initial supported methods', () => {
    expect(MetodoPagamentoSchema.safeParse('pix').success).toBe(true);
    expect(MetodoPagamentoSchema.safeParse('credit_card').success).toBe(true);
  });

  it('rejects unsupported payment methods', () => {
    expect(MetodoPagamentoSchema.safeParse('boleto').success).toBe(false);
  });
});

describe('criarPagamentoPendente', () => {
  it('creates a pending payment for the total paid amount', () => {
    const pagamento = criarPagamentoPendente({
      idPagamento,
      idIntencaoPagamento,
      composicaoValores,
      valorACobrarCents: 8400,
      metodo: 'pix',
      criadoEm,
    });

    expect(pagamento.id).toBe(idPagamento);
    expect(pagamento.intencao.idContribuicao).toBe(idContribuicao);
    expect(pagamento.intencao.amountCents).toBe(8400);
    expect(pagamento.status).toBe('pendente');
    expect(pagamento.transacaoExterna).toBeUndefined();
  });

  it('rejects a charge amount different from totalPaidCents', () => {
    expect(() =>
      criarPagamentoPendente({
        idPagamento,
        idIntencaoPagamento,
        composicaoValores,
        valorACobrarCents: 8300,
        metodo: 'pix',
        criadoEm,
      }),
    ).toThrow('Valor do pagamento deve ser igual ao total pago na composicao de valores.');
  });
});

describe('payment status transitions', () => {
  it('approves a pending payment with an approved external transaction', () => {
    const pagamento = criarPagamentoPendente({
      idPagamento,
      idIntencaoPagamento,
      composicaoValores,
      valorACobrarCents: 8400,
      metodo: 'pix',
      criadoEm,
    });

    const aprovado = aprovarPagamentoPendente(pagamento, transacaoAprovada, atualizadoEm);

    expect(aprovado.status).toBe('aprovado');
    expect(aprovado.transacaoExterna?.id).toBe(idTransacaoExterna);
    expect(aprovado.atualizadoEm).toEqual(atualizadoEm);
  });

  it('rejects a pending payment with a rejected external transaction', () => {
    const pagamento = criarPagamentoPendente({
      idPagamento,
      idIntencaoPagamento,
      composicaoValores,
      valorACobrarCents: 8400,
      metodo: 'credit_card',
      criadoEm,
    });

    const rejeitado = rejeitarPagamentoPendente(
      pagamento,
      { ...transacaoAprovada, status: 'rejeitado', statusBruto: 'rejeitado' },
      atualizadoEm,
    );

    expect(rejeitado.status).toBe('rejeitado');
    expect(rejeitado.transacaoExterna?.status).toBe('rejeitado');
  });

  it('does not approve a rejected payment', () => {
    const pagamento = criarPagamentoPendente({
      idPagamento,
      idIntencaoPagamento,
      composicaoValores,
      valorACobrarCents: 8400,
      metodo: 'pix',
      criadoEm,
    });
    const rejeitado = rejeitarPagamentoPendente(
      pagamento,
      { ...transacaoAprovada, status: 'rejeitado', statusBruto: 'rejeitado' },
      atualizadoEm,
    );

    expect(() => aprovarPagamentoPendente(rejeitado, transacaoAprovada, atualizadoEm)).toThrow(
      `Pagamento "${idPagamento}" nao pode ser aprovado a partir do status "rejeitado".`,
    );
  });

  it('does not reject an approved payment', () => {
    const pagamento = criarPagamentoPendente({
      idPagamento,
      idIntencaoPagamento,
      composicaoValores,
      valorACobrarCents: 8400,
      metodo: 'pix',
      criadoEm,
    });
    const aprovado = aprovarPagamentoPendente(pagamento, transacaoAprovada, atualizadoEm);

    expect(() =>
      rejeitarPagamentoPendente(
        aprovado,
        { ...transacaoAprovada, status: 'rejeitado', statusBruto: 'rejeitado' },
        atualizadoEm,
      ),
    ).toThrow(`Pagamento "${idPagamento}" nao pode ser rejeitado a partir do status "aprovado".`);
  });
});

describe('criarEventoPagamento', () => {
  it('creates an event from payment state', () => {
    const pagamento = aprovarPagamentoPendente(
      criarPagamentoPendente({
        idPagamento,
        idIntencaoPagamento,
        composicaoValores,
        valorACobrarCents: 8400,
        metodo: 'pix',
        criadoEm,
      }),
      transacaoAprovada,
      atualizadoEm,
    );

    const evento = criarEventoPagamento({
      id: idEvento,
      tipo: 'payment.approved',
      pagamento,
      ocorridoEm: atualizadoEm,
    });

    expect(evento).toMatchObject({
      id: idEvento,
      tipo: 'payment.approved',
      idPagamento,
      idIntencaoPagamento,
      idContribuicao,
      amountCents: 8400,
      status: 'aprovado',
      idTransacaoExterna,
    });
  });
});
