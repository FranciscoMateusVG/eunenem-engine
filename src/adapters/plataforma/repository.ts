import type { Plataforma } from '../../domain/plataforma/entities/plataforma.js';
import type { IdPlataforma } from '../../domain/plataforma/value-objects/ids.js';
import type { SlugPlataforma } from '../../domain/plataforma/value-objects/slug-plataforma.js';

/**
 * Persistência de plataformas (porta).
 *
 * Minimum-viable: read-only. Plataformas são seedadas (eunenem + eucasei) e
 * lidas por outros BCs para validar referências e escopar dados. O ciclo de
 * vida (criar/suspender/arquivar) é deferido para um plano futuro.
 */
export interface PlataformaRepository {
  findById(id: IdPlataforma): Promise<Plataforma | undefined>;
  findBySlug(slug: SlugPlataforma): Promise<Plataforma | undefined>;
  listAtivas(): Promise<readonly Plataforma[]>;
}
