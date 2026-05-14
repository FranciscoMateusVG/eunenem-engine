import { describe, expect, it } from 'vitest';
import {
  CalculateFeeCompositionInputSchema,
  calculatePercentageFeeAmount,
  calculateValueComposition,
  DEFAULT_FEE_RULE,
  FeeRuleSchema,
} from '../../src/domain/fees.js';

const contributionId = '550e8400-e29b-41d4-a716-446655440020';

describe('FeeRuleSchema', () => {
  it('accepts the fixed 5 percent contributor-paid rule', () => {
    expect(FeeRuleSchema.safeParse(DEFAULT_FEE_RULE).success).toBe(true);
  });

  it('rejects a fee payer outside the current model', () => {
    const result = FeeRuleSchema.safeParse({
      percentageBps: 500,
      feePayer: 'receiver',
    });

    expect(result.success).toBe(false);
  });
});

describe('CalculateFeeCompositionInputSchema', () => {
  it('accepts a positive contribution amount in cents', () => {
    const result = CalculateFeeCompositionInputSchema.safeParse({
      contributionId,
      contributionAmountCents: 8000,
    });

    expect(result.success).toBe(true);
  });

  it('rejects zero, negative and non-integer contribution amounts', () => {
    expect(
      CalculateFeeCompositionInputSchema.safeParse({
        contributionId,
        contributionAmountCents: 0,
      }).success,
    ).toBe(false);
    expect(
      CalculateFeeCompositionInputSchema.safeParse({
        contributionId,
        contributionAmountCents: -1,
      }).success,
    ).toBe(false);
    expect(
      CalculateFeeCompositionInputSchema.safeParse({
        contributionId,
        contributionAmountCents: 10.5,
      }).success,
    ).toBe(false);
  });
});

describe('calculatePercentageFeeAmount', () => {
  it('calculates 5 percent for the canonical R$ 80 contribution', () => {
    expect(calculatePercentageFeeAmount(8000, 500)).toBe(400);
  });

  it('rounds fractional cents up', () => {
    expect(calculatePercentageFeeAmount(101, 500)).toBe(6);
  });
});

describe('calculateValueComposition', () => {
  it('builds the canonical value composition', () => {
    const composition = calculateValueComposition(DEFAULT_FEE_RULE, {
      contributionId,
      contributionAmountCents: 8000,
    });

    expect(composition).toEqual({
      contributionId,
      contributionAmountCents: 8000,
      feeAmountCents: 400,
      totalPaidCents: 8400,
      receiverAmountCents: 8000,
      feePayer: 'contributor',
    });
  });

  it('keeps the receiver amount equal to the contribution amount', () => {
    const composition = calculateValueComposition(DEFAULT_FEE_RULE, {
      contributionId,
      contributionAmountCents: 8000,
    });

    expect(composition.receiverAmountCents).toBe(composition.contributionAmountCents);
    expect(composition.totalPaidCents).toBe(
      composition.contributionAmountCents + composition.feeAmountCents,
    );
  });
});
