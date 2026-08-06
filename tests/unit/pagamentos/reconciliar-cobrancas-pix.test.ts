import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import type {
  ConsultarCobrancaResult,
  PixCobrancaProvider,
} from '../../../src/adapters/pagamentos/pix-cobranca-provider.js';
import { PixCobrancaTransitoriaError } from '../../../src/adapters/pagamentos/pix-cobranca-provider.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import type { Logger } from '../../../src/observability/logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import {
  PIX_COBRANCA_RECONCILIATION_LEASE_MS,
  reconciliarCobrancasPix,
} from '../../../src/use-cases/pagamentos/reconciliar-cobrancas-pix.js';
import { makePagamento } from '../../helpers/pagamento-repository.conformance.js';

const NOW = new Date('2026-08-05T15:00:00.000Z');
const EXPIRY = new Date('2026-08-05T14:50:00.000Z');

class RecordingLogger implements Logger {
  readonly records: Array<{ level: string; message: string; attrs?: Record<string, unknown> }> = [];
  info(message: string, attrs?: Record<string, unknown>): void {
    this.records.push({ level: 'info', message, attrs });
  }
  warn(message: string, attrs?: Record<string, unknown>): void {
    this.records.push({ level: 'warn', message, attrs });
  }
  error(message: string, attrs?: Record<string, unknown>): void {
    this.records.push({ level: 'error', message, attrs });
  }
  debug(message: string, attrs?: Record<string, unknown>): void {
    this.records.push({ level: 'debug', message, attrs });
  }
}

async function setup(outcome: ConsultarCobrancaResult | Error) {
  const idPagamento = randomUUID();
  const idCampanha = randomUUID();
  const idPlataforma = randomUUID();
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
  const logger = new RecordingLogger();
  const pagamento = makePagamento({
    id: idPagamento as never,
    idCampanha,
    externalRef: idPagamento.replaceAll('-', ''),
    expiraEm: EXPIRY,
    metodo: 'pix',
    criadoEm: new Date('2026-08-05T14:40:00.000Z'),
  });
  await pagamentoRepository.save(pagamento);

  const consultarCobranca = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const pixCobrancaProvider = {
    consultarCobranca,
    criarCobranca: vi.fn(),
    solicitarDevolucao: vi.fn(),
    consultarDevolucao: vi.fn(),
  } as unknown as PixCobrancaProvider;
  const deps = {
    pagamentoRepository,
    pixCobrancaProvider,
    pagamentoEventPublisher,
    // The verified approval finalizer only needs these read projections. The
    // poller itself must not invent or mutate campaign/contribution state.
    contribuicaoRepository: {
      findById: vi.fn(async () => ({ id: pagamento.intencao.items[0]?.idContribuicao })),
    } as never,
    campanhaRepository: {
      findById: vi.fn(async () => ({ id: idCampanha, idPlataforma })),
    } as never,
    livroFinanceiroRepository,
    clock: () => NOW,
    observability: { logger, tracer: noopTracer() },
  };

  return {
    deps,
    idPagamento,
    pagamentoRepository,
    pagamentoEventPublisher,
    livroFinanceiroRepository,
    consultarCobranca,
    logger,
  };
}

describe('reconciliarCobrancasPix', () => {
  it('expires a due charge without any webhook and releases its lease', async () => {
    const context = await setup({ status: 'ativa' });

    const first = await reconciliarCobrancasPix(context.deps);

    expect(first).toEqual({ claimed: 1, approved: 0, rejected: 1, deferred: 0, failed: 0 });
    expect(context.consultarCobranca).toHaveBeenCalledOnce();
    expect(await context.pagamentoRepository.findById(context.idPagamento)).toMatchObject({
      status: 'rejeitado',
      transacaoExterna: {
        id: context.idPagamento.replaceAll('-', ''),
        provedor: 'inter',
        status: 'rejeitado',
        amountCents: 8400,
        statusBruto: 'ATIVA_EXPIRADA',
      },
    });
    expect(
      context.pagamentoEventPublisher.getEventosPublicados().map((event) => event.tipo),
    ).toEqual(['payment.rejected']);
    expect(
      await context.livroFinanceiroRepository.findLancamentosByIdPagamento(context.idPagamento),
    ).toEqual([]);

    // A terminal payment is no longer claimable. This also proves the first
    // worker did not leave a live lease that masks a bad selector.
    await expect(reconciliarCobrancasPix(context.deps)).resolves.toMatchObject({ claimed: 0 });
    expect(context.consultarCobranca).toHaveBeenCalledOnce();
  });

  it('recovers a concluded charge with no webhook and records Financeiro once', async () => {
    const horario = new Date('2026-08-05T14:45:00.000Z');
    const context = await setup({
      status: 'concluida',
      e2eId: 'E1234567890123456789012345678901',
      valorPagoCents: 8400,
      horario,
    });

    const first = await reconciliarCobrancasPix(context.deps);

    expect(first).toEqual({ claimed: 1, approved: 1, rejected: 0, deferred: 0, failed: 0 });
    expect(await context.pagamentoRepository.findById(context.idPagamento)).toMatchObject({
      status: 'aprovado',
      transacaoExterna: {
        id: 'E1234567890123456789012345678901',
        provedor: 'inter',
        status: 'aprovado',
        amountCents: 8400,
        criadaEm: horario,
      },
    });
    expect(
      context.pagamentoEventPublisher.getEventosPublicados().map((event) => event.tipo),
    ).toEqual(['payment.approved']);
    expect(
      await context.livroFinanceiroRepository.findLancamentosByIdPagamento(context.idPagamento),
    ).toHaveLength(2);

    await expect(reconciliarCobrancasPix(context.deps)).resolves.toMatchObject({ claimed: 0 });
    expect(context.consultarCobranca).toHaveBeenCalledOnce();
  });

  it('treats an authoritative removed charge as terminal rejection', async () => {
    const context = await setup({ status: 'removida' });

    await expect(reconciliarCobrancasPix(context.deps)).resolves.toEqual({
      claimed: 1,
      approved: 0,
      rejected: 1,
      deferred: 0,
      failed: 0,
    });
    expect(await context.pagamentoRepository.findById(context.idPagamento)).toMatchObject({
      status: 'rejeitado',
      transacaoExterna: { statusBruto: 'REMOVIDA' },
    });
  });

  it('defers an unknown provider state without transitioning and releases for a later run', async () => {
    const context = await setup({ status: 'desconhecido', statusBruto: 'SENTINEL-PII' });
    const release = vi.spyOn(context.pagamentoRepository, 'releasePixCobrancaReconciliationClaim');

    await expect(reconciliarCobrancasPix(context.deps)).resolves.toEqual({
      claimed: 1,
      approved: 0,
      rejected: 0,
      deferred: 1,
      failed: 0,
    });
    expect(await context.pagamentoRepository.findById(context.idPagamento)).toMatchObject({
      status: 'pendente',
    });

    // Exact-lease release makes the still-pending row immediately claimable.
    await expect(reconciliarCobrancasPix(context.deps)).resolves.toMatchObject({ claimed: 1 });
    expect(context.consultarCobranca).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenNthCalledWith(
      1,
      context.idPagamento,
      new Date(NOW.getTime() + PIX_COBRANCA_RECONCILIATION_LEASE_MS),
    );
    expect(JSON.stringify(context.logger.records)).not.toContain('SENTINEL-PII');
  });

  it('contains a transient provider failure, keeps state retryable, and does not log its payload', async () => {
    const context = await setup(
      new PixCobrancaTransitoriaError('SENTINEL-PII provider response must not be logged'),
    );

    await expect(reconciliarCobrancasPix(context.deps)).resolves.toEqual({
      claimed: 1,
      approved: 0,
      rejected: 0,
      deferred: 0,
      failed: 1,
    });
    expect(await context.pagamentoRepository.findById(context.idPagamento)).toMatchObject({
      status: 'pendente',
    });
    await expect(reconciliarCobrancasPix(context.deps)).resolves.toMatchObject({ claimed: 1 });
    expect(JSON.stringify(context.logger.records)).not.toContain('SENTINEL-PII');
    expect(context.logger.records).toContainEqual(
      expect.objectContaining({
        message: 'pix_cobranca.reconciliation.failed',
        attrs: expect.objectContaining({ reason: 'provider_transient' }),
      }),
    );
  });

  it('fails a concluded amount mismatch closed, releases the lease, and publishes nothing', async () => {
    const context = await setup({
      status: 'concluida',
      e2eId: 'E-MISMATCH',
      valorPagoCents: 8399,
      horario: NOW,
    });

    await expect(reconciliarCobrancasPix(context.deps)).resolves.toEqual({
      claimed: 1,
      approved: 0,
      rejected: 0,
      deferred: 0,
      failed: 1,
    });
    expect(await context.pagamentoRepository.findById(context.idPagamento)).toMatchObject({
      status: 'pendente',
    });
    expect(context.pagamentoEventPublisher.getEventosPublicados()).toEqual([]);

    await expect(reconciliarCobrancasPix(context.deps)).resolves.toMatchObject({ claimed: 1 });
    expect(context.consultarCobranca).toHaveBeenCalledTimes(2);
  });

  it('allows only one overlapping worker to claim and requery the same due payment', async () => {
    const context = await setup({
      status: 'concluida',
      e2eId: 'E2234567890123456789012345678901',
      valorPagoCents: 8400,
      horario: NOW,
    });

    const [first, second] = await Promise.all([
      reconciliarCobrancasPix(context.deps),
      reconciliarCobrancasPix(context.deps),
    ]);

    expect([first.claimed, second.claimed].sort()).toEqual([0, 1]);
    expect(context.consultarCobranca).toHaveBeenCalledOnce();
    expect(
      context.pagamentoEventPublisher.getEventosPublicados().map((event) => event.tipo),
    ).toEqual(['payment.approved']);
    expect(await context.pagamentoRepository.findById(context.idPagamento)).toMatchObject({
      status: 'aprovado',
      transacaoExterna: { id: 'E2234567890123456789012345678901' },
    });
  });
});
