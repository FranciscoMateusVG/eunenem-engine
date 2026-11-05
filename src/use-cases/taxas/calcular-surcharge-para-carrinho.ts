import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import { computeCardSurchargeCents } from '../../adapters/pagamentos/card-surcharge.js';
import { type MoneyCents, MoneyCentsSchema } from '../../domain/money.js';
import type { MetodoPagamento } from '../../domain/pagamentos/value-objects/metodo-pagamento.js';
import type { SnapshotComposicaoValoresItemSurcharge } from '../../domain/pagamentos/value-objects/snapshot-composicao-valores-item.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Plan 0016 Phase 2 (aperture-eg1s2). Cart-wide surcharge computation.
 *
 * Pre-0016 the surcharge was baked into `calcularComposicaoValores`
 * per-contribuição (aperture-uyw8i). With multi-item carts, the
 * processing surcharge is single per cart — not per-item — so it
 * lives in its own use-case sibling to `calcularComposicaoValoresParaItem`.
 *
 * PIX flows: returns `null` (no surcharge item).
 * Cartão flows: returns the `SnapshotComposicaoValoresItemSurcharge`
 * for the cart's gift + platform fee total (what Stripe actually
 * charges its percentage on).
 *
 * The surcharge item is the LAST item in the cart per operator review
 * lock #18 — the saga calling code is responsible for appending it
 * after the contribuição items.
 *
 * Locked decision #11 reminder: surcharge is its own ItemDoPagamento
 * (`tipo='passthrough_surcharge'`). The asymmetric pre-0016
 * `surchargeCents` field at IntencaoPagamento root retires.
 */

export const CalcularSurchargeParaCarrinhoInputSchema = z.object({
  /**
   * Sum of `contributionUnitAmountCents × quantidade` across all
   * contribuicao items in the cart (the gift amount, before fee).
   */
  totalContributionCents: MoneyCentsSchema,
  /**
   * Sum of the EuNeném platform fee across the cart. Stripe charges its
   * 3.9% + R$0.39 on the WHOLE charged total (gift + fee), so the surcharge
   * base is `totalContributionCents + totalFeeCents`.
   */
  totalFeeCents: MoneyCentsSchema,
  metodo: z.enum(['pix', 'credit_card']),
});

export type CalcularSurchargeParaCarrinhoInput = z.infer<
  typeof CalcularSurchargeParaCarrinhoInputSchema
>;

export interface CalcularSurchargeParaCarrinhoDeps {
  readonly observability: Observability;
}

export async function calcularSurchargeParaCarrinho(
  deps: CalcularSurchargeParaCarrinhoDeps,
  input: CalcularSurchargeParaCarrinhoInput,
): Promise<SnapshotComposicaoValoresItemSurcharge | null> {
  const { observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('calcularSurchargeParaCarrinho', async (span) => {
    try {
      const parsed = CalcularSurchargeParaCarrinhoInputSchema.parse(input);

      span.setAttributes({
        'taxas.cart.total_contribution_cents': parsed.totalContributionCents,
        'taxas.cart.total_fee_cents': parsed.totalFeeCents,
        'taxas.cart.metodo': parsed.metodo,
      });

      if (parsed.metodo !== 'credit_card') {
        span.setAttribute('taxas.cart.surcharge_cents', 0);
        span.setStatus({ code: SpanStatusCode.OK });
        return null;
      }

      const surchargeCents = computeCardSurchargeCents(
        (parsed.totalContributionCents + parsed.totalFeeCents) as MoneyCents,
      ) as MoneyCents;

      logger.info('taxas.cart.surcharge_calculada', {
        totalContributionCents: parsed.totalContributionCents,
        totalFeeCents: parsed.totalFeeCents,
        surchargeCents,
        metodo: parsed.metodo satisfies MetodoPagamento,
      });

      span.setAttribute('taxas.cart.surcharge_cents', surchargeCents);
      span.setStatus({ code: SpanStatusCode.OK });
      return {
        tipo: 'passthrough_surcharge' as const,
        amountCents: surchargeCents,
      };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
