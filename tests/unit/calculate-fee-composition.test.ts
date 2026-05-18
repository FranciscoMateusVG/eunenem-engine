import { describe, expect, it } from 'vitest';
import type { ProvedorRegraTaxa } from '../../src/adapters/taxas-regra-provider.js';
import { ProvedorRegraTaxaMemory } from '../../src/adapters/taxas-regra-provider.memory.js';
import type { RegraTaxa } from '../../src/domain/taxas.js';
import { TaxasInputInvalidoError } from '../../src/errors/taxas-input-invalido.error.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { calcularComposicaoValores } from '../../src/use-cases/calcular-composicao-valores.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const idContribuicao = '550e8400-e29b-41d4-a716-446655440021';

describe('calcularComposicaoValores', () => {
  it('returns the canonical value composition using the memory rule provider', async () => {
    const provedorRegraTaxa = new ProvedorRegraTaxaMemory();

    const composicao = await calcularComposicaoValores(
      { provedorRegraTaxa, observability: silentObservability },
      {
        idContribuicao,
        contributionAmountCents: 8000,
      },
    );

    expect(composicao).toEqual({
      idContribuicao,
      contributionAmountCents: 8000,
      feeAmountCents: 400,
      totalPaidCents: 8400,
      receiverAmountCents: 8000,
      responsavelTaxa: 'contribuinte',
    });
  });

  it('throws TaxasInputInvalidoError for invalid input', async () => {
    const provedorRegraTaxa = new ProvedorRegraTaxaMemory();

    await expect(
      calcularComposicaoValores(
        { provedorRegraTaxa, observability: silentObservability },
        {
          idContribuicao,
          contributionAmountCents: 0,
        },
      ),
    ).rejects.toThrow(TaxasInputInvalidoError);
  });

  it('throws TaxasInputInvalidoError for an invalid active rule', async () => {
    const provedorRegraTaxa: ProvedorRegraTaxa = {
      async getRegraAtiva(): Promise<RegraTaxa> {
        return { percentageBps: 0, responsavelTaxa: 'contribuinte' } as RegraTaxa;
      },
    };

    await expect(
      calcularComposicaoValores(
        { provedorRegraTaxa, observability: silentObservability },
        {
          idContribuicao,
          contributionAmountCents: 8000,
        },
      ),
    ).rejects.toThrow(TaxasInputInvalidoError);
  });
});
