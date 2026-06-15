import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import { PagamentoProviderFake } from '../../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import {
  criarItemContribuicao,
  type ItemDoPagamento,
} from '../../../src/domain/pagamentos/entities/item-do-pagamento.js';
import { PagamentosInputInvalidoError } from '../../../src/errors/pagamentos/input-invalido.error.js';
import { PagamentoNaoEncontradoError } from '../../../src/errors/pagamentos/nao-encontrado.error.js';
import { PagamentoTransicaoStatusInvalidaError } from '../../../src/errors/pagamentos/transicao-status-invalida.error.js';
import { PagamentoValorDivergenteError } from '../../../src/errors/pagamentos/valor-divergente.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { aprovarPagamento } from '../../../src/use-cases/pagamentos/aprovar-pagamento.js';
import type { CriarIntencaoPagamentoInput } from '../../../src/use-cases/pagamentos/criar-intencao-pagamento.js';
import { criarIntencaoPagamento } from '../../../src/use-cases/pagamentos/criar-intencao-pagamento.js';
import { obterPagamentoPorId } from '../../../src/use-cases/pagamentos/obter-pagamento-por-id.js';
import { rejeitarPagamento } from '../../../src/use-cases/pagamentos/rejeitar-pagamento.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

const idPagamento = '550e8400-e29b-41d4-a716-446655440501';
const idIntencaoPagamento = '550e8400-e29b-41d4-a716-446655440502';
const idContribuicao = '550e8400-e29b-41d4-a716-446655440503';
const idCampanha = '550e8400-e29b-41d4-a716-446655440505';
const idTransacaoExterna = '550e8400-e29b-41d4-a716-446655440504';

/**
 * Plan 0016 Phase 2 (aperture-eg1s2): the use-case now takes a multi-item
 * cart input — `items` + `composicaoValoresAggregate` — instead of the
 * pre-0016 flat `composicaoValores` snapshot. Default fixture is a single
 * contribuição line at R$80 + R$4 fee = R$84, matching the original test
 * shape exactly so the assertions still hold.
 */
function makeCriarIntencaoPagamentoInput(
  overrides: Partial<CriarIntencaoPagamentoInput> = {},
): CriarIntencaoPagamentoInput {
  const contributionItem: ItemDoPagamento = criarItemContribuicao({
    id: randomUUID() as never,
    composicaoValoresItem: {
      tipo: 'contribuicao',
      idContribuicao: idContribuicao as never,
      quantidade: 1,
      contributionUnitAmountCents: 8000 as never,
      feeUnitAmountCents: 400 as never,
      receiverUnitAmountCents: 8000 as never,
      lineContributionAmountCents: 8000 as never,
      lineFeeAmountCents: 400 as never,
      lineReceiverAmountCents: 8000 as never,
    },
    criadoEm: fixedDate,
  });
  return {
    idPagamento,
    idIntencaoPagamento,
    items: [contributionItem],
    composicaoValoresAggregate: {
      idCampanha: idCampanha as never,
      totalContributionCents: 8000 as never,
      totalFeeCents: 400 as never,
      totalReceiverCents: 8000 as never,
      totalSurchargeCents: 0,
      totalPaidCents: 8400 as never,
      responsavelTaxa: 'contribuinte',
    },
    valorACobrarCents: 8400,
    metodo: 'pix',
    ...overrides,
  };
}

describe('payment use cases', () => {
  it('creates and approves the canonical R$ 80 + R$ 4 payment flow', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
    const pagamentoProvider = new PagamentoProviderFake({
      idTransacaoFactory: () => idTransacaoExterna,
      clock,
    });

    const created = await criarIntencaoPagamento(
      { pagamentoRepository, pagamentoEventPublisher, clock, observability: silentObservability },
      makeCriarIntencaoPagamentoInput(),
    );

    expect(created.status).toBe('pendente');
    expect(created.intencao.composicaoValoresAggregate.totalPaidCents).toBe(8400);

    const approved = await aprovarPagamento(
      {
        pagamentoRepository,
        pagamentoProvider,
        pagamentoEventPublisher,
        clock,
        observability: silentObservability,
      },
      { idPagamento },
    );
    const loaded = await obterPagamentoPorId(
      { pagamentoRepository, observability: silentObservability },
      { idPagamento },
    );

    expect(approved.status).toBe('aprovado');
    expect(approved.transacaoExterna?.id).toBe(idTransacaoExterna);
    expect(loaded?.status).toBe('aprovado');
    expect(pagamentoEventPublisher.getEventosPublicados().map((event) => event.tipo)).toEqual([
      'payment.intent_created',
      'payment.approved',
    ]);
  });

  it('creates and rejects a payment from provider response', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
    const pagamentoProvider = new PagamentoProviderFake({
      statusResultado: 'rejeitado',
      idTransacaoFactory: () => idTransacaoExterna,
      clock,
    });

    await criarIntencaoPagamento(
      { pagamentoRepository, pagamentoEventPublisher, clock, observability: silentObservability },
      makeCriarIntencaoPagamentoInput(),
    );

    const rejected = await rejeitarPagamento(
      {
        pagamentoRepository,
        pagamentoProvider,
        pagamentoEventPublisher,
        clock,
        observability: silentObservability,
      },
      { idPagamento },
    );

    expect(rejected.status).toBe('rejeitado');
    expect(rejected.transacaoExterna?.status).toBe('rejeitado');
    expect(pagamentoEventPublisher.getEventosPublicados().map((event) => event.tipo)).toEqual([
      'payment.intent_created',
      'payment.rejected',
    ]);
  });

  it('does not create an intent when the charge amount differs from totalPaidCents', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const pagamentoEventPublisher = new PagamentoEventPublisherMemory();

    await expect(
      criarIntencaoPagamento(
        { pagamentoRepository, pagamentoEventPublisher, clock, observability: silentObservability },
        makeCriarIntencaoPagamentoInput({ valorACobrarCents: 8300 }),
      ),
    ).rejects.toThrow(PagamentoValorDivergenteError);
  });

  it('does not approve when the provider returns a different amount', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
    const pagamentoProvider = new PagamentoProviderFake({
      idTransacaoFactory: () => idTransacaoExterna,
      amountCentsTransacao: 8500,
      clock,
    });

    await criarIntencaoPagamento(
      { pagamentoRepository, pagamentoEventPublisher, clock, observability: silentObservability },
      makeCriarIntencaoPagamentoInput(),
    );

    await expect(
      aprovarPagamento(
        {
          pagamentoRepository,
          pagamentoProvider,
          pagamentoEventPublisher,
          clock,
          observability: silentObservability,
        },
        { idPagamento },
      ),
    ).rejects.toThrow(PagamentoValorDivergenteError);
  });

  it('does not approve a rejected payment', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
    const rejectedProvider = new PagamentoProviderFake({
      statusResultado: 'rejeitado',
      idTransacaoFactory: () => idTransacaoExterna,
      clock,
    });
    const approvedProvider = new PagamentoProviderFake({
      idTransacaoFactory: () => idTransacaoExterna,
      clock,
    });

    await criarIntencaoPagamento(
      { pagamentoRepository, pagamentoEventPublisher, clock, observability: silentObservability },
      makeCriarIntencaoPagamentoInput(),
    );
    await rejeitarPagamento(
      {
        pagamentoRepository,
        pagamentoProvider: rejectedProvider,
        pagamentoEventPublisher,
        clock,
        observability: silentObservability,
      },
      { idPagamento },
    );

    await expect(
      aprovarPagamento(
        {
          pagamentoRepository,
          pagamentoProvider: approvedProvider,
          pagamentoEventPublisher,
          clock,
          observability: silentObservability,
        },
        { idPagamento },
      ),
    ).rejects.toThrow(PagamentoTransicaoStatusInvalidaError);
  });

  it('does not reject an approved payment', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
    const approvedProvider = new PagamentoProviderFake({
      idTransacaoFactory: () => idTransacaoExterna,
      clock,
    });
    const rejectedProvider = new PagamentoProviderFake({
      statusResultado: 'rejeitado',
      idTransacaoFactory: () => idTransacaoExterna,
      clock,
    });

    await criarIntencaoPagamento(
      { pagamentoRepository, pagamentoEventPublisher, clock, observability: silentObservability },
      makeCriarIntencaoPagamentoInput(),
    );
    await aprovarPagamento(
      {
        pagamentoRepository,
        pagamentoProvider: approvedProvider,
        pagamentoEventPublisher,
        clock,
        observability: silentObservability,
      },
      { idPagamento },
    );

    await expect(
      rejeitarPagamento(
        {
          pagamentoRepository,
          pagamentoProvider: rejectedProvider,
          pagamentoEventPublisher,
          clock,
          observability: silentObservability,
        },
        { idPagamento },
      ),
    ).rejects.toThrow(PagamentoTransicaoStatusInvalidaError);
  });

  it('throws PagamentoNaoEncontradoError when approving a missing payment', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
    const pagamentoProvider = new PagamentoProviderFake({
      idTransacaoFactory: () => idTransacaoExterna,
      clock,
    });

    await expect(
      aprovarPagamento(
        {
          pagamentoRepository,
          pagamentoProvider,
          pagamentoEventPublisher,
          clock,
          observability: silentObservability,
        },
        { idPagamento },
      ),
    ).rejects.toThrow(PagamentoNaoEncontradoError);
  });

  it('throws PagamentosInputInvalidoError when querying an invalid payment id', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();

    await expect(
      obterPagamentoPorId(
        { pagamentoRepository, observability: silentObservability },
        { idPagamento: 'not-a-uuid' },
      ),
    ).rejects.toThrow(PagamentosInputInvalidoError);
  });
});
