import { z } from 'zod/v4';

/**
 * Identifier value objects for the Evento BC.
 * Each is a branded UUID — value-identity, immutable, no behavior of its own.
 */

export const IdEventoSchema = z.uuid();
export type IdEvento = z.infer<typeof IdEventoSchema>;

export const IdConviteSchema = z.uuid();
export type IdConvite = z.infer<typeof IdConviteSchema>;

/**
 * Mirror VO: public reference to a Campanha (Arrecadação). Same shape as
 * `IdCampanha` in Arrecadação, defined locally so Evento does NOT import from
 * `src/domain/arrecadacao/`.
 */
export const IdCampanhaSchema = z.uuid();
export type IdCampanha = z.infer<typeof IdCampanhaSchema>;
