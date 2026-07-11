import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';

/**
 * A campanha já usou sua única troca de slug permitida pelo painel de
 * perfil (aperture — 1-troca). Lançado por `campanhas.definirSlug` quando
 * `origem: 'perfil'` e `campanha.slugAlteradoEm` já está preenchido.
 * Chamadas com `origem: 'setup'` nunca lançam este erro.
 */
export class CampanhaSlugJaAlteradoError extends Error {
  public readonly code = 'CAMPANHA_SLUG_JA_ALTERADO' as const;

  constructor(public readonly idCampanha: IdCampanha) {
    super(`Slug da campanha ja foi alterado uma vez: ${idCampanha}`);
    this.name = 'CampanhaSlugJaAlteradoError';
  }
}
