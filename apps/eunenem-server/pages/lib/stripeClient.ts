// aperture-3xgch — singleton Stripe.js loader for the embedded checkout.
//
// loadStripe() returns a Promise<Stripe | null>. The Stripe team recommends
// calling it ONCE outside any component (or once memoised inside the
// provider) so the script tag isn't re-injected on every mount. We export
// `stripePromise` as the module-level singleton and let EmbeddedCheckout-
// Provider await it.
//
// STRIPE_PUBLISHABLE_KEY wiring:
//   - Today (scaffold mode): hardcoded TEST-mode pk per GLaDOS dispatch
//     2026-05-30. Operator-banked key; safe to commit (test mode only).
//   - Post-aperture-xaha2 (Rex's C2): esbuild `define` will replace the
//     identifier `STRIPE_PUBLISHABLE_KEY` at build time with the value from
//     process.env.STRIPE_PUBLISHABLE_KEY. Swap the const below to read
//     from the injected identifier with a typed declare.

import { loadStripe, type Stripe } from "@stripe/stripe-js";

// TEST-mode pk_test key. Operator-banked; switch to build-injected value
// once Rex's C2 (aperture-xaha2) wires the esbuild define + .env loading.
const STRIPE_PUBLISHABLE_KEY =
  "pk_test_51R28Bb2cuvGrl3yeeNLOzZ46afkz2N3DofgpTajlf4hpdp3BCRIwtv5vh3AUJjwKhIC2709dE9AfFMhuyyBwdhWG00edMxbmw9";

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
