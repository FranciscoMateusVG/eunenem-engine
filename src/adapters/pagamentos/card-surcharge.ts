import type { MoneyCents } from '../../domain/money.js';

/**
 * Stripe Brazil card surcharge calculator (aperture-uyw8i).
 *
 * Computes the per-transaction surcharge a buyer pays so the platform
 * still receives the full intended amount AFTER Stripe takes its
 * processing fee. Added as a "Taxa de processamento do cartão" line
 * item to the Stripe checkout session when `metodo === 'credit_card'`.
 *
 * **Pricing model (Stripe Brazil):** 3.9% + R$ 0.39 per transaction.
 * BOTH the percentage AND the fixed fee are buyer-paid in the
 * gross-up so the platform nets the intended base.
 *
 * **Formula derivation:**
 *   Let buyer_pays = base + surcharge.
 *   Stripe takes:  buyer_pays × rate + fixed.
 *   Platform nets: buyer_pays × (1 − rate) − fixed.
 *   We want platform_nets = base, so:
 *     buyer_pays × (1 − rate) − fixed = base
 *     buyer_pays = (base + fixed) / (1 − rate)
 *     surcharge  = buyer_pays − base
 *                = (base × rate + fixed) / (1 − rate)
 *
 *   `Math.ceil` always rounds UP so the platform never under-recovers
 *   on fractional-cent edges.
 *
 * **Rate constants:** legacy eunenem (`mini:~/projects/eunenem/src/lib/fees.ts`)
 * used 3.9% only (NO fixed fee). We mirror the percentage AND add the
 * R$ 0.39 fixed fee per current Stripe Brazil pricing — operator's
 * intent is "platform nets the gift price after Stripe's bite," which
 * the fixed-fee inclusion preserves at small gift sizes (R$ 0.39 is
 * ~0.87% effective at R$ 45, diminishing for larger gifts; ignoring
 * it would silently eat into platform margin on small contributions).
 *
 * When Stripe announces a rate change, bump the constants HERE — this
 * is the single source of truth for both the Stripe line item AND the
 * `obterListaPresentes.valorComTaxaCartao` display field (no
 * frontend/backend drift surface).
 *
 * **File placement (src/adapters/pagamentos/, NOT src/observability/):**
 * earlier iteration filed this under observability because the engine's
 * folder-structure rule (folder-structure.mjs) forbids `src/lib/`.
 * GLaDOS-feedback caught that observability is meant for OTel /
 * spans / metrics. This helper is Stripe-adjacent payment-domain
 * math — colocated with provider.stripe.ts (its only direct consumer
 * on the adapter side) so the rate constants travel with the adapter
 * that depends on them. The Taxas use-case imports it through the
 * adapters/ layer, which is a one-direction cross — and acceptable
 * because the engine permits use-case → adapter imports for
 * pure-function helpers (the depcruise rule guards against use-case
 * → adapter-IMPLEMENTATION imports, not pure-helper imports).
 */
export const STRIPE_CARD_RATE = 0.039 as const;
export const STRIPE_CARD_FIXED_CENTS = 39 as const; // R$ 0.39

export const SURCHARGE_LINE_ITEM_NAME = 'Taxa de processamento do cartão' as const;

/**
 * Compute the surcharge in cents for a given base amount.
 *
 * Returns 0 for non-positive inputs (no negative surcharge; defensive
 * guard if a downstream caller passes a zero-amount contribuicao —
 * the upstream zod schemas should reject these but defend in depth).
 */
export function computeCardSurchargeCents(baseAmountCents: MoneyCents): MoneyCents {
  if (baseAmountCents <= 0) return 0 as MoneyCents;
  return Math.ceil(
    (baseAmountCents * STRIPE_CARD_RATE + STRIPE_CARD_FIXED_CENTS) / (1 - STRIPE_CARD_RATE),
  ) as MoneyCents;
}
