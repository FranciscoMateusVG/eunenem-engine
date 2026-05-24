import { z } from 'zod/v4';

/**
 * Value object: the user's displayable name. Trimmed, non-empty, max 120 chars.
 * Immutable, equality by value.
 */
export const NomeExibicaoUsuarioSchema = z
  .string()
  .trim()
  .min(1, 'Nome de exibicao nao pode ser vazio')
  .max(120);

export type NomeExibicaoUsuario = z.infer<typeof NomeExibicaoUsuarioSchema>;
