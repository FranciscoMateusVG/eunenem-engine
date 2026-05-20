import type { IdCampanha } from '../../domain/arrecadacao/campanha.js';

export class ArrecadacaoCampanhaNaoEncontradaError extends Error {
  public readonly code = 'ARRECADACAO_CAMPANHA_NAO_ENCONTRADA' as const;

  constructor(public readonly idCampanha: IdCampanha) {
    super(`Campanha de arrecadacao nao encontrada: ${idCampanha}`);
    this.name = 'ArrecadacaoCampanhaNaoEncontradaError';
  }
}
