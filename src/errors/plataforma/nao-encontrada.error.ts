import type { IdPlataforma } from '../../domain/plataforma/value-objects/ids.js';

export class PlataformaNaoEncontradaError extends Error {
  public readonly code = 'PLATAFORMA_NAO_ENCONTRADA' as const;

  constructor(public readonly idPlataforma: IdPlataforma) {
    super(`Plataforma nao encontrada: ${idPlataforma}`);
    this.name = 'PlataformaNaoEncontradaError';
  }
}
