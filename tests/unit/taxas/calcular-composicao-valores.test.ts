import { describe, expect, it } from 'vitest';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
} from '../../../src/adapters/plataforma/repository.memory.js';
import { ProvedorRegraTaxaMemory } from '../../../src/adapters/taxas/regra-provider.memory.js';
import { TaxasInputInvalidoError } from '../../../src/errors/taxas/input-invalido.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { calcularComposicaoValores } from '../../../src/use-cases/taxas/calcular-composicao-valores.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const idContribuicao = '550e8400-e29b-41d4-a716-446655440021';

describe('calcularComposicaoValores', () => {
  it('applies the eunenem 5 percent rule for a presente', async () => {
    const provedorRegraTaxa = new ProvedorRegraTaxaMemory();

    const composicao = await calcularComposicaoValores(
      { provedorRegraTaxa, observability: silentObservability },
      {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idContribuicao,
        tipo: 'presente',
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

  it('applies the eucasei 6 percent rule for a presente', async () => {
    const provedorRegraTaxa = new ProvedorRegraTaxaMemory();

    const composicao = await calcularComposicaoValores(
      { provedorRegraTaxa, observability: silentObservability },
      {
        idPlataforma: ID_PLATAFORMA_EUCASEI,
        idContribuicao,
        tipo: 'presente',
        contributionAmountCents: 8000,
      },
    );

    expect(composicao.feeAmountCents).toBe(480);
    expect(composicao.totalPaidCents).toBe(8480);
    expect(composicao.receiverAmountCents).toBe(8000);
  });

  it('applies the eucasei 8 percent rule for a rifa', async () => {
    const provedorRegraTaxa = new ProvedorRegraTaxaMemory();

    const composicao = await calcularComposicaoValores(
      { provedorRegraTaxa, observability: silentObservability },
      {
        idPlataforma: ID_PLATAFORMA_EUCASEI,
        idContribuicao,
        tipo: 'rifa',
        contributionAmountCents: 8000,
      },
    );

    expect(composicao.feeAmountCents).toBe(640);
    expect(composicao.totalPaidCents).toBe(8640);
  });

  it('yields distinct fees for the same amount across plataformas', async () => {
    const provedorRegraTaxa = new ProvedorRegraTaxaMemory();
    const baseInput = {
      idContribuicao,
      tipo: 'presente' as const,
      contributionAmountCents: 8000,
    };

    const eunenem = await calcularComposicaoValores(
      { provedorRegraTaxa, observability: silentObservability },
      { ...baseInput, idPlataforma: ID_PLATAFORMA_EUNENEM },
    );
    const eucasei = await calcularComposicaoValores(
      { provedorRegraTaxa, observability: silentObservability },
      { ...baseInput, idPlataforma: ID_PLATAFORMA_EUCASEI },
    );

    expect(eunenem.feeAmountCents).toBe(400);
    expect(eucasei.feeAmountCents).toBe(480);
    expect(eucasei.feeAmountCents).toBeGreaterThan(eunenem.feeAmountCents);
  });

  it('throws TaxasInputInvalidoError for invalid input', async () => {
    const provedorRegraTaxa = new ProvedorRegraTaxaMemory();

    await expect(
      calcularComposicaoValores(
        { provedorRegraTaxa, observability: silentObservability },
        {
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          idContribuicao,
          tipo: 'presente',
          contributionAmountCents: 0,
        },
      ),
    ).rejects.toThrow(TaxasInputInvalidoError);
  });
});
