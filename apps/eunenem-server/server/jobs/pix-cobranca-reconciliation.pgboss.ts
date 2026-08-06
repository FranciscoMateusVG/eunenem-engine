import type { PgBoss } from 'pg-boss';
import {
  type ReconciliarCobrancasPixDeps,
  reconciliarCobrancasPix,
} from '../../../../src/use-cases/pagamentos/reconciliar-cobrancas-pix.js';

/**
 * The queue name is also pg-boss's schedule key. `schedule()` upserts by this
 * stable name, so repeated process boots cannot create duplicate cron rows.
 */
export const PIX_COBRANCA_RECONCILIATION_QUEUE = 'pix-cobranca-reconciliation-v1';
export const PIX_COBRANCA_RECONCILIATION_CRON = '*/5 * * * *';

export interface PixCobrancaReconciliationJobData {
  readonly schemaVersion: 1;
}

const JOB_OPTIONS = {
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  // Less than the five-minute cadence. Provider reads have their own shorter
  // timeout; this is the final guard against a hung worker process.
  expireInSeconds: 240,
} as const;

type ReconciliationBoss = Pick<PgBoss, 'createQueue' | 'schedule' | 'work'>;

/**
 * Registers the bounded five-minute reconciliation worker and its singleton
 * cron schedule. The composition root awaits this before starting HTTP.
 */
export async function registerPixCobrancaReconciliationJob(
  boss: ReconciliationBoss,
  deps: ReconciliarCobrancasPixDeps,
): Promise<void> {
  await boss.createQueue(PIX_COBRANCA_RECONCILIATION_QUEUE);
  await boss.work<PixCobrancaReconciliationJobData>(
    PIX_COBRANCA_RECONCILIATION_QUEUE,
    { batchSize: 1 },
    async (jobs) => {
      for (const _job of jobs) {
        await reconciliarCobrancasPix(deps);
      }
    },
  );
  await boss.schedule(
    PIX_COBRANCA_RECONCILIATION_QUEUE,
    PIX_COBRANCA_RECONCILIATION_CRON,
    { schemaVersion: 1 },
    JOB_OPTIONS,
  );
}
