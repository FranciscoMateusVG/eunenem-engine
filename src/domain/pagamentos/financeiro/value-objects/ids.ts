import { z } from 'zod/v4';

/**
 * Identifier value objects for the Financeiro BC. All branded UUIDs.
 *
 * `IdPagamentoReferencia` and `IdContribuicaoReferencia` are BC-local mirrors
 * of cross-BC references — Financeiro never imports identifier types from
 * Pagamentos or Arrecadação directly.
 */

export const IdLancamentoFinanceiroSchema = z.uuid();
export type IdLancamentoFinanceiro = z.infer<typeof IdLancamentoFinanceiroSchema>;

export const IdPagamentoReferenciaSchema = z.uuid();
export type IdPagamentoReferencia = z.infer<typeof IdPagamentoReferenciaSchema>;

export const IdContribuicaoReferenciaSchema = z.uuid();
export type IdContribuicaoReferencia = z.infer<typeof IdContribuicaoReferenciaSchema>;

export const IdRepasseSchema = z.uuid();
export type IdRepasse = z.infer<typeof IdRepasseSchema>;
