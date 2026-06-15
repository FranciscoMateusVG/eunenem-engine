import { z } from 'zod/v4';
import { IdCampanhaSchema } from '../../../arrecadacao/value-objects/ids.js';
import { MoneyCentsNonNegativeSchema, MoneyCentsSchema } from '../../../money.js';

/**
 * Value object: financeiro-side mirror of `SnapshotComposicaoValores*`
 * (the BC Pagamentos VO at IntencaoPagamento root). Immutable; Financeiro
 * never recalculates the fee — it uses exactly what it was given.
 *
 * **Plan 0016 (aperture-aj8qw).** Restructured to mirror the post-0016
 * per-item + aggregate split. The pre-0016 single
 * `SnapshotComposicaoValoresFinanceiro` (with root-level `surchargeCents`)
 * retires. Two new shapes take its place:
 *
 *   1. `SnapshotComposicaoValoresItemFinanceiro` — per-line, discriminated
 *      by `tipo` ('contribuicao' | 'passthrough_surcharge'). Mirrors the
 *      BC Pagamentos `SnapshotComposicaoValoresItem` shape.
 *
 *   2. `SnapshotComposicaoValoresAggregateFinanceiro` — aggregate (sum
 *      across items). Mirrors the BC Pagamentos
 *      `SnapshotComposicaoValoresAggregate` shape.
 *
 * The asymmetric `surchargeCents` field at root retires per locked
 * decision #11 — surcharge is its own item now.
 *
 * `ResponsavelTaxaFinanceiro` is inlined as the BC-local literal so
 * Financeiro does not depend on Taxas / Pagamentos domain types.
 *
 * **Consumers**: the financeiro snapshot is read by
 * `validarComposicaoFinanceiraPagamentoAprovado` and
 * `criarLancamentosParaPagamentoAprovado`. Both rewrite in Phase 2 to
 * iterate over items (per-item emission map per locked decision #12).
 * Until Phase 2 lands, those consumers fail to typecheck — that's
 * expected per the plan's predictable-fail discipline.
 */

export const ResponsavelTaxaFinanceiroSchema = z.literal('contribuinte');
export type ResponsavelTaxaFinanceiro = z.infer<typeof ResponsavelTaxaFinanceiroSchema>;

/**
 * Contribuição-tipo per-item financeiro snapshot. Mirrors the per-line
 * shape of `SnapshotComposicaoValoresItemContribuicao` in BC Pagamentos.
 *
 * Carries the per-line denormalised values (`line*AmountCents`) — those
 * are the canonical "what hit the ledger" values the lançamento factory
 * emits one-row-per. Per-unit values are preserved for audit
 * (mirror the upstream snapshot).
 *
 * `idContribuicao` is repeated here (sourced from the upstream item) so
 * the factory has it without traversing back to the item entity.
 */
export const SnapshotComposicaoValoresItemFinanceiroContribuicaoSchema = z.object({
  tipo: z.literal('contribuicao'),
  idContribuicao: z.uuid(),
  quantidade: z.number().int().positive(),
  contributionUnitAmountCents: MoneyCentsSchema,
  feeUnitAmountCents: MoneyCentsSchema,
  receiverUnitAmountCents: MoneyCentsSchema,
  lineContributionAmountCents: MoneyCentsSchema,
  lineFeeAmountCents: MoneyCentsSchema,
  lineReceiverAmountCents: MoneyCentsSchema,
});

export type SnapshotComposicaoValoresItemFinanceiroContribuicao = Readonly<
  z.infer<typeof SnapshotComposicaoValoresItemFinanceiroContribuicaoSchema>
>;

/**
 * Passthrough-surcharge-tipo per-item financeiro snapshot. Single line
 * for the whole cart; quantidade is fixed at 1.
 *
 * Lançamento factory emits ONE `credito_passthrough_surcharge` per
 * surcharge item (per locked decision #12). Audit-only — does NOT
 * contribute to bank balance (locked decision #13).
 */
export const SnapshotComposicaoValoresItemFinanceiroSurchargeSchema = z.object({
  tipo: z.literal('passthrough_surcharge'),
  amountCents: MoneyCentsSchema,
});

export type SnapshotComposicaoValoresItemFinanceiroSurcharge = Readonly<
  z.infer<typeof SnapshotComposicaoValoresItemFinanceiroSurchargeSchema>
>;

export const SnapshotComposicaoValoresItemFinanceiroSchema = z.discriminatedUnion('tipo', [
  SnapshotComposicaoValoresItemFinanceiroContribuicaoSchema,
  SnapshotComposicaoValoresItemFinanceiroSurchargeSchema,
]);

export type SnapshotComposicaoValoresItemFinanceiro = Readonly<
  z.infer<typeof SnapshotComposicaoValoresItemFinanceiroSchema>
>;

/**
 * Aggregate financeiro snapshot — sum across all items. Mirrors the
 * BC Pagamentos `SnapshotComposicaoValoresAggregate` shape. Same
 * book-balance invariant: `totalReceiver + totalFee + totalSurcharge === totalPaid`,
 * with `totalReceiver === totalContribution` when
 * `responsavelTaxa === 'contribuinte'`.
 *
 * Carries `idCampanha` as the cart-scope invariant carrier mirror.
 */
export const SnapshotComposicaoValoresAggregateFinanceiroSchema = z.object({
  idCampanha: IdCampanhaSchema,
  totalContributionCents: MoneyCentsSchema,
  totalFeeCents: MoneyCentsSchema,
  totalReceiverCents: MoneyCentsSchema,
  /**
   * aperture-daxwm bugfix mirror: zero is structurally valid for PIX flows.
   */
  totalSurchargeCents: MoneyCentsNonNegativeSchema,
  totalPaidCents: MoneyCentsSchema,
  responsavelTaxa: ResponsavelTaxaFinanceiroSchema,
});

export type SnapshotComposicaoValoresAggregateFinanceiro = Readonly<
  z.infer<typeof SnapshotComposicaoValoresAggregateFinanceiroSchema>
>;
