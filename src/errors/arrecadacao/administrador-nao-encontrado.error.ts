import type { IdConta } from '../../domain/arrecadacao/campanha.js';

export class ArrecadacaoAdministradorNaoEncontradoError extends Error {
  public readonly code = 'ARRECADACAO_ADMINISTRADOR_NAO_ENCONTRADO' as const;

  constructor(public readonly idConta: IdConta) {
    super(`A conta "${idConta}" nao e administradora desta campanha.`);
    this.name = 'ArrecadacaoAdministradorNaoEncontradoError';
  }
}
