import { z } from 'zod/v4';

/**
 * Value object: optional free-text address for in-person events.
 * Always optional — may be null for online events or when not yet filled in.
 */

export const EnderecoEventoSchema = z
  .string()
  .trim()
  .min(1, 'Endereco nao pode ser vazio')
  .max(500, 'Endereco e longo demais');

export type EnderecoEvento = z.infer<typeof EnderecoEventoSchema>;

/** Nullable endereco for aggregate fields and use-case input. */
export const EnderecoEventoNullableSchema = EnderecoEventoSchema.nullable();
