import { describe, expect, it } from 'vitest';
import {
  criarLancamentosParaPagamentoAprovado,
  type EfeitosFinanceirosPagamentoAprovado,
  type IdsLancamentosFinanceirosPorPagamento,
  type ItemDoPagamentoFinanceiro,
  type LancamentoFinanceiro,
} from '../../../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import { criarRepasseRecebedorSolicitado } from '../../../../src/domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import { calcularReceitaPlataforma } from '../../../../src/domain/pagamentos/financeiro/value-objects/receita-plataforma.js';
import { calcularSaldoRecebedor } from '../../../../src/domain/pagamentos/financeiro/value-objects/saldo-recebedor.js';

/**
 * Plan 0016 Phase 2 (aperture-eg1s2). Rewritten for the multi-item cart
 * shape:
 *   - EfeitosFinanceirosPagamentoAprovado drops root `idContribuicao` +
 *     `composicaoValores`; gains `items[]` + `idContribuicaoAnchor`.
 *   - The factory's second arg is `IdsLancamentosFinanceirosPorPagamento`
 *     (array of per-item id triples), NOT a single object.
 *   - contribuicao item → 2 lançamentos (recebedor + receita_plataforma)
 *   - passthrough_surcharge item → 1 lançamento (passthrough)
 *   - Every lançamento carries `idItemPagamento` (FK to intencao_items).
 *
 * Plan 0015 invariants preserved:
 *   - Lançamentos born with `transferidoEm: null, canceladoEm: null,
 *     idRepasse: null`.
 *   - calcularSaldoRecebedor predicates rewired:
 *       pending  = transferidoEm IS NULL AND canceladoEm IS NULL
 *       disponivel = transferidoEm IS NOT NULL AND canceladoEm IS NULL
 *       cancelled = canceladoEm IS NOT NULL (excluded from both sums)
 */

const idPagamento = '550e8400-e29b-41d4-a716-446655441001';
const idContribuicao = '550e8400-e29b-41d4-a716-446655441002';
const idCampanha = '550e8400-e29b-41d4-a716-446655441003';
const idItemContribuicao = '550e8400-e29b-41d4-a716-446655441020';
const idItemSurcharge = '550e8400-e29b-41d4-a716-446655441021';
const idLancamentoRecebedor = '550e8400-e29b-41d4-a716-446655441004';
const idLancamentoReceitaPlataforma = '550e8400-e29b-41d4-a716-446655441005';
const idLancamentoPassthroughSurcharge = '550e8400-e29b-41d4-a716-446655441099';
const idRepasse = '550e8400-e29b-41d4-a716-446655441006';
const criadoEm = new Date('2026-05-01T12:00:00.000Z');

// Per-item helpers — local fixtures for the multi-item cart shape. Mirror
// the helper pattern in `tests/unit/pagamentos/multi-item-cart.test.ts`.
function contribuicaoItem(
  opts: {
    idItemPagamento?: string;
    idContribuicao?: string;
    quantidade?: number;
    unitContribution?: number;
    unitFee?: number;
  } = {},
): ItemDoPagamentoFinanceiro {
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

function surchargeItem(
  amountCents: number,
  idItemPagamento = idItemSurcharge,
): ItemDoPagamentoFinanceiro {
  return {
    idItemPagamento,
    composicaoValoresItem: {
      tipo: 'passthrough_surcharge',
      amountCents,
    },
  };
}

const pixInput: EfeitosFinanceirosPagamentoAprovado = {
  idPagamento,
  idCampanha,
  statusPagamento: 'aprovado',
  idContribuicaoAnchor: idContribuicao,
  items: [contribuicaoItem()],
};

const pixIds: IdsLancamentosFinanceirosPorPagamento = [
  {
    idItemPagamento: idItemContribuicao,
    idLancamentoRecebedor,
    idLancamentoReceitaPlataforma,
  },
];

describe('criarLancamentosParaPagamentoAprovado', () => {
  it('creates receiver balance and platform revenue entries for the canonical PIX flow', () => {
    const lancamentos = criarLancamentosParaPagamentoAprovado(pixInput, pixIds, criadoEm);

    // Plan 0015: both lancamentos born with transferidoEm + canceladoEm null.
    // aperture-s03dr: idRepasse also born null.
    // Plan 0016 Phase 2: every lancamento carries idItemPagamento.
    expect(lancamentos).toEqual([
      {
        id: idLancamentoRecebedor,
        idPagamento,
        idItemPagamento: idItemContribuicao,
        idContribuicao,
        idCampanha,
        tipo: 'credito_saldo_recebedor',
        amountCents: 8000,
        criadoEm,
        transferidoEm: null,
        canceladoEm: null,
        idRepasse: null,
      },
      {
        id: idLancamentoReceitaPlataforma,
        idPagamento,
        idItemPagamento: idItemContribuicao,
        idContribuicao,
        // Platform revenue isn't pinned to a campanha (pre-0016 convention).
        tipo: 'credito_receita_plataforma',
        amountCents: 400,
        criadoEm,
        transferidoEm: null,
        canceladoEm: null,
        idRepasse: null,
      },
    ]);
  });

  it('rejects payments that are not approved', () => {
    expect(() =>
      criarLancamentosParaPagamentoAprovado(
        { ...pixInput, statusPagamento: 'pendente' },
        pixIds,
        criadoEm,
      ),
    ).toThrow('Apenas pagamentos aprovados podem gerar lancamentos financeiros.');
  });

  it('rejects an inconsistent per-item value composition (line != unit × quantidade)', () => {
    const badItem: ItemDoPagamentoFinanceiro = {
      idItemPagamento: idItemContribuicao,
      composicaoValoresItem: {
        tipo: 'contribuicao',
        idContribuicao,
        quantidade: 1,
        contributionUnitAmountCents: 8000,
        feeUnitAmountCents: 400,
        receiverUnitAmountCents: 8000,
        // Wrong: should be 8000.
        lineContributionAmountCents: 7900,
        lineFeeAmountCents: 400,
        lineReceiverAmountCents: 8000,
      },
    };
    expect(() =>
      criarLancamentosParaPagamentoAprovado({ ...pixInput, items: [badItem] }, pixIds, criadoEm),
    ).toThrow(/lineContributionAmountCents/);
  });

  it('uses the received fee amount without recalculating it', () => {
    const lancamentos = criarLancamentosParaPagamentoAprovado(
      {
        ...pixInput,
        items: [contribuicaoItem({ unitContribution: 8000, unitFee: 500 })],
      },
      pixIds,
      criadoEm,
    );

    expect(lancamentos[1].amountCents).toBe(500);
  });

  // ───── aperture-bjshv: credito_passthrough_surcharge ─────────────

  it('PIX emits exactly 2 lancamentos and book balances (aperture-bjshv)', () => {
    const lancamentos = criarLancamentosParaPagamentoAprovado(pixInput, pixIds, criadoEm);
    expect(lancamentos).toHaveLength(2);
    expect(lancamentos.map((l) => l.tipo)).toEqual([
      'credito_saldo_recebedor',
      'credito_receita_plataforma',
    ]);
    const sum = lancamentos.reduce((acc, l) => acc + l.amountCents, 0);
    // contributionUnit (8000) + feeUnit (400) = 8400 total paid for the
    // single contribuicao item.
    expect(sum).toBe(8400);
  });

  it('cartao (surcharge item present) emits 3 lancamentos and book balances (aperture-bjshv)', () => {
    const inputCartao: EfeitosFinanceirosPagamentoAprovado = {
      idPagamento,
      idCampanha,
      statusPagamento: 'aprovado',
      idContribuicaoAnchor: idContribuicao,
      items: [contribuicaoItem({ unitContribution: 4500, unitFee: 225 }), surchargeItem(224)],
    };
    const idsCartao: IdsLancamentosFinanceirosPorPagamento = [
      {
        idItemPagamento: idItemContribuicao,
        idLancamentoRecebedor,
        idLancamentoReceitaPlataforma,
      },
      {
        idItemPagamento: idItemSurcharge,
        idLancamentoPassthroughSurcharge,
      },
    ];

    const lancamentos = criarLancamentosParaPagamentoAprovado(inputCartao, idsCartao, criadoEm);

    expect(lancamentos).toHaveLength(3);
    expect(lancamentos.map((l) => l.tipo)).toEqual([
      'credito_saldo_recebedor',
      'credito_receita_plataforma',
      'credito_passthrough_surcharge',
    ]);
    const passthrough = lancamentos[2];
    expect(passthrough.id).toBe(idLancamentoPassthroughSurcharge);
    expect(passthrough.amountCents).toBe(224);
    // Plan 0015: all rows born with date columns null.
    expect(passthrough.transferidoEm).toBeNull();
    expect(passthrough.canceladoEm).toBeNull();
    expect(passthrough.idCampanha).toBe(idCampanha);
    expect(passthrough.idPagamento).toBe(idPagamento);
    // Surcharge has no real contribuição linkage; the anchor is stamped.
    expect(passthrough.idContribuicao).toBe(idContribuicao);
    expect(passthrough.idItemPagamento).toBe(idItemSurcharge);
    expect(passthrough.criadoEm).toBe(criadoEm);
    const sum = lancamentos.reduce((acc, l) => acc + l.amountCents, 0);
    // contribution (4500) + fee (225) + surcharge (224) = 4949.
    expect(sum).toBe(4949);
  });

  it('cartao without idLancamentoPassthroughSurcharge throws a clear error (aperture-bjshv)', () => {
    const inputCartao: EfeitosFinanceirosPagamentoAprovado = {
      idPagamento,
      idCampanha,
      statusPagamento: 'aprovado',
      idContribuicaoAnchor: idContribuicao,
      items: [contribuicaoItem({ unitContribution: 4500, unitFee: 225 }), surchargeItem(224)],
    };
    const incompleteIds: IdsLancamentosFinanceirosPorPagamento = [
      {
        idItemPagamento: idItemContribuicao,
        idLancamentoRecebedor,
        idLancamentoReceitaPlataforma,
      },
      {
        idItemPagamento: idItemSurcharge,
        // Missing idLancamentoPassthroughSurcharge.
      },
    ];
    expect(() =>
      criarLancamentosParaPagamentoAprovado(inputCartao, incompleteIds, criadoEm),
    ).toThrow(/idLancamentoPassthroughSurcharge/);
  });

  it('PIX with no surcharge item ignores any unused passthrough id (no-op when items has no surcharge)', () => {
    // PIX shape has no surcharge item by construction, so the factory
    // simply never visits passthrough-id entries.
    const lancamentos = criarLancamentosParaPagamentoAprovado(pixInput, pixIds, criadoEm);
    expect(lancamentos).toHaveLength(2);
    expect(lancamentos.find((l) => l.tipo === 'credito_passthrough_surcharge')).toBeUndefined();
  });
});

describe('financial summaries (plan 0015 date-column predicates)', () => {
  it('separates pending and transferred receiver balance via date columns', () => {
    const lancamentoPending = criarLancamentosParaPagamentoAprovado(pixInput, pixIds, criadoEm)[0];
    // Mock a different lancamento that's been transferred to the recebedor:
    // transferidoEm set, canceladoEm null → counts as "disponivel" (já recebido).
    const lancamentoTransferido: LancamentoFinanceiro = {
      ...lancamentoPending,
      id: '550e8400-e29b-41d4-a716-446655441007',
      idPagamento: '550e8400-e29b-41d4-a716-446655441008',
      transferidoEm: new Date('2026-05-02T10:00:00.000Z'),
      canceladoEm: null,
      amountCents: 2000,
    };

    expect(calcularSaldoRecebedor(idCampanha, [lancamentoPending, lancamentoTransferido])).toEqual({
      idCampanha,
      valorPendenteCents: 8000,
      valorDisponivelCents: 2000,
    });
  });

  it('excludes cancelled lançamentos from both sums', () => {
    const lancamentoPending = criarLancamentosParaPagamentoAprovado(pixInput, pixIds, criadoEm)[0];
    // canceladoEm set → estornado cascade fired before transfer. Excluded
    // from both pending AND disponivel.
    const lancamentoCancelado: LancamentoFinanceiro = {
      ...lancamentoPending,
      id: '550e8400-e29b-41d4-a716-446655441009',
      idPagamento: '550e8400-e29b-41d4-a716-446655441010',
      transferidoEm: null,
      canceladoEm: new Date('2026-05-02T10:00:00.000Z'),
      amountCents: 5000,
    };

    expect(calcularSaldoRecebedor(idCampanha, [lancamentoPending, lancamentoCancelado])).toEqual({
      idCampanha,
      valorPendenteCents: 8000,
      valorDisponivelCents: 0,
    });
  });

  it('accumulates only platform revenue entries', () => {
    const lancamentos = criarLancamentosParaPagamentoAprovado(pixInput, pixIds, criadoEm);

    expect(calcularReceitaPlataforma(lancamentos)).toEqual({ totalAmountCents: 400 });
  });
});

describe('criarRepasseRecebedorSolicitado', () => {
  it('creates a payout request in the initial requested status', () => {
    expect(
      criarRepasseRecebedorSolicitado(
        {
          idRepasse,
          idCampanha,
          amountCents: 2000,
        },
        criadoEm,
      ),
    ).toEqual({
      id: idRepasse,
      idCampanha,
      amountCents: 2000,
      status: 'solicitado',
      solicitadoEm: criadoEm,
      aprovadoEm: null,
      bankTransferRef: null,
    });
  });
});
