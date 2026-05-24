import { z } from 'zod/v4';
import { IdOpcaoContribuicaoSchema } from './ids.js';

/**
 * Value object: an option (sacola) inside a Campanha. Carries an id and a tipo;
 * equality is structural. Lives inside the Campanha aggregate.
 *
 * `TipoOpcaoContribuicao` is the enum that types the sacola (presente / rifa / convite)
 * — inlined here because it's intrinsic to the option.
 */

export const TipoOpcaoContribuicaoSchema = z.enum(['presente', 'rifa', 'convite']);
export type TipoOpcaoContribuicao = z.infer<typeof TipoOpcaoContribuicaoSchema>;

export const OpcaoContribuicaoSchema = z.object({
  id: IdOpcaoContribuicaoSchema,
  tipo: TipoOpcaoContribuicaoSchema,
});

export type OpcaoContribuicao = Readonly<z.infer<typeof OpcaoContribuicaoSchema>>;
