import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import type { TransacaoExterna } from '../../../src/domain/pagamentos/entities/pagamento.js';
import { PagamentosInputInvalidoError } from '../../../src/errors/pagamentos/input-invalido.error.js';
import { PagamentoTransicaoStatusInvalidaError } from '../../../src/errors/pagamentos/transicao-status-invalida.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { aprovarPagamentoComTransacaoVerificada } from '../../../src/use-cases/pagamentos/aprovar-pagamento.js';
import { rejeitarPagamentoComTransacaoVerificada } from '../../../src/use-cases/pagamentos/rejeitar-pagamento.js';
import { makePagamento } from '../../helpers/pagamento-repository.conformance.js';

const fixedDate = new Date('2026-08-05T12:00:00.000Z');
const clock = () => fixedDate;
const observability = { logger: new NoopLogger(), tracer: noopTracer() };

function transacao(
  status: 'aprovado' | 'rejeitado',
  id = 'E1234567890123456789012345678901',
): TransacaoExterna {
  return {
    id,
    provedor: 'inter',
    status,
    amountCents: 8400,
    criadaEm: fixedDate,
  };
}

async function setup(overrides: Parameters<typeof makePagamento>[0] = {}) {
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
  const pagamento = makePagamento({ id: randomUUID() as never, criadoEm: fixedDate, ...overrides });
  await pagamentoRepository.save(pagamento);
  return {
    pagamento,
    pagamentoRepository,
    pagamentoEventPublisher,
    deps: { pagamentoRepository, pagamentoEventPublisher, clock, observability },
  };
}

describe('provider-free verified payment transitions — CAS', () => {
  it('returns and publishes the rejection CAS snapshot with a concurrently stamped contributor', async () => {
    const { pagamento, pagamentoRepository, pagamentoEventPublisher, deps } = await setup({
      contribuinte: null,
    });
    const originalCas = pagamentoRepository.updateIfStatusIn.bind(pagamentoRepository);
    let stampInjected = false;
    pagamentoRepository.updateIfStatusIn = async (...args) => {
      if (!stampInjected) {
        stampInjected = true;
        await pagamentoRepository.setContribuinteIfAbsent(
          pagamento.id,
          { nome: 'Convidada', email: 'payer@example.com' },
          new Date(fixedDate.getTime() - 1),
        );
      }
      return originalCas(...args);
    };

    const rejected = await rejeitarPagamentoComTransacaoVerificada(deps, {
      idPagamento: pagamento.id,
      transacao: transacao('rejeitado'),
    });

    expect(rejected).toMatchObject({
      status: 'rejeitado',
      intencao: { contribuinte: { email: 'payer@example.com' } },
      transacaoExterna: transacao('rejeitado'),
    });
    await expect(pagamentoRepository.findById(pagamento.id)).resolves.toEqual(rejected);
    expect(pagamentoEventPublisher.getEventosPublicados()).toHaveLength(1);
    expect(pagamentoEventPublisher.getEventosPublicados()[0]).toMatchObject({
      tipo: 'payment.rejected',
      status: 'rejeitado',
      idTransacaoExterna: transacao('rejeitado').id,
    });
  });

  it('publishes approval once when concurrent exact deliveries race', async () => {
    const { pagamento, pagamentoEventPublisher, deps } = await setup({
      contribuinte: { nome: 'Convidada', email: 'payer@example.com' },
    });
    const pixReceiptNotifier = vi.fn(async () => undefined);
    const depsWithReceipt = { ...deps, pixReceiptNotifier };
    const authoritative = transacao('aprovado');

    const [first, second] = await Promise.all([
      aprovarPagamentoComTransacaoVerificada(depsWithReceipt, {
        idPagamento: pagamento.id,
        transacao: authoritative,
      }),
      aprovarPagamentoComTransacaoVerificada(depsWithReceipt, {
        idPagamento: pagamento.id,
        transacao: { ...authoritative },
      }),
    ]);

    expect(first).toEqual(second);
    expect(first.status).toBe('aprovado');
    expect(first.intencao.e2eExternalRef).toBe(authoritative.id);
    expect(first.intencao.balanceTransactionAvailableOn).toEqual(fixedDate);
    expect(pagamentoEventPublisher.getEventosPublicados().map((event) => event.tipo)).toEqual([
      'payment.approved',
    ]);
    expect(pixReceiptNotifier).toHaveBeenCalledOnce();

    const replay = await aprovarPagamentoComTransacaoVerificada(depsWithReceipt, {
      idPagamento: pagamento.id,
      transacao: { ...authoritative },
    });
    expect(replay).toEqual(first);
    expect(replay.intencao.balanceTransactionAvailableOn).toEqual(fixedDate);
    expect(pagamentoEventPublisher.getEventosPublicados()).toHaveLength(1);
    expect(pixReceiptNotifier).toHaveBeenCalledOnce();
  });

  it('does not notify a verified non-PIX approval', async () => {
    const { pagamento, deps } = await setup({
      metodo: 'credit_card',
      contribuinte: { nome: 'Convidada', email: 'payer@example.com' },
    });
    const pixReceiptNotifier = vi.fn(async () => undefined);

    await aprovarPagamentoComTransacaoVerificada(
      { ...deps, pixReceiptNotifier },
      {
        idPagamento: pagamento.id,
        transacao: {
          ...transacao('aprovado', 'pi_verified_stripe'),
          provedor: 'stripe',
          amountCents: pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
        },
      },
    );

    expect(pixReceiptNotifier).not.toHaveBeenCalled();
  });

  it('keeps an authoritative PIX approval when receipt delivery fails', async () => {
    const { pagamento, pagamentoRepository, deps } = await setup({
      contribuinte: { nome: 'Convidada', email: 'payer@example.com' },
    });
    const pixReceiptNotifier = vi.fn(async () => {
      throw new Error('smtp unavailable');
    });

    await expect(
      aprovarPagamentoComTransacaoVerificada(
        { ...deps, pixReceiptNotifier },
        { idPagamento: pagamento.id, transacao: transacao('aprovado') },
      ),
    ).resolves.toMatchObject({ status: 'aprovado' });

    expect((await pagamentoRepository.findById(pagamento.id))?.status).toBe('aprovado');
    expect(pixReceiptNotifier).toHaveBeenCalledOnce();
  });

  it('leaves Inter settlement metadata unset for a verified non-Inter transaction', async () => {
    const { pagamento, deps } = await setup();
    const authoritative: TransacaoExterna = {
      ...transacao('aprovado', 'pi_verified_stripe'),
      provedor: 'stripe',
    };

    const approved = await aprovarPagamentoComTransacaoVerificada(deps, {
      idPagamento: pagamento.id,
      transacao: authoritative,
    });

    expect(approved.intencao.e2eExternalRef).toBeNull();
    expect(approved.intencao.balanceTransactionAvailableOn).toBeNull();
  });

  it('preserves an existing Inter availability timestamp on verified approval', async () => {
    const existingAvailableOn = new Date('2026-08-04T09:30:00.000Z');
    const { pagamento, deps } = await setup({
      balanceTransactionAvailableOn: existingAvailableOn,
    });

    const approved = await aprovarPagamentoComTransacaoVerificada(deps, {
      idPagamento: pagamento.id,
      transacao: transacao('aprovado'),
    });

    expect(approved.intencao.balanceTransactionAvailableOn).toEqual(existingAvailableOn);
  });

  it('rejects a malformed authoritative Inter e2e reference before persistence', async () => {
    const { pagamento, pagamentoRepository, deps } = await setup();

    await expect(
      aprovarPagamentoComTransacaoVerificada(deps, {
        idPagamento: pagamento.id,
        transacao: transacao('aprovado', 'not-an-inter-e2e'),
      }),
    ).rejects.toBeInstanceOf(PagamentosInputInvalidoError);

    expect((await pagamentoRepository.findById(pagamento.id))?.status).toBe('pendente');
  });

  it('fails closed when concurrent approvals carry different transaction identities', async () => {
    const { pagamento, pagamentoEventPublisher, deps } = await setup();

    const results = await Promise.allSettled([
      aprovarPagamentoComTransacaoVerificada(deps, {
        idPagamento: pagamento.id,
        transacao: transacao('aprovado', 'A'.repeat(32)),
      }),
      aprovarPagamentoComTransacaoVerificada(deps, {
        idPagamento: pagamento.id,
        transacao: transacao('aprovado', 'B'.repeat(32)),
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(PagamentosInputInvalidoError) });
    expect(pagamentoEventPublisher.getEventosPublicados()).toHaveLength(1);
  });

  it('publishes rejection once when concurrent exact deliveries race', async () => {
    const { pagamento, pagamentoEventPublisher, deps } = await setup();
    const authoritative = transacao('rejeitado');

    const [first, second] = await Promise.all([
      rejeitarPagamentoComTransacaoVerificada(deps, {
        idPagamento: pagamento.id,
        transacao: authoritative,
      }),
      rejeitarPagamentoComTransacaoVerificada(deps, {
        idPagamento: pagamento.id,
        transacao: { ...authoritative },
      }),
    ]);

    expect(first).toEqual(second);
    expect(first.status).toBe('rejeitado');
    expect(pagamentoEventPublisher.getEventosPublicados().map((event) => event.tipo)).toEqual([
      'payment.rejected',
    ]);

    const replay = await rejeitarPagamentoComTransacaoVerificada(deps, {
      idPagamento: pagamento.id,
      transacao: { ...authoritative },
    });
    expect(replay).toEqual(first);
    expect(pagamentoEventPublisher.getEventosPublicados()).toHaveLength(1);
  });

  it('fails closed when concurrent rejections carry different transaction identities', async () => {
    const { pagamento, pagamentoEventPublisher, deps } = await setup();

    const results = await Promise.allSettled([
      rejeitarPagamentoComTransacaoVerificada(deps, {
        idPagamento: pagamento.id,
        transacao: transacao('rejeitado', 'E-FIRST-REJECTION'),
      }),
      rejeitarPagamentoComTransacaoVerificada(deps, {
        idPagamento: pagamento.id,
        transacao: transacao('rejeitado', 'E-CONFLICTING-REJECTION'),
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(PagamentosInputInvalidoError) });
    expect(pagamentoEventPublisher.getEventosPublicados()).toHaveLength(1);
  });

  it('rejects terminal cross-transition conflicts without a second publication', async () => {
    const { pagamento, pagamentoEventPublisher, deps } = await setup();

    await aprovarPagamentoComTransacaoVerificada(deps, {
      idPagamento: pagamento.id,
      transacao: transacao('aprovado'),
    });

    await expect(
      rejeitarPagamentoComTransacaoVerificada(deps, {
        idPagamento: pagamento.id,
        transacao: transacao('rejeitado'),
      }),
    ).rejects.toThrow(PagamentoTransicaoStatusInvalidaError);
    expect(pagamentoEventPublisher.getEventosPublicados().map((event) => event.tipo)).toEqual([
      'payment.approved',
    ]);
  });

  it('validates rejected provider status and amount before the CAS', async () => {
    const { pagamento, pagamentoRepository, pagamentoEventPublisher, deps } = await setup();

    await expect(
      rejeitarPagamentoComTransacaoVerificada(deps, {
        idPagamento: pagamento.id,
        transacao: transacao('aprovado'),
      }),
    ).rejects.toThrow(PagamentoTransicaoStatusInvalidaError);
    await expect(
      rejeitarPagamentoComTransacaoVerificada(deps, {
        idPagamento: pagamento.id,
        transacao: { ...transacao('rejeitado'), amountCents: 8399 },
      }),
    ).rejects.toThrow('Valor do pagamento divergente');

    await expect(pagamentoRepository.findById(pagamento.id)).resolves.toMatchObject({
      status: 'pendente',
    });
    expect(pagamentoEventPublisher.getEventosPublicados()).toEqual([]);
  });
});
