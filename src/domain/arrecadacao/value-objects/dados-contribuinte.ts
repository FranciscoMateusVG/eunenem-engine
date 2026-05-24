import { z } from 'zod/v4';

/**
 * Value object: the visitor's data attached to a Contribuição (nome + email).
 * Immutable, equality is structural. Lives inside the Contribuição aggregate root.
 *
 * `NomeContribuinte` is inlined as a field-level schema since it's only used here.
 */

export const NomeContribuinteSchema = z
  .string()
  .trim()
  .min(1, 'Nome do contribuinte nao pode ser vazio')
  .max(120);

export const DadosContribuinteSchema = z.object({
  nome: NomeContribuinteSchema,
  email: z.string().trim().email('Email invalido').max(320),
});

export type DadosContribuinte = Readonly<z.infer<typeof DadosContribuinteSchema>>;
