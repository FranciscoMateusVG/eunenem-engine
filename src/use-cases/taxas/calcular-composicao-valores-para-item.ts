import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ProvedorRegraTaxa } from '../../adapters/taxas/regra-provider.js';
import { MoneyCentsSchema } from '../../domain/money.js';
import type { IdContribuicaoPagamento } from '../../domain/pagamentos/value-objects/ids.js';
import type { SnapshotComposicaoValoresItemContribuicao } from '../../domain/pagamentos/value-objects/snapshot-composicao-valores-item.js';
import { obterTarifaPorTipo } from '../../domain/taxas/entities/regra-taxa.js';
import { calcularComposicaoValores as calcularComposicaoValoresDominio } from '../../domain/taxas/value-objects/composicao-valores.js';
import {
  IdContribuicaoReferenciaSchema,
  IdPlataformaReferenciaSchema,
} from '../../domain/taxas/value-objects/ids.js';
import { TipoOpcaoContribuicaoReferenciaSchema } from '../../domain/taxas/value-objects/tarifa-tipo.js';
import { TaxasInputInvalidoError } from '../../errors/taxas/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Plan 0016 Phase 2 (aperture-eg1s2). Per-item composição computation.
 * Replaces the pre-0016 `calcularComposicaoValores` which returned a
 * single root-level `ComposicaoValores` (with surcharge baked in). The
 * new shape:
 *   - per-unit math (fee per unit, receiver per unit)
 *   - × quantidade → per-line denormalised totals
 *   - surcharge HANDLED ELSEWHERE: see `calcularSurchargeParaCarrinho`
 *     for the cart-wide surcharge item (PIX flows have none; cartão
 *     flows have exactly one across the whole cart).
 *
 * Returns the per-item snapshot conforming to
 * `SnapshotComposicaoValoresItemContribuicao` — the per-item VO from
 * `src/domain/pagamentos/value-objects/snapshot-composicao-valores-item.ts`.
 */
export const CalcularComposicaoValoresParaItemInputSchema = z.object({
  idPlataforma: IdPlataformaReferenciaSchema,
  idContribuicao: IdContribuicaoReferenciaSchema,
  tipo: TipoOpcaoContribuicaoReferenciaSchema,
  /**
   * The contribuição's intrinsic price PER UNIT (one slot's intrinsic
   * value — sourced from `contribuicao.valor`). Multiplied by quantidade
   * to get the per-line denormalised totals.
   */
  contributionUnitAmountCents: MoneyCentsSchema,
  quantidade: z.number().int().positive(),
});

export type CalcularComposicaoValoresParaItemInput = z.infer<
  typeof CalcularComposicaoValoresParaItemInputSchema
>;

export interface CalcularComposicaoValoresParaItemDeps {
  readonly provedorRegraTaxa: ProvedorRegraTaxa;
  readonly observability: Observability;
}

export async function calcularComposicaoValoresParaItem(
  deps: CalcularComposicaoValoresParaItemDeps,
  input: CalcularComposicaoValoresParaItemInput,
): Promise<SnapshotComposicaoValoresItemContribuicao> {
  const { provedorRegraTaxa, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('calcularComposicaoValoresParaItem', async (span) => {
    try {
      const parsedInput = CalcularComposicaoValoresParaItemInputSchema.safeParse(input);
      if (!parsedInput.success) {
        const message = parsedInput.error.issues.map((i) => i.message).join('; ');
        throw new TaxasInputInvalidoError(message);
      }

      const { idPlataforma, idContribuicao, tipo, contributionUnitAmountCents, quantidade } =
        parsedInput.data;

      span.setAttributes({
        'taxas.plataforma.id': idPlataforma,
        'taxas.contribuicao.id': idContribuicao,
        'taxas.contribuicao.tipo': tipo,
        'taxas.item.contribution_unit_amount_cents': contributionUnitAmountCents,
        'taxas.item.quantidade': quantidade,
      });

      const regraAtiva = await provedorRegraTaxa.getRegraAtiva(idPlataforma);
      const tarifa = obterTarifaPorTipo(regraAtiva, tipo);

      // Per-unit math: compute the unit-level composição using the
      // existing domain calc with surchargeCents=0 (surcharge is a
      // cart-wide item now, not per-unit).
      const unit = calcularComposicaoValoresDominio(tarifa, {
        idContribuicao,
        contributionAmountCents: contributionUnitAmountCents,
        surchargeCents: 0,
      });

      const result: SnapshotComposicaoValoresItemContribuicao = {
        tipo: 'contribuicao',
        idContribuicao: idContribuicao as unknown as IdContribuicaoPagamento,
        quantidade,
        contributionUnitAmountCents: unit.contributionAmountCents,
        feeUnitAmountCents: unit.feeAmountCents,
        receiverUnitAmountCents: unit.receiverAmountCents,
        lineContributionAmountCents: (unit.contributionAmountCents * quantidade) as never,
        lineFeeAmountCents: (unit.feeAmountCents * quantidade) as never,
        lineReceiverAmountCents: (unit.receiverAmountCents * quantidade) as never,
      };

      logger.info('taxas.composicao_item.calculada', {
        idPlataforma,
        idContribuicao,
        tipo,
        contributionUnitAmountCents: result.contributionUnitAmountCents,
        feeUnitAmountCents: result.feeUnitAmountCents,
        receiverUnitAmountCents: result.receiverUnitAmountCents,
        quantidade,
        lineContributionAmountCents: result.lineContributionAmountCents,
        lineFeeAmountCents: result.lineFeeAmountCents,
        lineReceiverAmountCents: result.lineReceiverAmountCents,
      });

      span.setAttributes({
        'taxas.item.fee_unit_amount_cents': result.feeUnitAmountCents,
        'taxas.item.line_contribution_amount_cents': result.lineContributionAmountCents,
        'taxas.item.line_fee_amount_cents': result.lineFeeAmountCents,
      });
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
