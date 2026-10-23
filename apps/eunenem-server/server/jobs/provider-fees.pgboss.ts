import type { PgBoss } from 'pg-boss';

export const INTER_FEES_QUEUE = 'inter-processing-fees-v1';
export const PROVIDER_FEES_QUEUE = 'provider-processing-fees-v1';
/** Own queue: failures never delay payment confirmation or touch a payout. */
export async function registerProviderFeesJob(
  boss: Pick<PgBoss, 'createQueue' | 'work' | 'schedule' | 'unschedule'>,
  service: { readonly enabled: boolean; run(): Promise<unknown> },
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
    lifecycle.runJob(async () => { await service.run(); }),
  );
  lifecycle.assertAdmissionOpen();
  await boss.schedule(queue, '*/5 * * * *', { schemaVersion: 1 },
    { retryLimit: 0, expireInSeconds: 240 });
}
