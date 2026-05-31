// aperture-3xgch (scaffold) + aperture-ra027 (build-define swap).
//
// loadStripe() returns a Promise<Stripe | null>. The Stripe team recommends
// calling it ONCE outside any component (or once memoised inside the
// provider) so the script tag isn't re-injected on every mount. We export
// `stripePromise` as the module-level singleton and let EmbeddedCheckout-
// Provider await it.
//
// STRIPE_PUBLISHABLE_KEY wiring (aperture-xaha2 / build.mjs):
//   The esbuild define block in build.mjs replaces
//   `process.env.STRIPE_PUBLISHABLE_KEY` at build time with the value of
//   the same env var on the build host. Empty string falls through if the
//   env var is unset at build time — `loadStripe('')` rejects with a clear
//   Stripe error rather than silently breaking, which is exactly what we
//   want for a config-miss in CI / staging deploys.

import { loadStripe, type Stripe } from "@stripe/stripe-js";

// Build-time inlined by esbuild define (see apps/eunenem-server/build.mjs).
// At runtime in the bundle this is a string literal — the `process.env`
// reference does not exist on the client.
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY ?? "";

let stripePromise: Promise<Stripe | null> | null = null;

/**
 * Idempotent accessor for the Stripe singleton. First call kicks off the
 * script-tag injection; subsequent calls return the cached promise.
 */
export function getStripePromise(): Promise<Stripe | null> {
  if (!stripePromise) {
    stripePromise = loadStripe(STRIPE_PUBLISHABLE_KEY);
  }
  return stripePromise;
}
