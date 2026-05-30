/**
 * Composite (idPlataforma, slug) collision in `usuarios` (aperture-khbow).
 *
 * The use-case `registrarContaUsuario` resolves collisions BEFORE calling
 * `saveRegistroDomain` by walking `base, base-2, base-3…` until it finds
 * a free slot. This error is therefore a defensive bottom-of-the-stack
 * signal — it should only surface if two registrations race past the
 * pre-check AND the Postgres unique constraint catches the second one.
 */
export class UsuarioSlugJaExisteError extends Error {
  public readonly code = 'USUARIO_SLUG_JA_EXISTE' as const;

  constructor(public readonly slug: string) {
    super(`Slug de usuario ja existe: ${slug}`);
    this.name = 'UsuarioSlugJaExisteError';
  }
}
