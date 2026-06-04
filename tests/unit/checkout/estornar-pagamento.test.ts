import { describe, expect, it } from 'vitest';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import { PagamentoProviderFake } from '../../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import type { LancamentoFinanceiro } from '../../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import {
  aprovarPagamentoPendente,
  criarPagamentoPendente,
  type Pagamento,
} from '../../../src/domain/pagamentos/entities/pagamento.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import {
  estornarPagamento,
  PagamentoEstornoLancamentoJaTransferidoError,
  PagamentoEstornoRecusadoPeloProvedorError,
} from '../../../src/use-cases/checkout/estornar-pagamento.js';
import { PagamentoTransicaoStatusInvalidaError } from '../../../src/errors/pagamentos/transicao-status-invalida.error.js';
import { PagamentoNaoEncontradoError } from '../../../src/errors/pagamentos/nao-encontrado.error.js';

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
const idTransacaoExterna = '550e8400-e29b-41d4-a716-446655440306';

const observability = { logger: new NoopLogger(), tracer: noopTracer() };

const composicaoValores = {
  idContribuicao,
  contributionAmountCents: 8000,
  feeAmountCents: 400,
  totalPaidCents: 8400,
  receiverAmountCents: 8000,
  responsavelTaxa: 'contribuinte' as const,
};

async function seedAprovado(deps: {
  pagamentoRepository: PagamentoRepositoryMemory;
  livroFinanceiroRepository: LivroFinanceiroRepositoryMemory;
}): Promise<{ pagamento: Pagamento; lancamentos: LancamentoFinanceiro[] }> {
  const pendente = criarPagamentoPendente({
    idPagamento,
    idIntencaoPagamento,
    composicaoValores,
    valorACobrarCents: 8400,
    metodo: 'pix',
    criadoEm: new Date('2026-05-01T12:00:00Z'),
  });
  await deps.pagamentoRepository.save(pendente);
  // Approve via the entity transition.
  const aprovado = aprovarPagamentoPendente(
    pendente,
    {
      id: idTransacaoExterna,
      provedor: 'fake-provider',
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
    });

    const result = await estornarPagamento(
      {
        pagamentoRepository,
        pagamentoProvider,
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
          pagamentoEventPublisher,
          livroFinanceiroRepository,
          clock: () => new Date('2026-05-02T15:00:00Z'),
          observability,
        },
        { idPagamento },
      ),
    ).rejects.toBeInstanceOf(PagamentoEstornoLancamentoJaTransferidoError);

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
        pagamentoEventPublisher,
        livroFinanceiroRepository,
        clock: () => new Date('2026-05-02T16:00:00Z'),
        observability,
      },
      { idPagamento },
    );
    expect(providerCalls).toBe(1);
    expect(replay.pagamento.status).toBe('estornado');
    expect(replay.refundId).toBe('replay');
  });
});

describe('estornarPagamento — invalid source states', () => {
  it('throws when pagamento is pendente', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
    const pagamentoProvider = new PagamentoProviderFake();
    const pagamentoEventPublisher = new PagamentoEventPublisherMemory();

    const pendente = criarPagamentoPendente({
      idPagamento,
      idIntencaoPagamento,
      composicaoValores,
      valorACobrarCents: 8400,
      metodo: 'pix',
      criadoEm: new Date('2026-05-01T12:00:00Z'),
    });
    await pagamentoRepository.save(pendente);

    await expect(
      estornarPagamento(
        {
          pagamentoRepository,
          pagamentoProvider,
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
