import type { IdEvento } from '../../domain/evento/value-objects/ids.js';

export class ConviteJaExisteError extends Error {
  public readonly code = 'CONVITE_JA_EXISTE' as const;

  constructor(public readonly idEvento: IdEvento) {
    super(`Evento ja possui um convite: ${idEvento}`);
    this.name = 'ConviteJaExisteError';
  }
}
