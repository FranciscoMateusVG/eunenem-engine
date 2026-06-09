import { describe, expect, it } from 'vitest';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
} from '../../../src/adapters/plataforma/repository.memory.js';
import { ProvedorRegraTaxaMemory } from '../../../src/adapters/taxas/regra-provider.memory.js';
import { TaxasInputInvalidoError } from '../../../src/errors/taxas/input-invalido.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { calcularComposicaoValoresParaItem } from '../../../src/use-cases/taxas/calcular-composicao-valores-para-item.js';

/**
 * Plan 0016 Phase 2 (aperture-eg1s2) rewrite. The pre-0016
 * `calcularComposicaoValores` use-case was replaced by two use-cases:
 *   - `calcularComposicaoValoresParaItem` (per-item math; this file)
 *   - `calcularSurchargeParaCarrinho` (cart-wide surcharge; sibling tests)
 *
 * These tests pin the platform-fee-rule behavior (eunenem 5%, eucasei 6%
 * presente / 8% rifa) onto the per-item shape. The new use-case returns
 * a `SnapshotComposicaoValoresItemContribuicao` (per-unit + per-line
 * denormalised totals) rather than the pre-0016 single
 * `ComposicaoValores`.
 */

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const idContribuicao = '550e8400-e29b-41d4-a716-446655440021';

describe('calcularComposicaoValoresParaItem', () => {
  it('applies the eunenem 5 percent rule for a presente (quantidade=1)', async () => {
    const provedorRegraTaxa = new ProvedorRegraTaxaMemory();

    const composicao = await calcularComposicaoValoresParaItem(
      { provedorRegraTaxa, observability: silentObservability },
      {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idContribuicao,
        tipo: 'presente',
        contributionUnitAmountCents: 8000,
        quantidade: 1,
      },
    );

    expect(composicao).toEqual({
      tipo: 'contribuicao',
      idContribuicao,
      quantidade: 1,
      contributionUnitAmountCents: 8000,
      feeUnitAmountCents: 400,
      receiverUnitAmountCents: 8000,
      lineContributionAmountCents: 8000,
      lineFeeAmountCents: 400,
      lineReceiverAmountCents: 8000,
    });
  });

  it('applies the eucasei 6 percent rule for a presente', async () => {
    const provedorRegraTaxa = new ProvedorRegraTaxaMemory();

    const composicao = await calcularComposicaoValoresParaItem(
      { provedorRegraTaxa, observability: silentObservability },
      {
        idPlataforma: ID_PLATAFORMA_EUCASEI,
        idContribuicao,
        tipo: 'presente',
        contributionUnitAmountCents: 8000,
        quantidade: 1,
      },
    );

    expect(composicao.feeUnitAmountCents).toBe(480);
    expect(composicao.lineFeeAmountCents).toBe(480);
    expect(composicao.receiverUnitAmountCents).toBe(8000);
    expect(composicao.lineReceiverAmountCents).toBe(8000);
  });

  it('applies the eucasei 8 percent rule for a rifa', async () => {
    const provedorRegraTaxa = new ProvedorRegraTaxaMemory();

    const composicao = await calcularComposicaoValoresParaItem(
      { provedorRegraTaxa, observability: silentObservability },
      {
        idPlataforma: ID_PLATAFORMA_EUCASEI,
        idContribuicao,
        tipo: 'rifa',
        contributionUnitAmountCents: 8000,
        quantidade: 1,
      },
    );

    expect(composicao.feeUnitAmountCents).toBe(640);
    expect(composicao.lineFeeAmountCents).toBe(640);
  });

  it('denormalises per-line totals as unit × quantidade', async () => {
    const provedorRegraTaxa = new ProvedorRegraTaxaMemory();

    const composicao = await calcularComposicaoValoresParaItem(
      { provedorRegraTaxa, observability: silentObservability },
      {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idContribuicao,
        tipo: 'presente',
        contributionUnitAmountCents: 8000,
        quantidade: 3,
      },
    );

    expect(composicao.quantidade).toBe(3);
    expect(composicao.contributionUnitAmountCents).toBe(8000);
    expect(composicao.feeUnitAmountCents).toBe(400);
    expect(composicao.receiverUnitAmountCents).toBe(8000);
    expect(composicao.lineContributionAmountCents).toBe(24000);
    expect(composicao.lineFeeAmountCents).toBe(1200);
    expect(composicao.lineReceiverAmountCents).toBe(24000);
  });

  it('yields distinct fees for the same amount across plataformas', async () => {
    const provedorRegraTaxa = new ProvedorRegraTaxaMemory();
    const baseInput = {
      idContribuicao,
      tipo: 'presente' as const,
      contributionUnitAmountCents: 8000,
      quantidade: 1,
    };

    const eunenem = await calcularComposicaoValoresParaItem(
      { provedorRegraTaxa, observability: silentObservability },
      { ...baseInput, idPlataforma: ID_PLATAFORMA_EUNENEM },
    );
    const eucasei = await calcularComposicaoValoresParaItem(
      { provedorRegraTaxa, observability: silentObservability },
      { ...baseInput, idPlataforma: ID_PLATAFORMA_EUCASEI },
    );

    expect(eunenem.feeUnitAmountCents).toBe(400);
    expect(eucasei.feeUnitAmountCents).toBe(480);
    expect(eucasei.feeUnitAmountCents).toBeGreaterThan(eunenem.feeUnitAmountCents);
  });

  it('throws TaxasInputInvalidoError for invalid input (zero contribution)', async () => {
    const provedorRegraTaxa = new ProvedorRegraTaxaMemory();

    await expect(
      calcularComposicaoValoresParaItem(
        { provedorRegraTaxa, observability: silentObservability },
        {
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          idContribuicao,
          tipo: 'presente',
          contributionUnitAmountCents: 0,
          quantidade: 1,
        },
      ),
    ).rejects.toThrow(TaxasInputInvalidoError);
  });

  it('throws TaxasInputInvalidoError for invalid input (zero quantidade)', async () => {
    const provedorRegraTaxa = new ProvedorRegraTaxaMemory();

    await expect(
      calcularComposicaoValoresParaItem(
        { provedorRegraTaxa, observability: silentObservability },
        {
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          idContribuicao,
          tipo: 'presente',
          contributionUnitAmountCents: 8000,
          quantidade: 0,
        },
      ),
    ).rejects.toThrow(TaxasInputInvalidoError);
  });
});
