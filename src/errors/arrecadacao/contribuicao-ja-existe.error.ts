import type { IdContribuicao } from '../../domain/arrecadacao/value-objects/ids.js';

export class ArrecadacaoContribuicaoJaExisteError extends Error {
  public readonly code = 'ARRECADACAO_CONTRIBUICAO_JA_EXISTE' as const;

  constructor(public readonly idContribuicao: IdContribuicao) {
    super(`Ja existe uma contribuicao com id "${idContribuicao}".`);
    this.name = 'ArrecadacaoContribuicaoJaExisteError';
  }
}
