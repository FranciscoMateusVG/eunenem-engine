import { describe, expect, it } from 'vitest';
import type { FeeRuleProvider } from '../../src/adapters/fee-rule-provider.js';
import { FeeRuleProviderMemory } from '../../src/adapters/fee-rule-provider.memory.js';
import type { FeeRule } from '../../src/domain/fees.js';
import { FeesInvalidInputError } from '../../src/errors/fees-invalid-input.error.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { calculateFeeComposition } from '../../src/use-cases/calculate-fee-composition.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const contributionId = '550e8400-e29b-41d4-a716-446655440021';

describe('calculateFeeComposition', () => {
  it('returns the canonical value composition using the memory rule provider', async () => {
    const feeRuleProvider = new FeeRuleProviderMemory();

    const composition = await calculateFeeComposition(
      { feeRuleProvider, observability: silentObservability },
      {
        contributionId,
        contributionAmountCents: 8000,
      },
    );

    expect(composition).toEqual({
      contributionId,
      contributionAmountCents: 8000,
      feeAmountCents: 400,
      totalPaidCents: 8400,
      receiverAmountCents: 8000,
      feePayer: 'contributor',
    });
  });

  it('throws FeesInvalidInputError for invalid input', async () => {
    const feeRuleProvider = new FeeRuleProviderMemory();

    await expect(
      calculateFeeComposition(
        { feeRuleProvider, observability: silentObservability },
        {
          contributionId,
          contributionAmountCents: 0,
        },
      ),
    ).rejects.toThrow(FeesInvalidInputError);
  });

  it('throws FeesInvalidInputError for an invalid active rule', async () => {
    const feeRuleProvider: FeeRuleProvider = {
      async getActiveRule(): Promise<FeeRule> {
        return { percentageBps: 0, feePayer: 'contributor' } as FeeRule;
      },
    };

    await expect(
      calculateFeeComposition(
        { feeRuleProvider, observability: silentObservability },
        {
          contributionId,
          contributionAmountCents: 8000,
        },
      ),
    ).rejects.toThrow(FeesInvalidInputError);
  });
});
