import { z } from 'zod/v4';
import {
  IdContribuicaoPagamentoSchema,
  type IdItemDoPagamento,
  IdItemDoPagamentoSchema,
} from '../value-objects/ids.js';
import {
  type SnapshotComposicaoValoresItemContribuicao,
  SnapshotComposicaoValoresItemContribuicaoSchema,
  type SnapshotComposicaoValoresItemSurcharge,
  SnapshotComposicaoValoresItemSurchargeSchema,
  validarComposicaoItem,
} from '../value-objects/snapshot-composicao-valores-item.js';

/**
 * @entity ItemDoPagamento (within Pagamento aggregate, sibling-child of
 * IntencaoPagamento)
 *
 * Plan 0016 (aperture-aj8qw): the per-line decomposition of an
 * IntencaoPagamento's cart. Born + dies with its IntencaoPagamento; no
 * independent lifecycle.
 *
 * Discriminated by `tipo`:
 *   - `'contribuicao'`: carries `idContribuicao` + `quantidade` +
 *     per-item contribuição composição.
 *   - `'passthrough_surcharge'`: carries the cart-wide card processing
 *     fee as its own line. `idContribuicao === null`,
 *     `quantidade === 1`.
 *
 * Position-stability inside the cart's `items` array: contribuição items
 * first (in caller-provided order), surcharge item ALWAYS LAST when
 * present per operator review lock #18. The position is application-layer
 * (enforced by the IntencaoPagamento factory + the DB's
 * `intencao_items_pagamento_position_uniq` constraint).
 *
 * `id` is a fresh UUID per item — caller-controlled at construction time
 * per the engine's existing convention (use-case generates UUIDs;
 * threads them through to the factory).
 *
 * Placement rationale (per locked decision #5): under IntencaoPagamento
 * (not directly under Pagamento root). The lançamento factory iterates
 * over `intencao.items` once; a sibling-of-IntencaoPagamento shape would
 * force a two-level traversal at the factory call site.
 */

export const ItemDoPagamentoContribuicaoSchema = z.object({
  id: IdItemDoPagamentoSchema,
  tipo: z.literal('contribuicao'),
  idContribuicao: IdContribuicaoPagamentoSchema,
  quantidade: z.number().int().positive(),
  composicaoValoresItem: SnapshotComposicaoValoresItemContribuicaoSchema,
  criadoEm: z.date(),
});

export type ItemDoPagamentoContribuicao = Readonly<
  z.infer<typeof ItemDoPagamentoContribuicaoSchema>
>;

export const ItemDoPagamentoPassthroughSurchargeSchema = z.object({
  id: IdItemDoPagamentoSchema,
  tipo: z.literal('passthrough_surcharge'),
  idContribuicao: z.null(),
  quantidade: z.literal(1),
  composicaoValoresItem: SnapshotComposicaoValoresItemSurchargeSchema,
  criadoEm: z.date(),
});

export type ItemDoPagamentoPassthroughSurcharge = Readonly<
  z.infer<typeof ItemDoPagamentoPassthroughSurchargeSchema>
>;

export const ItemDoPagamentoSchema = z.discriminatedUnion('tipo', [
  ItemDoPagamentoContribuicaoSchema,
  ItemDoPagamentoPassthroughSurchargeSchema,
]);

export type ItemDoPagamento = Readonly<z.infer<typeof ItemDoPagamentoSchema>>;

/**
 * Factory: build a contribuição-tipo item. Validates the composição
 * (per-unit × quantidade = per-line) at construction time and copies
 * the contribuição-level identifiers into the entity root for cheap
 * read-side access (avoids drilling into `composicaoValoresItem.*`
 * everywhere).
 *
 * The `id_pagamento` + `id_intencao_pagamento` references that the DB
 * persistence layer needs are NOT carried on the item — they're added
 * by the persistence adapter at save time, sourced from the parent
 * IntencaoPagamento + Pagamento ids. The item entity itself only carries
 * what's intrinsic to the line.
 */
export function criarItemContribuicao(input: {
  readonly id: IdItemDoPagamento;
  readonly composicaoValoresItem: SnapshotComposicaoValoresItemContribuicao;
  readonly criadoEm: Date;
}): ItemDoPagamentoContribuicao {
  validarComposicaoItem(input.composicaoValoresItem);
  return ItemDoPagamentoContribuicaoSchema.parse({
    id: input.id,
    tipo: 'contribuicao',
    idContribuicao: input.composicaoValoresItem.idContribuicao,
    quantidade: input.composicaoValoresItem.quantidade,
    composicaoValoresItem: input.composicaoValoresItem,
    criadoEm: input.criadoEm,
  });
}

/**
 * Factory: build the (at-most-one-per-cart) passthrough-surcharge item.
 * `idContribuicao` is fixed to `null`, `quantidade` to `1` — both
 * enforced structurally by the schema discriminator.
 */
export function criarItemPassthroughSurcharge(input: {
  readonly id: IdItemDoPagamento;
  readonly composicaoValoresItem: SnapshotComposicaoValoresItemSurcharge;
  readonly criadoEm: Date;
}): ItemDoPagamentoPassthroughSurcharge {
  validarComposicaoItem(input.composicaoValoresItem);
  return ItemDoPagamentoPassthroughSurchargeSchema.parse({
    id: input.id,
    tipo: 'passthrough_surcharge',
    idContribuicao: null,
    quantidade: 1,
    composicaoValoresItem: input.composicaoValoresItem,
    criadoEm: input.criadoEm,
  });
}
