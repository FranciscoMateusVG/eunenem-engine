import type { PgBoss } from 'pg-boss';
import type { ProviderFeeSync } from '../../../../src/use-cases/pagamentos/provider-fee-sync.js';
export const PROVIDER_FEES_QUEUE = 'provider-processing-fees-v1';
/** Own queue: failures never delay payment confirmation or touch a payout. */
export async function registerProviderFeesJob(
  boss: Pick<PgBoss, 'createQueue' | 'work' | 'schedule'>,
  service: ProviderFeeSync,
  lifecycle: { assertAdmissionOpen: () => void; runJob: <T>(operation: () => Promise<T>) => Promise<T> },
): Promise<void> {
  lifecycle.assertAdmissionOpen();
  await boss.createQueue(PROVIDER_FEES_QUEUE);
  lifecycle.assertAdmissionOpen();
  await boss.work(PROVIDER_FEES_QUEUE, { batchSize: 1 }, () =>
    lifecycle.runJob(async () => { await service.run(); }),
  );
  lifecycle.assertAdmissionOpen();
  await boss.schedule(PROVIDER_FEES_QUEUE, '*/5 * * * *', { schemaVersion: 1 },
    { retryLimit: 0, expireInSeconds: 180 });
}
