import type { IdEvento } from '../../domain/evento/value-objects/ids.js';

export class ListaDeConvidadosJaExisteError extends Error {
  public readonly code = 'LISTA_DE_CONVIDADOS_JA_EXISTE' as const;

  constructor(public readonly idEvento: IdEvento) {
    super(`Evento ja possui uma lista de convidados: ${idEvento}`);
    this.name = 'ListaDeConvidadosJaExisteError';
  }
}
