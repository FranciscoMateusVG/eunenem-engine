import { z } from 'zod/v4';

/**
 * Value object: a single per-tipo fee posture (`percentageBps` +
 * `responsavelTaxa`). Lives inside the RegraTaxa aggregate — there's one
 * TarifaTipo per supported `TipoOpcaoContribuicaoReferencia` per plataforma.
 *
 * Equality is structural; no identity. A TarifaTipo never leaves its parent
 * RegraTaxa as a standalone reference.
 */

/**
 * Mirror of Arrecadação's `TipoOpcaoContribuicao`. Kept BC-local so Taxas
 * does not depend on Arrecadação's domain. The literal set MUST stay in sync
 * with `arrecadacao/value-objects/opcao-contribuicao.ts` — if a tipo is
 * added there, add it here too.
 */
export const TipoOpcaoContribuicaoReferenciaSchema = z.enum(['presente', 'rifa', 'convite']);
export type TipoOpcaoContribuicaoReferencia = z.infer<typeof TipoOpcaoContribuicaoReferenciaSchema>;

export const ResponsavelTaxaSchema = z.literal('contribuinte');
export type ResponsavelTaxa = z.infer<typeof ResponsavelTaxaSchema>;

export const PercentualTaxaBpsSchema = z.number().int().positive().max(10_000);
export type PercentualTaxaBps = z.infer<typeof PercentualTaxaBpsSchema>;

export const TarifaTipoSchema = z.object({
  percentageBps: PercentualTaxaBpsSchema,
  responsavelTaxa: ResponsavelTaxaSchema,
});

export type TarifaTipo = Readonly<z.infer<typeof TarifaTipoSchema>>;
