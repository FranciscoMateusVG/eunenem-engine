import type { IdPlataformaReferencia } from '../../domain/arrecadacao/value-objects/ids.js';

export class ArrecadacaoPlataformaNaoEncontradaError extends Error {
  public readonly code = 'ARRECADACAO_PLATAFORMA_NAO_ENCONTRADA' as const;

  constructor(public readonly idPlataforma: IdPlataformaReferencia) {
    super(`Plataforma referenciada pela campanha nao encontrada: ${idPlataforma}`);
    this.name = 'ArrecadacaoPlataformaNaoEncontradaError';
  }
}
