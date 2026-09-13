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

// Lifecycle boundary only: queue/schedule/effect policies remain unchanged.
describe('reconciliation startup/drain admission', () => {
  it('does not register a worker or schedule after a startup checkpoint closes', async () => {
    let open = true;
    const boss = {
      createQueue: vi.fn(async () => {
        open = false;
      }),
      work: vi.fn(async () => 'worker-id'),
      schedule: vi.fn(async () => undefined),
    };
    const lifecycle = {
      assertAdmissionOpen: () => {
        if (!open) throw new Error('server_admission_closed');
      },
      runJob: <T>(operation: () => Promise<T>) => operation(),
    };
    await expect(
      registerPixCobrancaReconciliationJob(boss as never, reconciliationDeps(), lifecycle),
    ).rejects.toThrow('server_admission_closed');
    expect(boss.work).not.toHaveBeenCalled();
    expect(boss.schedule).not.toHaveBeenCalled();
  });

  it('passes the existing callback through lifecycle tracking; late callbacks cannot start effects', async () => {
    let handler: ((jobs: readonly unknown[]) => Promise<void>) | undefined;
    const boss = {
      createQueue: vi.fn(async () => undefined),
      work: vi.fn(async (_name, _options, registered) => {
        handler = registered;
        return 'worker-id';
      }),
      schedule: vi.fn(async () => undefined),
    };
    let open = true;
    const runJob = vi.fn(async <T>(operation: () => Promise<T>) => {
      if (!open) throw new Error('server_admission_closed');
      return operation();
    });
    const deps = reconciliationDeps();
    await registerPixCobrancaReconciliationJob(boss as never, deps, {
      assertAdmissionOpen: () => {},
      runJob,
    });
    await handler?.([{ data: { schemaVersion: 1 } }]);
    expect(runJob).toHaveBeenCalledOnce();
    expect(
      deps.pagamentoRepository.claimPixCobrancaReconciliationCandidates,
    ).toHaveBeenCalledOnce();
    open = false;
    await expect(handler?.([{ data: { schemaVersion: 1 } }])).rejects.toThrow(
      'server_admission_closed',
    );
    expect(
      deps.pagamentoRepository.claimPixCobrancaReconciliationCandidates,
    ).toHaveBeenCalledOnce();
  });
});
