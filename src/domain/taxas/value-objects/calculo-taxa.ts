import type { MoneyCents } from '../../money.js';
import type { IdContribuicaoReferencia } from './ids.js';
import type { PercentualTaxaBps, ResponsavelTaxa, TarifaTipo } from './tarifa-tipo.js';

/**
 * Pure calculation helpers for the Taxas BC: turn a TarifaTipo + a
 * contribution amount into a `CalculoTaxa` intermediate, which the
 * `composicao-valores` module then composes into the final
 * `ComposicaoValores`.
 *
 * These functions are stateless and do not know about RegraTaxa or
 * plataformas — they operate on a single TarifaTipo. The aggregate's
 * `obterTarifaPorTipo` query is what picks the TarifaTipo upstream.
 */

/** Intermediate fee calculation: the result of applying a TarifaTipo to an amount. */
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

export function calcularTaxa(tarifa: TarifaTipo, input: DadosCalculoTaxa): CalculoTaxa {
  return {
    idContribuicao: input.idContribuicao,
    contributionAmountCents: input.contributionAmountCents,
    feeAmountCents: calcularValorTaxaPercentual(
      input.contributionAmountCents,
      tarifa.percentageBps,
    ),
    responsavelTaxa: tarifa.responsavelTaxa,
  };
}
