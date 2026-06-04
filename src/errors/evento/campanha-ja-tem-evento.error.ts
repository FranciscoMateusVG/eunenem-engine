import type { IdCampanha } from '../../domain/evento/value-objects/ids.js';

export class EventoCampanhaJaTemEventoError extends Error {
  public readonly code = 'EVENTO_CAMPANHA_JA_TEM_EVENTO' as const;

  constructor(public readonly idCampanha: IdCampanha) {
    super(`Campanha ja possui um evento: ${idCampanha}`);
    this.name = 'EventoCampanhaJaTemEventoError';
  }
}
