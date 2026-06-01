/**
 * Test-DB helper — returns a connected Kysely instance against a
 * Postgres container.
 *
 * Two modes (aperture-m4xaj):
 *   - INSIDE vitest: `TEST_DATABASE_URL` is set by globalSetup
 *     (tests/helpers/global-setup.ts), which spun up ONE shared
 *     container for the entire run. `createTestDatabase()` opens a
 *     new pool against that URI and returns. No per-file container
 *     start — eliminates the 15-concurrent-container race that hit
 *     under `pnpm check` + v8 coverage.
 *   - OUTSIDE vitest (examples scripts, ad-hoc invocation):
 *     `TEST_DATABASE_URL` is unset. Fall back to spinning up an
 *     ephemeral container in this process, run migrations, return
 *     a teardown that stops the container. Preserves the original
 *     behavior so `tsx examples/create-cat.ts` keeps working.
 *
 * Backwards-compatible contract:
 *   - Return shape is unchanged: `{ db, connectionUri, teardown }`.
 *   - `container` field intentionally removed — examples never used
 *     it, and exposing it in the shared-container mode would be
 *     misleading (the real container is owned by globalSetup).
 *   - In shared mode, `teardown()` only destroys this file's Kysely
 *     pool; the container itself stays alive for the next file.
 *   - In ephemeral mode, `teardown()` destroys the pool AND stops
 *     the container — original behavior.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Migrator } from 'kysely';
import { createDatabase, type Database } from '../../src/adapters/database.js';
import { createMigrationProvider } from './migration-provider.js';

export interface TestDatabase {
  db: Database;
  connectionUri: string;
  /**
   * Destroys this file's Kysely pool. In shared-container mode, the
   * container stays alive (globalSetup owns it). In ephemeral-container
   * mode, the container is also stopped.
   */
  teardown: () => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const sharedUri = process.env.TEST_DATABASE_URL;

  if (sharedUri) {
    // SHARED MODE — vitest globalSetup spun up the container.
    const db = createDatabase(sharedUri);
    const teardown = async () => {
      await db.destroy();
    };
    return { db, connectionUri: sharedUri, teardown };
  }

  // EPHEMERAL MODE — no globalSetup; spin our own container.
  // Used by example scripts (tsx examples/create-cat.ts) and ad-hoc
  // invocations outside vitest.
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16')
    .withDatabase('frame')
    .withUsername('frame')
    .withPassword('frame')
    .start();

  const connectionUri = container.getConnectionUri();
  const db = createDatabase(connectionUri);

  const migrator = new Migrator({
    db,
    provider: createMigrationProvider(),
  });

  const { error } = await migrator.migrateToLatest();
  if (error) {
    await db.destroy();
    await container.stop();
    throw new Error(`Migration failed: ${String(error)}`);
  }

  const teardown = async () => {
    await db.destroy();
    await container.stop();
  };

  return { db, connectionUri, teardown };
}
