import type { IdContribuicao } from '../../domain/arrecadacao/contribuicao.js';

export class ArrecadacaoContribuicaoNaoDisponivelError extends Error {
  constructor(public readonly idContribuicao: IdContribuicao) {
    super(`Contribuicao nao esta disponivel: ${idContribuicao}`);
    this.name = 'ArrecadacaoContribuicaoNaoDisponivelError';
  }
}
