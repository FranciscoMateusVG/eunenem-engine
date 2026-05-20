export class UsuarioInputInvalidoError extends Error {
  public readonly code = 'USUARIO_INPUT_INVALIDO' as const;

  constructor(public readonly reason: string) {
    super(`Input de usuario invalido: ${reason}`);
    this.name = 'UsuarioInputInvalidoError';
  }
}
