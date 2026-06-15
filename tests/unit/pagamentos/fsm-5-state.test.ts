import { describe, expect, it } from 'vitest';
import {
  aprovarPagamentoPendente,
  criarPagamentoPendente,
  estornarPagamentoAprovado,
  iniciarProcessamentoPagamento,
  type Pagamento,
  podeAprovarPagamento,
  podeRejeitarPagamento,
  rejeitarPagamentoPendente,
  StatusPagamentoSchema,
  type TransacaoExterna,
} from '../../../src/domain/pagamentos/entities/pagamento.js';

/**
 * Plan 0015 (aperture-ucgok). Tests the new 5-state Pagamento FSM:
 *   pendente   → processing   (iniciarProcessamentoPagamento; pix QR scanned)
 *   pendente   → aprovado     (aprovarPagamentoPendente; card happy path)
 *   processing → aprovado     (aprovarPagamentoPendente; pix after bank confirm)
 *   pendente   → rejeitado    (rejeitarPagamentoPendente; failure before processing)
 *   processing → rejeitado    (rejeitarPagamentoPendente; failure during processing)
 *   aprovado   → estornado    (estornarPagamentoAprovado; charge.refunded)
 *
 * The pre-existing pagamentos.test.ts covers the 3-state baseline; this
 * file covers the 5-state-specific additions + invalid transitions.
 */

const idPagamento = '550e8400-e29b-41d4-a716-446655440201';
const idIntencaoPagamento = '550e8400-e29b-41d4-a716-446655440202';
const idContribuicao = '550e8400-e29b-41d4-a716-446655440203';
const idTransacaoExterna = '550e8400-e29b-41d4-a716-446655440204';
const criadoEm = new Date('2026-05-01T12:00:00.000Z');
const processingEm = new Date('2026-05-01T12:01:00.000Z');
const atualizadoEm = new Date('2026-05-01T12:05:00.000Z');
const estornadoEm = new Date('2026-05-02T15:00:00.000Z');

const idCampanha = '550e8400-e29b-41d4-a716-446655440205';
const idItem = '550e8400-e29b-41d4-a716-446655440206';

const transacaoAprovada: TransacaoExterna = {
  id: idTransacaoExterna,
  provedor: 'fake-provider',
  status: 'aprovado',
  amountCents: 8400 as never,
  criadaEm: atualizadoEm,
  statusBruto: 'aprovado',
};

const transacaoRejeitada: TransacaoExterna = {
  ...transacaoAprovada,
  status: 'rejeitado',
  statusBruto: 'failed',
};

function novoPendente(metodo: 'pix' | 'credit_card' = 'pix'): Pagamento {
  // Plan 0016 Phase 2: build a single-item PIX cart fixture.
  const item = {
    id: idItem,
    tipo: 'contribuicao' as const,
    idContribuicao,
    quantidade: 1,
    composicaoValoresItem: {
      tipo: 'contribuicao' as const,
      idContribuicao,
      quantidade: 1,
      contributionUnitAmountCents: 8000,
      feeUnitAmountCents: 400,
      receiverUnitAmountCents: 8000,
      lineContributionAmountCents: 8000,
      lineFeeAmountCents: 400,
      lineReceiverAmountCents: 8000,
    },
    criadoEm,
  };
  return criarPagamentoPendente({
    idPagamento,
    idIntencaoPagamento,
    items: [item as never],
    composicaoValoresAggregate: {
      idCampanha: idCampanha as never,
      totalContributionCents: 8000 as never,
      totalFeeCents: 400 as never,
      totalReceiverCents: 8000 as never,
      totalSurchargeCents: 0,
      totalPaidCents: 8400 as never,
      responsavelTaxa: 'contribuinte',
    },
    valorACobrarCents: 8400 as never,
    metodo,
    criadoEm,
  });
}

describe('StatusPagamentoSchema (5-state)', () => {
  it('accepts all five states', () => {
    for (const s of ['pendente', 'processing', 'aprovado', 'rejeitado', 'estornado']) {
      expect(StatusPagamentoSchema.safeParse(s).success).toBe(true);
    }
  });

  it('rejects unknown states', () => {
    expect(StatusPagamentoSchema.safeParse('refunded').success).toBe(false);
    expect(StatusPagamentoSchema.safeParse('disputed').success).toBe(false);
  });
});

describe('criarPagamentoPendente — new IntencaoPagamento.contribuinte', () => {
  it('starts with contribuinte: null (set later by webhook)', () => {
    const pagamento = novoPendente();
    expect(pagamento.intencao.contribuinte).toBeNull();
  });
});

describe('iniciarProcessamentoPagamento (pendente → processing)', () => {
  it('transitions pendente → processing', () => {
    const pendente = novoPendente('pix');
    const processing = iniciarProcessamentoPagamento(pendente, processingEm);
    expect(processing.status).toBe('processing');
    expect(processing.atualizadoEm).toBe(processingEm);
  });

  it('is idempotent on processing → processing (returns the same object)', () => {
    const pendente = novoPendente('pix');
    const processing1 = iniciarProcessamentoPagamento(pendente, processingEm);
    const processing2 = iniciarProcessamentoPagamento(processing1, atualizadoEm);
    expect(processing2).toBe(processing1);
  });

  it('throws when transitioning from aprovado', () => {
    const pendente = novoPendente('pix');
    const aprovado = aprovarPagamentoPendente(pendente, transacaoAprovada, atualizadoEm);
    expect(() => iniciarProcessamentoPagamento(aprovado, processingEm)).toThrow(
      /nao pode transitar para processing/,
    );
  });

  it('throws when transitioning from rejeitado', () => {
    const pendente = novoPendente('pix');
    const rejeitado = rejeitarPagamentoPendente(pendente, transacaoRejeitada, atualizadoEm);
    expect(() => iniciarProcessamentoPagamento(rejeitado, processingEm)).toThrow(
      /nao pode transitar para processing/,
    );
  });
});

describe('podeAprovarPagamento (accepts pendente OR processing)', () => {
  it('accepts pendente', () => {
    expect(podeAprovarPagamento(novoPendente())).toBe(true);
  });

  it('accepts processing (pix after QR scan)', () => {
    const processing = iniciarProcessamentoPagamento(novoPendente('pix'), processingEm);
    expect(podeAprovarPagamento(processing)).toBe(true);
  });

  it('rejects aprovado', () => {
    const aprovado = aprovarPagamentoPendente(novoPendente(), transacaoAprovada, atualizadoEm);
    expect(podeAprovarPagamento(aprovado)).toBe(false);
  });

  it('rejects rejeitado', () => {
    const rejeitado = rejeitarPagamentoPendente(novoPendente(), transacaoRejeitada, atualizadoEm);
    expect(podeAprovarPagamento(rejeitado)).toBe(false);
  });
});

describe('aprovarPagamentoPendente — processing → aprovado path (plan 0015)', () => {
  it('approves a processing pagamento (pix happy path)', () => {
    const processing = iniciarProcessamentoPagamento(novoPendente('pix'), processingEm);
    const aprovado = aprovarPagamentoPendente(processing, transacaoAprovada, atualizadoEm);
    expect(aprovado.status).toBe('aprovado');
    expect(aprovado.transacaoExterna?.id).toBe(idTransacaoExterna);
  });

  it('still approves a pendente pagamento (card happy path — skips processing)', () => {
    const pendente = novoPendente('credit_card');
    const aprovado = aprovarPagamentoPendente(pendente, transacaoAprovada, atualizadoEm);
    expect(aprovado.status).toBe('aprovado');
  });
});

describe('podeRejeitarPagamento (accepts pendente OR processing)', () => {
  it('accepts pendente', () => {
    expect(podeRejeitarPagamento(novoPendente())).toBe(true);
  });

  it('accepts processing', () => {
    const processing = iniciarProcessamentoPagamento(novoPendente('pix'), processingEm);
    expect(podeRejeitarPagamento(processing)).toBe(true);
  });
});

describe('rejeitarPagamentoPendente — processing → rejeitado (plan 0015)', () => {
  it('rejects a processing pagamento (pix failure mid-flight)', () => {
    const processing = iniciarProcessamentoPagamento(novoPendente('pix'), processingEm);
    const rejeitado = rejeitarPagamentoPendente(processing, transacaoRejeitada, atualizadoEm);
    expect(rejeitado.status).toBe('rejeitado');
  });
});

describe('estornarPagamentoAprovado (aprovado → estornado)', () => {
  it('transitions aprovado → estornado', () => {
    const aprovado = aprovarPagamentoPendente(novoPendente(), transacaoAprovada, atualizadoEm);
    const estornado = estornarPagamentoAprovado(aprovado, estornadoEm);
    expect(estornado.status).toBe('estornado');
    expect(estornado.atualizadoEm).toBe(estornadoEm);
    // transacaoExterna preserved (audit trail of the original aprovação).
    expect(estornado.transacaoExterna?.id).toBe(idTransacaoExterna);
  });

  it('throws when source state is pendente', () => {
    expect(() => estornarPagamentoAprovado(novoPendente(), estornadoEm)).toThrow(
      /nao pode ser estornado.*pendente/,
    );
  });

  it('throws when source state is processing', () => {
    const processing = iniciarProcessamentoPagamento(novoPendente('pix'), processingEm);
    expect(() => estornarPagamentoAprovado(processing, estornadoEm)).toThrow(
      /nao pode ser estornado.*processing/,
    );
  });

  it('throws when source state is rejeitado', () => {
    const rejeitado = rejeitarPagamentoPendente(novoPendente(), transacaoRejeitada, atualizadoEm);
    expect(() => estornarPagamentoAprovado(rejeitado, estornadoEm)).toThrow(
      /nao pode ser estornado.*rejeitado/,
    );
  });

  it('throws on double-estorno (estornado → estornado)', () => {
    const aprovado = aprovarPagamentoPendente(novoPendente(), transacaoAprovada, atualizadoEm);
    const estornado = estornarPagamentoAprovado(aprovado, estornadoEm);
    expect(() => estornarPagamentoAprovado(estornado, estornadoEm)).toThrow(
      /nao pode ser estornado.*estornado/,
    );
  });
});
