import { z } from 'zod/v4';
import { type IdCampanha, IdCampanhaSchema } from '../../arrecadacao/value-objects/ids.js';
import { MoneyCentsSchema } from '../../money.js';
import type { MetodoPagamento } from '../../pagamentos/value-objects/metodo-pagamento.js';
import {
  type IdContribuicaoReferencia,
  IdContribuicaoReferenciaSchema,
  IdLancamentoFinanceiroSchema,
  type IdPagamentoReferencia,
  IdPagamentoReferenciaSchema,
} from '../value-objects/ids.js';
import { calcularMaturaEm } from '../value-objects/regra-maturacao.js';
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
  /**
   * The moment at which this lancamento may flip from `pendente` to
   * `disponivel` (aperture-led0r, plano 0006). Computed at factory time
   * via `calcularMaturaEm(metodo, criadoEm)`; the maturation use-case
   * queries `WHERE status='pendente' AND matura_em <= now()`. Persisted
   * (not derived) so historical lancamentos retain their original
   * maturation date even if the rule changes later.
   */
  maturaEm: z.date(),
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
  /**
   * The pagamento `metodo` (aperture-led0r). Required to compute
   * `maturaEm` per `REGRAS_MATURACAO_PADRAO`. The use-case caller
   * (Stripe webhook handler / finalizarPagamentoAprovado) already has
   * this on the Pagamento aggregate and passes it through.
   */
  readonly metodo: MetodoPagamento;
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
 * receita_plataforma. Returns 3 for cartao (`surchargeCents > 0`) —
 * adds a `credito_passthrough_surcharge` entry so the book balances
 * against `totalPaidCents` (aperture-bjshv).
 *
 * Book-balance invariant: once this returns,
 * `SUM(amountCents over all returned lancamentos) === totalPaidCents`
 * for BOTH paths. The composicao-input invariant
 * (`receiverAmountCents + feeAmountCents + surchargeCents === totalPaidCents`)
 * is enforced upstream by `validarComposicaoFinanceiraPagamentoAprovado`;
 * the third lancamento makes it true on the OUTPUT side too.
 *
 * Maturation (aperture-led0r, plano 0006): every emitted lancamento
 * starts `status: 'pendente'` — including `credito_receita_plataforma`,
 * which prior to led0r hardcoded `disponivel` (the Finding #2 bug). The
 * `maturaEm` field is computed ONCE per pagamento via
 * `calcularMaturaEm(input.metodo, criadoEm)` and stamped on every
 * emitted row (same Stripe payout governs all of them). The
 * `maturarLancamentosPendentes` use-case flips matured rows to
 * `disponivel`. Until the cron lands per plano 0005, the flip is
 * manual; the admin UI surfaces the gap.
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

  // aperture-led0r: compute maturaEm ONCE per pagamento. All emitted
  // lancamentos share the same maturation date because they're
  // governed by the same Stripe payout schedule. Throws on unknown
  // metodo (e.g. boleto added without an entry in REGRAS_MATURACAO_PADRAO).
  const maturaEm = calcularMaturaEm(input.metodo, criadoEm);

  const lancamentoRecebedor: LancamentoFinanceiro = {
    id: idsLancamentos.idLancamentoRecebedor,
    idPagamento: input.idPagamento,
    idContribuicao: input.idContribuicao,
    idCampanha: input.idCampanha,
    tipo: 'credito_saldo_recebedor',
    amountCents: input.composicaoValores.receiverAmountCents,
    status: 'pendente',
    criadoEm,
    maturaEm,
  };

  // aperture-led0r Finding #2 fix: receita_plataforma now starts
  // 'pendente'. Prior to led0r this hardcoded 'disponivel' — the bug.
  // All tipos governed by the same Stripe payout schedule per the epic.
  const lancamentoReceita: LancamentoFinanceiro = {
    id: idsLancamentos.idLancamentoReceitaPlataforma,
    idPagamento: input.idPagamento,
    idContribuicao: input.idContribuicao,
    tipo: 'credito_receita_plataforma',
    amountCents: input.composicaoValores.feeAmountCents,
    status: 'pendente',
    criadoEm,
    maturaEm,
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
    maturaEm,
  };

  // Book balance (cartao): recebedor (= contribution) + receita (= fee) +
  // passthrough (= surcharge) === totalPaid.
  return [lancamentoRecebedor, lancamentoReceita, lancamentoPassthrough];
}
