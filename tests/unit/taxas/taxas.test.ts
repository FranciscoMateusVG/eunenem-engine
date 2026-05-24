import { describe, expect, it } from 'vitest';
import { calcularComposicaoValores } from '../../../src/domain/taxas/value-objects/composicao-valores.js';
import {
  calcularValorTaxaPercentual,
  REGRA_TAXA_PADRAO,
  RegraTaxaSchema,
} from '../../../src/domain/taxas/value-objects/regra-taxa.js';
import { CalcularComposicaoValoresInputSchema } from '../../../src/use-cases/taxas/calcular-composicao-valores.js';

const idContribuicao = '550e8400-e29b-41d4-a716-446655440020';

describe('RegraTaxaSchema', () => {
  it('accepts the fixed 5 percent contributor-paid rule', () => {
    expect(RegraTaxaSchema.safeParse(REGRA_TAXA_PADRAO).success).toBe(true);
  });

  it('rejects a fee payer outside the current model', () => {
    const result = RegraTaxaSchema.safeParse({
      percentageBps: 500,
      responsavelTaxa: 'recebedor',
    });

    expect(result.success).toBe(false);
  });
});

describe('CalcularComposicaoValoresInputSchema', () => {
  it('accepts a positive contribution amount in cents', () => {
    const result = CalcularComposicaoValoresInputSchema.safeParse({
      idContribuicao,
      contributionAmountCents: 8000,
    });

    expect(result.success).toBe(true);
  });

  it('rejects zero, negative and non-integer contribution amounts', () => {
    expect(
      CalcularComposicaoValoresInputSchema.safeParse({
        idContribuicao,
        contributionAmountCents: 0,
      }).success,
    ).toBe(false);
    expect(
      CalcularComposicaoValoresInputSchema.safeParse({
        idContribuicao,
        contributionAmountCents: -1,
      }).success,
    ).toBe(false);
    expect(
      CalcularComposicaoValoresInputSchema.safeParse({
        idContribuicao,
        contributionAmountCents: 10.5,
      }).success,
    ).toBe(false);
  });
});

describe('calcularValorTaxaPercentual', () => {
  it('calculates 5 percent for the canonical R$ 80 contribution', () => {
    expect(calcularValorTaxaPercentual(8000, 500)).toBe(400);
  });

  it('rounds fractional cents up', () => {
    expect(calcularValorTaxaPercentual(101, 500)).toBe(6);
  });
});

describe('calcularComposicaoValores', () => {
  it('builds the canonical value composition', () => {
    const composicao = calcularComposicaoValores(REGRA_TAXA_PADRAO, {
      idContribuicao,
      contributionAmountCents: 8000,
    });

    expect(composicao).toEqual({
      idContribuicao,
      contributionAmountCents: 8000,
      feeAmountCents: 400,
      totalPaidCents: 8400,
      receiverAmountCents: 8000,
      responsavelTaxa: 'contribuinte',
    });
  });

  it('keeps the receiver amount equal to the contribution amount', () => {
    const composicao = calcularComposicaoValores(REGRA_TAXA_PADRAO, {
      idContribuicao,
      contributionAmountCents: 8000,
    });

    expect(composicao.receiverAmountCents).toBe(composicao.contributionAmountCents);
    expect(composicao.totalPaidCents).toBe(
      composicao.contributionAmountCents + composicao.feeAmountCents,
    );
  });
});
