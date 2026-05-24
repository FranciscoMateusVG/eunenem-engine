import { z } from 'zod/v4';
import { type IdConta, IdContaSchema } from './ids.js';

/**
 * Value object: the validated list of administrator account IDs on a Campanha.
 * Invariant: at least one admin, no duplicates. Equality is structural.
 */
export const IdsAdministradoresSchema = z
  .array(IdContaSchema)
  .min(1, 'Campanha precisa de pelo menos um administrador')
  .refine((ids: readonly IdConta[]) => new Set(ids).size === ids.length, {
    message: 'Ids de administradores duplicados',
  });
