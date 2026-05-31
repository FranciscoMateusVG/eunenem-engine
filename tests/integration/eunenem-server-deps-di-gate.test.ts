import { afterEach, describe, expect, it } from 'vitest';
import { buildServerDeps, loadEnv } from '../../apps/eunenem-server/server/auth/setup.js';
import { __resetStripeForTests } from '../../apps/eunenem-server/src/lib/stripe/stripe.js';
import { PagamentoProviderFake, PagamentoProviderStripe } from '../../src/index.js';

/**
 * Regression tests for the payment-provider DI gate (aperture-ozlcr).
 *
 * The DI gate was originally `NODE_ENV === 'production'` — that broke
 * operator's daily dev workflow: to exercise the real Stripe path
 * locally (test-mode keys + `stripe listen --forward-to ...`), the
 * operator would have to flip NODE_ENV=production, which has side
 * effects (Secure cookie flag rejects HTTP cookies on localhost, log
 * verbosity drops, etc). And without NODE_ENV=production, Stripe.js
 * rejected the fake adapter's `cs_fake_xxx` clientSecrets on the browser
 * side with `IntegrationError: Unable to parse client secret`.
 *
 * The fix gates on STRIPE_SECRET_KEY presence instead. These tests lock
 * the new behaviour in place so a future refactor can't silently revert
 * the gate to the NODE_ENV check (which would re-break the operator's
 * dev workflow).
 *
 * **Why integration not unit:** buildServerDeps opens a real Kysely
 * pool against the DATABASE_URL env. We don't actually exercise the
 * pool (no SQL fires before the gate decision), but the constructor
 * needs the URL to be parseable. Tests use the same dev DATABASE_URL
 * as the other integration tests.
 */

const DEV_DATABASE_URL = 'postgresql://frame:frame@localhost:54320/frame';

function baseEnv(): NodeJS.ProcessEnv {
  return {
    BETTER_AUTH_SECRET: 'test-secret-min-32-chars-aaaaaaaaaaaaaaaaaaaaaa',
    BETTER_AUTH_URL: 'http://localhost:3001',
    TRUSTED_ORIGINS: 'http://localhost:3001',
    DATABASE_URL: DEV_DATABASE_URL,
    NODE_ENV: 'development',
  } as NodeJS.ProcessEnv;
}

describe('eunenem-server payment-provider DI gate (aperture-ozlcr)', () => {
  // getStripe() reads process.env.STRIPE_SECRET_KEY at call time and
  // caches the Stripe SDK singleton. Tests that exercise the Stripe gate
  // need to write process.env BEFORE buildServerDeps fires (the loadEnv
  // call uses a synthetic env object for boot validation, but the lazy
  // SDK init still reads the live process env). Reset between tests so
  // cross-test cache pollution doesn't mask regressions.
  const ORIGINAL_STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
  afterEach(() => {
    if (ORIGINAL_STRIPE_SECRET === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = ORIGINAL_STRIPE_SECRET;
    }
    __resetStripeForTests();
  });

  it('binds PagamentoProviderStripe when STRIPE_SECRET_KEY is set (dev with test keys)', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_for_di_gate_assertion';
    const env = loadEnv({
      ...baseEnv(),
      STRIPE_SECRET_KEY: 'sk_test_dummy_for_di_gate_assertion',
    });
    const deps = buildServerDeps(env);
    try {
      expect(deps.pagamentoProvider).toBeInstanceOf(PagamentoProviderStripe);
      expect(deps.checkoutSessionProvider).toBeInstanceOf(PagamentoProviderStripe);
      // Same instance — Stripe adapter implements both ports; the DI
      // wires the single object to both interfaces. Confirms we didn't
      // accidentally construct two different adapter instances.
      expect(deps.pagamentoProvider).toBe(deps.checkoutSessionProvider);
    } finally {
      // Close the Kysely pool so the test doesn't leak a connection
      // across describes. db is a kysely.Kysely<unknown>; destroy() is
      // the supported teardown.
      void deps.db.destroy();
    }
  });

  it('falls back to PagamentoProviderFake when STRIPE_SECRET_KEY is empty (fresh clone)', () => {
    const env = loadEnv({
      ...baseEnv(),
      STRIPE_SECRET_KEY: '',
    });
    const deps = buildServerDeps(env);
    try {
      expect(deps.pagamentoProvider).toBeInstanceOf(PagamentoProviderFake);
      expect(deps.checkoutSessionProvider).toBeInstanceOf(PagamentoProviderFake);
      expect(deps.pagamentoProvider).toBe(deps.checkoutSessionProvider);
    } finally {
      void deps.db.destroy();
    }
  });

  it('binds Stripe in production when STRIPE_SECRET_KEY is set (live deploy)', () => {
    // Production still requires STRIPE_SECRET_KEY (env-schema superRefine
    // throws if missing). When present the gate fires the same way as
    // dev — real Stripe adapter. This test exists so a future refactor
    // doesn't accidentally re-introduce the NODE_ENV branch.
    process.env.STRIPE_SECRET_KEY = 'sk_live_dummy_for_di_gate_assertion';
    const env = loadEnv({
      ...baseEnv(),
      NODE_ENV: 'production',
      STRIPE_PUBLISHABLE_KEY: 'pk_live_dummy_for_di_gate_assertion',
      STRIPE_SECRET_KEY: 'sk_live_dummy_for_di_gate_assertion',
      STRIPE_WEBHOOK_SECRET: 'whsec_live_dummy_for_di_gate_assertion',
      LOG_PII_HASH_SALT: 'live-salt-thirty-two-chars-aaaaaaaaaaaaaaaaaaaa',
      TRUSTED_HOP_COUNT: '1',
    });
    const deps = buildServerDeps(env);
    try {
      expect(deps.pagamentoProvider).toBeInstanceOf(PagamentoProviderStripe);
      expect(deps.checkoutSessionProvider).toBeInstanceOf(PagamentoProviderStripe);
    } finally {
      void deps.db.destroy();
    }
  });
});
