/**
 * Vitest globalSetup — spin up ONE Postgres container shared by every
 * integration test file (aperture-m4xaj).
 *
 * Before this change, every test file called `createTestDatabase()` in
 * its own beforeAll, which spawned a fresh PostgreSqlContainer. Under
 * `pnpm check` + v8 coverage, 15+ containers raced to start
 * simultaneously, the 60s beforeAll timeout fired, and 15 files cascaded
 * into "Cannot read properties of undefined (reading 'teardown')"
 * because beforeAll never finished.
 *
 * The fix: hoist container lifecycle to vitest's globalSetup. One
 * container starts before any test file runs, migrations run once,
 * connectionUri is exported via `process.env.TEST_DATABASE_URL`, and
 * the container stops when the vitest run completes.
 *
 * `tests/helpers/test-db.ts`'s `createTestDatabase()` now reads
 * `TEST_DATABASE_URL` and returns a Database handle pointing at the
 * shared container — no container start per file.
 *
 * State isolation between tests is unchanged: tests still TRUNCATE in
 * `beforeEach`. Vitest's `fileParallelism: false` keeps files from
 * truncating each other's mid-test data (see vitest.config.ts).
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Migrator } from 'kysely';
import { createDatabase } from '../../src/adapters/database.js';
import { createMigrationProvider } from './migration-provider.js';

let container: StartedPostgreSqlContainer | undefined;

/**
 * Vitest globalSetup hook. Runs once before any test file.
 * Returns a teardown function that runs after every test file completes.
 */
export default async function setup(): Promise<() => Promise<void>> {
  // Spin up the one shared container.
  container = await new PostgreSqlContainer('postgres:16')
    .withDatabase('frame')
    .withUsername('frame')
    .withPassword('frame')
    .start();

  const connectionUri = container.getConnectionUri();

  // Run migrations once. Use the same createDatabase factory consumers
  // use so any side effects in that factory are exercised here too.
  const db = createDatabase(connectionUri);
  const migrator = new Migrator({
    db,
    provider: createMigrationProvider(),
  });

  const { error } = await migrator.migrateToLatest();
  if (error) {
    await db.destroy();
    await container.stop();
    container = undefined;
    throw new Error(`Migration failed in globalSetup: ${String(error)}`);
  }

  // The pool from the migration run is per-process and shouldn't leak
  // into worker forks. Destroy it here; createTestDatabase() in each
  // worker creates its own pool against the shared container.
  await db.destroy();

  // Export the URI for workers to pick up. process.env values set in
  // globalSetup are inherited by vitest's worker forks.
  process.env.TEST_DATABASE_URL = connectionUri;

  // Teardown — runs after all test files complete.
  return async () => {
    if (container) {
      await container.stop();
      container = undefined;
    }
  };
}
