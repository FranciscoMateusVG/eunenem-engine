import type { IdOpcaoContribuicao } from '../../domain/arrecadacao/value-objects/ids.js';

export class ArrecadacaoOpcaoIdDuplicadoError extends Error {
  public readonly code = 'ARRECADACAO_OPCAO_ID_DUPLICADO' as const;

  constructor(public readonly idOpcao: IdOpcaoContribuicao) {
    super(`Ja existe uma opcao de contribuicao com id "${idOpcao}" nesta campanha.`);
    this.name = 'ArrecadacaoOpcaoIdDuplicadoError';
  }
}
