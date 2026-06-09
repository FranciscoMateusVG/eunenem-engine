import { z } from 'zod/v4';
import { type IdCampanha, IdCampanhaSchema } from '../../../arrecadacao/value-objects/ids.js';
import { MoneyCentsSchema } from '../../../money.js';
import { IdItemDoPagamentoSchema } from '../../value-objects/ids.js';
import {
  type IdContribuicaoReferencia,
  IdContribuicaoReferenciaSchema,
  IdLancamentoFinanceiroSchema,
  type IdPagamentoReferencia,
  IdPagamentoReferenciaSchema,
  IdRepasseSchema,
} from '../value-objects/ids.js';
import type {
  SnapshotComposicaoValoresItemFinanceiro,
  SnapshotComposicaoValoresItemFinanceiroContribuicao,
  SnapshotComposicaoValoresItemFinanceiroSurcharge,
} from '../value-objects/snapshot-composicao-valores-financeiro.js';

/**
 * @entity LancamentoFinanceiro (within the implicit Livro Financeiro
 * aggregate).
 *
 * Plan 0016 Phase 2 (aperture-eg1s2): reshaped to mirror the multi-item
 * cart structure of IntencaoPagamento. Each lançamento now points back
 * to a single `ItemDoPagamento` via `idItemPagamento` (FK to
 * `intencao_items.id`, migration 023). The factory iterates over the
 * cart's items and emits per-item lançamentos per locked decision #12:
 *
 *   - `contribuicao` item → 2 lançamentos
 *       (`credito_saldo_recebedor` + `credito_receita_plataforma`)
 *   - `passthrough_surcharge` item → 1 lançamento
 *       (`credito_passthrough_surcharge`)
 *
 * Per-pagamento total = `2 × N(contribuicao items) + S(surcharge items)`.
 * The pre-0016 "+1 if cartão" branch at pagamento level RETIRES.
 *
 * Book-balance invariant unchanged in shape: once the factory returns,
 * `SUM(amountCents over all returned)` equals
 * `composicaoValoresAggregate.totalPaidCents` for BOTH pix and cartão
 * paths. The pix path now produces `2N` rows (no surcharge item);
 * cartão produces `2N + 1`.
 *
 * `idContribuicao` on the row stays NOT NULL — even surcharge-tipo
 * lançamentos carry the cart's anchor contribuição id (the first
 * contribuicao item's contribuição) for traceability + index reuse.
 * The discriminator is `tipo`, not the presence of idContribuicao.
 */

export const TipoLancamentoFinanceiroSchema = z.enum([
  'credito_saldo_recebedor',
  'credito_receita_plataforma',
  // aperture-bjshv + plan 0016: third tipo for buyer-paid card surcharge
  // accounting. Audit-only (NOT in bank balance per locked decision #13).
  'credito_passthrough_surcharge',
]);
export type TipoLancamentoFinanceiro = z.infer<typeof TipoLancamentoFinanceiroSchema>;

export const StatusPagamentoFinanceiroSchema = z.enum(['pendente', 'aprovado', 'rejeitado']);
export type StatusPagamentoFinanceiro = z.infer<typeof StatusPagamentoFinanceiroSchema>;

export const LancamentoFinanceiroSchema = z.object({
  id: IdLancamentoFinanceiroSchema,
  idPagamento: IdPagamentoReferenciaSchema,
  /**
   * Plan 0016 Phase 2 (aperture-eg1s2 / migration 023): FK to the
   * `intencao_items` row this lançamento represents. NOT NULL on the
   * DB side; the factory always populates it.
   */
  idItemPagamento: IdItemDoPagamentoSchema,
  idContribuicao: IdContribuicaoReferenciaSchema,
  idCampanha: IdCampanhaSchema.optional(),
  tipo: TipoLancamentoFinanceiroSchema,
  amountCents: MoneyCentsSchema,
  criadoEm: z.date(),
  transferidoEm: z.date().nullable(),
  canceladoEm: z.date().nullable(),
  /**
   * aperture-s03dr. Set when this lançamento has been swept into a
   * pending or aprovado `RepasseRecebedor` via the
   * `solicitarRepasseRecebedor` use-case.
   */
  idRepasse: IdRepasseSchema.nullable(),
});

export type LancamentoFinanceiro = Readonly<z.infer<typeof LancamentoFinanceiroSchema>>;

/**
 * Plan 0016 Phase 2 (aperture-eg1s2). Per-item financeiro shape — what
 * the lançamento factory consumes. Mirrors the BC Pagamentos
 * `ItemDoPagamento` shape minus the entity wrapper (no `criadoEm`, no
 * `tipo`-on-the-item-root — only what the factory needs).
 *
 * Carries the item's `id` (so the factory can stamp it onto every
 * lançamento it produces for the item) + the per-item composição (the
 * cents math).
 */
export interface ItemDoPagamentoFinanceiro {
  readonly idItemPagamento: string;
  readonly composicaoValoresItem: SnapshotComposicaoValoresItemFinanceiro;
}

/**
 * Per-item IDs the factory needs. One entry per item the cart contains.
 * For contribuicao tipo: both `idLancamentoRecebedor` +
 * `idLancamentoReceitaPlataforma` MUST be provided. For
 * passthrough_surcharge tipo: only `idLancamentoPassthroughSurcharge`
 * MUST be provided.
 *
 * Replaces the pre-0016 `IdsLancamentosFinanceiros` (which was a single
 * triple keyed off the pagamento) with a per-item collection.
 */
export interface IdsLancamentosPorItem {
  readonly idItemPagamento: string;
  readonly idLancamentoRecebedor?: string;
  readonly idLancamentoReceitaPlataforma?: string;
  readonly idLancamentoPassthroughSurcharge?: string;
}

export type IdsLancamentosFinanceirosPorPagamento = readonly IdsLancamentosPorItem[];

/**
 * Domain-shaped input para registrar efeitos financeiros de um pagamento
 * aprovado.
 *
 * Plan 0016 Phase 2 (aperture-eg1s2): drops `idContribuicao` from the
 * root (now per-item) and `composicaoValores` (replaced by per-item
 * `items`). The cart-scope `idCampanha` stays at root — every
 * lançamento on the pagamento gets stamped with it (recebedor +
 * passthrough_surcharge rows; receita_plataforma stays untyped per the
 * pre-0016 convention — platform revenue isn't pinned to a campanha).
 *
 * `metodo` was already removed in plan 0015 (aperture-7pqee).
 */
export interface EfeitosFinanceirosPagamentoAprovado {
  readonly idPagamento: IdPagamentoReferencia;
  readonly idCampanha: IdCampanha;
  readonly statusPagamento: StatusPagamentoFinanceiro;
  /**
   * Anchor contribuição id used to populate `id_contribuicao` on every
   * lançamento (including surcharge rows) for traceability. The actual
   * per-item `idContribuicao` lives inside each item's
   * `composicaoValoresItem` for contribuicao-tipo items; surcharge items
   * have none, so we fall back to the anchor at the row level.
   */
  readonly idContribuicaoAnchor: IdContribuicaoReferencia;
  readonly items: readonly ItemDoPagamentoFinanceiro[];
}

export function validarComposicaoFinanceiraPagamentoAprovado(
  input: EfeitosFinanceirosPagamentoAprovado,
): void {
  if (input.statusPagamento !== 'aprovado') {
    throw new Error('Apenas pagamentos aprovados podem gerar lancamentos financeiros.');
  }
  if (input.items.length < 1) {
    throw new Error('Pagamento aprovado deve conter ao menos um item.');
  }

  // Per-item invariants:
  //   contribuicao item: line === unit × quantidade for all three pairs;
  //                      receiver === contribution per unit.
  //   surcharge item: amountCents non-negative.
  for (const item of input.items) {
    const c = item.composicaoValoresItem;
    if (c.tipo === 'contribuicao') {
      if (c.contributionUnitAmountCents * c.quantidade !== c.lineContributionAmountCents) {
        throw new Error(
          `Composição financeira inconsistente: lineContributionAmountCents (${c.lineContributionAmountCents}) deve ser unit (${c.contributionUnitAmountCents}) × quantidade (${c.quantidade}).`,
        );
      }
      if (c.feeUnitAmountCents * c.quantidade !== c.lineFeeAmountCents) {
        throw new Error(
          `Composição financeira inconsistente: lineFeeAmountCents (${c.lineFeeAmountCents}) deve ser unit (${c.feeUnitAmountCents}) × quantidade (${c.quantidade}).`,
        );
      }
      if (c.receiverUnitAmountCents * c.quantidade !== c.lineReceiverAmountCents) {
        throw new Error(
          `Composição financeira inconsistente: lineReceiverAmountCents (${c.lineReceiverAmountCents}) deve ser unit (${c.receiverUnitAmountCents}) × quantidade (${c.quantidade}).`,
        );
      }
      if (c.receiverUnitAmountCents !== c.contributionUnitAmountCents) {
        throw new Error(
          'Composição financeira inconsistente: receiverUnit deve ser igual a contributionUnit quando responsavelTaxa=contribuinte.',
        );
      }
    }
  }
}

/**
 * Build the lançamentos for a freshly-aprovado pagamento. Plan 0016
 * Phase 2 (aperture-eg1s2): per-item emission per locked decision #12.
 *
 * Caller provides per-item id arrays (`idsPorItem`); each entry MUST
 * align with `input.items` by `idItemPagamento` (the factory validates
 * the linkage and throws if they're misaligned).
 *
 * Book-balance invariant: once this returns, `SUM(amountCents over all
 * returned)` equals the cart's `composicaoValoresAggregate.totalPaidCents`
 * (the saga / use-case caller is responsible for the aggregate
 * matching; this entity validates each item is internally consistent).
 */
export function criarLancamentosParaPagamentoAprovado(
  input: EfeitosFinanceirosPagamentoAprovado,
  idsPorItem: IdsLancamentosFinanceirosPorPagamento,
  criadoEm: Date,
): readonly LancamentoFinanceiro[] {
  validarComposicaoFinanceiraPagamentoAprovado(input);

  const idsByItem = new Map<string, IdsLancamentosPorItem>();
  for (const ids of idsPorItem) {
    idsByItem.set(ids.idItemPagamento, ids);
  }

  const out: LancamentoFinanceiro[] = [];

  for (const item of input.items) {
    const c = item.composicaoValoresItem;
    const ids = idsByItem.get(item.idItemPagamento);
    if (!ids) {
      throw new Error(
        `idsPorItem missing ids for item ${item.idItemPagamento}; saga must supply one entry per item.`,
      );
    }

    if (c.tipo === 'contribuicao') {
      if (!ids.idLancamentoRecebedor || !ids.idLancamentoReceitaPlataforma) {
        throw new Error(
          `idLancamentoRecebedor + idLancamentoReceitaPlataforma são obrigatórios para item contribuicao (${item.idItemPagamento}).`,
        );
      }
      const contribuicaoC = c as SnapshotComposicaoValoresItemFinanceiroContribuicao;
      out.push({
        id: ids.idLancamentoRecebedor,
        idPagamento: input.idPagamento,
        idItemPagamento: item.idItemPagamento,
        idContribuicao: contribuicaoC.idContribuicao as IdContribuicaoReferencia,
        idCampanha: input.idCampanha,
        tipo: 'credito_saldo_recebedor',
        amountCents: contribuicaoC.lineReceiverAmountCents,
        criadoEm,
        transferidoEm: null,
        canceladoEm: null,
        idRepasse: null,
      });
      out.push({
        id: ids.idLancamentoReceitaPlataforma,
        idPagamento: input.idPagamento,
        idItemPagamento: item.idItemPagamento,
        idContribuicao: contribuicaoC.idContribuicao as IdContribuicaoReferencia,
        // Platform revenue isn't pinned to a specific campanha (pre-0016
        // convention preserved).
        tipo: 'credito_receita_plataforma',
        amountCents: contribuicaoC.lineFeeAmountCents,
        criadoEm,
        transferidoEm: null,
        canceladoEm: null,
        idRepasse: null,
      });
    } else {
      if (!ids.idLancamentoPassthroughSurcharge) {
        throw new Error(
          `idLancamentoPassthroughSurcharge é obrigatório para item passthrough_surcharge (${item.idItemPagamento}).`,
        );
      }
      const surchargeC = c as SnapshotComposicaoValoresItemFinanceiroSurcharge;
      out.push({
        id: ids.idLancamentoPassthroughSurcharge,
        idPagamento: input.idPagamento,
        idItemPagamento: item.idItemPagamento,
        // Anchor contribuição for traceability — surcharge has no real
        // contribuição linkage but the DB column is NOT NULL.
        idContribuicao: input.idContribuicaoAnchor,
        idCampanha: input.idCampanha,
        tipo: 'credito_passthrough_surcharge',
        amountCents: surchargeC.amountCents,
        criadoEm,
        transferidoEm: null,
        canceladoEm: null,
        idRepasse: null,
      });
    }
  }

  return out;
}
