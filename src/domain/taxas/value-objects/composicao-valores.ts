import type { MoneyCents } from '../../money.js';
import { type CalculoTaxa, calcularTaxa, type DadosCalculoTaxa } from './calculo-taxa.js';
import type { IdContribuicaoReferencia } from './ids.js';
import type { ResponsavelTaxa, TarifaTipo } from './tarifa-tipo.js';

/**
 * Value object: the immutable breakdown of values produced by the Taxas BC.
 *
 * Invariant (aperture-uyw8i extended):
 *   `totalPaidCents = contributionAmountCents + feeAmountCents + surchargeCents`
 *   `receiverAmountCents = contributionAmountCents` (when the contribuinte
 *      pays the fee — unchanged)
 *   `feeAmountCents` computed from `contributionAmountCents × tarifa.percentageBps`
 *      (NOT from the gross — platform fee base is the gift price, not the
 *      surcharge-inclusive total). This means eunenem revenue receipts net
 *      out to the intended rate regardless of provider surcharge.
 *
 * No identity; equality is structural. This snapshot crosses BC boundaries
 * to Pagamentos and Financeiro.
 *
 * **`surchargeCents`** is the buyer-paid provider gross-up (e.g. Stripe
 * 3.9% + R$0.39 card surcharge). Zero for Pix or non-surcharge providers.
 * Excluded from the platform-fee base — added on top of totalPaidCents
 * so the buyer's actual charge matches what Stripe captures.
 */
export interface ComposicaoValores {
  readonly idContribuicao: IdContribuicaoReferencia;
  readonly contributionAmountCents: MoneyCents;
  readonly feeAmountCents: MoneyCents;
  readonly surchargeCents: number;
  readonly totalPaidCents: MoneyCents;
  readonly receiverAmountCents: MoneyCents;
  readonly responsavelTaxa: ResponsavelTaxa;
}

export function comporComposicaoValores(calculo: CalculoTaxa): ComposicaoValores {
  return {
    ...calculo,
    totalPaidCents: (calculo.contributionAmountCents +
      calculo.feeAmountCents +
      calculo.surchargeCents) as MoneyCents,
    receiverAmountCents: calculo.contributionAmountCents,
  };
}

export function calcularComposicaoValores(
  tarifa: TarifaTipo,
  input: DadosCalculoTaxa,
): ComposicaoValores {
  return comporComposicaoValores(calcularTaxa(tarifa, input));
}
