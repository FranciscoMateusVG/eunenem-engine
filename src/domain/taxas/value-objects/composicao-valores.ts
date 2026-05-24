import type { MoneyCents } from '../../money.js';
import type { IdContribuicaoReferencia } from './ids.js';
import {
  type CalculoTaxa,
  calcularTaxa,
  type DadosCalculoTaxa,
  type RegraTaxa,
  type ResponsavelTaxa,
} from './regra-taxa.js';

/**
 * Value object: the immutable breakdown of values produced by the Taxas BC.
 *
 * Invariant: `totalPaidCents = contributionAmountCents + feeAmountCents` and
 * `receiverAmountCents = contributionAmountCents` (when the contribuinte pays
 * the fee). No identity; equality is structural.
 *
 * This snapshot is what crosses BC boundaries to Pagamentos and Financeiro.
 */
export interface ComposicaoValores {
  readonly idContribuicao: IdContribuicaoReferencia;
  readonly contributionAmountCents: MoneyCents;
  readonly feeAmountCents: MoneyCents;
  readonly totalPaidCents: MoneyCents;
  readonly receiverAmountCents: MoneyCents;
  readonly responsavelTaxa: ResponsavelTaxa;
}

export function comporComposicaoValores(calculo: CalculoTaxa): ComposicaoValores {
  return {
    ...calculo,
    totalPaidCents: calculo.contributionAmountCents + calculo.feeAmountCents,
    receiverAmountCents: calculo.contributionAmountCents,
  };
}

export function calcularComposicaoValores(
  regra: RegraTaxa,
  input: DadosCalculoTaxa,
): ComposicaoValores {
  return comporComposicaoValores(calcularTaxa(regra, input));
}
