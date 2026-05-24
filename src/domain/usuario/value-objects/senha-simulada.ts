import { z } from 'zod/v4';

/**
 * Value object: simulated password — plain text, deliberately *not* real
 * security. Named so reviewers can't confuse it with a production credential.
 * Will be replaced when real auth lands.
 */
export const SenhaSimuladaSchema = z
  .string()
  .min(1, 'Senha simulada nao pode ser vazia')
  .max(200, 'Senha simulada e longa demais');

export type SenhaSimulada = z.infer<typeof SenhaSimuladaSchema>;
