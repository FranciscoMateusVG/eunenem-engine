import { z } from 'zod/v4';

/**
 * Identifier value object for the Plataforma BC — the multi-tenant boundary
 * of the engine. Each plataforma (eunenem, eucasei, ...) has its own
 * IdPlataforma. Other BCs reference it via their own `IdPlataformaReferencia`
 * mirror VO — they never import from this file.
 */
export const IdPlataformaSchema = z.uuid();
export type IdPlataforma = z.infer<typeof IdPlataformaSchema>;
