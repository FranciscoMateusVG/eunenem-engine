import { describe, expect, it } from 'vitest';
import {
  criarLancamentosParaPagamentoAprovado,
  type EfeitosFinanceirosPagamentoAprovado,
  type LancamentoFinanceiro,
} from '../../../src/domain/financeiro/entities/lancamento-financeiro.js';
import { criarRepasseRecebedorSolicitado } from '../../../src/domain/financeiro/entities/repasse-recebedor.js';
import { calcularReceitaPlataforma } from '../../../src/domain/financeiro/value-objects/receita-plataforma.js';
import { calcularSaldoRecebedor } from '../../../src/domain/financeiro/value-objects/saldo-recebedor.js';

const idPagamento = '550e8400-e29b-41d4-a716-446655441001';
const idContribuicao = '550e8400-e29b-41d4-a716-446655441002';
const idCampanha = '550e8400-e29b-41d4-a716-446655441003';
const idLancamentoRecebedor = '550e8400-e29b-41d4-a716-446655441004';
const idLancamentoReceitaPlataforma = '550e8400-e29b-41d4-a716-446655441005';
const idRepasse = '550e8400-e29b-41d4-a716-446655441006';
const criadoEm = new Date('2026-05-01T12:00:00.000Z');

const inputPagamentoAprovado: EfeitosFinanceirosPagamentoAprovado = {
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
        idCampanha,
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
          surchargeCents: 0,
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

  // ───── aperture-bjshv: credito_passthrough_surcharge ─────────────

  const idLancamentoPassthroughSurcharge = '550e8400-e29b-41d4-a716-446655441099';

  it('PIX (surchargeCents=0) emits exactly 2 lancamentos and book balances (aperture-bjshv)', () => {
    const lancamentos = criarLancamentosParaPagamentoAprovado(
      inputPagamentoAprovado,
      { idLancamentoRecebedor, idLancamentoReceitaPlataforma },
      criadoEm,
    );
    expect(lancamentos).toHaveLength(2);
    expect(lancamentos.map((l) => l.tipo)).toEqual([
      'credito_saldo_recebedor',
      'credito_receita_plataforma',
    ]);
    // Book-balance invariant on the PIX path.
    const sum = lancamentos.reduce((acc, l) => acc + l.amountCents, 0);
    expect(sum).toBe(inputPagamentoAprovado.composicaoValores.totalPaidCents);
  });

  it('cartao (surchargeCents>0) emits 3 lancamentos and book balances (aperture-bjshv)', () => {
    const inputCartao = {
      ...inputPagamentoAprovado,
      composicaoValores: {
        contributionAmountCents: 4500,
        feeAmountCents: 225,
        surchargeCents: 224,
        totalPaidCents: 4949,
        receiverAmountCents: 4500,
        responsavelTaxa: 'contribuinte' as const,
      },
    };
    const lancamentos = criarLancamentosParaPagamentoAprovado(
      inputCartao,
      {
        idLancamentoRecebedor,
        idLancamentoReceitaPlataforma,
        idLancamentoPassthroughSurcharge,
      },
      criadoEm,
    );
    expect(lancamentos).toHaveLength(3);
    expect(lancamentos.map((l) => l.tipo)).toEqual([
      'credito_saldo_recebedor',
      'credito_receita_plataforma',
      'credito_passthrough_surcharge',
    ]);
    // Per-row shape checks for the new passthrough lancamento.
    const passthrough = lancamentos[2];
    expect(passthrough.id).toBe(idLancamentoPassthroughSurcharge);
    expect(passthrough.amountCents).toBe(224);
    expect(passthrough.status).toBe('pendente');
    expect(passthrough.idCampanha).toBe(idCampanha); // inherit from input per bead
    expect(passthrough.idPagamento).toBe(idPagamento);
    expect(passthrough.idContribuicao).toBe(idContribuicao);
    expect(passthrough.criadoEm).toBe(criadoEm);
    // Book-balance invariant on the cartao path — the whole reason this exists.
    const sum = lancamentos.reduce((acc, l) => acc + l.amountCents, 0);
    expect(sum).toBe(inputCartao.composicaoValores.totalPaidCents);
    expect(sum).toBe(4949);
  });

  it('cartao without idLancamentoPassthroughSurcharge throws a clear error (aperture-bjshv)', () => {
    expect(() =>
      criarLancamentosParaPagamentoAprovado(
        {
          ...inputPagamentoAprovado,
          composicaoValores: {
            contributionAmountCents: 4500,
            feeAmountCents: 225,
            surchargeCents: 224,
            totalPaidCents: 4949,
            receiverAmountCents: 4500,
            responsavelTaxa: 'contribuinte',
          },
        },
        { idLancamentoRecebedor, idLancamentoReceitaPlataforma },
        criadoEm,
      ),
    ).toThrow(/idLancamentoPassthroughSurcharge/);
  });

  it('PIX accepts a present idLancamentoPassthroughSurcharge but ignores it (no-op when surchargeCents=0)', () => {
    // Defensive: caller minted an extra UUID for a PIX payment. Factory
    // should NOT emit a 3rd lancamento — the surchargeCents===0 check
    // wins before the optional id is consumed.
    const lancamentos = criarLancamentosParaPagamentoAprovado(
      inputPagamentoAprovado,
      {
        idLancamentoRecebedor,
        idLancamentoReceitaPlataforma,
        idLancamentoPassthroughSurcharge,
      },
      criadoEm,
    );
    expect(lancamentos).toHaveLength(2);
    expect(lancamentos.find((l) => l.tipo === 'credito_passthrough_surcharge')).toBeUndefined();
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

    expect(calcularSaldoRecebedor(idCampanha, [lancamentoPendente, lancamentoDisponivel])).toEqual({
      idCampanha,
      valorPendenteCents: 8000,
      valorDisponivelCents: 2000,
    });
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
    });
  });
});
