import { SLUG_USUARIO_REGEX, type SlugUsuario } from './value-objects/slug-usuario.js';

/**
 * Pure derivation: turn a `nomeExibicao` into a candidate slug.
 *
 * Algorithm (aperture-khbow):
 *   1. Strip diacritics (NFD + remove combining marks): "André" → "Andre"
 *   2. Lowercase
 *   3. Replace anything that is NOT [a-z0-9] with a single hyphen
 *   4. Collapse repeated hyphens and trim leading/trailing hyphens
 *   5. Take the FIRST hyphen-separated segment (operator convention:
 *      `/painel/helena` not `/painel/helena-silva`)
 *   6. Truncate to 30 chars
 *   7. If the result fails the slug regex (e.g. name started with a digit
 *      or was empty after sanitisation), fall back to `'usuario'` — the
 *      caller is expected to resolve collisions, so `usuario`, `usuario-2`,
 *      `usuario-3` are always valid escape hatches.
 *
 * The return is a CANDIDATE — not guaranteed unique. The caller
 * (`registrarContaUsuario`) walks `base`, `base-2`, `base-3`… against
 * `findUsuarioBySlug` within the target plataforma until it finds a free
 * one.
 */
export function deriveSlugBase(nomeExibicao: string): SlugUsuario {
  // U+0300..U+036F = Combining Diacritical Marks block. NFD splits "é"
  // into "e" + U+0301; this regex drops every combining mark and leaves
  // bare base letters.
  const stripped = nomeExibicao.normalize('NFD').replace(/[̀-ͯ]/g, '');

  const sanitised = stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  // First hyphen-separated word — operator's "first name" convention.
  const firstSegment = sanitised.split('-')[0] ?? '';

  // Truncate to 30 chars (the VO's max length).
  const truncated = firstSegment.slice(0, 30);

  if (SLUG_USUARIO_REGEX.test(truncated)) {
    return truncated;
  }

  // Pad too-short segments to ≥3 chars by appending more digits if needed.
  // Common case: name was a single char ("X") → truncated="x" → invalid.
  // Easier fallback: punt to a generic base + let collision-resolver suffix.
  return 'usuario';
}

/**
 * Build a candidate slug with a numeric suffix. Used by the collision walker.
 *
 * `slugWithSuffix(base, 1) → base` (no suffix on the first try).
 * `slugWithSuffix(base, 2) → base-2`.
 * `slugWithSuffix(base, 3) → base-3`.
 *
 * Always keeps the result ≤30 chars by truncating `base` if the suffix would
 * push it over.
 */
export function slugWithSuffix(base: SlugUsuario, attempt: number): SlugUsuario {
  if (attempt <= 1) return base;
  const suffix = `-${attempt}`;
  const maxBaseLen = 30 - suffix.length;
  const trimmedBase = base.slice(0, maxBaseLen).replace(/-+$/g, '');
  // The trimmed base may now be too short (<3 chars) — that's still fine
  // because we're suffixing. e.g. 'us-2' = 4 chars total, passes the regex.
  // Defensive: if trimming nuked the leading letter, fall back to 'usuario'.
  if (!/^[a-z]/.test(trimmedBase)) {
    return `usuario${suffix}`;
  }
  return `${trimmedBase}${suffix}`;
}
