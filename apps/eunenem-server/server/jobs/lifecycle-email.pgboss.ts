import type { PgBoss } from 'pg-boss';
import type { LifecycleEmailService } from '../../../../src/use-cases/email/lifecycle-email.js';

export const LIFECYCLE_EMAIL_QUEUE = 'lifecycle-email-v1';
/** Postgres owns events, delivery claims, retries and ambiguity; pg-boss only wakes it. */
export async function registerLifecycleEmailJob(
  boss: Pick<PgBoss, 'createQueue' | 'work' | 'schedule'>,
  service: LifecycleEmailService,
  lifecycle: {
    assertAdmissionOpen: () => void;
    runJob: <T>(operation: () => Promise<T>) => Promise<T>;
  },
): Promise<void> {
  lifecycle.assertAdmissionOpen();
  await service.initialize();
  await boss.createQueue(LIFECYCLE_EMAIL_QUEUE);
  lifecycle.assertAdmissionOpen();
  await boss.work(LIFECYCLE_EMAIL_QUEUE, { batchSize: 1 }, () =>
    lifecycle.runJob(async () => {
      await service.scan();
      await service.dispatch();
    }),
  );
  lifecycle.assertAdmissionOpen();
  // UTC cron wakes every minute; civil-date predicate enforces 09:00 São Paulo.
  await boss.schedule(
    LIFECYCLE_EMAIL_QUEUE,
    '* * * * *',
    { schemaVersion: 1 },
    { retryLimit: 0, expireInSeconds: 300 },
  );
}
