import type { PgBoss } from 'pg-boss';

export const INTER_FEES_QUEUE = 'inter-processing-fees-v1';
export const PROVIDER_FEES_QUEUE = 'provider-processing-fees-v1';
/** Own queue: failures never delay payment confirmation or touch a payout. */
export async function registerProviderFeesJob(
  boss: Pick<PgBoss, 'createQueue' | 'work' | 'schedule' | 'unschedule'>,
  service: { readonly enabled: boolean; runAll(): Promise<unknown> },
  lifecycle: { assertAdmissionOpen: () => void; runJob: <T>(operation: () => Promise<T>) => Promise<T> },
  queue: string = PROVIDER_FEES_QUEUE,
): Promise<void> {
  if (!service.enabled) {
    lifecycle.assertAdmissionOpen();
    await boss.unschedule(queue);
    return;
  }
  lifecycle.assertAdmissionOpen();
  await boss.createQueue(queue);
  lifecycle.assertAdmissionOpen();
  await boss.work(queue, { batchSize: 1 }, () =>
    lifecycle.runJob(async () => { await service.runAll(); }),
  );
  lifecycle.assertAdmissionOpen();
  await boss.schedule(queue, '0 6,14,22 * * *', { schemaVersion: 1 },
    { tz: 'America/Sao_Paulo', retryLimit: 0, expireInSeconds: 6 * 60 * 60 });
}
