import { afterAll, beforeAll } from 'vitest';
import { AuthServiceBetterAuth } from '../../src/adapters/usuario/auth-service.better-auth.js';
import { describeAuthServiceConformance } from '../helpers/auth-service.conformance.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateBetterAuthTables } from '../helpers/truncate-better-auth.js';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describeAuthServiceConformance('BetterAuth (Postgres)', {
  factory: () => new AuthServiceBetterAuth(testDb.db),
  resetState: () => truncateBetterAuthTables(testDb.db),
});
