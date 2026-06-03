import { z } from 'zod/v4';
import { type IdCampanha, IdCampanhaSchema } from '../../../arrecadacao/value-objects/ids.js';
import { MoneyCentsSchema } from '../../../money.js';
import {
  type IdContribuicaoReferencia,
  IdContribuicaoReferenciaSchema,
  IdLancamentoFinanceiroSchema,
  type IdPagamentoReferencia,
  IdPagamentoReferenciaSchema,
} from '../value-objects/ids.js';
import type { SnapshotComposicaoValoresFinanceiro } from '../value-objects/snapshot-composicao-valores-financeiro.js';

/**
 * @entity LancamentoFinanceiro (within the implicit Livro Financeiro aggregate)
 *
 * A single ledger entry — either a credit to a receiver's balance or to the
 * platform's revenue. Persisted via `LivroFinanceiroRepository` (the ledger
 * is the implicit aggregate boundary; there is no separate `Livro` entity
 * today).
 *
 * **Plan 0015 collapse (aperture-7pqee).** Before 0015 this entity had a
 * 2-state FSM (`pendente | disponivel`) plus a predicted-maturation date
 * (`maturaEm`) computed from the metodo's maturation rule. Plan 0015
 * removes both — the lançamento has no FSM anymore. Instead, two
 * observed-event date columns capture money flow:
 *
 *   - `transferidoEm: Date | null` — set when the admin marks that the
 *     money actually reached the recebedor (manual action; automated
 *     banking integration is out of scope for this plan).
 *   - `canceladoEm: Date | null` — set when the parent pagamento
 *     transitions to `estornado` AND this lançamento was still
 *     untransferred at that moment.
 *
 * Implicit "states" are now query-time predicates:
 *
 *   pending      transferidoEm IS NULL AND canceladoEm IS NULL
 *   transferred  transferidoEm IS NOT NULL AND canceladoEm IS NULL
 *   cancelado    canceladoEm IS NOT NULL
 *
 * The rationale (plan 0015 DDD concept #6): predicted dates desync from
 * reality; observed dates don't. The pre-0015 maturation model stored a
 * guess about when Stripe would release funds; the new model stores what
 * actually happened, when it happened.
 *
 * `TipoLancamentoFinanceiro` and `StatusPagamentoFinanceiro` are intrinsic
 * enum VOs kept inline. `EfeitosFinanceirosPagamentoAprovado` is the
 * domain-shaped input type for the factory below.
 */

export const TipoLancamentoFinanceiroSchema = z.enum([
  'credito_saldo_recebedor',
  'credito_receita_plataforma',
  // aperture-bjshv: third tipo for buyer-paid card surcharge accounting.
  // Naming rationale: matches composicao field name `surchargeCents` (single
  // source of truth in the codebase). NOT `credito_taxa_cartao` — would
  // conflate with `feeAmountCents` which is OUR platform fee, semantically
  // distinct. "Passthrough" describes the accounting role: money the
  // visitante paid that flows through us to the provider; we never own it.
  // Only emitted when surchargeCents > 0 (cartao); PIX pagamentos omit it.
  'credito_passthrough_surcharge',
]);
export type TipoLancamentoFinanceiro = z.infer<typeof TipoLancamentoFinanceiroSchema>;

export const StatusPagamentoFinanceiroSchema = z.enum(['pendente', 'aprovado', 'rejeitado']);
export type StatusPagamentoFinanceiro = z.infer<typeof StatusPagamentoFinanceiroSchema>;

export const LancamentoFinanceiroSchema = z.object({
  id: IdLancamentoFinanceiroSchema,
  idPagamento: IdPagamentoReferenciaSchema,
  idContribuicao: IdContribuicaoReferenciaSchema,
  idCampanha: IdCampanhaSchema.optional(),
  tipo: TipoLancamentoFinanceiroSchema,
  amountCents: MoneyCentsSchema,
  criadoEm: z.date(),
  /**
   * Set when the admin marks this lançamento as actually transferred to
   * the recebedor. Manual action — no cron, no Stripe Connect, no
   * automated banking in v1. Idempotent at the use-case layer:
   * re-marking an already-transferred row is a no-op.
   *
   * Plan 0015 replaces the old `status='disponivel'` flip with this
   * observed-event timestamp.
   */
  transferidoEm: z.date().nullable(),
  /**
   * Set when the parent pagamento transitions to `estornado` AND this
   * lançamento was still `transferidoEm IS NULL` at that moment. The
   * cascade-scope rule (plan 0015 DDD concept #5): only untransferred
   * rows are cancelled. The 409-on-estorno-after-transfer rule (locked
   * decision #10) is the upstream gate that keeps this cascade safe.
   */
  canceladoEm: z.date().nullable(),
});

export type LancamentoFinanceiro = Readonly<z.infer<typeof LancamentoFinanceiroSchema>>;

export const IdsLancamentosFinanceirosSchema = z.object({
  idLancamentoRecebedor: IdLancamentoFinanceiroSchema,
  idLancamentoReceitaPlataforma: IdLancamentoFinanceiroSchema,
  /**
   * Optional id for the passthrough_surcharge lancamento (aperture-bjshv).
   * REQUIRED when `composicaoValores.surchargeCents > 0` (cartao payments) —
   * absence under that condition surfaces a clear factory-side error.
   * Absent for PIX payments where surchargeCents === 0.
   */
  idLancamentoPassthroughSurcharge: IdLancamentoFinanceiroSchema.optional(),
});

export type IdsLancamentosFinanceiros = Readonly<z.infer<typeof IdsLancamentosFinanceirosSchema>>;

/**
 * Domain-shaped input para registrar efeitos financeiros de um pagamento
 * aprovado.
 *
 * **Plan 0015:** `metodo` field removed. Pre-0015 the factory needed it
 * to compute `maturaEm` via `REGRAS_MATURACAO_PADRAO`. With maturation
 * gone, `metodo` is no longer required at the lançamento factory
 * boundary (the pagamento still carries it for routing webhook events).
 */
export interface EfeitosFinanceirosPagamentoAprovado {
  readonly idPagamento: IdPagamentoReferencia;
  readonly idContribuicao: IdContribuicaoReferencia;
  readonly idCampanha: IdCampanha;
  readonly statusPagamento: StatusPagamentoFinanceiro;
  readonly composicaoValores: SnapshotComposicaoValoresFinanceiro;
}

export function validarComposicaoFinanceiraPagamentoAprovado(
  input: EfeitosFinanceirosPagamentoAprovado,
): void {
  if (input.statusPagamento !== 'aprovado') {
    throw new Error('Apenas pagamentos aprovados podem gerar lancamentos financeiros.');
  }

  const {
    contributionAmountCents,
    feeAmountCents,
    surchargeCents,
    receiverAmountCents,
    totalPaidCents,
  } = input.composicaoValores;

  // aperture-uyw8i extension: buyer-paid card surcharge is part of the
  // total paid by the contribuinte but NOT counted toward platform fee
  // or receiver amount. Invariant per SnapshotComposicaoValoresFinanceiro:
  //   receiverAmountCents + feeAmountCents + surchargeCents === totalPaidCents
  if (receiverAmountCents + feeAmountCents + surchargeCents !== totalPaidCents) {
    throw new Error('Composicao de valores financeira nao confere com o total pago.');
  }

  if (receiverAmountCents !== contributionAmountCents) {
    throw new Error(
      'Valor destinado ao recebedor deve ser igual ao valor da contribuicao quando a taxa e paga pelo contribuinte.',
    );
  }
}

/**
 * Build the lancamentos for a freshly-aprovado pagamento.
 *
 * Returns 2 lancamentos for PIX (`surchargeCents === 0`) — recebedor +
 * receita_plataforma. Returns 3 for cartao (`surchargeCents > 0`) —
 * adds a `credito_passthrough_surcharge` entry so the book balances
 * against `totalPaidCents` (aperture-bjshv).
 *
 * Book-balance invariant: once this returns,
 * `SUM(amountCents over all returned lancamentos) === totalPaidCents`
 * for BOTH paths.
 *
 * **Plan 0015 (aperture-7pqee).** Every emitted lançamento starts with
 * both date columns null (`transferidoEm: null, canceladoEm: null`) — the
 * implicit "pending" state. Pre-0015 the factory computed a `maturaEm`
 * per pagamento and stamped it on every row; the maturation rule is gone
 * and the factory no longer touches the metodo. The admin marks
 * `transferidoEm` when the money actually reaches the recebedor; the
 * estorno cascade sets `canceladoEm` when the pagamento goes
 * `estornado` and the row was still untransferred.
 *
 * idCampanha is populated on `recebedor` (today's behavior) AND on
 * `passthrough` (per bjshv spec — "inherit from input"), but NOT on
 * `receita_plataforma` (today's behavior — platform revenue isn't tied
 * to a specific campanha at the lancamento level).
 *
 * When `surchargeCents > 0`, `idsLancamentos.idLancamentoPassthroughSurcharge`
 * MUST be defined — absence under that condition throws a clear error.
 */
export function criarLancamentosParaPagamentoAprovado(
  input: EfeitosFinanceirosPagamentoAprovado,
  idsLancamentos: IdsLancamentosFinanceiros,
  criadoEm: Date,
): readonly LancamentoFinanceiro[] {
  validarComposicaoFinanceiraPagamentoAprovado(input);

  const lancamentoRecebedor: LancamentoFinanceiro = {
    id: idsLancamentos.idLancamentoRecebedor,
    idPagamento: input.idPagamento,
    idContribuicao: input.idContribuicao,
    idCampanha: input.idCampanha,
    tipo: 'credito_saldo_recebedor',
    amountCents: input.composicaoValores.receiverAmountCents,
    criadoEm,
    transferidoEm: null,
    canceladoEm: null,
  };

  const lancamentoReceita: LancamentoFinanceiro = {
    id: idsLancamentos.idLancamentoReceitaPlataforma,
    idPagamento: input.idPagamento,
    idContribuicao: input.idContribuicao,
    tipo: 'credito_receita_plataforma',
    amountCents: input.composicaoValores.feeAmountCents,
    criadoEm,
    transferidoEm: null,
    canceladoEm: null,
  };

  // PIX path — no surcharge, no third lancamento. Book balance:
  //   recebedor (= contribution) + receita (= fee) === totalPaid.
  if (input.composicaoValores.surchargeCents === 0) {
    return [lancamentoRecebedor, lancamentoReceita];
  }

  // Cartao path — surcharge > 0 requires the third lancamento.
  if (!idsLancamentos.idLancamentoPassthroughSurcharge) {
    throw new Error(
      'idLancamentoPassthroughSurcharge é obrigatório quando composicaoValores.surchargeCents > 0 (aperture-bjshv).',
    );
  }
  const lancamentoPassthrough: LancamentoFinanceiro = {
    id: idsLancamentos.idLancamentoPassthroughSurcharge,
    idPagamento: input.idPagamento,
    idContribuicao: input.idContribuicao,
    idCampanha: input.idCampanha,
    tipo: 'credito_passthrough_surcharge',
    amountCents: input.composicaoValores.surchargeCents,
    criadoEm,
    transferidoEm: null,
    canceladoEm: null,
  };

  // Book balance (cartao): recebedor (= contribution) + receita (= fee) +
  // passthrough (= surcharge) === totalPaid.
  return [lancamentoRecebedor, lancamentoReceita, lancamentoPassthrough];
}
