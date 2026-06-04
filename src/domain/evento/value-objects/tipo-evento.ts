import { z } from 'zod/v4';

/**
 * Value object: kind of celebration tied to the invite experience.
 * Aligned with product catalog (eunenem convite builder).
 */

export const TipoEventoSchema = z.enum([
  'cha-bebe',
  'cha-fraldas',
  'cha-surpresa',
  'cha-revelacao',
  'batizado',
  'aniversario',
]);

export type TipoEvento = z.infer<typeof TipoEventoSchema>;
