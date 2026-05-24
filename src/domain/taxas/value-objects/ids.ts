import { z } from 'zod/v4';

/**
 * Identifier value object: a public reference to a Contribuição used by the
 * Taxas BC. Mirrors `IdContribuicao` from Arrecadação but kept BC-local so
 * Taxas does not depend on Arrecadação's domain types.
 */
export const IdContribuicaoReferenciaSchema = z.uuid();
export type IdContribuicaoReferencia = z.infer<typeof IdContribuicaoReferenciaSchema>;
