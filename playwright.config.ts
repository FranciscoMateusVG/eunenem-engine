import { defineConfig, devices } from '@playwright/test';

/**
 * Remote-target mode (aperture-118sb): when E2E_BASE_URL points at a
 * deployed instance (anything non-localhost), do NOT spawn the local
 * webServer — the tests exercise the deployment directly. Local runs
 * (no E2E_BASE_URL, or an explicit localhost one) keep the Phase-1
 * spawn-own-server behaviour unchanged.
 */
const REMOTE_TARGET = Boolean(
  process.env.E2E_BASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.E2E_BASE_URL),
);

/**
 * Playwright E2E configuration for the eunenem engine (aperture-ilji3).
 *
 * This is the FIRST E2E gate to land — the suite's purpose is to catch
 * user-facing regressions that slip past unit + integration tests.
 *
 * Phase 1 (this PR): local-only. Playwright spawns its OWN copy of the
 * eunenem-server on port 3002 (so it picks up the worktree's current
 * code, not whatever operator has running on 3001 for dev). The spawned
 * server reuses the same Postgres the engine's docker-compose ships
 * (frame@localhost:54320). Each test seeds a fresh user + campaign +
 * contribuição via direct engine calls (NOT through the UI). Operator's
 * dev data is untouched — different port + isolated test users.
 *
 * Phase 2 (separate child PR): testcontainers Postgres per run +
 * GitHub Actions workflow so the gate runs in CI on every PR with full
 * hermetic isolation.
 *
 * RUN LOCALLY:
 *   docker compose -f docker/docker-compose.yml up -d  # Postgres only, once
 *   pnpm test:e2e                                       # Playwright handles the rest
 *
 * The Postgres must be reachable at the connection string in
 * E2E_DATABASE_URL (defaults to .env.example's frame@localhost:54320).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Single worker until per-worker DB isolation lands in the CI phase.
  // E2E tests share the operator's dev DB; running them sequentially
  // prevents cross-test fixture collisions.
  workers: 1,
  fullyParallel: false,
  // Fail the run if `test.only` was accidentally committed.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3002',
    // Each test gets a fresh browser context (no shared cookies).
    // Auth comes via the per-test fixture in e2e/fixtures/auth.ts.
    storageState: undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Spawn the engine's eunenem-server from THIS worktree on port 3002.
  // Build the client bundle once (no watch), then start the server. This
  // guarantees the served bundle is the worktree's current code — not
  // whatever operator's `pnpm dev` is shipping on 3001. Reuse-existing
  // is enabled outside CI so iterating on tests doesn't re-build every
  // time.
  webServer: REMOTE_TARGET
    ? undefined
    : {
        command:
          'cd apps/eunenem-server && pnpm build && PORT=3002 NODE_ENV=development tsx server.tsx',
        url: 'http://localhost:3002/healthz',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          // Same connection string as .env.example (engine's docker-compose).
          // Override via shell env if needed.
          DATABASE_URL:
            process.env.E2E_DATABASE_URL ?? 'postgresql://frame:frame@localhost:54320/frame',
          BETTER_AUTH_SECRET:
            process.env.BETTER_AUTH_SECRET ?? 'e2e-test-secret-must-be-at-least-32-chars-long-ok',
          BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3002',
          TRUSTED_ORIGINS: process.env.TRUSTED_ORIGINS ?? 'http://localhost:3002',
          // Optional Stripe vars stay empty — server falls back to fake adapter.
          STRIPE_SECRET_KEY: '',
          STRIPE_PUBLISHABLE_KEY: '',
          STRIPE_WEBHOOK_SECRET: '',
        },
      },
});
