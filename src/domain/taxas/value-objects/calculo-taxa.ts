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
  /**
   * Provider-specific buyer-paid surcharge (aperture-uyw8i). For Stripe
   * card payments this is the 3.9% + R$0.39 gross-up so platform fee
   * receipts net out to the intended base. Zero for Pix or when the
   * provider has no per-transaction surcharge. Excluded from the
   * platform-fee base — eunenemFee is still computed on
   * contributionAmountCents.
   */
  /** Surcharge cents — non-negative integer. NOT typed as MoneyCents
   *  because MoneyCents requires positive(); surcharge can be 0 (Pix). */
  readonly surchargeCents: number;
  readonly responsavelTaxa: ResponsavelTaxa;
}

/** Domain-shaped input for `calcularTaxa` / `calcularComposicaoValores`. */
export interface DadosCalculoTaxa {
  readonly idContribuicao: IdContribuicaoReferencia;
  readonly contributionAmountCents: MoneyCents;
  /**
   * Optional surcharge to include in the composicao (aperture-uyw8i).
   * Computed upstream by the surcharge calculator when the payment
   * provider charges a per-transaction gross-up (Stripe card).
   * Defaults to 0 — Pix flows and non-surcharge providers omit this.
   */
  readonly surchargeCents?: number;
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
    // surchargeCents passes through verbatim — surcharge is a provider
    // concern (Stripe gross-up) computed upstream, NOT a domain fee
    // concern. Always non-negative; defaults to 0 when caller omits.
    surchargeCents: input.surchargeCents ?? 0,
    responsavelTaxa: tarifa.responsavelTaxa,
  };
}
