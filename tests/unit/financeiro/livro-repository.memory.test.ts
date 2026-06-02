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
  metodo: 'pix', // aperture-led0r
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

  // ───── aperture-bjshv: passthrough_surcharge round-trip (memory) ─────

  const idLancamentoPassthroughSurcharge = '550e8400-e29b-41d4-a716-446655442099';

  const cartaoInput: EfeitosFinanceirosPagamentoAprovado = {
    idPagamento: '550e8400-e29b-41d4-a716-446655443101',
    idContribuicao: '550e8400-e29b-41d4-a716-446655443102',
    idCampanha: '550e8400-e29b-41d4-a716-446655443103',
    statusPagamento: 'aprovado',
    metodo: 'credit_card', // aperture-led0r — cartao path
    composicaoValores: {
      contributionAmountCents: 4500,
      feeAmountCents: 225,
      surchargeCents: 224,
      totalPaidCents: 4949,
      receiverAmountCents: 4500,
      responsavelTaxa: 'contribuinte',
    },
  };

  it('cartao 3-lancamento round-trip: findLancamentosByIdPagamento returns all three (aperture-bjshv)', async () => {
    const repository = new LivroFinanceiroRepositoryMemory();
    const lancamentos = criarLancamentosParaPagamentoAprovado(
      cartaoInput,
      {
        idLancamentoRecebedor: '550e8400-e29b-41d4-a716-446655443104',
        idLancamentoReceitaPlataforma: '550e8400-e29b-41d4-a716-446655443105',
        idLancamentoPassthroughSurcharge,
      },
      criadoEm,
    );
    expect(lancamentos).toHaveLength(3);

    await repository.saveLancamentos(lancamentos);

    const loaded = await repository.findLancamentosByIdPagamento(cartaoInput.idPagamento);
    expect(loaded).toHaveLength(3);
    const tipos = loaded.map((l) => l.tipo).sort();
    expect(tipos).toEqual(
      [
        'credito_passthrough_surcharge',
        'credito_receita_plataforma',
        'credito_saldo_recebedor',
      ].sort(),
    );

    // Book-balance invariant survives the round-trip.
    const sum = loaded.reduce((acc, l) => acc + l.amountCents, 0);
    expect(sum).toBe(cartaoInput.composicaoValores.totalPaidCents);
  });

  it('cartao: findLancamentosByIdCampanha includes passthrough (it carries idCampanha) (aperture-bjshv)', async () => {
    const repository = new LivroFinanceiroRepositoryMemory();
    const lancamentos = criarLancamentosParaPagamentoAprovado(
      cartaoInput,
      {
        idLancamentoRecebedor: '550e8400-e29b-41d4-a716-446655443204',
        idLancamentoReceitaPlataforma: '550e8400-e29b-41d4-a716-446655443205',
        idLancamentoPassthroughSurcharge: '550e8400-e29b-41d4-a716-446655443299',
      },
      criadoEm,
    );
    await repository.saveLancamentos(lancamentos);

    const byCampanha = await repository.findLancamentosByIdCampanha(cartaoInput.idCampanha);
    // Both recebedor + passthrough carry idCampanha; receita_plataforma omits it.
    const tipos = byCampanha.map((l) => l.tipo).sort();
    expect(tipos).toEqual(['credito_passthrough_surcharge', 'credito_saldo_recebedor'].sort());
  });

  it('cartao: findLancamentosReceitaPlataforma does NOT include passthrough rows (aperture-bjshv)', async () => {
    const repository = new LivroFinanceiroRepositoryMemory();
    const lancamentos = criarLancamentosParaPagamentoAprovado(
      cartaoInput,
      {
        idLancamentoRecebedor: '550e8400-e29b-41d4-a716-446655443304',
        idLancamentoReceitaPlataforma: '550e8400-e29b-41d4-a716-446655443305',
        idLancamentoPassthroughSurcharge: '550e8400-e29b-41d4-a716-446655443399',
      },
      criadoEm,
    );
    await repository.saveLancamentos(lancamentos);

    const receitaRows = await repository.findLancamentosReceitaPlataforma();
    expect(receitaRows).toHaveLength(1);
    expect(receitaRows[0]?.tipo).toBe('credito_receita_plataforma');
    expect(receitaRows.find((l) => l.tipo === 'credito_passthrough_surcharge')).toBeUndefined();
  });

  it('PIX path (surchargeCents=0) saves exactly 2 lancamentos — no passthrough row (aperture-bjshv backward compat)', async () => {
    const repository = new LivroFinanceiroRepositoryMemory();
    const lancamentos = criarLancamentosParaPagamentoAprovado(
      approvedPaymentInput,
      { idLancamentoRecebedor, idLancamentoReceitaPlataforma },
      criadoEm,
    );
    expect(lancamentos).toHaveLength(2);

    await repository.saveLancamentos(lancamentos);

    const loaded = await repository.findLancamentosByIdPagamento(idPagamento);
    expect(loaded).toHaveLength(2);
    expect(loaded.find((l) => l.tipo === 'credito_passthrough_surcharge')).toBeUndefined();
  });
});
