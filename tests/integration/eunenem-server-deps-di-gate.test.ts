import { afterEach, describe, expect, it } from 'vitest';
import { buildServerDeps, loadEnv } from '../../apps/eunenem-server/server/auth/setup.js';
import { __resetStripeForTests } from '../../apps/eunenem-server/src/lib/stripe/stripe.js';
import {
  CatalogoAdminAuditPostgres,
  CatalogoRepositoryPostgres,
  PagamentoProviderFake,
  PagamentoProviderStripe,
  PixCobrancaProviderFake,
  PixCobrancaProviderInter,
  TransferenciaProviderFake,
  TransferenciaProviderInter,
} from '../../src/index.js';

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
    // aperture-gejcw — required (non-empty) in production by the env-schema
    // superRefine guard (the 1.0 card + legacy bridge derive from it).
    LEGACY_SITE_ORIGIN: 'https://eunenem.com',
  } as NodeJS.ProcessEnv;
}

describe('eunenem-server catalog composition root (aperture-ldo5d)', () => {
  it('binds the required Postgres catalog adapter into production-shaped ServerDeps', () => {
    const deps = buildServerDeps(loadEnv(baseEnv()));
    try {
      expect(deps.catalogoRepository).toBeInstanceOf(CatalogoRepositoryPostgres);
      expect(deps.catalogoAdminAudit).toBeInstanceOf(CatalogoAdminAuditPostgres);
    } finally {
      void deps.db.destroy();
    }
  });
});

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

/**
 * aperture-ju5w2 — the Inter PIX transfer rail boot guard. Two structural
 * money-safety invariants live in the env superRefine: (1) 'inter' is ONLY
 * selectable in production (staging/dev can NEVER fire a real transfer);
 * (2) selecting 'inter' requires every INTER_* credential to be present, so a
 * half-configured prod deploy fails fast at boot rather than on the first PIX.
 */
describe('eunenem-server Inter transfer-rail boot guard (aperture-ju5w2)', () => {
  const B64 = (s: string) => Buffer.from(s).toString('base64');

  function prodInterEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...baseEnv(),
      NODE_ENV: 'production',
      STRIPE_PUBLISHABLE_KEY: 'pk_live_dummy',
      STRIPE_SECRET_KEY: 'sk_live_dummy',
      STRIPE_WEBHOOK_SECRET: 'whsec_live_dummy',
      LOG_PII_HASH_SALT: 'live-salt-thirty-two-chars-aaaaaaaaaaaaaaaaaaaa',
      TRUSTED_HOP_COUNT: '1',
      TRANSFERENCIA_PROVIDER: 'inter',
      INTER_BASE_URL: 'https://cdpj.partners.bancointer.com.br',
      INTER_CLIENT_ID: 'cid',
      INTER_CLIENT_SECRET: 'csecret',
      INTER_SCOPE: 'pagamento-pix.write extrato.read',
      INTER_CERT_BASE64: B64('DUMMY-CERT-PEM'),
      INTER_KEY_BASE64: B64('DUMMY-KEY-PEM'),
      ...overrides,
    } as NodeJS.ProcessEnv;
  }

  it("REJECTS 'inter' outside production (staging/dev can never fire a real transfer)", () => {
    expect(() =>
      loadEnv({ ...baseEnv(), NODE_ENV: 'development', TRANSFERENCIA_PROVIDER: 'inter' }),
    ).toThrow(/production/i);
  });

  it("REJECTS 'inter' in production when INTER_* credentials are missing (fail fast)", () => {
    expect(() =>
      loadEnv(
        prodInterEnv({
          INTER_CLIENT_SECRET: '',
          INTER_CERT_BASE64: '',
          INTER_KEY_BASE64: '',
        }),
      ),
    ).toThrow(/INTER_/);
  });

  it("ACCEPTS 'inter' in production with all credentials present", () => {
    const env = loadEnv(prodInterEnv());
    expect(env.TRANSFERENCIA_PROVIDER).toBe('inter');
  });

  it("binds TransferenciaProviderInter when 'inter' is fully configured in production", () => {
    // getStripe() (fired inside buildServerDeps' pagamento gate) reads the LIVE
    // process.env.STRIPE_SECRET_KEY, not the synthetic loadEnv object — mirror
    // the Stripe prod test and set it before building, restore after.
    const original = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_live_dummy';
    __resetStripeForTests();
    const env = loadEnv(prodInterEnv());
    const deps = buildServerDeps(env);
    try {
      expect(deps.transferenciaProvider).toBeInstanceOf(TransferenciaProviderInter);
      expect(deps.transferenciaProvider).not.toBeInstanceOf(TransferenciaProviderFake);
    } finally {
      void deps.db.destroy();
      if (original === undefined) {
        delete process.env.STRIPE_SECRET_KEY;
      } else {
        process.env.STRIPE_SECRET_KEY = original;
      }
      __resetStripeForTests();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
//  MINIO_ENDPOINT browser-reachability boot guard (aperture-9wqh1)
// ─────────────────────────────────────────────────────────────────────
describe('eunenem-server MINIO_ENDPOINT boot guard (aperture-9wqh1)', () => {
  function productionEnv(minioEndpoint: string): NodeJS.ProcessEnv {
    return {
      ...baseEnv(),
      NODE_ENV: 'production',
      STRIPE_PUBLISHABLE_KEY: 'pk_live_dummy',
      STRIPE_SECRET_KEY: 'sk_live_dummy',
      STRIPE_WEBHOOK_SECRET: 'whsec_live_dummy',
      LOG_PII_HASH_SALT: 'live-salt-thirty-two-chars-aaaaaaaaaaaaaaaaaaaa',
      TRUSTED_HOP_COUNT: '1',
      MINIO_ENDPOINT: minioEndpoint,
    } as NodeJS.ProcessEnv;
  }

  it('rejects the INTERNAL service host (the reported bug: broken images)', () => {
    expect(() => loadEnv({ ...baseEnv(), MINIO_ENDPOINT: 'http://eunenem-minio:9000' })).toThrow(
      /MINIO_ENDPOINT/,
    );
  });

  it('rejects a bare host with no scheme', () => {
    expect(() => loadEnv({ ...baseEnv(), MINIO_ENDPOINT: 'eunenem-minio:9000' })).toThrow(
      /MINIO_ENDPOINT/,
    );
  });

  it('accepts the public per-stack domain (https, dotted host)', () => {
    expect(() =>
      loadEnv({
        ...baseEnv(),
        MINIO_ENDPOINT: 'https://storage-eunenem.test.pocketsoftware.com.br',
      }),
    ).not.toThrow();
  });

  it('rejects non-loopback HTTP endpoints', () => {
    expect(() =>
      loadEnv({
        ...baseEnv(),
        MINIO_ENDPOINT: 'http://storage-eunenem.test.pocketsoftware.com.br',
      }),
    ).toThrow(/MINIO_ENDPOINT/);
  });

  it.each([
    'https://access:secret@storage-eunenem.test.pocketsoftware.com.br',
    'http://access:secret@localhost:9000',
  ])('rejects endpoints with embedded credentials: %s', (endpoint) => {
    expect(() => loadEnv({ ...baseEnv(), MINIO_ENDPOINT: endpoint })).toThrow(/MINIO_ENDPOINT/);
  });

  it('accepts a local MinIO on localhost for dev', () => {
    expect(() => loadEnv({ ...baseEnv(), MINIO_ENDPOINT: 'http://localhost:9000' })).not.toThrow();
    expect(() => loadEnv({ ...baseEnv(), MINIO_ENDPOINT: 'http://127.0.0.1:9000' })).not.toThrow();
    expect(() => loadEnv({ ...baseEnv(), MINIO_ENDPOINT: 'http://[::1]:9000' })).not.toThrow();
  });

  it.each([
    'https://localhost:9000',
    'https://10.0.0.1:9000',
    'https://100.64.0.1:9000',
    'https://127.0.0.1:9000',
    'https://169.254.169.254:9000',
    'https://172.16.0.1:9000',
    'https://192.168.1.1:9000',
    'https://[::1]:9000',
    'https://[fc00::1]:9000',
    'https://[fd12:3456:789a::1]:9000',
    'https://[fe80::1]:9000',
  ])('rejects a private/special numeric endpoint in production: %s', (endpoint) => {
    expect(() => loadEnv(productionEnv(endpoint))).toThrow(/MINIO_ENDPOINT/);
  });

  it.each([
    'https://8.8.8.8:9000',
    'https://[2606:4700:4700::1111]:9000',
  ])('accepts a public numeric HTTPS endpoint in production: %s', (endpoint) => {
    expect(() => loadEnv(productionEnv(endpoint))).not.toThrow();
  });

  it('is skipped entirely when MINIO_ENDPOINT is unset (fresh-clone boot)', () => {
    expect(() => loadEnv({ ...baseEnv() })).not.toThrow();
  });
});

/**
 * aperture-18j3j (B7 of 2j2j1) — the PIX-in charge rail DI gate + boot guard.
 *
 * Invariants pinned here:
 * 1. Default/unset + no Inter credentials → 'stripe' checkout routing and the
 *    PixCobrancaNaoConfigurado throw-on-use stub; existing Stripe/fake
 *    checkout bindings stay byte-for-byte unchanged.
 * 2. 'fake' → deterministic PixCobrancaProviderFake.
 * 3. 'inter' + full INTER_COB_* creds → real PixCobrancaProviderInter.
 * 4. 'inter' + ANY missing cred → boot rejection in EVERY environment
 *    (inter-selected-but-unusable is a misconfiguration; fail closed).
 * 5. DELIBERATE ASYMMETRY vs TRANSFERENCIA_PROVIDER (spec 2j2j1 §6): 'inter'
 *    is allowed OUTSIDE production (sandbox stance — a PIX charge has no
 *    double-pay hazard, unlike a PIX transfer). Pinned so a future refactor
 *    doesn't "harmonize" the two gates and kill sandbox verification.
 * 6. 'stripe' + complete Inter credentials keeps the real Inter adapter bound
 *    for webhook/poller recovery of in-flight charges while NEW checkouts use
 *    Stripe. Checkout routing and reconciliation availability are separate.
 */
describe('eunenem-server PIX cobrança rail DI gate (aperture-18j3j)', () => {
  const B64 = (s: string) => Buffer.from(s).toString('base64');

  function interCobEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...baseEnv(),
      COBRANCA_PIX_PROVIDER: 'inter',
      INTER_COB_BASE_URL: 'https://cdpj-sandbox.partners.uatinter.co',
      INTER_COB_CLIENT_ID: 'cob-cid',
      INTER_COB_CLIENT_SECRET: 'cob-csecret',
      INTER_COB_SCOPE: 'cob.write cob.read pix.read pix.write',
      INTER_COB_CERT_BASE64: B64('DUMMY-COB-CERT-PEM'),
      INTER_COB_KEY_BASE64: B64('DUMMY-COB-KEY-PEM'),
      INTER_COB_PIX_KEY: 'chave-pix-recebimento@eunenem.com',
      ...overrides,
    } as NodeJS.ProcessEnv;
  }

  function prodEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...baseEnv(),
      NODE_ENV: 'production',
      STRIPE_PUBLISHABLE_KEY: 'pk_live_dummy',
      STRIPE_SECRET_KEY: 'sk_live_dummy',
      STRIPE_WEBHOOK_SECRET: 'whsec_live_dummy',
      LOG_PII_HASH_SALT: 'live-salt-thirty-two-chars-aaaaaaaaaaaaaaaaaaaa',
      TRUSTED_HOP_COUNT: '1',
      ...overrides,
    } as NodeJS.ProcessEnv;
  }

  it("defaults to 'stripe' and binds the throw-on-use stub when the var is unset", async () => {
    const env = loadEnv(baseEnv());
    expect(env.COBRANCA_PIX_PROVIDER).toBe('stripe');
    const deps = buildServerDeps(env);
    try {
      expect(deps.pixCobrancaProvider).not.toBeInstanceOf(PixCobrancaProviderFake);
      expect(deps.pixCobrancaProvider).not.toBeInstanceOf(PixCobrancaProviderInter);
      expect(deps.pixCobrancaProvider.constructor.name).toBe('PixCobrancaNaoConfigurado');
      // Every method throws loudly, naming the selector var — under 'stripe'
      // routing this port must never be reached, so a call is a wiring bug.
      await expect(deps.pixCobrancaProvider.consultarCobranca('A'.repeat(26))).rejects.toThrow(
        /COBRANCA_PIX_PROVIDER/,
      );
    } finally {
      void deps.db.destroy();
    }
  });

  describe('zero-behavior-change proof: stripe-parity table (aperture-18j3j QA hold)', () => {
    // The claim to prove: introducing COBRANCA_PIX_PROVIDER changes NOTHING
    // about the existing checkout wiring under BOTH configurations of the
    // Stripe gate — not just the Fake branch. Table: STRIPE_SECRET_KEY in
    // [empty, set] × COBRANCA_PIX_PROVIDER in [unset (pre-merge env shape),
    // explicit 'stripe' default]. Every cell asserts (a) the gate resolves to
    // the class the key state demands, identically whether the new var is
    // present or absent, and (b) the dual-port binding stays ONE shared
    // instance serving both deps (the existing single-instance invariant).
    const ORIGINAL_STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
    afterEach(() => {
      if (ORIGINAL_STRIPE_SECRET === undefined) {
        delete process.env.STRIPE_SECRET_KEY;
      } else {
        process.env.STRIPE_SECRET_KEY = ORIGINAL_STRIPE_SECRET;
      }
      __resetStripeForTests();
    });

    const KEY_STATES = [
      {
        keyState: 'STRIPE_SECRET_KEY empty (fresh clone → Fake)',
        stripeKey: '',
        expected: PagamentoProviderFake,
      },
      {
        keyState: 'STRIPE_SECRET_KEY set (test keys → Stripe)',
        stripeKey: 'sk_test_dummy_zero_behavior_change',
        expected: PagamentoProviderStripe,
      },
    ];
    const COB_STATES = [
      { cobState: 'COBRANCA_PIX_PROVIDER unset (pre-merge env shape)', cobrancaVar: undefined },
      { cobState: "COBRANCA_PIX_PROVIDER='stripe' (explicit default)", cobrancaVar: 'stripe' },
    ];
    const CELLS = KEY_STATES.flatMap((k) => COB_STATES.map((c) => ({ ...k, ...c })));

    it.each(CELLS)('$keyState × $cobState → checkout wiring unchanged', ({
      stripeKey,
      expected,
      cobrancaVar,
    }) => {
      // getStripe() reads the LIVE process.env at call time — mirror the
      // payment-gate describe above and write it before building.
      process.env.STRIPE_SECRET_KEY = stripeKey;
      __resetStripeForTests();
      const env = loadEnv({
        ...baseEnv(),
        STRIPE_SECRET_KEY: stripeKey,
        ...(cobrancaVar !== undefined ? { COBRANCA_PIX_PROVIDER: cobrancaVar } : {}),
      });
      const deps = buildServerDeps(env);
      try {
        expect(deps.pagamentoProvider).toBeInstanceOf(expected);
        expect(deps.checkoutSessionProvider).toBeInstanceOf(expected);
        // ONE shared instance serving both ports — the pre-existing
        // dual-port invariant must survive the new var in every cell.
        expect(deps.pagamentoProvider).toBe(deps.checkoutSessionProvider);
        expect(deps.pixCobrancaProvider.constructor.name).toBe('PixCobrancaNaoConfigurado');
      } finally {
        void deps.db.destroy();
      }
    });
  });

  it("binds PixCobrancaProviderFake when COBRANCA_PIX_PROVIDER='fake'", () => {
    const deps = buildServerDeps(loadEnv({ ...baseEnv(), COBRANCA_PIX_PROVIDER: 'fake' }));
    try {
      expect(deps.pixCobrancaProvider).toBeInstanceOf(PixCobrancaProviderFake);
    } finally {
      void deps.db.destroy();
    }
  });

  const INTER_COB_CREDS = [
    'INTER_COB_BASE_URL',
    'INTER_COB_CLIENT_ID',
    'INTER_COB_CLIENT_SECRET',
    'INTER_COB_SCOPE',
    'INTER_COB_CERT_BASE64',
    'INTER_COB_KEY_BASE64',
    'INTER_COB_PIX_KEY',
  ] as const;

  describe("checkout rollback to 'stripe'", () => {
    const ORIGINAL_STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
    const ROLLBACK_STRIPE_SECRET = 'sk_test_dummy_inter_cob_rollback';

    afterEach(() => {
      if (ORIGINAL_STRIPE_SECRET === undefined) {
        delete process.env.STRIPE_SECRET_KEY;
      } else {
        process.env.STRIPE_SECRET_KEY = ORIGINAL_STRIPE_SECRET;
      }
      __resetStripeForTests();
    });

    function buildRollbackDeps(overrides: NodeJS.ProcessEnv = {}) {
      // getStripe() reads the live process env. A synthetic loadEnv key alone
      // would silently exercise the fake adapter and prove the wrong rollback.
      process.env.STRIPE_SECRET_KEY = ROLLBACK_STRIPE_SECRET;
      __resetStripeForTests();
      return buildServerDeps(
        loadEnv(
          interCobEnv({
            COBRANCA_PIX_PROVIDER: 'stripe',
            STRIPE_SECRET_KEY: ROLLBACK_STRIPE_SECRET,
            ...overrides,
          }),
        ),
      );
    }

    it('keeps the real Inter recovery adapter while payment checkout uses one Stripe instance', () => {
      const deps = buildRollbackDeps();
      try {
        // The selector routes NEW PIX checkouts. Complete Inter credentials are
        // a separate recovery signal: already-created Inter charges must remain
        // queryable by the webhook and B4 poller during the rollback window.
        expect(deps.pagamentoProvider).toBeInstanceOf(PagamentoProviderStripe);
        expect(deps.checkoutSessionProvider).toBeInstanceOf(PagamentoProviderStripe);
        expect(deps.pagamentoProvider).toBe(deps.checkoutSessionProvider);
        expect(deps.pixCobrancaProvider).toBeInstanceOf(PixCobrancaProviderInter);
        expect(deps.pixCobrancaProvider).not.toBeInstanceOf(PixCobrancaProviderFake);
      } finally {
        void deps.db.destroy();
      }
    });

    it.each(
      INTER_COB_CREDS,
    )('keeps Stripe identity and binds the throw-on-use PIX stub when rollback lacks %s', async (missingCredential) => {
      const deps = buildRollbackDeps({ [missingCredential]: '' });
      try {
        expect(deps.pagamentoProvider).toBeInstanceOf(PagamentoProviderStripe);
        expect(deps.checkoutSessionProvider).toBeInstanceOf(PagamentoProviderStripe);
        expect(deps.pagamentoProvider).toBe(deps.checkoutSessionProvider);
        expect(deps.pixCobrancaProvider.constructor.name).toBe('PixCobrancaNaoConfigurado');
        expect(deps.pixCobrancaProvider).not.toBeInstanceOf(PixCobrancaProviderInter);
        expect(deps.pixCobrancaProvider).not.toBeInstanceOf(PixCobrancaProviderFake);
        await expect(deps.pixCobrancaProvider.consultarCobranca('A'.repeat(26))).rejects.toThrow(
          /COBRANCA_PIX_PROVIDER/,
        );
      } finally {
        void deps.db.destroy();
      }
    });
  });

  it("binds PixCobrancaProviderInter when 'inter' is fully configured in production", () => {
    // getStripe() (fired inside buildServerDeps' pagamento gate) reads the
    // LIVE process.env.STRIPE_SECRET_KEY — mirror the transfer-rail prod test.
    const original = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_live_dummy';
    __resetStripeForTests();
    const env = loadEnv(prodEnv(interCobEnv({ NODE_ENV: 'production' })));
    const deps = buildServerDeps(env);
    try {
      expect(deps.pixCobrancaProvider).toBeInstanceOf(PixCobrancaProviderInter);
      expect(deps.pixCobrancaProvider).not.toBeInstanceOf(PixCobrancaProviderFake);
    } finally {
      void deps.db.destroy();
      if (original === undefined) {
        delete process.env.STRIPE_SECRET_KEY;
      } else {
        process.env.STRIPE_SECRET_KEY = original;
      }
      __resetStripeForTests();
    }
  });

  // ── fail-closed matrix (aperture-18j3j QA hold) ──────────────────────────
  // Code + comments promise rejection in EVERY environment. Prove the full
  // claim, not a sample: each of the 7 INTER_COB_* credentials × each
  // NODE_ENV × two absence variants — truly unset (exercises the zod ''
  // default) and whitespace-only (exercises the .trim() in the superRefine).
  // 7 × 3 × 2 = 42 cells, every one executed, every one asserting a
  // boot/schema rejection that NAMES the missing credential.
  const NODE_ENVS = ['production', 'development', 'test'] as const;
  const ABSENCE_VARIANTS = [
    {
      variant: 'unset (zod default "")',
      apply: (env: NodeJS.ProcessEnv, cred: string) => {
        delete env[cred];
      },
    },
    {
      variant: 'whitespace-only',
      apply: (env: NodeJS.ProcessEnv, cred: string) => {
        env[cred] = '   ';
      },
    },
  ] as const;
  const FAIL_CLOSED_CELLS = INTER_COB_CREDS.flatMap((cred) =>
    NODE_ENVS.flatMap((nodeEnv) =>
      ABSENCE_VARIANTS.map(({ variant, apply }) => ({ cred, nodeEnv, variant, apply })),
    ),
  );

  it.each(
    FAIL_CLOSED_CELLS,
  )("REJECTS 'inter' when $cred is $variant in NODE_ENV=$nodeEnv (fail closed in EVERY environment)", ({
    cred,
    nodeEnv,
    apply,
  }) => {
    const env =
      nodeEnv === 'production'
        ? prodEnv(interCobEnv({ NODE_ENV: 'production' }))
        : interCobEnv({ NODE_ENV: nodeEnv });
    apply(env, cred);
    expect(() => loadEnv(env)).toThrow(new RegExp(`${cred}.*COBRANCA_PIX_PROVIDER`));
  });

  it("ACCEPTS 'inter' in development with full creds (sandbox stance — asymmetry vs TRANSFERENCIA_PROVIDER)", () => {
    // spec 2j2j1 §6: PIX-out is prod-only (double-pay hazard); PIX-in is not.
    // This test pins the asymmetry: the same NODE_ENV=development that REJECTS
    // TRANSFERENCIA_PROVIDER='inter' BOOTS with COBRANCA_PIX_PROVIDER='inter'.
    const env = loadEnv(interCobEnv());
    expect(env.NODE_ENV).toBe('development');
    expect(env.COBRANCA_PIX_PROVIDER).toBe('inter');
    const deps = buildServerDeps(env);
    try {
      expect(deps.pixCobrancaProvider).toBeInstanceOf(PixCobrancaProviderInter);
    } finally {
      void deps.db.destroy();
    }
  });
});
