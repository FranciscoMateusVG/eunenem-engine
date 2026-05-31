import { describe, expect, it } from 'vitest';
import { ID_PLATAFORMA_EUNENEM } from '../../../src/adapters/plataforma/repository.memory.js';
import {
  criarRegraTaxa,
  obterTarifaPorTipo,
} from '../../../src/domain/taxas/entities/regra-taxa.js';
import { calcularValorTaxaPercentual } from '../../../src/domain/taxas/value-objects/calculo-taxa.js';
import { calcularComposicaoValores } from '../../../src/domain/taxas/value-objects/composicao-valores.js';
import {
  type TarifaTipo,
  TarifaTipoSchema,
} from '../../../src/domain/taxas/value-objects/tarifa-tipo.js';
import { CalcularComposicaoValoresInputSchema } from '../../../src/use-cases/taxas/calcular-composicao-valores.js';

const idContribuicao = '550e8400-e29b-41d4-a716-446655440020';

const TARIFA_EUNENEM_PRESENTE: TarifaTipo = {
  percentageBps: 500,
  responsavelTaxa: 'contribuinte',
};

describe('TarifaTipoSchema', () => {
  it('accepts the canonical contribuinte-paid tarifa', () => {
    expect(TarifaTipoSchema.safeParse(TARIFA_EUNENEM_PRESENTE).success).toBe(true);
  });

  it('rejects a tarifa where the recebedor pays the fee (out of current model)', () => {
    expect(
      TarifaTipoSchema.safeParse({
        percentageBps: 500,
        responsavelTaxa: 'recebedor',
      }).success,
    ).toBe(false);
  });

  it('rejects negative or zero percentageBps', () => {
    expect(
      TarifaTipoSchema.safeParse({ percentageBps: 0, responsavelTaxa: 'contribuinte' }).success,
    ).toBe(false);
    expect(
      TarifaTipoSchema.safeParse({ percentageBps: -1, responsavelTaxa: 'contribuinte' }).success,
    ).toBe(false);
  });
});

describe('criarRegraTaxa + obterTarifaPorTipo', () => {
  const regra = criarRegraTaxa({
    id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    tarifasPorTipo: {
      presente: TARIFA_EUNENEM_PRESENTE,
      rifa: { percentageBps: 800, responsavelTaxa: 'contribuinte' },
      convite: { percentageBps: 800, responsavelTaxa: 'contribuinte' },
    },
    criadaEm: new Date('2026-01-01T00:00:00.000Z'),
  });

  it('returns the tarifa for each configured tipo', () => {
    expect(obterTarifaPorTipo(regra, 'presente')).toEqual(TARIFA_EUNENEM_PRESENTE);
    expect(obterTarifaPorTipo(regra, 'rifa')).toEqual({
      percentageBps: 800,
      responsavelTaxa: 'contribuinte',
    });
    expect(obterTarifaPorTipo(regra, 'convite')).toEqual({
      percentageBps: 800,
      responsavelTaxa: 'contribuinte',
    });
  });
});

describe('CalcularComposicaoValoresInputSchema', () => {
  const validInput = {
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    idContribuicao,
    tipo: 'presente' as const,
    contributionAmountCents: 8000,
  };

  it('accepts a complete input', () => {
    expect(CalcularComposicaoValoresInputSchema.safeParse(validInput).success).toBe(true);
  });

  it('rejects zero, negative and non-integer contribution amounts', () => {
    expect(
      CalcularComposicaoValoresInputSchema.safeParse({ ...validInput, contributionAmountCents: 0 })
        .success,
    ).toBe(false);
    expect(
      CalcularComposicaoValoresInputSchema.safeParse({ ...validInput, contributionAmountCents: -1 })
        .success,
    ).toBe(false);
    expect(
      CalcularComposicaoValoresInputSchema.safeParse({
        ...validInput,
        contributionAmountCents: 10.5,
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown tipo', () => {
    expect(
      CalcularComposicaoValoresInputSchema.safeParse({ ...validInput, tipo: 'mystery' }).success,
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

describe('calcularComposicaoValores (domain pure)', () => {
  it('builds the canonical value composition from a TarifaTipo', () => {
    const composicao = calcularComposicaoValores(TARIFA_EUNENEM_PRESENTE, {
      idContribuicao,
      contributionAmountCents: 8000,
    });

    expect(composicao).toEqual({
      idContribuicao,
      contributionAmountCents: 8000,
      feeAmountCents: 400,
      surchargeCents: 0,
      totalPaidCents: 8400,
      receiverAmountCents: 8000,
      responsavelTaxa: 'contribuinte',
    });
  });

  it('keeps the receiver amount equal to the contribution amount', () => {
    const composicao = calcularComposicaoValores(TARIFA_EUNENEM_PRESENTE, {
      idContribuicao,
      contributionAmountCents: 8000,
    });

    expect(composicao.receiverAmountCents).toBe(composicao.contributionAmountCents);
    expect(composicao.totalPaidCents).toBe(
      composicao.contributionAmountCents + composicao.feeAmountCents,
    );
  });
});
