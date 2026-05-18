import { z } from 'zod/v4';
import type { MoneyCents } from './money.js';
import { MoneyCentsSchema } from './money.js';

export const DEFAULT_FEE_PERCENTAGE_BPS = 500;

export const IdContribuicaoReferenciaSchema = z.uuid();
export type IdContribuicaoReferencia = z.infer<typeof IdContribuicaoReferenciaSchema>;

export const ResponsavelTaxaSchema = z.literal('contribuinte');
export type ResponsavelTaxa = z.infer<typeof ResponsavelTaxaSchema>;

export const PercentualTaxaBpsSchema = z.number().int().positive().max(10_000);
export type PercentualTaxaBps = z.infer<typeof PercentualTaxaBpsSchema>;

export const RegraTaxaSchema = z.object({
  percentageBps: PercentualTaxaBpsSchema,
  responsavelTaxa: ResponsavelTaxaSchema,
});

export type RegraTaxa = Readonly<z.infer<typeof RegraTaxaSchema>>;

export const REGRA_TAXA_PADRAO: RegraTaxa = {
  percentageBps: DEFAULT_FEE_PERCENTAGE_BPS,
  responsavelTaxa: 'contribuinte',
};

export const CalcularComposicaoValoresInputSchema = z.object({
  idContribuicao: IdContribuicaoReferenciaSchema,
  contributionAmountCents: MoneyCentsSchema,
});

export type CalcularComposicaoValoresInput = z.infer<typeof CalcularComposicaoValoresInputSchema>;

export interface CalculoTaxa {
  readonly idContribuicao: IdContribuicaoReferencia;
  readonly contributionAmountCents: MoneyCents;
  readonly feeAmountCents: MoneyCents;
  readonly responsavelTaxa: ResponsavelTaxa;
}

export interface ComposicaoValores {
  readonly idContribuicao: IdContribuicaoReferencia;
  readonly contributionAmountCents: MoneyCents;
  readonly feeAmountCents: MoneyCents;
  readonly totalPaidCents: MoneyCents;
  readonly receiverAmountCents: MoneyCents;
  readonly responsavelTaxa: ResponsavelTaxa;
}

export function calcularValorTaxaPercentual(
  contributionAmountCents: MoneyCents,
  percentageBps: PercentualTaxaBps,
): MoneyCents {
  MoneyCentsSchema.parse(contributionAmountCents);
  PercentualTaxaBpsSchema.parse(percentageBps);

  return Math.ceil((contributionAmountCents * percentageBps) / 10_000);
}

export function calcularTaxa(regra: RegraTaxa, input: CalcularComposicaoValoresInput): CalculoTaxa {
  const regraParsed = RegraTaxaSchema.parse(regra);
  const inputParsed = CalcularComposicaoValoresInputSchema.parse(input);

  return {
    idContribuicao: inputParsed.idContribuicao,
    contributionAmountCents: inputParsed.contributionAmountCents,
    feeAmountCents: calcularValorTaxaPercentual(
      inputParsed.contributionAmountCents,
      regraParsed.percentageBps,
    ),
    responsavelTaxa: regraParsed.responsavelTaxa,
  };
}

export function comporComposicaoValores(calculo: CalculoTaxa): ComposicaoValores {
  const calculoParsed = {
    idContribuicao: IdContribuicaoReferenciaSchema.parse(calculo.idContribuicao),
    contributionAmountCents: MoneyCentsSchema.parse(calculo.contributionAmountCents),
    feeAmountCents: MoneyCentsSchema.parse(calculo.feeAmountCents),
    responsavelTaxa: ResponsavelTaxaSchema.parse(calculo.responsavelTaxa),
  };

  return {
    ...calculoParsed,
    totalPaidCents: calculoParsed.contributionAmountCents + calculoParsed.feeAmountCents,
    receiverAmountCents: calculoParsed.contributionAmountCents,
  };
}

export function calcularComposicaoValores(
  regra: RegraTaxa,
  input: CalcularComposicaoValoresInput,
): ComposicaoValores {
  return comporComposicaoValores(calcularTaxa(regra, input));
}
