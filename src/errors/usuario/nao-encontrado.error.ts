export class UsuarioNaoEncontradoError extends Error {
  public readonly code = 'USUARIO_NAO_ENCONTRADO' as const;

  constructor(public readonly idUsuario: string) {
    super(`Usuario nao encontrado: ${idUsuario}`);
    this.name = 'UsuarioNaoEncontradoError';
  }
}
