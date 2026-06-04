import { z } from 'zod/v4';

/**
 * Value object: calendar date + time of the event as a single instant.
 * Validated at boundaries (use-case input) — rejects Invalid Date.
 */

export const DataHoraEventoSchema = z
  .date()
  .refine((d) => !Number.isNaN(d.getTime()), { message: 'Data e hora do evento invalidas' });

export type DataHoraEvento = z.infer<typeof DataHoraEventoSchema>;
