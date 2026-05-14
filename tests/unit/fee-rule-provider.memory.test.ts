import { describe, expect, it } from 'vitest';
import { FeeRuleProviderMemory } from '../../src/adapters/fee-rule-provider.memory.js';
import { DEFAULT_FEE_RULE } from '../../src/domain/fees.js';

describe('FeeRuleProviderMemory', () => {
  it('returns the default fixed 5 percent rule', async () => {
    const provider = new FeeRuleProviderMemory();

    await expect(provider.getActiveRule()).resolves.toEqual(DEFAULT_FEE_RULE);
  });

  it('returns a provided in-memory rule', async () => {
    const provider = new FeeRuleProviderMemory({
      percentageBps: 250,
      feePayer: 'contributor',
    });

    await expect(provider.getActiveRule()).resolves.toEqual({
      percentageBps: 250,
      feePayer: 'contributor',
    });
  });
});
