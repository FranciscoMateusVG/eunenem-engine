import { describe, expect, it } from 'vitest';
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import { PaymentMoneyMovementMemoryCoordinator } from '../../../src/adapters/pagamentos/payment-money-movement-lock.memory.js';
import { PixCobrancaDevolucaoRepositoryMemory } from '../../../src/adapters/pagamentos/pix-cobranca-devolucao-repository.memory.js';
import type { PixCobrancaProvider } from '../../../src/adapters/pagamentos/pix-cobranca-provider.js';
import { PagamentoProviderFake } from '../../../src/adapters/pagamentos/provider.fake.js';
import type {
  PagamentoProvider,
  RefundarPagamentoInput,
  RefundarPagamentoResult,
} from '../../../src/adapters/pagamentos/provider.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import { StripeRefundOperationRepositoryMemory } from '../../../src/adapters/pagamentos/stripe-refund-operation-repository.memory.js';
import {
  aprovarPagamentoPendente,
  type Pagamento,
} from '../../../src/domain/pagamentos/entities/pagamento.js';
import type { LancamentoFinanceiro } from '../../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import { PagamentoNaoEncontradoError } from '../../../src/errors/pagamentos/nao-encontrado.error.js';
import { PagamentoTransicaoStatusInvalidaError } from '../../../src/errors/pagamentos/transicao-status-invalida.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import {
  estornarPagamento,
  PagamentoEstornoLancamentoJaTransferidoError,
  PagamentoEstornoRecusadoPeloProvedorError,
  PagamentoEstornoStripeOutcomeDesconhecidoError,
} from '../../../src/use-cases/checkout/estornar-pagamento.js';
import { makePagamento } from '../../helpers/pagamento-repository.conformance.js';

/**
 * Plan 0015 (aperture-ucgok). Tests the new estornar-pagamento use-case:
 *   - Happy path: aprovado pagamento + no transferred lançamentos →
 *     provider refunds → pagamento → estornado, lançamentos cancelled.
 *   - 409 gate: any transferred lançamento blocks the estorno; provider
 *     is NOT called; pagamento stays aprovado.
 *   - Provider refusal: provider returns `recusado` → use-case throws;
 *     pagamento stays aprovado (no partial state).
 *   - Idempotency: already-estornado pagamento returns existing state
 *     without re-firing the provider call.
 *   - Invalid source state: throws PagamentoTransicaoStatusInvalidaError.
 */

const idPagamento = '550e8400-e29b-41d4-a716-446655440301';
const idIntencaoPagamento = '550e8400-e29b-41d4-a716-446655440302';
const idContribuicao = '550e8400-e29b-41d4-a716-446655440303';
const idLancamentoRecebedor = '550e8400-e29b-41d4-a716-446655440304';
const idLancamentoReceita = '550e8400-e29b-41d4-a716-446655440305';

const observability = { logger: new NoopLogger(), tracer: noopTracer() };

const pixCobrancaProviderNever: PixCobrancaProvider = {
  criarCobranca: async () => {
    throw new Error('unexpected Inter charge call');
  },
  consultarCobranca: async () => {
    throw new Error('unexpected Inter charge query');
  },
  solicitarDevolucao: async () => {
    throw new Error('unexpected Inter refund call');
  },
  consultarDevolucao: async () => {
    throw new Error('unexpected Inter refund query');
  },
};

const stripeRefundRepositories = new WeakMap<
  PagamentoRepositoryMemory,
  StripeRefundOperationRepositoryMemory
>();

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function legacyRefundDeps(
  pagamentoRepository: PagamentoRepositoryMemory,
  livroFinanceiroRepository: LivroFinanceiroRepositoryMemory,
) {
  let stripeRefundOperationRepository = stripeRefundRepositories.get(pagamentoRepository);
  if (!stripeRefundOperationRepository) {
    stripeRefundOperationRepository = new StripeRefundOperationRepositoryMemory(
      pagamentoRepository,
      livroFinanceiroRepository,
    );
    stripeRefundRepositories.set(pagamentoRepository, stripeRefundOperationRepository);
  }
  return {
    pixCobrancaProvider: pixCobrancaProviderNever,
    pixCobrancaDevolucaoRepository: new PixCobrancaDevolucaoRepositoryMemory(),
    stripeRefundOperationRepository,
  };
}

async function seedAprovado(deps: {
  pagamentoRepository: PagamentoRepositoryMemory;
  livroFinanceiroRepository: LivroFinanceiroRepositoryMemory;
}): Promise<{ pagamento: Pagamento; lancamentos: LancamentoFinanceiro[] }> {
  // Plan 0016 Phase 2 (aperture-eg1s2): build the pendente pagamento via
  // the shared `makePagamento` factory so the cart-shape invariants are
  // satisfied. Pin id / idIntencaoPagamento / idContribuicao so the
  // seeded lançamentos below reference the same aggregate.
  const pendente = makePagamento({
    id: idPagamento as never,
    idContribuicao: idContribuicao as never,
    criadoEm: new Date('2026-05-01T12:00:00Z'),
    metodo: 'pix',
  });
  // Pin idIntencaoPagamento so external observers can correlate.
  const pendenteComIntencao: Pagamento = {
    ...pendente,
    intencao: { ...pendente.intencao, id: idIntencaoPagamento as never },
  };
  await deps.pagamentoRepository.save(pendenteComIntencao);
  // Approve via the entity transition.
  const aprovado = aprovarPagamentoPendente(
    pendenteComIntencao,
    {
      id: 'ch_test_fake_123',
      // Historical Stripe provenance must keep using PagamentoProvider even
      // while Banco Inter refunds coexist in the same orchestration.
      provedor: 'stripe',
      status: 'aprovado',
      amountCents: 8400,
      criadaEm: new Date('2026-05-01T12:05:00Z'),
    },
    new Date('2026-05-01T12:05:00Z'),
  );
  // Plan 0015: also set chargeExternalRef so the refund can find a charge id.
  const aprovadoComCh: Pagamento = {
    ...aprovado,
    intencao: { ...aprovado.intencao, chargeExternalRef: 'ch_test_fake_123' },
  };
  await deps.pagamentoRepository.update(aprovadoComCh);

  // Seed two lancamentos, both born pending (transferidoEm=null, canceladoEm=null).
  const lancamentos: LancamentoFinanceiro[] = [
    {
      id: idLancamentoRecebedor,
      idPagamento,
      idContribuicao,
      idCampanha: '550e8400-e29b-41d4-a716-446655440307',
      tipo: 'credito_saldo_recebedor',
      amountCents: 8000,
      criadoEm: new Date('2026-05-01T12:05:00Z'),
      transferidoEm: null,
      canceladoEm: null,
    },
    {
      id: idLancamentoReceita,
      idPagamento,
      idContribuicao,
      tipo: 'credito_receita_plataforma',
      amountCents: 400,
      criadoEm: new Date('2026-05-01T12:05:00Z'),
      transferidoEm: null,
      canceladoEm: null,
    },
  ];
  await deps.livroFinanceiroRepository.saveLancamentos(lancamentos);

  return { pagamento: aprovadoComCh, lancamentos };
}

describe('estornarPagamento — happy path (no transferred lançamentos)', () => {
  it('refunds + transitions pagamento → estornado + cancels lançamentos', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
    const pagamentoProvider = new PagamentoProviderFake({ statusRefund: 'aceito' });
    const pagamentoEventPublisher = new PagamentoEventPublisherMemory();

    await seedAprovado({ pagamentoRepository, livroFinanceiroRepository });

    const result = await estornarPagamento(
      {
        pagamentoRepository,
        pagamentoProvider,
        ...legacyRefundDeps(pagamentoRepository, livroFinanceiroRepository),
        pagamentoEventPublisher,
        livroFinanceiroRepository,
        clock: () => new Date('2026-05-02T15:00:00Z'),
        observability,
      },
      { idPagamento, reason: 'requested_by_customer' },
    );

    expect(result.pagamento.status).toBe('estornado');
    expect(result.refundId).toMatch(/^re_fake_/);

    // Pagamento persisted.
    const persisted = await pagamentoRepository.findById(idPagamento);
    expect(persisted?.status).toBe('estornado');

    // Both lançamentos cancelled (transferidoEm still null; canceladoEm set).
    const lancamentos = await livroFinanceiroRepository.findLancamentosByIdPagamento(idPagamento);
    expect(lancamentos).toHaveLength(2);
    for (const l of lancamentos) {
      expect(l.transferidoEm).toBeNull();
      expect(l.canceladoEm).toEqual(new Date('2026-05-02T15:00:00Z'));
    }
  });

  it('uses paymentIntentExternalRef as fallback when chargeExternalRef is null', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
    const pagamentoProvider = new PagamentoProviderFake({ statusRefund: 'aceito' });
    const pagamentoEventPublisher = new PagamentoEventPublisherMemory();

    const { pagamento } = await seedAprovado({ pagamentoRepository, livroFinanceiroRepository });
    // Strip the chargeExternalRef; set only pi.
    await pagamentoRepository.update({
      ...pagamento,
      intencao: {
        ...pagamento.intencao,
        chargeExternalRef: null,
        paymentIntentExternalRef: 'pi_test_fake_456',
      },
      transacaoExterna: pagamento.transacaoExterna
        ? { ...pagamento.transacaoExterna, id: 'pi_test_fake_456' }
        : undefined,
    });

    const result = await estornarPagamento(
      {
        pagamentoRepository,
        pagamentoProvider,
        ...legacyRefundDeps(pagamentoRepository, livroFinanceiroRepository),
        pagamentoEventPublisher,
        livroFinanceiroRepository,
        clock: () => new Date('2026-05-02T15:00:00Z'),
        observability,
      },
      { idPagamento },
    );

    expect(result.pagamento.status).toBe('estornado');
  });
});

describe('estornarPagamento — 409 gate (any lançamento already transferred)', () => {
  it('refuses estorno when at least one lançamento has transferidoEm set', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
    const pagamentoProvider = new PagamentoProviderFake({ statusRefund: 'aceito' });
    let providerCalls = 0;
    const originalRefund = pagamentoProvider.refundarPagamento.bind(pagamentoProvider);
    pagamentoProvider.refundarPagamento = async (input) => {
      providerCalls += 1;
      return originalRefund(input);
    };
    const pagamentoEventPublisher = new PagamentoEventPublisherMemory();

    await seedAprovado({ pagamentoRepository, livroFinanceiroRepository });
    // Mark the receiver lançamento as transferred — money has reached the recebedor.
    await livroFinanceiroRepository.marcarLancamentosComoTransferidos(
      [idLancamentoRecebedor],
      new Date('2026-05-02T10:00:00Z'),
    );

    await expect(
      estornarPagamento(
        {
          pagamentoRepository,
          pagamentoProvider,
          ...legacyRefundDeps(pagamentoRepository, livroFinanceiroRepository),
          pagamentoEventPublisher,
          livroFinanceiroRepository,
          clock: () => new Date('2026-05-02T15:00:00Z'),
          observability,
        },
        { idPagamento },
      ),
    ).rejects.toBeInstanceOf(PagamentoEstornoLancamentoJaTransferidoError);
    expect(providerCalls).toBe(0);

    // Pagamento stays aprovado — no partial state.
    const persisted = await pagamentoRepository.findById(idPagamento);
    expect(persisted?.status).toBe('aprovado');
    // The receiver lançamento is still transferred; the receita one stays pending (not cancelled).
    const lancamentos = await livroFinanceiroRepository.findLancamentosByIdPagamento(idPagamento);
    const receita = lancamentos.find((l) => l.tipo === 'credito_receita_plataforma');
    expect(receita?.canceladoEm).toBeNull();
  });
});

describe('estornarPagamento — provider refusal', () => {
  it('throws when provider returns recusado; pagamento stays aprovado', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
    const pagamentoProvider = new PagamentoProviderFake({ statusRefund: 'recusado' });
    const pagamentoEventPublisher = new PagamentoEventPublisherMemory();

    await seedAprovado({ pagamentoRepository, livroFinanceiroRepository });

    await expect(
      estornarPagamento(
        {
          pagamentoRepository,
          pagamentoProvider,
          ...legacyRefundDeps(pagamentoRepository, livroFinanceiroRepository),
          pagamentoEventPublisher,
          livroFinanceiroRepository,
          clock: () => new Date('2026-05-02T15:00:00Z'),
          observability,
        },
        { idPagamento },
      ),
    ).rejects.toBeInstanceOf(PagamentoEstornoRecusadoPeloProvedorError);

    const persisted = await pagamentoRepository.findById(idPagamento);
    expect(persisted?.status).toBe('aprovado');
    // No lancamentos cancelled.
    const lancamentos = await livroFinanceiroRepository.findLancamentosByIdPagamento(idPagamento);
    for (const l of lancamentos) {
      expect(l.canceladoEm).toBeNull();
    }
  });
});

describe('estornarPagamento — idempotency', () => {
  it('returns existing state on already-estornado pagamento without re-firing provider', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
    let providerCalls = 0;
    const pagamentoProvider = new PagamentoProviderFake({ statusRefund: 'aceito' });
    const originalRefund = pagamentoProvider.refundarPagamento.bind(pagamentoProvider);
    pagamentoProvider.refundarPagamento = async (input) => {
      providerCalls += 1;
      return originalRefund(input);
    };
    const pagamentoEventPublisher = new PagamentoEventPublisherMemory();

    await seedAprovado({ pagamentoRepository, livroFinanceiroRepository });

    await estornarPagamento(
      {
        pagamentoRepository,
        pagamentoProvider,
        ...legacyRefundDeps(pagamentoRepository, livroFinanceiroRepository),
        pagamentoEventPublisher,
        livroFinanceiroRepository,
        clock: () => new Date('2026-05-02T15:00:00Z'),
        observability,
      },
      { idPagamento },
    );
    expect(providerCalls).toBe(1);

    // Replay: should NOT fire the provider again.
    const replay = await estornarPagamento(
      {
        pagamentoRepository,
        pagamentoProvider,
        ...legacyRefundDeps(pagamentoRepository, livroFinanceiroRepository),
        pagamentoEventPublisher,
        livroFinanceiroRepository,
        clock: () => new Date('2026-05-02T16:00:00Z'),
        observability,
      },
      { idPagamento },
    );
    expect(providerCalls).toBe(1);
    expect(replay.pagamento.status).toBe('estornado');
    expect(replay.refundId).toMatch(/^re_fake_/);
  });
});

describe('estornarPagamento — durable Stripe refund attempts', () => {
  function buildDeps(pagamentoProvider: PagamentoProvider) {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
    const moneyMovement = new PaymentMoneyMovementMemoryCoordinator();
    const stripeRefundOperationRepository = new StripeRefundOperationRepositoryMemory(
      pagamentoRepository,
      livroFinanceiroRepository,
      moneyMovement,
    );
    return {
      pagamentoRepository,
      livroFinanceiroRepository,
      stripeRefundOperationRepository,
      moneyMovement,
      deps: {
        pagamentoRepository,
        pagamentoProvider,
        pixCobrancaProvider: pixCobrancaProviderNever,
        pixCobrancaDevolucaoRepository: new PixCobrancaDevolucaoRepositoryMemory(),
        stripeRefundOperationRepository,
        pagamentoEventPublisher: new PagamentoEventPublisherMemory(),
        livroFinanceiroRepository,
        clock: () => new Date('2026-05-02T15:00:00Z'),
        observability,
      },
    };
  }

  it('admits one provider call when two refunds race', async () => {
    const entered = deferred();
    const release = deferred();
    let providerCalls = 0;
    const provider = new PagamentoProviderFake({ statusRefund: 'aceito' });
    const originalRefund = provider.refundarPagamento.bind(provider);
    provider.refundarPagamento = async (input) => {
      providerCalls += 1;
      entered.resolve();
      await release.promise;
      return originalRefund(input);
    };
    const rig = buildDeps(provider);
    await seedAprovado(rig);

    const first = estornarPagamento(rig.deps, { idPagamento });
    await entered.promise;
    const second = estornarPagamento(rig.deps, { idPagamento });
    release.resolve();
    const outcomes = await Promise.allSettled([first, second]);

    expect(providerCalls).toBe(1);
    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    expect((await rig.pagamentoRepository.findById(idPagamento))?.status).toBe('estornado');
  });

  it('uses a new numbered idempotency key only after an exact terminal refusal', async () => {
    const calls: RefundarPagamentoInput[] = [];
    const results: RefundarPagamentoResult[] = [
      { id: 're_failed_1', status: 'failed', amountCents: 8400, currency: 'brl' },
      { id: 're_succeeded_2', status: 'succeeded', amountCents: 8400, currency: 'brl' },
    ];
    const base = new PagamentoProviderFake();
    base.refundarPagamento = async (input) => {
      calls.push(input);
      const result = results.shift();
      if (!result) throw new Error('unexpected provider retry');
      return result;
    };
    const rig = buildDeps(base);
    await seedAprovado(rig);

    await expect(estornarPagamento(rig.deps, { idPagamento })).rejects.toBeInstanceOf(
      PagamentoEstornoRecusadoPeloProvedorError,
    );
    await expect(estornarPagamento(rig.deps, { idPagamento })).resolves.toMatchObject({
      refundId: 're_succeeded_2',
      refundStatus: 'aceito',
    });

    expect(calls.map((call) => call.idempotencyKey)).toEqual([
      `pagamento:${idPagamento}:refund:1`,
      `pagamento:${idPagamento}:refund:2`,
    ]);
    expect(new Set(calls.map((call) => call.operationId))).toHaveLength(1);
    expect(
      (await rig.stripeRefundOperationRepository.findByPaymentId(idPagamento))?.attemptCount,
    ).toBe(2);
  });

  it('resumes a persisted provider success after a pre-convergence crash without another create', async () => {
    let providerCalls = 0;
    const provider = new PagamentoProviderFake({ statusRefund: 'aceito' });
    const originalRefund = provider.refundarPagamento.bind(provider);
    provider.refundarPagamento = async (input) => {
      providerCalls += 1;
      return originalRefund(input);
    };
    const rig = buildDeps(provider);
    await seedAprovado(rig);
    const originalConverge = rig.stripeRefundOperationRepository.convergeSuccessful.bind(
      rig.stripeRefundOperationRepository,
    );
    rig.stripeRefundOperationRepository.convergeSuccessful = async () => {
      throw new Error('synthetic crash before local convergence');
    };

    await expect(estornarPagamento(rig.deps, { idPagamento })).rejects.toThrow(
      'synthetic crash before local convergence',
    );
    expect(providerCalls).toBe(1);
    expect((await rig.stripeRefundOperationRepository.findByPaymentId(idPagamento))?.state).toBe(
      'provider_succeeded',
    );
    expect((await rig.pagamentoRepository.findById(idPagamento))?.status).toBe('aprovado');
    expect(
      (await rig.livroFinanceiroRepository.findLancamentosByIdPagamento(idPagamento)).every(
        (entry) => entry.canceladoEm === null,
      ),
    ).toBe(true);

    rig.stripeRefundOperationRepository.convergeSuccessful = originalConverge;
    await expect(estornarPagamento(rig.deps, { idPagamento })).resolves.toMatchObject({
      refundStatus: 'aceito',
      pagamento: { status: 'estornado' },
    });
    expect(providerCalls).toBe(1);
    expect((await rig.stripeRefundOperationRepository.findByPaymentId(idPagamento))?.state).toBe(
      'local_committed',
    );
    expect(
      (await rig.livroFinanceiroRepository.findLancamentosByIdPagamento(idPagamento)).every(
        (entry) => entry.canceladoEm !== null,
      ),
    ).toBe(true);
  });

  it('never repeats a provider call after a post-create persistence failure', async () => {
    let providerCalls = 0;
    const provider = new PagamentoProviderFake({ statusRefund: 'aceito' });
    const originalRefund = provider.refundarPagamento.bind(provider);
    provider.refundarPagamento = async (input) => {
      providerCalls += 1;
      return originalRefund(input);
    };
    const rig = buildDeps(provider);
    await seedAprovado(rig);
    const originalRecord = rig.stripeRefundOperationRepository.recordProviderResult.bind(
      rig.stripeRefundOperationRepository,
    );
    rig.stripeRefundOperationRepository.recordProviderResult = async () => {
      throw new Error('synthetic persistence outage after provider return');
    };

    await expect(estornarPagamento(rig.deps, { idPagamento })).rejects.toThrow(
      'synthetic persistence outage',
    );
    rig.stripeRefundOperationRepository.recordProviderResult = originalRecord;
    await expect(estornarPagamento(rig.deps, { idPagamento })).rejects.toBeInstanceOf(
      PagamentoEstornoStripeOutcomeDesconhecidoError,
    );
    expect(providerCalls).toBe(1);
    expect((await rig.stripeRefundOperationRepository.findByPaymentId(idPagamento))?.state).toBe(
      'provider_started',
    );
  });

  it('holds a malformed provider response as unknown and never recreates it', async () => {
    let providerCalls = 0;
    const provider = new PagamentoProviderFake();
    provider.refundarPagamento = async () => {
      providerCalls += 1;
      return {
        id: 're_malformed_1',
        amountCents: 8400,
        currency: 'brl',
      } as never;
    };
    const rig = buildDeps(provider);
    await seedAprovado(rig);

    await expect(estornarPagamento(rig.deps, { idPagamento })).rejects.toBeInstanceOf(
      PagamentoEstornoStripeOutcomeDesconhecidoError,
    );
    await expect(estornarPagamento(rig.deps, { idPagamento })).rejects.toBeInstanceOf(
      PagamentoEstornoStripeOutcomeDesconhecidoError,
    );
    expect(providerCalls).toBe(1);
    expect((await rig.stripeRefundOperationRepository.findByPaymentId(idPagamento))?.state).toBe(
      'outcome_unknown',
    );
  });

  it('keeps a pending provider result nonterminal and payout-blocking without recreating', async () => {
    let providerCalls = 0;
    const provider = new PagamentoProviderFake();
    provider.refundarPagamento = async () => {
      providerCalls += 1;
      return { id: 're_pending_1', status: 'pending', amountCents: 8400, currency: 'brl' };
    };
    const rig = buildDeps(provider);
    await seedAprovado(rig);

    await expect(estornarPagamento(rig.deps, { idPagamento })).resolves.toMatchObject({
      refundId: 're_pending_1',
      refundStatus: 'em_processamento',
      pagamento: { status: 'aprovado' },
    });
    await expect(estornarPagamento(rig.deps, { idPagamento })).resolves.toMatchObject({
      refundStatus: 'em_processamento',
      pagamento: { status: 'aprovado' },
    });

    expect(providerCalls).toBe(1);
    expect((await rig.stripeRefundOperationRepository.findByPaymentId(idPagamento))?.state).toBe(
      'provider_pending',
    );
    expect(rig.moneyMovement.hasBlockingRefund(idPagamento)).toBe(true);
    const entries = await rig.livroFinanceiroRepository.findLancamentosByIdPagamento(idPagamento);
    expect(entries.every((entry) => entry.canceladoEm === null)).toBe(true);

    const operation = await rig.stripeRefundOperationRepository.findByPaymentId(idPagamento);
    if (!operation) throw new Error('pending operation not persisted');
    await expect(
      rig.stripeRefundOperationRepository.recordProviderResult({
        operationId: operation.operationId,
        attemptNo: operation.attemptCount,
        outcome: 'provider_failed',
        providerRef: 're_pending_1',
        providerStatus: 'failed',
        amountCents: operation.amountCents,
        currency: 'brl',
        now: new Date('2026-05-02T16:00:00Z'),
      }),
    ).resolves.toMatchObject({ state: 'provider_pending' });
    expect((await rig.pagamentoRepository.findById(idPagamento))?.status).toBe('aprovado');
  });
});

describe('estornarPagamento — invalid source states', () => {
  it('throws when pagamento is pendente', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
    const pagamentoProvider = new PagamentoProviderFake();
    const pagamentoEventPublisher = new PagamentoEventPublisherMemory();

    const pendente = makePagamento({
      id: idPagamento as never,
      idContribuicao: idContribuicao as never,
      criadoEm: new Date('2026-05-01T12:00:00Z'),
      metodo: 'pix',
    });
    await pagamentoRepository.save(pendente);

    await expect(
      estornarPagamento(
        {
          pagamentoRepository,
          pagamentoProvider,
          ...legacyRefundDeps(pagamentoRepository, livroFinanceiroRepository),
          pagamentoEventPublisher,
          livroFinanceiroRepository,
          clock: () => new Date('2026-05-02T15:00:00Z'),
          observability,
        },
        { idPagamento },
      ),
    ).rejects.toBeInstanceOf(PagamentoTransicaoStatusInvalidaError);
  });

  it('throws PagamentoNaoEncontradoError when the pagamento does not exist', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
    const pagamentoProvider = new PagamentoProviderFake();
    const pagamentoEventPublisher = new PagamentoEventPublisherMemory();

    await expect(
      estornarPagamento(
        {
          pagamentoRepository,
          pagamentoProvider,
          ...legacyRefundDeps(pagamentoRepository, livroFinanceiroRepository),
          pagamentoEventPublisher,
          livroFinanceiroRepository,
          clock: () => new Date('2026-05-02T15:00:00Z'),
          observability,
        },
        { idPagamento },
      ),
    ).rejects.toBeInstanceOf(PagamentoNaoEncontradoError);
  });
});
