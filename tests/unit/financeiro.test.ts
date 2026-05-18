import { describe, expect, it } from 'vitest';
import {
  calcularReceitaPlataforma,
  calcularSaldoRecebedor,
  criarLancamentosParaPagamentoAprovado,
  criarRepasseRecebedorSolicitado,
  type LancamentoFinanceiro,
  type RegistrarEfeitosFinanceirosPagamentoAprovadoInput,
} from '../../src/domain/financeiro.js';

const idPagamento = '550e8400-e29b-41d4-a716-446655441001';
const idContribuicao = '550e8400-e29b-41d4-a716-446655441002';
const idRecebedor = '550e8400-e29b-41d4-a716-446655441003';
const idLancamentoRecebedor = '550e8400-e29b-41d4-a716-446655441004';
const idLancamentoReceitaPlataforma = '550e8400-e29b-41d4-a716-446655441005';
const idRepasse = '550e8400-e29b-41d4-a716-446655441006';
const criadoEm = new Date('2026-05-01T12:00:00.000Z');

const inputPagamentoAprovado: RegistrarEfeitosFinanceirosPagamentoAprovadoInput = {
  idPagamento,
  idContribuicao,
  idRecebedor,
  statusPagamento: 'aprovado',
  composicaoValores: {
    contributionAmountCents: 8000,
    feeAmountCents: 400,
    totalPaidCents: 8400,
    receiverAmountCents: 8000,
    responsavelTaxa: 'contribuinte',
  },
};

describe('criarLancamentosParaPagamentoAprovado', () => {
  it('creates receiver balance and platform revenue entries for the canonical flow', () => {
    const lancamentos = criarLancamentosParaPagamentoAprovado(
      inputPagamentoAprovado,
      { idLancamentoRecebedor, idLancamentoReceitaPlataforma },
      criadoEm,
    );

    expect(lancamentos).toEqual([
      {
        id: idLancamentoRecebedor,
        idPagamento,
        idContribuicao,
        idRecebedor,
        tipo: 'credito_saldo_recebedor',
        amountCents: 8000,
        status: 'pendente',
        criadoEm,
      },
      {
        id: idLancamentoReceitaPlataforma,
        idPagamento,
        idContribuicao,
        tipo: 'credito_receita_plataforma',
        amountCents: 400,
        status: 'disponivel',
        criadoEm,
      },
    ]);
  });

  it('rejects payments that are not approved', () => {
    expect(() =>
      criarLancamentosParaPagamentoAprovado(
        { ...inputPagamentoAprovado, statusPagamento: 'pendente' },
        { idLancamentoRecebedor, idLancamentoReceitaPlataforma },
        criadoEm,
      ),
    ).toThrow('Apenas pagamentos aprovados podem gerar lancamentos financeiros.');
  });

  it('rejects an inconsistent value composition', () => {
    expect(() =>
      criarLancamentosParaPagamentoAprovado(
        {
          ...inputPagamentoAprovado,
          composicaoValores: {
            ...inputPagamentoAprovado.composicaoValores,
            totalPaidCents: 8300,
          },
        },
        { idLancamentoRecebedor, idLancamentoReceitaPlataforma },
        criadoEm,
      ),
    ).toThrow('Composicao de valores financeira nao confere com o total pago.');
  });

  it('uses the received fee amount without recalculating it', () => {
    const lancamentos = criarLancamentosParaPagamentoAprovado(
      {
        ...inputPagamentoAprovado,
        composicaoValores: {
          contributionAmountCents: 8000,
          feeAmountCents: 500,
          totalPaidCents: 8500,
          receiverAmountCents: 8000,
          responsavelTaxa: 'contribuinte',
        },
      },
      { idLancamentoRecebedor, idLancamentoReceitaPlataforma },
      criadoEm,
    );

    expect(lancamentos[1].amountCents).toBe(500);
  });
});

describe('financial summaries', () => {
  it('separates pending and available receiver balance', () => {
    const lancamentoPendente = criarLancamentosParaPagamentoAprovado(
      inputPagamentoAprovado,
      { idLancamentoRecebedor, idLancamentoReceitaPlataforma },
      criadoEm,
    )[0];
    const lancamentoDisponivel: LancamentoFinanceiro = {
      ...lancamentoPendente,
      id: '550e8400-e29b-41d4-a716-446655441007',
      idPagamento: '550e8400-e29b-41d4-a716-446655441008',
      status: 'disponivel',
      amountCents: 2000,
    };

    expect(calcularSaldoRecebedor(idRecebedor, [lancamentoPendente, lancamentoDisponivel])).toEqual(
      {
        idRecebedor,
        valorPendenteCents: 8000,
        valorDisponivelCents: 2000,
      },
    );
  });

  it('accumulates only platform revenue entries', () => {
    const lancamentos = criarLancamentosParaPagamentoAprovado(
      inputPagamentoAprovado,
      { idLancamentoRecebedor, idLancamentoReceitaPlataforma },
      criadoEm,
    );

    expect(calcularReceitaPlataforma(lancamentos)).toEqual({ totalAmountCents: 400 });
  });
});

describe('criarRepasseRecebedorSolicitado', () => {
  it('creates a payout request in the initial requested status', () => {
    expect(
      criarRepasseRecebedorSolicitado(
        {
          idRepasse,
          idRecebedor,
          amountCents: 2000,
        },
        criadoEm,
      ),
    ).toEqual({
      id: idRepasse,
      idRecebedor,
      amountCents: 2000,
      status: 'solicitado',
      solicitadoEm: criadoEm,
    });
  });
});
