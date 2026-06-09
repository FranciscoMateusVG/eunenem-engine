import { describe, expect, it } from 'vitest';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import {
  criarLancamentosParaPagamentoAprovado,
  type EfeitosFinanceirosPagamentoAprovado,
  type IdsLancamentosFinanceirosPorPagamento,
  type ItemDoPagamentoFinanceiro,
} from '../../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import { criarRepasseRecebedorSolicitado } from '../../../src/domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import { FinanceiroPagamentoJaRegistradoError } from '../../../src/errors/pagamentos/financeiro/pagamento-ja-registrado.error.js';

const idPagamento = '550e8400-e29b-41d4-a716-446655442001';
const idContribuicao = '550e8400-e29b-41d4-a716-446655442002';
const idCampanha = '550e8400-e29b-41d4-a716-446655442003';
const idItemContribuicao = '550e8400-e29b-41d4-a716-446655442020';
const idItemSurcharge = '550e8400-e29b-41d4-a716-446655442021';
const idLancamentoRecebedor = '550e8400-e29b-41d4-a716-446655442004';
const idLancamentoReceitaPlataforma = '550e8400-e29b-41d4-a716-446655442005';
const idRepasse = '550e8400-e29b-41d4-a716-446655442006';
const criadoEm = new Date('2026-05-01T12:00:00.000Z');

// Plan 0016 Phase 2 (aperture-eg1s2): multi-item cart shape. Local
// helpers mirror those in `tests/unit/financeiro/financeiro.test.ts`.
function contribuicaoItem(opts: {
  idItemPagamento?: string;
  idContribuicao?: string;
  quantidade?: number;
  unitContribution?: number;
  unitFee?: number;
} = {}): ItemDoPagamentoFinanceiro {
  const quantidade = opts.quantidade ?? 1;
  const unitContribution = opts.unitContribution ?? 8000;
  const unitFee = opts.unitFee ?? 400;
  return {
    idItemPagamento: opts.idItemPagamento ?? idItemContribuicao,
    composicaoValoresItem: {
      tipo: 'contribuicao',
      idContribuicao: opts.idContribuicao ?? idContribuicao,
      quantidade,
      contributionUnitAmountCents: unitContribution,
      feeUnitAmountCents: unitFee,
      receiverUnitAmountCents: unitContribution,
      lineContributionAmountCents: unitContribution * quantidade,
      lineFeeAmountCents: unitFee * quantidade,
      lineReceiverAmountCents: unitContribution * quantidade,
    },
  };
}

function surchargeItem(amountCents: number, idItemPagamento = idItemSurcharge): ItemDoPagamentoFinanceiro {
  return {
    idItemPagamento,
    composicaoValoresItem: {
      tipo: 'passthrough_surcharge',
      amountCents,
    },
  };
}

const approvedPaymentInput: EfeitosFinanceirosPagamentoAprovado = {
  idPagamento,
  idCampanha,
  statusPagamento: 'aprovado',
  idContribuicaoAnchor: idContribuicao,
  items: [contribuicaoItem()],
};

const approvedPaymentIds: IdsLancamentosFinanceirosPorPagamento = [
  {
    idItemPagamento: idItemContribuicao,
    idLancamentoRecebedor,
    idLancamentoReceitaPlataforma,
  },
];

describe('LivroFinanceiroRepositoryMemory', () => {
  it('saves and lists financial entries by payment, receiver and platform revenue', async () => {
    const repository = new LivroFinanceiroRepositoryMemory();
    const lancamentos = criarLancamentosParaPagamentoAprovado(
      approvedPaymentInput,
      approvedPaymentIds,
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
      approvedPaymentIds,
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
  const cartaoIdPagamento = '550e8400-e29b-41d4-a716-446655443101';
  const cartaoIdContribuicao = '550e8400-e29b-41d4-a716-446655443102';
  const cartaoIdCampanha = '550e8400-e29b-41d4-a716-446655443103';
  const cartaoIdItemContribuicao = '550e8400-e29b-41d4-a716-446655443120';
  const cartaoIdItemSurcharge = '550e8400-e29b-41d4-a716-446655443121';

  const cartaoInput: EfeitosFinanceirosPagamentoAprovado = {
    idPagamento: cartaoIdPagamento,
    idCampanha: cartaoIdCampanha,
    statusPagamento: 'aprovado',
    idContribuicaoAnchor: cartaoIdContribuicao,
    items: [
      contribuicaoItem({
        idItemPagamento: cartaoIdItemContribuicao,
        idContribuicao: cartaoIdContribuicao,
        unitContribution: 4500,
        unitFee: 225,
      }),
      surchargeItem(224, cartaoIdItemSurcharge),
    ],
  };

  function cartaoIds(
    overrides: {
      idLancamentoRecebedor?: string;
      idLancamentoReceitaPlataforma?: string;
      idLancamentoPassthroughSurcharge?: string;
    } = {},
  ): IdsLancamentosFinanceirosPorPagamento {
    return [
      {
        idItemPagamento: cartaoIdItemContribuicao,
        idLancamentoRecebedor:
          overrides.idLancamentoRecebedor ?? '550e8400-e29b-41d4-a716-446655443104',
        idLancamentoReceitaPlataforma:
          overrides.idLancamentoReceitaPlataforma ?? '550e8400-e29b-41d4-a716-446655443105',
      },
      {
        idItemPagamento: cartaoIdItemSurcharge,
        idLancamentoPassthroughSurcharge:
          overrides.idLancamentoPassthroughSurcharge ?? idLancamentoPassthroughSurcharge,
      },
    ];
  }

  it('cartao 3-lancamento round-trip: findLancamentosByIdPagamento returns all three (aperture-bjshv)', async () => {
    const repository = new LivroFinanceiroRepositoryMemory();
    const lancamentos = criarLancamentosParaPagamentoAprovado(
      cartaoInput,
      cartaoIds(),
      criadoEm,
    );
    expect(lancamentos).toHaveLength(3);

    await repository.saveLancamentos(lancamentos);

    const loaded = await repository.findLancamentosByIdPagamento(cartaoIdPagamento);
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
    // contribuicao(4500) + fee(225) + surcharge(224) = 4949
    const sum = loaded.reduce((acc, l) => acc + l.amountCents, 0);
    expect(sum).toBe(4949);
  });

  it('cartao: findLancamentosByIdCampanha includes passthrough (it carries idCampanha) (aperture-bjshv)', async () => {
    const repository = new LivroFinanceiroRepositoryMemory();
    const lancamentos = criarLancamentosParaPagamentoAprovado(
      cartaoInput,
      cartaoIds({
        idLancamentoRecebedor: '550e8400-e29b-41d4-a716-446655443204',
        idLancamentoReceitaPlataforma: '550e8400-e29b-41d4-a716-446655443205',
        idLancamentoPassthroughSurcharge: '550e8400-e29b-41d4-a716-446655443299',
      }),
      criadoEm,
    );
    await repository.saveLancamentos(lancamentos);

    const byCampanha = await repository.findLancamentosByIdCampanha(cartaoIdCampanha);
    // Both recebedor + passthrough carry idCampanha; receita_plataforma omits it.
    const tipos = byCampanha.map((l) => l.tipo).sort();
    expect(tipos).toEqual(['credito_passthrough_surcharge', 'credito_saldo_recebedor'].sort());
  });

  it('cartao: findLancamentosReceitaPlataforma does NOT include passthrough rows (aperture-bjshv)', async () => {
    const repository = new LivroFinanceiroRepositoryMemory();
    const lancamentos = criarLancamentosParaPagamentoAprovado(
      cartaoInput,
      cartaoIds({
        idLancamentoRecebedor: '550e8400-e29b-41d4-a716-446655443304',
        idLancamentoReceitaPlataforma: '550e8400-e29b-41d4-a716-446655443305',
        idLancamentoPassthroughSurcharge: '550e8400-e29b-41d4-a716-446655443399',
      }),
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
      approvedPaymentIds,
      criadoEm,
    );
    expect(lancamentos).toHaveLength(2);

    await repository.saveLancamentos(lancamentos);

    const loaded = await repository.findLancamentosByIdPagamento(idPagamento);
    expect(loaded).toHaveLength(2);
    expect(loaded.find((l) => l.tipo === 'credito_passthrough_surcharge')).toBeUndefined();
  });
});
