import type { IdConta } from '../../domain/arrecadacao/value-objects/ids.js';

export class ArrecadacaoAdministradorDuplicadoError extends Error {
  public readonly code = 'ARRECADACAO_ADMINISTRADOR_DUPLICADO' as const;

  constructor(public readonly idConta: IdConta) {
    super(`A conta "${idConta}" ja e administradora desta campanha.`);
    this.name = 'ArrecadacaoAdministradorDuplicadoError';
  }
}
