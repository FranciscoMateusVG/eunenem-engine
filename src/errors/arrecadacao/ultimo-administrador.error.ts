import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';

export class ArrecadacaoUltimoAdministradorError extends Error {
  public readonly code = 'ARRECADACAO_ULTIMO_ADMINISTRADOR' as const;

  constructor(public readonly idCampanha: IdCampanha) {
    super(`Nao e possivel remover o ultimo administrador da campanha "${idCampanha}".`);
    this.name = 'ArrecadacaoUltimoAdministradorError';
  }
}
