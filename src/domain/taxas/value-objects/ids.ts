import { z } from 'zod/v4';

/**
 * Identifier value objects for the Taxas BC.
 *
 * Cross-BC references use `*Referencia` mirror VOs — same shape as the
 * source ID, but defined locally so Taxas does not import from other BCs'
 * domain layers. Enforced by dependency-cruiser.
 */

export const IdRegraTaxaSchema = z.uuid();
export type IdRegraTaxa = z.infer<typeof IdRegraTaxaSchema>;

export const IdPlataformaReferenciaSchema = z.uuid();
export type IdPlataformaReferencia = z.infer<typeof IdPlataformaReferenciaSchema>;

export const IdContribuicaoReferenciaSchema = z.uuid();
export type IdContribuicaoReferencia = z.infer<typeof IdContribuicaoReferenciaSchema>;
