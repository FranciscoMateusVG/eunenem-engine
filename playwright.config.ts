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

// Same connection string as .env.example (engine's docker-compose). In CI the
// ci.yml `e2e` job overrides this to point at its `services: postgres:16`.
const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgresql://frame:frame@localhost:54320/frame';

/**
 * Build one webServer entry for the engine's eunenem-server on `port`.
 *
 * NOTE (aperture-zaz5r): the client bundle is built ONCE by the `test:e2e`
 * script BEFORE Playwright starts (`(cd apps/eunenem-server && pnpm build) &&
 * playwright test`). The webServer commands below therefore only start the
 * server (`tsx server.tsx`) and do NOT build. This is deliberate: Playwright
 * launches all webServers concurrently, so two `pnpm build` invocations would
 * race on the same apps/eunenem-server/public/client.js output and corrupt the
 * bundle. Single pre-build → both servers serve the identical, already-built
 * worktree bundle.
 */
function makeServer(port: number, extraEnv: Record<string, string>) {
  return {
    command: `cd apps/eunenem-server && PORT=${port} NODE_ENV=development tsx server.tsx`,
    url: `http://localhost:${port}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? 'e2e-test-secret-must-be-at-least-32-chars-long-ok',
      BETTER_AUTH_URL: `http://localhost:${port}`,
      TRUSTED_ORIGINS: `http://localhost:${port}`,
      // aperture-r5y94: arm the E2E magic-chave forced-outcome path on the fake
      // transferencia rail (aperture-4ifbm). TRANSFERENCIA_PROVIDER defaults to
      // 'fake' and 'inter' is superRefine-rejected off production, so both local
      // servers bind TransferenciaProviderFake; this flag lets the repasse E2E
      // drive pagarPix outcomes (pago/rejeitado/ambiguo/…) from the recebedor's
      // marker chave. Off by default everywhere else — zero blast radius.
      EUNENEM_FAKE_E2E_MAGIC: 'true',
      // Base server (:3002): empty STRIPE_* → server falls back to the fake
      // payment adapter (visitor-cart + UI specs rely on this).
      STRIPE_SECRET_KEY: '',
      STRIPE_PUBLISHABLE_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      // Per-port overrides (:3003 sets the real Stripe-env, below).
      ...extraEnv,
    },
  };
}

/**
 * Playwright E2E configuration for the eunenem engine.
 *
 * Two local webServers (aperture-zaz5r, folding in Izzy's cluster-E fix):
 *   :3002  default server, EMPTY STRIPE_* env → fake payment adapter. Serves
 *          the visitor-cart / routing / admin / UI specs.
 *   :3003  dedicated Stripe-env server: STRIPE_WEBHOOK_SECRET set so
 *          /api/webhooks/stripe does real HMAC signature verification
 *          (constructEvent is pure local HMAC — no Stripe API call). A
 *          non-empty STRIPE_SECRET_KEY flips DI to the real Stripe provider,
 *          which is exactly what the webhook-signature specs
 *          (stripe-webhook-pix / -cartao) need. Setting these on :3002 would
 *          break the fake-adapter specs — hence a separate server.
 *
 * The WEBHOOK_SECRET below MUST match the value the specs sign with
 * (e2e/stripe-webhook-*.spec.ts → WEBHOOK_SECRET).
 *
 * RUN LOCALLY:
 *   docker compose -f docker/docker-compose.yml up -d  # Postgres only, once
 *   pnpm test:e2e                                       # builds once, spawns both servers
 *
 * CI: the ci.yml `e2e` job supplies a fresh `services: postgres:16` per run
 * (hermetic per-run isolation; approved swap from the old "testcontainers"
 * Phase-2 note — identical isolation, mirrors the existing `migrate` job).
 */
const STRIPE_ENV_3003: Record<string, string> = {
  STRIPE_SECRET_KEY: process.env.E2E_STRIPE_SECRET_KEY ?? 'sk_test_dummy_e2e',
  STRIPE_WEBHOOK_SECRET:
    process.env.E2E_STRIPE_WEBHOOK_SECRET ?? 'whsec_test_e2e_secret_for_signing_0000',
  // aperture-07x5c: the dummy STRIPE_SECRET_KEY above unblocks getStripe() for
  // pure-HMAC webhook signature verification (constructEvent), but would flip DI
  // to the real Stripe provider whose solicitarPagamento re-retrieves the
  // Checkout Session over the API and 500s without a live account. This seam
  // forces the deterministic fake provider while keeping verification real.
  // Hard-disabled when NODE_ENV=production (setup.ts superRefine rejects it).
  E2E_FAKE_PAGAMENTO_PROVIDER: '1',
};

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Single worker until per-worker DB isolation lands. E2E tests share one DB;
  // running them sequentially prevents cross-test fixture collisions.
  workers: 1,
  fullyParallel: false,
  // Fail the run if `test.only` was accidentally committed.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3002',
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
  // Conditional key (not `webServer: undefined`): under exactOptionalPropertyTypes
  // an explicit `undefined` is not assignable to the optional `webServer`.
  ...(REMOTE_TARGET
    ? {}
    : {
        webServer: [
          // :3002 carries ADMIN_ALLOWED_EMAILS (Vance cluster-C): admin routes +
          // auth.me live on the eunenem-server default port, not the stripe server.
          makeServer(3002, {
            ADMIN_ALLOWED_EMAILS: process.env.ADMIN_ALLOWED_EMAILS ?? 'e2e-admin@e2e.local',
          }),
          makeServer(3003, STRIPE_ENV_3003),
        ],
      }),
});
