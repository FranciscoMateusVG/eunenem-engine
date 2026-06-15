import { z } from 'zod/v4';
import { MoneyCentsSchema } from '../../money.js';
import { IdContribuicaoPagamentoSchema } from './ids.js';

/**
 * Plan 0016 (aperture-aj8qw): per-item composição snapshot — the per-line
 * decomposition of a multi-item cart.
 *
 * Discriminated by `tipo`:
 *   - `'contribuicao'`: carries per-unit values + per-line denormalised
 *     totals + the `idContribuicao` + `quantidade`. Both per-unit and
 *     per-line are stored — per-line are the canonical "what hit the
 *     ledger" values; per-unit is the audit trail. Invariant validated
 *     in `validarComposicaoItem`: per-line === per-unit × quantidade.
 *   - `'passthrough_surcharge'`: carries a single `amountCents` (the
 *     cart-wide card processing fee). No `idContribuicao`. Single line
 *     for the whole cart per locked decision #11.
 *
 * Both shapes share the `tipo` discriminator with the corresponding
 * `ItemDoPagamento` shape — the per-item composição IS one field of an
 * `ItemDoPagamento`; the discriminator is shared via the type field.
 *
 * Replaces (with the aggregate VO) the single `SnapshotComposicaoValores`
 * that lived at IntencaoPagamento root pre-0016.
 */

/**
 * Contribuição-tipo per-item composição.
 *
 * Per-unit math:
 *   - `contributionUnitAmountCents`: the contribuição's intrinsic price per unit.
 *   - `feeUnitAmountCents`: platform fee per unit (calculated by Taxas).
 *   - `receiverUnitAmountCents`: per-unit amount net to the recebedor; equals
 *     `contributionUnitAmountCents` when `responsavelTaxa === 'contribuinte'`
 *     (which is the only supported value today; see aggregate VO).
 *
 * Per-line denormalised:
 *   - `line*AmountCents = unit*AmountCents × quantidade`. Stored alongside
 *     the per-unit values so the ledger never has to multiply at read
 *     time. Validated in `validarComposicaoItem`.
 */
export const SnapshotComposicaoValoresItemContribuicaoSchema = z.object({
  tipo: z.literal('contribuicao'),
  idContribuicao: IdContribuicaoPagamentoSchema,
  quantidade: z.number().int().positive(),
  contributionUnitAmountCents: MoneyCentsSchema,
  feeUnitAmountCents: MoneyCentsSchema,
  receiverUnitAmountCents: MoneyCentsSchema,
  lineContributionAmountCents: MoneyCentsSchema,
  lineFeeAmountCents: MoneyCentsSchema,
  lineReceiverAmountCents: MoneyCentsSchema,
});

export type SnapshotComposicaoValoresItemContribuicao = Readonly<
  z.infer<typeof SnapshotComposicaoValoresItemContribuicaoSchema>
>;

/**
 * Passthrough-surcharge-tipo per-item composição. Single line for the
 * whole cart; quantidade is fixed at 1 (the surcharge is a cart-wide
 * processing fee, not per-item). PIX flows have zero surcharge items;
 * cartão flows have exactly one. Per locked decision #11.
 */
export const SnapshotComposicaoValoresItemSurchargeSchema = z.object({
  tipo: z.literal('passthrough_surcharge'),
  amountCents: MoneyCentsSchema,
});

export type SnapshotComposicaoValoresItemSurcharge = Readonly<
  z.infer<typeof SnapshotComposicaoValoresItemSurchargeSchema>
>;

export const SnapshotComposicaoValoresItemSchema = z.discriminatedUnion('tipo', [
  SnapshotComposicaoValoresItemContribuicaoSchema,
  SnapshotComposicaoValoresItemSurchargeSchema,
]);

export type SnapshotComposicaoValoresItem = Readonly<
  z.infer<typeof SnapshotComposicaoValoresItemSchema>
>;

/**
 * Per-item composição invariants:
 *   - contribuição tipo: line === unit × quantidade for all three cents
 *     pairs. Receiver === contribution per unit (since responsavelTaxa
 *     is always 'contribuinte' today). MoneyCents already enforces
 *     non-negative integers via the schema.
 *   - surcharge tipo: amountCents is a MoneyCents (non-negative). Nothing
 *     else to validate at the item level — the cart-level invariant
 *     "at most one surcharge item, always last" lives in the
 *     IntencaoPagamento factory.
 *
 * Called by `criarItemContribuicao` and `criarItemPassthroughSurcharge`
 * in `item-do-pagamento.ts` at construction time.
 */
export function validarComposicaoItem(item: SnapshotComposicaoValoresItem): void {
  if (item.tipo === 'contribuicao') {
    if (item.contributionUnitAmountCents * item.quantidade !== item.lineContributionAmountCents) {
      throw new Error(
        `Composição de item contribuição inconsistente: lineContributionAmountCents (${item.lineContributionAmountCents}) deve ser contributionUnitAmountCents (${item.contributionUnitAmountCents}) × quantidade (${item.quantidade}).`,
      );
    }
    if (item.feeUnitAmountCents * item.quantidade !== item.lineFeeAmountCents) {
      throw new Error(
        `Composição de item contribuição inconsistente: lineFeeAmountCents (${item.lineFeeAmountCents}) deve ser feeUnitAmountCents (${item.feeUnitAmountCents}) × quantidade (${item.quantidade}).`,
      );
    }
    if (item.receiverUnitAmountCents * item.quantidade !== item.lineReceiverAmountCents) {
      throw new Error(
        `Composição de item contribuição inconsistente: lineReceiverAmountCents (${item.lineReceiverAmountCents}) deve ser receiverUnitAmountCents (${item.receiverUnitAmountCents}) × quantidade (${item.quantidade}).`,
      );
    }
    if (item.receiverUnitAmountCents !== item.contributionUnitAmountCents) {
      throw new Error(
        `Composição de item contribuição inconsistente: receiverUnitAmountCents (${item.receiverUnitAmountCents}) deve ser igual a contributionUnitAmountCents (${item.contributionUnitAmountCents}) quando responsavelTaxa=contribuinte.`,
      );
    }
  }
  // surcharge tipo: MoneyCentsSchema enforces non-negative integer — no
  // further constraints at the item level.
}
