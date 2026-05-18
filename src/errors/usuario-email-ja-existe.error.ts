export class UsuarioEmailJaExisteError extends Error {
  public readonly code = 'USUARIO_EMAIL_JA_EXISTE' as const;

  constructor(public readonly email: string) {
    super(`Email de usuario ja existe: ${email}`);
    this.name = 'UsuarioEmailJaExisteError';
  }
}
