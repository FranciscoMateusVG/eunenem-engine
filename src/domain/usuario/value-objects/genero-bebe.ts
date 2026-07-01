import { z } from 'zod/v4';

/**
 * Value object: the celebrated baby's gender (aperture-neiwx / 29kho-C).
 *
 * Display copy carried by `PerfilCriador`, used to drive PT-BR pronoun/article
 * agreement on BOTH greeting surfaces (the guest profile Hero + the owner
 * painel header) from a SINGLE source — so they can never disagree (the
 * pre-fix bug rendered the guest page masculine "do {nome}" and the owner
 * painel feminine "da {nome}" for the same baby).
 *
 * Nullable on the aggregate: a profile starts without it. Frontend agreement
 * treats `neutro`, `surpresa` and `null` as neutral phrasing ("Boas-vindas",
 * article "de"); `menino`/`menina` drive masculine/feminine. `surpresa`
 * (gender-reveal pending) is kept distinct from a deliberate `neutro` so the
 * UI can phrase it differently if product wants ("é surpresa!") while still
 * agreeing neutrally.
 */
export const GeneroBebeSchema = z.enum(['menino', 'menina', 'neutro', 'surpresa']);

export type GeneroBebe = z.infer<typeof GeneroBebeSchema>;
