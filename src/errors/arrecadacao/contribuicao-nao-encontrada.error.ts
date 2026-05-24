import type { IdContribuicao } from '../../domain/arrecadacao/value-objects/ids.js';

export class ArrecadacaoContribuicaoNaoEncontradaError extends Error {
  constructor(public readonly idContribuicao: IdContribuicao) {
    super(`Contribuicao nao encontrada: ${idContribuicao}`);
    this.name = 'ArrecadacaoContribuicaoNaoEncontradaError';
  }
}
