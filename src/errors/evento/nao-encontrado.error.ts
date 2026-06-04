import type { IdCampanha, IdEvento } from '../../domain/evento/value-objects/ids.js';

export class EventoNaoEncontradoError extends Error {
  public readonly code = 'EVENTO_NAO_ENCONTRADO' as const;

  constructor(
    public readonly idEvento?: IdEvento,
    public readonly idCampanha?: IdCampanha,
  ) {
    const message =
      idEvento !== undefined
        ? `Evento nao encontrado: ${idEvento}`
        : `Evento nao encontrado para campanha: ${idCampanha}`;
    super(message);
    this.name = 'EventoNaoEncontradoError';
  }
}
