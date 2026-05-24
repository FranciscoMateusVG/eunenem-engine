import type { IdPlataformaReferencia } from '../../domain/usuario/value-objects/ids.js';

export class UsuarioPlataformaNaoEncontradaError extends Error {
  public readonly code = 'USUARIO_PLATAFORMA_NAO_ENCONTRADA' as const;

  constructor(public readonly idPlataforma: IdPlataformaReferencia) {
    super(`Plataforma referenciada pelo usuario nao encontrada: ${idPlataforma}`);
    this.name = 'UsuarioPlataformaNaoEncontradaError';
  }
}
