import { sql } from 'kysely';
import { afterAll, beforeAll } from 'vitest';
import { WebhookEventArchivePostgres } from '../../src/adapters/webhook-archive/webhook-event-archive.postgres.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { describeWebhookEventArchiveConformance } from '../helpers/webhook-event-archive.conformance.js';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describeWebhookEventArchiveConformance('Postgres', {
  factory: () => new WebhookEventArchivePostgres(testDb.db),
  resetState: async () => {
    await sql`TRUNCATE TABLE payment_webhook_events`.execute(testDb.db);
  },
});
