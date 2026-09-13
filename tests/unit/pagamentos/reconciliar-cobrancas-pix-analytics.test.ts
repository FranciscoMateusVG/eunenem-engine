/**
 * aperture-4yse9 — PIX approvals recovered by the reconciliation poll (no
 * webhook) used to be invisible to analytics. The use-case exposes an optional
 * `onPagamentoAprovado` port called ONLY with the exact approved pagamento +
 * Inter's `horario` when THIS run performed the transition; the pg-boss job
 * wrapper wires it to THE `pagamento_aprovado` emitter tagged
 * `caminho: 'reconciliacao'`.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ServerAnalytics } from '../../../apps/eunenem-server/server/analytics/server-analytics.js';
import { withReconciliationAnalytics } from '../../../apps/eunenem-server/server/jobs/pix-cobranca-reconciliation.pgboss.js';
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import type {
  ConsultarCobrancaResult,
  PixCobrancaProvider,
} from '../../../src/adapters/pagamentos/pix-cobranca-provider.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { reconciliarCobrancasPix } from '../../../src/use-cases/pagamentos/reconciliar-cobrancas-pix.js';
import { makePagamento } from '../../helpers/pagamento-repository.conformance.js';

const NOW = new Date('2026-08-05T15:00:00.000Z');
const EXPIRY = new Date('2026-08-05T14:50:00.000Z');
const HORARIO = new Date('2026-08-05T14:45:00.000Z');

async function setup(outcome: ConsultarCobrancaResult) {
  const idPagamento = randomUUID();
  const idCampanha = randomUUID();
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const pagamento = makePagamento({
    id: idPagamento as never,
    idCampanha,
    externalRef: idPagamento.replaceAll('-', ''),
    expiraEm: EXPIRY,
    metodo: 'pix',
    criadoEm: new Date('2026-08-05T14:40:00.000Z'),
  });
  await pagamentoRepository.save(pagamento);
  const pixCobrancaProvider = {
    consultarCobranca: vi.fn(async () => outcome),
    criarCobranca: vi.fn(),
    solicitarDevolucao: vi.fn(),
    consultarDevolucao: vi.fn(),
  } as unknown as PixCobrancaProvider;
  const deps = {
    pagamentoRepository,
    pixCobrancaProvider,
    pagamentoEventPublisher: new PagamentoEventPublisherMemory(),
    contribuicaoRepository: {
      findById: vi.fn(async () => ({ id: pagamento.intencao.items[0]?.idContribuicao })),
    } as never,
    campanhaRepository: {
      findById: vi.fn(async () => ({
        id: idCampanha,
        idPlataforma: randomUUID(),
        idsAdministradores: ['conta-dono'],
      })),
    } as never,
    livroFinanceiroRepository: new LivroFinanceiroRepositoryMemory(),
    clock: () => NOW,
    observability: { logger: new NoopLogger(), tracer: noopTracer() },
  };
  return { deps, idPagamento, idCampanha };
}

const CONCLUIDA: ConsultarCobrancaResult = {
  status: 'concluida',
  e2eId: 'E1234567890123456789012345678901',
  valorPagoCents: 8400,
  horario: HORARIO,
};

describe('reconciliarCobrancasPix — onPagamentoAprovado port', () => {
  it('calls the port exactly once with the approved pagamento and the Inter horario', async () => {
    const context = await setup(CONCLUIDA);
    const onPagamentoAprovado = vi.fn();

    const first = await reconciliarCobrancasPix({ ...context.deps, onPagamentoAprovado });
    expect(first).toMatchObject({ approved: 1 });
    expect(onPagamentoAprovado).toHaveBeenCalledTimes(1);
    const fato = onPagamentoAprovado.mock.calls[0]?.[0] as {
      pagamento: { id: string; status: string };
      horario: Date;
    };
    expect(fato.pagamento.id).toBe(context.idPagamento);
    expect(fato.pagamento.status).toBe('aprovado');
    expect(fato.horario).toBe(HORARIO);

    // A second run has nothing to claim — the port is not called again.
    const second = await reconciliarCobrancasPix({ ...context.deps, onPagamentoAprovado });
    expect(second).toMatchObject({ claimed: 0 });
    expect(onPagamentoAprovado).toHaveBeenCalledTimes(1);
  });

  it('a throwing port never fails reconciliation', async () => {
    const context = await setup(CONCLUIDA);
    const onPagamentoAprovado = vi.fn(async () => {
      throw new Error('analytics down');
    });
    const result = await reconciliarCobrancasPix({ ...context.deps, onPagamentoAprovado });
    expect(result).toEqual({ claimed: 1, approved: 1, rejected: 0, deferred: 0, failed: 0 });
  });

  it('is not called on the rejected/expired path', async () => {
    const context = await setup({ status: 'ativa' });
    const onPagamentoAprovado = vi.fn();
    await reconciliarCobrancasPix({ ...context.deps, onPagamentoAprovado });
    expect(onPagamentoAprovado).not.toHaveBeenCalled();
  });
});

describe('withReconciliationAnalytics (pg-boss job wiring)', () => {
  it('emits pagamento_aprovado with caminho=reconciliacao, owner distinct_id, insertKey and horario', async () => {
    const context = await setup(CONCLUIDA);
    const calls: Array<[string, string | null, Record<string, unknown> | undefined, unknown]> = [];
    const serverAnalytics: ServerAnalytics = {
      track: (event, distinctId, props, options) => {
        calls.push([event, distinctId, props, options]);
      },
    };

    const runDeps = withReconciliationAnalytics({ ...context.deps, serverAnalytics });
    await reconciliarCobrancasPix(runDeps);

    expect(calls).toHaveLength(1);
    const [event, distinctId, props, options] = calls[0] as (typeof calls)[number];
    expect(event).toBe('pagamento_aprovado');
    expect(distinctId).toBe('conta-dono');
    expect(props).toMatchObject({
      id_pagamento: context.idPagamento,
      id_campanha: context.idCampanha,
      metodo: 'pix',
      provedor: 'inter',
      caminho: 'reconciliacao',
      valor_centavos: 8400,
    });
    expect(options).toEqual({ insertKey: context.idPagamento, occurredAt: HORARIO });
  });

  it('leaves deps untouched when there is no sink', () => {
    const deps = { campanhaRepository: {} } as never;
    expect(withReconciliationAnalytics(deps)).toBe(deps);
  });
});
