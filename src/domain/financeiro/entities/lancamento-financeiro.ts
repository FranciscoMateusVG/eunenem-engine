import { z } from 'zod/v4';
import { type IdCampanha, IdCampanhaSchema } from '../../arrecadacao/value-objects/ids.js';
import { MoneyCentsSchema } from '../../money.js';
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
 * platform's revenue. Has its own id and lifecycle (`pendente` → `disponivel`).
 * Persisted via `LivroFinanceiroRepository` (the ledger is the implicit
 * aggregate boundary; there is no separate `Livro` entity today).
 *
 * `StatusLancamento`, `TipoLancamentoFinanceiro`, and `StatusPagamentoFinanceiro`
 * are intrinsic enum VOs kept inline. `EfeitosFinanceirosPagamentoAprovado` is
 * the domain-shaped input type for the factory below.
 */

export const StatusLancamentoSchema = z.enum(['pendente', 'disponivel']);
export type StatusLancamento = z.infer<typeof StatusLancamentoSchema>;

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
  status: StatusLancamentoSchema,
  criadoEm: z.date(),
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

/** Domain-shaped input para registrar efeitos financeiros de um pagamento aprovado. */
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
  // The original equality check missed surchargeCents → every card
  // payment threw here despite the saga steps 1+2 succeeding upstream
  // (operator-caught aperture-6g58e verify session 2026-05-31).
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
 * receita_plataforma — preserving the pre-bjshv behavior. Returns 3
 * lancamentos for cartao (`surchargeCents > 0`) — adds a
 * `credito_passthrough_surcharge` entry so the book balances against
 * `totalPaidCents` (aperture-bjshv).
 *
 * Book-balance invariant (aperture-bjshv): once this returns,
 * `SUM(amountCents over all returned lancamentos) === totalPaidCents` for
 * BOTH paths. The composicao-input invariant
 * (`receiverAmountCents + feeAmountCents + surchargeCents === totalPaidCents`)
 * is enforced upstream by `validarComposicaoFinanceiraPagamentoAprovado`.
 *
 * When `surchargeCents > 0`, `idsLancamentos.idLancamentoPassthroughSurcharge`
 * MUST be defined — absence under that condition throws a clear error so
 * use-case-level UUID minting bugs surface at factory-time, not at
 * adapter-time with a confusing schema error.
 *
 * The passthrough lancamento starts `pendente` per the bead spec (Stripe
 * hasn't actually deducted the surcharge from us at aprovado-time — the
 * maturation rule per plano 0006 is Finding #2's territory; this factory
 * does NOT speculate). The existing `receita_plataforma` entry retains
 * its current `disponivel` status to avoid touching the maturation
 * question here.
 *
 * idCampanha is populated on `recebedor` (today's behavior) AND on
 * `passthrough` (per bead spec — "inherit from input"), but NOT on
 * `receita_plataforma` (today's behavior — platform revenue isn't tied
 * to a specific campanha at the lancamento level). The receita
 * exclusion is unchanged to keep this bead's blast radius minimal.
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
    status: 'pendente',
    criadoEm,
  };

  const lancamentoReceita: LancamentoFinanceiro = {
    id: idsLancamentos.idLancamentoReceitaPlataforma,
    idPagamento: input.idPagamento,
    idContribuicao: input.idContribuicao,
    tipo: 'credito_receita_plataforma',
    amountCents: input.composicaoValores.feeAmountCents,
    status: 'disponivel',
    criadoEm,
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
    status: 'pendente',
    criadoEm,
  };

  // Book balance (cartao): recebedor (= contribution) + receita (= fee) +
  // passthrough (= surcharge) === totalPaid. Validated upstream on the
  // composicao input; the third lancamento makes it true on the
  // OUTPUT side too.
  return [lancamentoRecebedor, lancamentoReceita, lancamentoPassthrough];
}
