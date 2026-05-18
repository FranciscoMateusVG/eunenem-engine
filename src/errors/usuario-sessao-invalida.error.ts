export class UsuarioSessaoInvalidaError extends Error {
  public readonly code = 'USUARIO_SESSAO_INVALIDA' as const;

  constructor(public readonly reason: string) {
    super(`Sessao de usuario invalida: ${reason}`);
    this.name = 'UsuarioSessaoInvalidaError';
  }
}
