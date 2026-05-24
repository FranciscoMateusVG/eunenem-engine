import { z } from 'zod/v4';
import type { MoneyCents } from '../../money.js';
import type { IdContribuicaoReferencia } from './ids.js';

/**
 * Value object: the active fee rule (percentual in basis points + responsible
 * party). Plus pure helpers `calcularValorTaxaPercentual` and `calcularTaxa`
 * that operate on the rule + a contribution amount.
 *
 * Equality is structural; no identity. Today only one rule exists
 * (`REGRA_TAXA_PADRAO` — 5% paid by the contribuinte).
 */

export const DEFAULT_FEE_PERCENTAGE_BPS = 500;

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

/** Intermediate fee calculation: the result of applying `RegraTaxa` to an amount. */
export interface CalculoTaxa {
  readonly idContribuicao: IdContribuicaoReferencia;
  readonly contributionAmountCents: MoneyCents;
  readonly feeAmountCents: MoneyCents;
  readonly responsavelTaxa: ResponsavelTaxa;
}

/** Domain-shaped input for `calcularTaxa` / `calcularComposicaoValores`. */
export interface DadosCalculoTaxa {
  readonly idContribuicao: IdContribuicaoReferencia;
  readonly contributionAmountCents: MoneyCents;
}

export function calcularValorTaxaPercentual(
  contributionAmountCents: MoneyCents,
  percentageBps: PercentualTaxaBps,
): MoneyCents {
  return Math.ceil((contributionAmountCents * percentageBps) / 10_000);
}

export function calcularTaxa(regra: RegraTaxa, input: DadosCalculoTaxa): CalculoTaxa {
  return {
    idContribuicao: input.idContribuicao,
    contributionAmountCents: input.contributionAmountCents,
    feeAmountCents: calcularValorTaxaPercentual(input.contributionAmountCents, regra.percentageBps),
    responsavelTaxa: regra.responsavelTaxa,
  };
}
