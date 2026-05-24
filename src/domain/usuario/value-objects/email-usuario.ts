import { z } from 'zod/v4';

/**
 * Value object: a normalized email address (trimmed + lowercased).
 * Equality is structural; no identity. Used as a natural-key lookup for Usuário.
 */
export const EmailUsuarioSchema = z
  .string()
  .trim()
  .transform((s) => s.toLowerCase())
  .pipe(z.string().email('Deve ser um email valido'));

export type EmailUsuario = z.infer<typeof EmailUsuarioSchema>;
