import { describe, expect, it, vi } from 'vitest';
import {
  PIX_COBRANCA_RECONCILIATION_CRON,
  PIX_COBRANCA_RECONCILIATION_QUEUE,
  registerPixCobrancaReconciliationJob,
} from '../../../apps/eunenem-server/server/jobs/pix-cobranca-reconciliation.pgboss.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';

function reconciliationDeps() {
  return {
    pagamentoRepository: {
      claimPixCobrancaReconciliationCandidates: vi.fn(async () => []),
      releasePixCobrancaReconciliationClaim: vi.fn(async () => true),
    },
    pixCobrancaProvider: {},
    pagamentoEventPublisher: {},
    contribuicaoRepository: {},
    campanhaRepository: {},
    livroFinanceiroRepository: {},
    clock: () => new Date('2026-08-05T15:00:00.000Z'),
    observability: { logger: new NoopLogger(), tracer: noopTracer() },
  } as never;
}

describe('PIX cobranca reconciliation pg-boss registration', () => {
  it('creates one stable queue, registers the worker, and upserts the five-minute schedule', async () => {
    let handler: ((jobs: readonly unknown[]) => Promise<void>) | undefined;
    const createQueue = vi.fn(async () => undefined);
    const work = vi.fn(async (_name, _options, registered) => {
      handler = registered;
      return 'worker-id';
    });
    const schedule = vi.fn(async () => undefined);
    const deps = reconciliationDeps();

    await registerPixCobrancaReconciliationJob({ createQueue, work, schedule } as never, deps);

    expect(createQueue).toHaveBeenCalledWith(PIX_COBRANCA_RECONCILIATION_QUEUE);
    expect(work).toHaveBeenCalledWith(
      PIX_COBRANCA_RECONCILIATION_QUEUE,
      { batchSize: 1 },
      expect.any(Function),
    );
    expect(schedule).toHaveBeenCalledWith(
      PIX_COBRANCA_RECONCILIATION_QUEUE,
      PIX_COBRANCA_RECONCILIATION_CRON,
      { schemaVersion: 1 },
      {
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        expireInSeconds: 240,
      },
    );

    await handler?.([{ data: { schemaVersion: 1 } }]);
    expect(
      deps.pagamentoRepository.claimPixCobrancaReconciliationCandidates,
    ).toHaveBeenCalledOnce();
  });

  it('uses the same schedule key on repeated bootstrap instead of inventing duplicate names', async () => {
    const boss = {
      createQueue: vi.fn(async () => undefined),
      work: vi.fn(async () => 'worker-id'),
      schedule: vi.fn(async () => undefined),
    };

    await registerPixCobrancaReconciliationJob(boss as never, reconciliationDeps());
    await registerPixCobrancaReconciliationJob(boss as never, reconciliationDeps());

    expect(boss.schedule).toHaveBeenCalledTimes(2);
    expect(boss.schedule.mock.calls.map((call) => call[0])).toEqual([
      PIX_COBRANCA_RECONCILIATION_QUEUE,
      PIX_COBRANCA_RECONCILIATION_QUEUE,
    ]);
  });
});
