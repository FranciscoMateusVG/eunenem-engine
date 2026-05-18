export class UsuarioNaoAutorizadoError extends Error {
  public readonly code = 'USUARIO_NAO_AUTORIZADO' as const;

  constructor(public readonly permissao: string) {
    super(`Usuario nao autorizado: falta permissao ${permissao}`);
    this.name = 'UsuarioNaoAutorizadoError';
  }
}
