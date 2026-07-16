import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

/**
 * Signature-verification unit tests (aperture-44mfy).
 *
 * The pipeline test (`stripe-webhook-pipeline.test.ts`) deliberately stubs
 * `verifyEvent: () => event`, and its header note asserts "the actual Stripe
 * SDK signature math is NOT exercised here — a dumb pass-through with no
 * decision logic." That assumption is exactly the coverage gap: the real
 * production `verifyEvent` is
 *
 *     getStripe().webhooks.constructEvent(rawBody, sigHeader, secret)
 *     — apps/eunenem-server/server/webhooks/stripe-webhook.ts:213-214
 *
 * and that HMAC/timestamp check is the webhook's TRUST BOUNDARY: it is the
 * only thing standing between an anonymous POST to /api/webhooks/stripe and a
 * pagamento being marked `aprovado`. If it silently stopped rejecting forged
 * bodies, every downstream test would still pass (they inject a valid event)
 * while prod became a free "mark-any-payment-paid" endpoint.
 *
 * These tests drive the REAL `constructEvent` — the same SDK method the
 * handler calls — with signatures minted by Stripe's own
 * `generateTestHeaderString`. No API key or network is used; webhook
 * verification is pure local crypto.
 */

const SECRET = 'whsec_test_signature_verification_0000';

// A minimal but well-formed event body (what Stripe would POST as the raw
// request body). constructEvent verifies the signature over these exact bytes.
const PAYLOAD = JSON.stringify({
  id: 'evt_sig_test',
  object: 'event',
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_test_sig', object: 'checkout.session' } },
});

// A fresh Stripe instance. Webhook signature verification needs no live key
// (it never calls the API) — the dummy key just satisfies the constructor.
const stripe = new Stripe('sk_test_dummy_for_signature_math', {
  apiVersion: '2025-08-27.basil',
});

function sign(payload: string, secret = SECRET, timestamp?: number): string {
  return stripe.webhooks.generateTestHeaderString(
    timestamp === undefined ? { payload, secret } : { payload, secret, timestamp },
  );
}

describe('Stripe webhook signature verification (real constructEvent)', () => {
  it('accepts a correctly-signed payload and returns the parsed event', () => {
    const header = sign(PAYLOAD);
    const event = stripe.webhooks.constructEvent(PAYLOAD, header, SECRET);

    expect(event.id).toBe('evt_sig_test');
    expect(event.type).toBe('checkout.session.completed');
  });

  it('REJECTS a tampered body (signature no longer matches the bytes)', () => {
    const header = sign(PAYLOAD);
    // Attacker keeps the valid signature but swaps the body — e.g. inflates
    // amount_total. The HMAC is over the original bytes, so this must throw.
    const tampered = PAYLOAD.replace('cs_test_sig', 'cs_attacker_injected');

    expect(() => stripe.webhooks.constructEvent(tampered, header, SECRET)).toThrow();
  });

  it('REJECTS a payload signed with a different secret', () => {
    const header = sign(PAYLOAD, 'whsec_the_wrong_secret_9999');

    expect(() => stripe.webhooks.constructEvent(PAYLOAD, header, SECRET)).toThrow();
  });

  it('REJECTS a stale timestamp beyond the tolerance window', () => {
    // Signed ~1 hour ago. constructEvent's default tolerance is 300s, so this
    // replay must be rejected. (Pass an explicit tolerance to be deterministic
    // regardless of the SDK default.)
    const oneHourAgo = Math.floor(Date.parse('2020-01-01T00:00:00Z') / 1000);
    const header = sign(PAYLOAD, SECRET, oneHourAgo);

    expect(() => stripe.webhooks.constructEvent(PAYLOAD, header, SECRET, 300)).toThrow(
      /timestamp|tolerance/i,
    );
  });

  it('REJECTS a garbage / malformed signature header', () => {
    expect(() =>
      stripe.webhooks.constructEvent(PAYLOAD, 'not-a-real-stripe-signature', SECRET),
    ).toThrow();
  });

  it('REJECTS an empty signature header', () => {
    expect(() => stripe.webhooks.constructEvent(PAYLOAD, '', SECRET)).toThrow();
  });
});
