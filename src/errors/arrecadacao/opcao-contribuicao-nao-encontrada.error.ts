import type { IdCampanha, IdOpcaoContribuicao } from '../../domain/arrecadacao/campanha.js';

export class ArrecadacaoOpcaoContribuicaoNaoEncontradaError extends Error {
  public readonly code = 'ARRECADACAO_OPCAO_CONTRIBUICAO_NAO_ENCONTRADA' as const;

  constructor(
    public readonly idCampanha: IdCampanha,
    public readonly idOpcao: IdOpcaoContribuicao,
  ) {
    super(`Opcao de contribuicao "${idOpcao}" nao encontrada na campanha "${idCampanha}".`);
    this.name = 'ArrecadacaoOpcaoContribuicaoNaoEncontradaError';
  }
}
