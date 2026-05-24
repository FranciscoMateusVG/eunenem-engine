import { z } from 'zod/v4';

/**
 * Human-readable, URL-safe identifier for a plataforma (e.g. "eunenem",
 * "eucasei"). Unique across the engine. Lowercase letters, digits and hyphens
 * only; must start with a letter; 3–30 chars.
 *
 * Distinct from `IdPlataforma` (the UUID): the slug is what humans, URLs and
 * config files use; the id is the persistent reference.
 */
export const SlugPlataformaSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{2,29}$/,
    'Slug deve ter 3-30 caracteres, iniciar com letra minuscula, e conter apenas letras minusculas, digitos e hifens.',
  );
export type SlugPlataforma = z.infer<typeof SlugPlataformaSchema>;
