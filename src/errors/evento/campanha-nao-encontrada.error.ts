import type { IdCampanha } from '../../domain/evento/value-objects/ids.js';

export class EventoCampanhaNaoEncontradaError extends Error {
  public readonly code = 'EVENTO_CAMPANHA_NAO_ENCONTRADA' as const;

  constructor(public readonly idCampanha: IdCampanha) {
    super(`Campanha referenciada pelo evento nao encontrada: ${idCampanha}`);
    this.name = 'EventoCampanhaNaoEncontradaError';
  }
}
