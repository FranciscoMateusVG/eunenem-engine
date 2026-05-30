import { z } from 'zod/v4';

/**
 * Value object: the user's public URL-segment slug (e.g. /painel/helena).
 *
 * Constraints (aperture-khbow):
 *   - Lowercase only
 *   - 3-30 characters
 *   - Alphanumeric + hyphens
 *   - MUST start with a letter (no leading digit/hyphen; avoids slugs that
 *     look like ids or that path-collide with future reserved prefixes)
 *
 * Uniqueness is composite `(idPlataforma, slug)`, enforced at the repository
 * layer — same multi-tenancy boundary as email. The same slug can exist on
 * eunenem AND eucasei without collision.
 */
export const SLUG_USUARIO_REGEX = /^[a-z][a-z0-9-]{2,29}$/;

export const SlugUsuarioSchema = z
  .string()
  .trim()
  .regex(
    SLUG_USUARIO_REGEX,
    'Slug deve ter 3-30 caracteres, começar com letra, conter apenas letras minúsculas, dígitos ou hífens',
  );

export type SlugUsuario = z.infer<typeof SlugUsuarioSchema>;
