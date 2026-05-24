import { z } from 'zod/v4';

/**
 * Identifier value objects for the Arrecadação BC.
 * Each is a branded UUID — value-identity (two `IdCampanha` with the same
 * string are equal), immutable, no behavior of its own.
 */

export const IdContaSchema = z.uuid();
export type IdConta = z.infer<typeof IdContaSchema>;

export const IdCampanhaSchema = z.uuid();
export type IdCampanha = z.infer<typeof IdCampanhaSchema>;

export const IdOpcaoContribuicaoSchema = z.uuid();
export type IdOpcaoContribuicao = z.infer<typeof IdOpcaoContribuicaoSchema>;

export const IdRecebedorSchema = z.uuid();
export type IdRecebedor = z.infer<typeof IdRecebedorSchema>;

export const IdContribuicaoSchema = z.uuid();
export type IdContribuicao = z.infer<typeof IdContribuicaoSchema>;
