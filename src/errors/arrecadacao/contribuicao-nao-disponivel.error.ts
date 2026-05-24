import type { IdContribuicao } from '../../domain/arrecadacao/value-objects/ids.js';

export class ArrecadacaoContribuicaoNaoDisponivelError extends Error {
  constructor(public readonly idContribuicao: IdContribuicao) {
    super(`Contribuicao nao esta disponivel: ${idContribuicao}`);
    this.name = 'ArrecadacaoContribuicaoNaoDisponivelError';
  }
}
