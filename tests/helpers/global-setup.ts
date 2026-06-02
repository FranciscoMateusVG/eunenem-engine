/**
 * Vitest globalSetup — spin up ONE Postgres container shared by every
 * integration test file (aperture-m4xaj), conditionally based on whether
 * the current run actually includes integration tests (aperture-epmps).
 *
 * Before m4xaj, every test file called `createTestDatabase()` in its own
 * beforeAll, which spawned a fresh PostgreSqlContainer. Under
 * `pnpm check` + v8 coverage, 15+ containers raced to start
 * simultaneously, the 60s beforeAll timeout fired, and 15 files cascaded
 * into "Cannot read properties of undefined (reading 'teardown')"
 * because beforeAll never finished.
 *
 * After m4xaj, container lifecycle was hoisted to vitest's globalSetup.
 * One container starts before any test file runs, migrations run once,
 * connectionUri is exported via `process.env.TEST_DATABASE_URL`, and
 * the container stops when the vitest run completes.
 *
 * After epmps (this file), the container ONLY starts if the run actually
 * includes integration tests. Targeted unit-only runs
 * (`vitest run tests/unit/foo.test.ts`) skip the container entirely —
 * which means a wedged docker daemon no longer cascades unit-test
 * failures across the suite. `pnpm test:coverage` and full `vitest run`
 * still spin the container (default = "full run" = "needs container").
 *
 * `tests/helpers/test-db.ts`'s `createTestDatabase()` continues to read
 * `TEST_DATABASE_URL` and returns a Database handle pointing at the
 * shared container; if the env var is missing (skipped path), it falls
 * back to its original ephemeral-container behavior (so a unit test
 * that happens to call createTestDatabase still works in standalone
 * scripts, though no integration test does that today).
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
 * Decides whether the postgres container should be spun for this
 * vitest run. Pure function — takes argv + env, returns a bool. Exported
 * for unit-test coverage; the real entrypoint below calls it once.
 *
 * Decision rules (first match wins):
 *   1. `SKIP_DB_GLOBAL_SETUP=1` → always skip (env override)
 *   2. `FORCE_DB_GLOBAL_SETUP=1` → always spin (env override)
 *   3. CLI args contain test paths → skip ONLY if EVERY path arg is
 *      explicitly scoped to `tests/unit/` (or contains the substring
 *      `tests/unit`). Anything else — integration paths, parent dirs
 *      like `tests/`, helper paths, ambiguous paths — spins the
 *      container. This is conservative: false-positive spin is cheap
 *      (a few seconds wasted on a healthy daemon), false-negative
 *      no-spin would break integration tests that need TEST_DATABASE_URL.
 *   4. No CLI test path → full run is implied → spin (default behavior)
 *
 * The override env vars exist so CI matrices or local dev can force
 * either path explicitly when the heuristic isn't what they want.
 */
export function shouldSpinPostgresContainer(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean {
  // 1. Explicit overrides take precedence.
  if (env.SKIP_DB_GLOBAL_SETUP === '1') return false;
  if (env.FORCE_DB_GLOBAL_SETUP === '1') return true;

  // 2. Find user-supplied test path args. Skip vitest's own flags and
  //    the leading 'node' / 'vitest' / 'run' tokens. A "test path arg"
  //    is anything that doesn't start with `-` and contains `tests/`
  //    or `tests` (covers absolute + relative paths, files + dirs).
  const testPathArgs = argv.filter(
    (a) => !a.startsWith('-') && (a.includes('tests/') || a.endsWith('tests')),
  );

  // 3. No path args = full run = container needed (existing behavior).
  if (testPathArgs.length === 0) return true;

  // 4. Skip ONLY if EVERY path arg is explicitly under tests/unit.
  //    Anything else (integration paths, parent dirs, mixed) spins.
  //    Conservative bias: false-positive spin costs seconds, false-
  //    negative no-spin breaks tests that need TEST_DATABASE_URL.
  return !testPathArgs.every((a) => a.includes('tests/unit'));
}

/**
 * Vitest globalSetup hook. Runs once before any test file.
 * Returns a teardown function that runs after every test file completes.
 *
 * When `shouldSpinPostgresContainer(argv, env)` returns false, this hook
 * is a no-op — no container, no migrations, no env var set. Tests that
 * depend on TEST_DATABASE_URL will error at their own beforeAll, which
 * is exactly the right behavior: a unit-only run shouldn't include
 * integration test files in the first place (the include pattern
 * matches them but the user explicitly targeted unit/).
 */
export default async function setup(): Promise<() => Promise<void>> {
  if (!shouldSpinPostgresContainer(process.argv, process.env)) {
    // No container needed for this run. Return a no-op teardown so
    // vitest's lifecycle stays happy.
    return async () => {
      /* no-op — container was never spun */
    };
  }

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
