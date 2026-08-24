import { describe, expect, it, vi } from 'vitest';
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import { PixCobrancaDevolucaoRepositoryMemory } from '../../../src/adapters/pagamentos/pix-cobranca-devolucao-repository.memory.js';
import {
  type DevolucaoOutcome,
  PixCobrancaAmbiguaError,
  type PixCobrancaProvider,
  PixCobrancaTransitoriaError,
} from '../../../src/adapters/pagamentos/pix-cobranca-provider.js';
import { PagamentoProviderFake } from '../../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import {
  aprovarPagamentoPendente,
  type Pagamento,
} from '../../../src/domain/pagamentos/entities/pagamento.js';
import type { LancamentoFinanceiro } from '../../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import {
  estornarPagamento,
  PagamentoEstornoPixNaoConcluidoError,
  PagamentoEstornoPixVinculoInvalidoError,
} from '../../../src/use-cases/checkout/estornar-pagamento.js';
import { finalizarEstornoPixVerificado } from '../../../src/use-cases/checkout/finalizar-estorno-pix-verificado.js';
import { makePagamento } from '../../helpers/pagamento-repository.conformance.js';

const ID_PAGAMENTO = '550e8400-e29b-41d4-a716-446655440301';
const ID_DEVOLUCAO = '550e8400e29b41d4a716446655440301';
const E2E_ID = 'E1234567890123456789012345678901';
const NOW = new Date('2026-08-05T15:00:00.000Z');
const observability = { logger: new NoopLogger(), tracer: noopTracer() };

function pixProvider(options: { put?: DevolucaoOutcome | Error; get?: DevolucaoOutcome | Error }) {
  const solicitarDevolucao = vi.fn(async () => {
    if (options.put instanceof Error) throw options.put;
    return options.put ?? { status: 'em_processamento', rtrId: 'D123' };
  });
  const consultarDevolucao = vi.fn(async () => {
    if (options.get instanceof Error) throw options.get;
    return options.get ?? { status: 'em_processamento', rtrId: 'D123' };
  });
  const provider: PixCobrancaProvider = {
    criarCobranca: async () => {
      throw new Error('unexpected charge creation');
    },
    consultarCobranca: async () => {
      throw new Error('unexpected charge query');
    },
    solicitarDevolucao,
    consultarDevolucao,
  };
  return { provider, solicitarDevolucao, consultarDevolucao };
}

async function setup(providerOptions: Parameters<typeof pixProvider>[0] = {}) {
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
  const pixCobrancaDevolucaoRepository = new PixCobrancaDevolucaoRepositoryMemory();
  const pagamentoProvider = new PagamentoProviderFake({ statusRefund: 'aceito' });
  const legacyRefund = vi.spyOn(pagamentoProvider, 'refundarPagamento');
  const inter = pixProvider(providerOptions);

  const pendente = makePagamento({
    id: ID_PAGAMENTO as never,
    idContribuicao: '550e8400-e29b-41d4-a716-446655440303' as never,
    criadoEm: new Date('2026-08-05T12:00:00.000Z'),
    metodo: 'pix',
  });
  const aprovado = aprovarPagamentoPendente(
    pendente,
    {
      id: E2E_ID,
      provedor: 'inter',
      status: 'aprovado',
      amountCents: pendente.intencao.composicaoValoresAggregate.totalPaidCents,
      criadaEm: new Date('2026-08-05T12:05:00.000Z'),
    },
    new Date('2026-08-05T12:05:00.000Z'),
  );
  const bound: Pagamento = {
    ...aprovado,
    intencao: { ...aprovado.intencao, e2eExternalRef: E2E_ID },
  };
  await pagamentoRepository.save(bound);

  const lancamento: LancamentoFinanceiro = {
    id: '550e8400-e29b-41d4-a716-446655440304',
    idPagamento: bound.id,
    idContribuicao: bound.intencao.idContribuicao,
    idCampanha: bound.intencao.idCampanha,
    tipo: 'credito_saldo_recebedor',
    amountCents: bound.intencao.composicaoValoresAggregate.totalPaidCents,
    criadoEm: new Date('2026-08-05T12:05:00.000Z'),
    transferidoEm: null,
    canceladoEm: null,
  };
  await livroFinanceiroRepository.saveLancamentos([lancamento]);

  const deps = {
    pagamentoRepository,
    pagamentoProvider,
    pixCobrancaProvider: inter.provider,
    pixCobrancaDevolucaoRepository,
    pagamentoEventPublisher: new PagamentoEventPublisherMemory(),
    livroFinanceiroRepository,
    clock: () => NOW,
    observability,
  };
  return { ...deps, deps, inter, legacyRefund, pagamento: bound };
}

describe('estornarPagamento — Banco Inter orchestration', () => {
  it('persists processing before returning and never routes Inter through the Stripe port', async () => {
    const { deps, inter, legacyRefund, pixCobrancaDevolucaoRepository, pagamentoRepository } =
      await setup({ put: { status: 'em_processamento', rtrId: 'D-processing' } });
    inter.solicitarDevolucao.mockImplementationOnce(async () => {
      expect(await pixCobrancaDevolucaoRepository.findByPagamentoId(ID_PAGAMENTO)).toMatchObject({
        status: 'em_processamento',
        rtrId: null,
      });
      return { status: 'em_processamento', rtrId: 'D-processing' };
    });

    const result = await estornarPagamento(deps, { idPagamento: ID_PAGAMENTO });

    expect(result).toMatchObject({ refundId: ID_DEVOLUCAO, refundStatus: 'em_processamento' });
    expect(result.pagamento.status).toBe('aprovado');
    expect(inter.solicitarDevolucao).toHaveBeenCalledOnce();
    expect(inter.solicitarDevolucao).toHaveBeenCalledWith({
      e2eId: E2E_ID,
      idDevolucao: ID_DEVOLUCAO,
      amountCents: result.pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
    });
    expect(legacyRefund).not.toHaveBeenCalled();
    expect(await pixCobrancaDevolucaoRepository.findByPagamentoId(ID_PAGAMENTO)).toMatchObject({
      status: 'em_processamento',
      rtrId: 'D-processing',
    });
    expect((await pagamentoRepository.findById(ID_PAGAMENTO))?.status).toBe('aprovado');
  });

  it('finalizes payment and ledger only for an authoritative immediate devolvida outcome', async () => {
    const { deps, pixCobrancaDevolucaoRepository, livroFinanceiroRepository } = await setup({
      put: { status: 'devolvida' },
    });

    const result = await estornarPagamento(deps, { idPagamento: ID_PAGAMENTO });

    expect(result.refundStatus).toBe('devolvida');
    expect(result.pagamento.status).toBe('estornado');
    expect(await pixCobrancaDevolucaoRepository.findByPagamentoId(ID_PAGAMENTO)).toMatchObject({
      status: 'devolvida',
    });
    expect(
      (await livroFinanceiroRepository.findLancamentosByIdPagamento(ID_PAGAMENTO))[0]?.canceladoEm,
    ).toEqual(NOW);
  });

  it.each([
    'nao_realizada',
    'rejeitada',
  ] as const)('persists %s and refuses the local transition without leaking provider detail', async (status) => {
    const outcome: DevolucaoOutcome =
      status === 'nao_realizada'
        ? { status, motivo: 'provider-controlled-secret' }
        : { status, codigo: 'provider-controlled-secret' };
    const { deps, pixCobrancaDevolucaoRepository, pagamentoRepository } = await setup({
      put: outcome,
    });

    const promise = estornarPagamento(deps, { idPagamento: ID_PAGAMENTO });
    await expect(promise).rejects.toBeInstanceOf(PagamentoEstornoPixNaoConcluidoError);
    await expect(promise).rejects.not.toThrow('provider-controlled-secret');
    expect(await pixCobrancaDevolucaoRepository.findByPagamentoId(ID_PAGAMENTO)).toMatchObject({
      status,
    });
    expect((await pagamentoRepository.findById(ID_PAGAMENTO))?.status).toBe('aprovado');
  });

  it('replays pending via authoritative GET and never issues a second PUT', async () => {
    const { deps, inter, pagamento } = await setup({
      put: { status: 'em_processamento', rtrId: 'D-first' },
      get: { status: 'devolvida' },
    });

    expect((await estornarPagamento(deps, { idPagamento: ID_PAGAMENTO })).refundStatus).toBe(
      'em_processamento',
    );
    expect((await estornarPagamento(deps, { idPagamento: ID_PAGAMENTO })).refundStatus).toBe(
      'devolvida',
    );
    expect(inter.solicitarDevolucao).toHaveBeenCalledOnce();
    expect(inter.consultarDevolucao).toHaveBeenCalledOnce();
    expect(inter.consultarDevolucao).toHaveBeenCalledWith({
      e2eId: E2E_ID,
      idDevolucao: ID_DEVOLUCAO,
      amountCents: pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
    });
  });

  it('keeps an ambiguous PUT pending, then consults before any retry', async () => {
    const { deps, inter, pixCobrancaDevolucaoRepository } = await setup({
      put: new PixCobrancaAmbiguaError('ambiguous'),
      get: { status: 'em_processamento', rtrId: 'D-after-query' },
    });

    await expect(estornarPagamento(deps, { idPagamento: ID_PAGAMENTO })).rejects.toBeInstanceOf(
      PixCobrancaAmbiguaError,
    );
    expect(await pixCobrancaDevolucaoRepository.findByPagamentoId(ID_PAGAMENTO)).toMatchObject({
      status: 'em_processamento',
    });
    expect((await estornarPagamento(deps, { idPagamento: ID_PAGAMENTO })).refundStatus).toBe(
      'em_processamento',
    );
    expect(inter.solicitarDevolucao).toHaveBeenCalledOnce();
    expect(inter.consultarDevolucao).toHaveBeenCalledOnce();
  });

  it('removes a definitely-unsent pending row so a later retry may re-PUT', async () => {
    const { deps, inter, pixCobrancaDevolucaoRepository } = await setup({
      put: new PixCobrancaTransitoriaError('pre-send'),
    });

    await expect(estornarPagamento(deps, { idPagamento: ID_PAGAMENTO })).rejects.toBeInstanceOf(
      PixCobrancaTransitoriaError,
    );
    expect(await pixCobrancaDevolucaoRepository.findByPagamentoId(ID_PAGAMENTO)).toBeUndefined();

    inter.solicitarDevolucao.mockResolvedValueOnce({
      status: 'em_processamento',
      rtrId: 'D-retry',
    });
    expect((await estornarPagamento(deps, { idPagamento: ID_PAGAMENTO })).refundStatus).toBe(
      'em_processamento',
    );
    expect(inter.solicitarDevolucao).toHaveBeenCalledTimes(2);
  });
});

describe('finalizarEstornoPixVerificado — provider-free callback seam', () => {
  it('converges duplicate verified callbacks with an idempotent ledger repair', async () => {
    const { deps, pixCobrancaDevolucaoRepository, livroFinanceiroRepository, inter, pagamento } =
      await setup();
    await pixCobrancaDevolucaoRepository.createIfAbsent({
      id: '550e8400-e29b-41d4-a716-446655440399',
      idPagamento: ID_PAGAMENTO,
      e2eId: E2E_ID,
      idDevolucao: ID_DEVOLUCAO,
      amountCents: pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
      criadoEm: NOW,
    });
    const cancel = vi.spyOn(
      livroFinanceiroRepository,
      'marcarLancamentosComoCanceladosPorPagamento',
    );
    const seamDeps = {
      pagamentoRepository: deps.pagamentoRepository,
      pixCobrancaDevolucaoRepository,
      livroFinanceiroRepository,
      clock: () => NOW,
    };

    const first = await finalizarEstornoPixVerificado(seamDeps, {
      e2eId: E2E_ID,
      idDevolucao: ID_DEVOLUCAO,
    });
    const second = await finalizarEstornoPixVerificado(seamDeps, {
      e2eId: E2E_ID,
      idDevolucao: ID_DEVOLUCAO,
    });

    expect(first).toEqual({ pagamentoId: ID_PAGAMENTO });
    expect(second).toEqual(first);
    // The replay repeats only the idempotent ledger repair, never provider
    // money movement or the payment CAS transition.
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(inter.solicitarDevolucao).not.toHaveBeenCalled();
    expect(inter.consultarDevolucao).not.toHaveBeenCalled();
  });

  it('repairs the ledger on replay after payment CAS won but cancellation failed', async () => {
    const { deps, pixCobrancaDevolucaoRepository, livroFinanceiroRepository, pagamento, inter } =
      await setup();
    await pixCobrancaDevolucaoRepository.createIfAbsent({
      id: '550e8400-e29b-41d4-a716-446655440399',
      idPagamento: ID_PAGAMENTO,
      e2eId: E2E_ID,
      idDevolucao: ID_DEVOLUCAO,
      amountCents: pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
      criadoEm: NOW,
    });
    const originalCancel =
      livroFinanceiroRepository.marcarLancamentosComoCanceladosPorPagamento.bind(
        livroFinanceiroRepository,
      );
    const cancel = vi
      .spyOn(livroFinanceiroRepository, 'marcarLancamentosComoCanceladosPorPagamento')
      .mockRejectedValueOnce(new Error('simulated ledger outage'))
      .mockImplementation(originalCancel);
    const seamDeps = {
      pagamentoRepository: deps.pagamentoRepository,
      pixCobrancaDevolucaoRepository,
      livroFinanceiroRepository,
      clock: () => NOW,
    };

    await expect(
      finalizarEstornoPixVerificado(seamDeps, {
        e2eId: E2E_ID,
        idDevolucao: ID_DEVOLUCAO,
      }),
    ).rejects.toThrow('simulated ledger outage');
    expect((await deps.pagamentoRepository.findById(ID_PAGAMENTO))?.status).toBe('estornado');

    await expect(estornarPagamento(deps, { idPagamento: ID_PAGAMENTO })).resolves.toMatchObject({
      pagamento: { status: 'estornado' },
      refundId: ID_DEVOLUCAO,
      refundStatus: 'devolvida',
    });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(inter.solicitarDevolucao).not.toHaveBeenCalled();
    expect(inter.consultarDevolucao).not.toHaveBeenCalled();
  });

  it('fails closed when refund identity is not bound to the payment', async () => {
    const { deps, pixCobrancaDevolucaoRepository, livroFinanceiroRepository, pagamento } =
      await setup();
    await pixCobrancaDevolucaoRepository.createIfAbsent({
      id: '550e8400-e29b-41d4-a716-446655440399',
      idPagamento: ID_PAGAMENTO,
      e2eId: 'F1234567890123456789012345678901',
      idDevolucao: ID_DEVOLUCAO,
      amountCents: pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
      criadoEm: NOW,
    });

    await expect(
      finalizarEstornoPixVerificado(
        {
          pagamentoRepository: deps.pagamentoRepository,
          pixCobrancaDevolucaoRepository,
          livroFinanceiroRepository,
          clock: () => NOW,
        },
        { e2eId: 'F1234567890123456789012345678901', idDevolucao: ID_DEVOLUCAO },
      ),
    ).rejects.toBeInstanceOf(PagamentoEstornoPixVinculoInvalidoError);
  });

  it('rejects a persisted refund id that is not the deterministic payment id', async () => {
    const { deps, pixCobrancaDevolucaoRepository, livroFinanceiroRepository, pagamento } =
      await setup();
    const wrongRefundId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await pixCobrancaDevolucaoRepository.createIfAbsent({
      id: '550e8400-e29b-41d4-a716-446655440399',
      idPagamento: ID_PAGAMENTO,
      e2eId: E2E_ID,
      idDevolucao: wrongRefundId,
      amountCents: pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
      criadoEm: NOW,
    });

    await expect(
      finalizarEstornoPixVerificado(
        {
          pagamentoRepository: deps.pagamentoRepository,
          pixCobrancaDevolucaoRepository,
          livroFinanceiroRepository,
          clock: () => NOW,
        },
        { e2eId: E2E_ID, idDevolucao: wrongRefundId },
      ),
    ).rejects.toBeInstanceOf(PagamentoEstornoPixVinculoInvalidoError);
  });
});
