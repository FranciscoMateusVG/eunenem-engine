import { describe, expect, it } from 'vitest';
import { ProvedorRegraTaxaMemory } from '../../../src/adapters/taxas/regra-provider.memory.js';
import { REGRA_TAXA_PADRAO } from '../../../src/domain/taxas/value-objects/regra-taxa.js';

describe('ProvedorRegraTaxaMemory', () => {
  it('returns the default fixed 5 percent rule', async () => {
    const provider = new ProvedorRegraTaxaMemory();

    await expect(provider.getRegraAtiva()).resolves.toEqual(REGRA_TAXA_PADRAO);
  });

  it('returns a provided in-memory rule', async () => {
    const provider = new ProvedorRegraTaxaMemory({
      percentageBps: 250,
      responsavelTaxa: 'contribuinte',
    });

    await expect(provider.getRegraAtiva()).resolves.toEqual({
      percentageBps: 250,
      responsavelTaxa: 'contribuinte',
    });
  });
});
