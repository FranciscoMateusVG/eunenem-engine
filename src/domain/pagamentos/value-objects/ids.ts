import { z } from 'zod/v4';

/**
 * Identifier value objects for the Pagamentos BC. Each is a branded UUID —
 * value-identity, immutable, no behavior. `IdContribuicaoPagamento` is the
 * BC-local mirror of the contribuição reference (kept here so Pagamentos does
 * not depend on Arrecadação's domain types).
 */

export const IdPagamentoSchema = z.uuid();
export type IdPagamento = z.infer<typeof IdPagamentoSchema>;

export const IdIntencaoPagamentoSchema = z.uuid();
export type IdIntencaoPagamento = z.infer<typeof IdIntencaoPagamentoSchema>;

export const IdTransacaoExternaSchema = z.uuid();
export type IdTransacaoExterna = z.infer<typeof IdTransacaoExternaSchema>;

export const IdContribuicaoPagamentoSchema = z.uuid();
export type IdContribuicaoPagamento = z.infer<typeof IdContribuicaoPagamentoSchema>;
