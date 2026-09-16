import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';

/**
 * A campanha já usou sua única troca de slug público. Lançado por
 * `campanhas.definirSlug` quando o estado persistido mostra uma troca
 * anterior; nenhum metadado do cliente pode contornar essa regra.
 */
export class CampanhaSlugJaAlteradoError extends Error {
  public readonly code = 'CAMPANHA_SLUG_JA_ALTERADO' as const;

  constructor(public readonly idCampanha: IdCampanha) {
    super(`Slug da campanha ja foi alterado uma vez: ${idCampanha}`);
    this.name = 'CampanhaSlugJaAlteradoError';
  }
}
