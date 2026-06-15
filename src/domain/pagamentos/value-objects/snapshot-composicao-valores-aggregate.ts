import { z } from 'zod/v4';
import { IdCampanhaSchema } from '../../arrecadacao/value-objects/ids.js';
import { MoneyCentsNonNegativeSchema, MoneyCentsSchema } from '../../money.js';
import type { SnapshotComposicaoValoresItem } from './snapshot-composicao-valores-item.js';

/**
 * Plan 0016 (aperture-aj8qw): aggregate composição snapshot at the
 * IntencaoPagamento root. Sum across all items of the cart, denormalised
 * at intent-creation for read-path simplicity.
 *
 * Replaces (with the per-item VO) the single `SnapshotComposicaoValores`
 * that lived at root pre-0016. The book-balance invariant moves from
 * "totalPaid = receiver + fee + surcharge" (pagamento-level) to
 * "totalPaid = SUM(item totals)" (cart-level) per locked decision #11.
 *
 * Carries `idCampanha` as the cart-scope invariant carrier — all items
 * in a cart share the same campanha (locked decision #8). Hoisted from
 * items at intent-creation; redundant at runtime but stored explicitly
 * so the read path doesn't have to traverse items to find the campanha.
 *
 * `responsavelTaxa` is intrinsic to the snapshot — same one-of literal
 * (`'contribuinte'`) as the pre-0016 shape.
 */

export const ResponsavelTaxaPagamentoSchema = z.literal('contribuinte');
export type ResponsavelTaxaPagamento = z.infer<typeof ResponsavelTaxaPagamentoSchema>;

export const SnapshotComposicaoValoresAggregateSchema = z.object({
  idCampanha: IdCampanhaSchema,
  totalContributionCents: MoneyCentsSchema,
  totalFeeCents: MoneyCentsSchema,
  totalReceiverCents: MoneyCentsSchema,
  /**
   * aperture-daxwm bugfix: zero is structurally valid. PIX flows have no
   * passthrough_surcharge item, so the cart's surcharge sum is 0 — must
   * not be rejected by `PagamentoSchema.parse` at hidration time.
   */
  totalSurchargeCents: MoneyCentsNonNegativeSchema,
  totalPaidCents: MoneyCentsSchema,
  responsavelTaxa: ResponsavelTaxaPagamentoSchema,
});

export type SnapshotComposicaoValoresAggregate = Readonly<
  z.infer<typeof SnapshotComposicaoValoresAggregateSchema>
>;

/**
 * Aggregate invariants:
 *   - Each `total*Cents` field MUST equal the sum of the corresponding
 *     per-line value across items. Surcharge sum comes from the (at most
 *     one) surcharge-tipo item's `amountCents`; the other three sums
 *     come from `line*AmountCents` across contribuição-tipo items.
 *   - Book balance: `totalReceiverCents + totalFeeCents + totalSurchargeCents === totalPaidCents`.
 *   - When `responsavelTaxa === 'contribuinte'`:
 *     `totalReceiverCents === totalContributionCents` (the contribuinte
 *     covers the fee on top — recebedor takes the whole contribuição
 *     amount).
 *
 * Called by the IntencaoPagamento factory (`criarPagamentoPendente`) at
 * cart-construction time; same defense-in-depth pattern as the per-item
 * `validarComposicaoItem`.
 */
export function validarComposicaoAggregate(
  aggregate: SnapshotComposicaoValoresAggregate,
  items: readonly SnapshotComposicaoValoresItem[],
): void {
  let sumContribution = 0;
  let sumFee = 0;
  let sumReceiver = 0;
  let sumSurcharge = 0;
  for (const item of items) {
    if (item.tipo === 'contribuicao') {
      sumContribution += item.lineContributionAmountCents;
      sumFee += item.lineFeeAmountCents;
      sumReceiver += item.lineReceiverAmountCents;
    } else {
      sumSurcharge += item.amountCents;
    }
  }

  if (sumContribution !== aggregate.totalContributionCents) {
    throw new Error(
      `Aggregate inconsistente: totalContributionCents (${aggregate.totalContributionCents}) deve ser a soma de lineContributionAmountCents dos items (${sumContribution}).`,
    );
  }
  if (sumFee !== aggregate.totalFeeCents) {
    throw new Error(
      `Aggregate inconsistente: totalFeeCents (${aggregate.totalFeeCents}) deve ser a soma de lineFeeAmountCents dos items (${sumFee}).`,
    );
  }
  if (sumReceiver !== aggregate.totalReceiverCents) {
    throw new Error(
      `Aggregate inconsistente: totalReceiverCents (${aggregate.totalReceiverCents}) deve ser a soma de lineReceiverAmountCents dos items (${sumReceiver}).`,
    );
  }
  if (sumSurcharge !== aggregate.totalSurchargeCents) {
    throw new Error(
      `Aggregate inconsistente: totalSurchargeCents (${aggregate.totalSurchargeCents}) deve ser a soma de amountCents dos items surcharge (${sumSurcharge}).`,
    );
  }

  if (
    aggregate.totalReceiverCents + aggregate.totalFeeCents + aggregate.totalSurchargeCents !==
    aggregate.totalPaidCents
  ) {
    throw new Error(
      `Aggregate inconsistente: totalReceiverCents (${aggregate.totalReceiverCents}) + totalFeeCents (${aggregate.totalFeeCents}) + totalSurchargeCents (${aggregate.totalSurchargeCents}) deve ser igual a totalPaidCents (${aggregate.totalPaidCents}).`,
    );
  }

  if (
    aggregate.responsavelTaxa === 'contribuinte' &&
    aggregate.totalReceiverCents !== aggregate.totalContributionCents
  ) {
    throw new Error(
      `Aggregate inconsistente: totalReceiverCents (${aggregate.totalReceiverCents}) deve ser igual a totalContributionCents (${aggregate.totalContributionCents}) quando responsavelTaxa=contribuinte.`,
    );
  }
}
