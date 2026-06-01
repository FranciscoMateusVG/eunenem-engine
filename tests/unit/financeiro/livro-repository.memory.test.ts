import { describe, expect, it } from 'vitest';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/financeiro/livro-repository.memory.js';
import {
  criarLancamentosParaPagamentoAprovado,
  type EfeitosFinanceirosPagamentoAprovado,
} from '../../../src/domain/financeiro/entities/lancamento-financeiro.js';
import { criarRepasseRecebedorSolicitado } from '../../../src/domain/financeiro/entities/repasse-recebedor.js';
import { FinanceiroPagamentoJaRegistradoError } from '../../../src/errors/financeiro/pagamento-ja-registrado.error.js';

const idPagamento = '550e8400-e29b-41d4-a716-446655442001';
const idContribuicao = '550e8400-e29b-41d4-a716-446655442002';
const idCampanha = '550e8400-e29b-41d4-a716-446655442003';
const idLancamentoRecebedor = '550e8400-e29b-41d4-a716-446655442004';
const idLancamentoReceitaPlataforma = '550e8400-e29b-41d4-a716-446655442005';
const idRepasse = '550e8400-e29b-41d4-a716-446655442006';
const criadoEm = new Date('2026-05-01T12:00:00.000Z');

const approvedPaymentInput: EfeitosFinanceirosPagamentoAprovado = {
  idPagamento,
  idContribuicao,
  idCampanha,
  statusPagamento: 'aprovado',
  composicaoValores: {
    contributionAmountCents: 8000,
    feeAmountCents: 400,
    surchargeCents: 0,
    totalPaidCents: 8400,
    receiverAmountCents: 8000,
    responsavelTaxa: 'contribuinte',
  },
};

describe('LivroFinanceiroRepositoryMemory', () => {
  it('saves and lists financial entries by payment, receiver and platform revenue', async () => {
    const repository = new LivroFinanceiroRepositoryMemory();
    const lancamentos = criarLancamentosParaPagamentoAprovado(
      approvedPaymentInput,
      { idLancamentoRecebedor, idLancamentoReceitaPlataforma },
      criadoEm,
    );

    await repository.saveLancamentos(lancamentos);

    expect(await repository.findLancamentosByIdPagamento(idPagamento)).toEqual(lancamentos);
    expect(await repository.findLancamentosByIdCampanha(idCampanha)).toEqual([lancamentos[0]]);
    expect(await repository.findLancamentosReceitaPlataforma()).toEqual([lancamentos[1]]);
  });

  it('does not save duplicate entries for the same payment', async () => {
    const repository = new LivroFinanceiroRepositoryMemory();
    const lancamentos = criarLancamentosParaPagamentoAprovado(
      approvedPaymentInput,
      { idLancamentoRecebedor, idLancamentoReceitaPlataforma },
      criadoEm,
    );

    await repository.saveLancamentos(lancamentos);

    await expect(repository.saveLancamentos(lancamentos)).rejects.toThrow(
      FinanceiroPagamentoJaRegistradoError,
    );
  });

  it('saves and lists payout requests by id and receiver', async () => {
    const repository = new LivroFinanceiroRepositoryMemory();
    const repasse = criarRepasseRecebedorSolicitado(
      {
        idRepasse,
        idCampanha,
        amountCents: 2000,
      },
      criadoEm,
    );

    await repository.saveRepasse(repasse);

    expect(await repository.findRepasseById(idRepasse)).toEqual(repasse);
    expect(await repository.findRepassesByIdCampanha(idCampanha)).toEqual([repasse]);
  });
});
