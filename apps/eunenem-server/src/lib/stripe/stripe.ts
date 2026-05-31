/**
 * Single-instance Stripe SDK init for the eunenem-server (aperture-xaha2).
 *
 * Both the payment-provider adapter (PagamentoProviderStripe) AND the
 * webhook handler (/api/webhooks/stripe, aperture-24n36) consume this
 * module. Keep it singleton — multiple `new Stripe(...)` calls in the same
 * process work, but they each open a separate HTTP keep-alive pool and
 * make the metrics noisier.
 *
 * Module-level instantiation is deliberate: the SDK only opens TCP
 * connections lazily on the first request, so importing this module is
 * cheap even if a code path never actually calls Stripe.
 *
 * **Boot contract:** if `STRIPE_SECRET_KEY` is missing AND we're trying
 * to actually use it (Stripe adapter requested), `getStripe()` throws.
 * If you only need a placeholder import for tree-shaking / typecheck
 * reasons, don't call `getStripe()` — the module import alone has no
 * side effects beyond reading the env var.
 *
 * Why a getter function instead of `export const stripe = new Stripe(...)`:
 *   - Dev / test environments often boot without STRIPE_SECRET_KEY set.
 *     A top-level `new Stripe(undefined)` throws at import time, which
 *     would crash the server even for code paths that don't touch Stripe.
 *     A lazy getter defers the error to the first real use.
 *   - The DI gate in setup.ts only constructs PagamentoProviderStripe
 *     when NODE_ENV === 'production'; this matches that pattern.
 */
import Stripe from 'stripe';

// Pin to the SDK's currently-expected version. When upgrading the
// `stripe` package, bump this string to the new SDK default (the type
// will fail compilation if it drifts) and review the Stripe API
// changelog for any behavioural changes.
const STRIPE_API_VERSION = '2025-08-27.basil' as const;

let cached: Stripe | undefined;

/**
 * Returns the lazily-constructed Stripe singleton. Throws a readable
 * error if STRIPE_SECRET_KEY is missing — the boot env validator should
 * have caught this in production, but we double-check at first use.
 */
export function getStripe(): Stripe {
  if (cached) return cached;

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret || secret.length === 0) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Add it to apps/eunenem-server/.env (test-mode key from https://dashboard.stripe.com/test/apikeys).',
    );
  }

  cached = new Stripe(secret, {
    apiVersion: STRIPE_API_VERSION,
    // Identify our integration in Stripe's request logs (helps debugging
    // when staring at the Stripe Dashboard's "Logs" tab).
    appInfo: {
      name: 'eunenem-server',
      version: '0.0.0',
    },
    // Use Node's global fetch (Node 20+) instead of the SDK's bundled
    // request library. Same TLS behaviour, smaller hot path.
    httpClient: Stripe.createFetchHttpClient(),
  });

  return cached;
}

/**
 * Reset the cached singleton — TEST-ONLY hatch for unit tests that
 * want to swap the SDK out. NOT used in production code paths.
 */
export function __resetStripeForTests(): void {
  cached = undefined;
}
