import { z } from 'zod/v4';

/**
 * Value object: opaque session token (not a JWT — just a random string with
 * minimum length). Equality by value.
 */
export const TokenSessaoSchema = z
  .string()
  .min(32, 'Token de sessao deve ser opaco e longo o suficiente');

export type TokenSessao = z.infer<typeof TokenSessaoSchema>;
