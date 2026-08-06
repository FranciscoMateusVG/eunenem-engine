import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
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

async function setup() {
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
  const pagamento = makePagamento({ id: randomUUID() as never, criadoEm: fixedDate });
  await pagamentoRepository.save(pagamento);
  return {
    pagamento,
    pagamentoRepository,
    pagamentoEventPublisher,
    deps: { pagamentoRepository, pagamentoEventPublisher, clock, observability },
  };
}

describe('provider-free verified payment transitions — CAS', () => {
  it('publishes approval once when concurrent exact deliveries race', async () => {
    const { pagamento, pagamentoEventPublisher, deps } = await setup();
    const authoritative = transacao('aprovado');

    const [first, second] = await Promise.all([
      aprovarPagamentoComTransacaoVerificada(deps, {
        idPagamento: pagamento.id,
        transacao: authoritative,
      }),
      aprovarPagamentoComTransacaoVerificada(deps, {
        idPagamento: pagamento.id,
        transacao: { ...authoritative },
      }),
    ]);

    expect(first).toEqual(second);
    expect(first.status).toBe('aprovado');
    expect(pagamentoEventPublisher.getEventosPublicados().map((event) => event.tipo)).toEqual([
      'payment.approved',
    ]);

    const replay = await aprovarPagamentoComTransacaoVerificada(deps, {
      idPagamento: pagamento.id,
      transacao: { ...authoritative },
    });
    expect(replay).toEqual(first);
    expect(pagamentoEventPublisher.getEventosPublicados()).toHaveLength(1);
  });

  it('fails closed when concurrent approvals carry different transaction identities', async () => {
    const { pagamento, pagamentoEventPublisher, deps } = await setup();

    const results = await Promise.allSettled([
      aprovarPagamentoComTransacaoVerificada(deps, {
        idPagamento: pagamento.id,
        transacao: transacao('aprovado', 'E-FIRST-APPROVAL'),
      }),
      aprovarPagamentoComTransacaoVerificada(deps, {
        idPagamento: pagamento.id,
        transacao: transacao('aprovado', 'E-CONFLICTING-APPROVAL'),
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
