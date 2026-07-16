import { describe, expect, it } from 'vitest';
import {
  computeCardSurchargeCents,
  STRIPE_CARD_FIXED_CENTS,
  STRIPE_CARD_RATE,
} from '../../../src/adapters/pagamentos/card-surcharge.js';
import type { MoneyCents } from '../../../src/domain/money.js';

/**
 * Exact-cents coverage for the card surcharge (aperture-e1z6b).
 *
 * `computeCardSurchargeCents` is the gross-up a card buyer pays so the platform
 * nets the gift price after Stripe's 3.9% + R$0.39 bite. It is the ONLY term of
 * the card buyer's total (base + platform fee + surcharge) with no cents-level
 * assertion anywhere — a rounding/rate regression silently over- or
 * under-charges EVERY card purchase and mis-nets the platform. This test pins
 * the intended model with independently-computed values (NOT the function's own
 * output), so a drift from (base×rate + fixed)/(1−rate) with Math.ceil fails.
 *
 * Expected values verified by hand against the documented formula:
 *   surcharge = ceil((base×0.039 + 39) / (1 − 0.039))
 */
const cents = (n: number) => n as MoneyCents;

describe('computeCardSurchargeCents — exact cents (Stripe BR 3.9% + R$0.39 gross-up)', () => {
  // base cents → expected surcharge cents (independently computed)
  const CASES: ReadonlyArray<readonly [number, number]> = [
    [100, 45], // R$1.00  → R$0.45
    [4500, 224], // R$45.00 → R$2.24
    [5000, 244], // R$50.00 → R$2.44
    [8000, 366], // R$80.00 → R$3.66
    [50000, 2070], // R$500   → R$20.70
    [100000, 4099], // R$1000  → R$40.99
  ];

  it.each(CASES)('base %i cents → surcharge %i cents', (base, expected) => {
    expect(computeCardSurchargeCents(cents(base))).toBe(expected);
  });

  it('rounds UP (ceil) so the platform never under-recovers on fractional cents', () => {
    // At base 8000 the exact quotient is 365.24…; ceil→366. A `Math.round`
    // regression would return 365 (under-recovery); a truncation would too.
    expect(computeCardSurchargeCents(cents(8000))).toBe(366);
    expect(computeCardSurchargeCents(cents(8000))).toBeGreaterThan(
      Math.round((8000 * STRIPE_CARD_RATE + STRIPE_CARD_FIXED_CENTS) / (1 - STRIPE_CARD_RATE)),
    );
  });

  it('includes the R$0.39 fixed fee (dropping it would under-charge)', () => {
    // Without the fixed fee, base 8000 → 325. WITH it → 366. Locks the
    // fixed-fee term against the legacy "3.9% only" regression.
    const withoutFixed = Math.ceil((8000 * STRIPE_CARD_RATE) / (1 - STRIPE_CARD_RATE));
    expect(withoutFixed).toBe(325);
    expect(computeCardSurchargeCents(cents(8000))).toBe(366);
    expect(computeCardSurchargeCents(cents(8000))).toBeGreaterThan(withoutFixed);
  });

  it('returns 0 for zero and negative bases (defensive guard, no negative surcharge)', () => {
    expect(computeCardSurchargeCents(cents(0))).toBe(0);
    expect(computeCardSurchargeCents(cents(-100))).toBe(0);
  });

  it('pins the rate constants (a silent constant bump must break a test)', () => {
    expect(STRIPE_CARD_RATE).toBe(0.039);
    expect(STRIPE_CARD_FIXED_CENTS).toBe(39);
  });
});
