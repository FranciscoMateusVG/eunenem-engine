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

export function criarLancamentosParaPagamentoAprovado(
  input: EfeitosFinanceirosPagamentoAprovado,
  idsLancamentos: IdsLancamentosFinanceiros,
  criadoEm: Date,
): readonly [LancamentoFinanceiro, LancamentoFinanceiro] {
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

  return [lancamentoRecebedor, lancamentoReceita];
}
