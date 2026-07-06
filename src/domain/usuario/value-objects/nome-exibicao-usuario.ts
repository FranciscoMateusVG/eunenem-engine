import { z } from 'zod/v4';

/**
 * Value object: the user's displayable name. Trimmed, non-empty, max 120 chars.
 * Immutable, equality by value.
 */
export const NomeExibicaoUsuarioSchema = z
  .string()
  .trim()
  .min(1, 'Nome de exibicao nao pode ser vazio')
  .max(120);

export type NomeExibicaoUsuario = z.infer<typeof NomeExibicaoUsuarioSchema>;

/**
 * Derive a guaranteed-valid display name from a possibly-empty OAuth profile
 * name (aperture-uq69m). Microsoft's OIDC can return an empty/absent `name`
 * claim — verified in prod: BOTH thacyane@hotmail and diego@bessa.digital had
 * `users.name = ''`, so the OAuth-orphan self-heal's
 * `NomeExibicaoUsuarioSchema.parse` threw "Nome de exibicao nao pode ser vazio"
 * and stranded a half-authed user (session, but no `usuarios` domain row). This
 * returns a NON-EMPTY string of length 1..120 that `NomeExibicaoUsuarioSchema`
 * ALWAYS accepts, in priority order:
 *   1. the trimmed profile name, if present;
 *   2. else the email local-part (before `@`) — a stable, human-recognisable
 *      handle;
 *   3. else a final `'Usuário'` fallback (an email with no local-part is
 *      pathological but must not crash the heal).
 *
 * Callers with richer profile fields (e.g. Microsoft's split `given_name` +
 * `family_name`) should compose their best candidate name and pass it as
 * `nome`; this function only guarantees the non-empty invariant.
 */
export function derivarNomeExibicaoFallback(
  nome: string | null | undefined,
  email: string,
): string {
  const clampar = (s: string) => s.slice(0, 120);
  const informado = (nome ?? '').trim();
  if (informado.length > 0) return clampar(informado);
  const localPart = (email.split('@')[0] ?? '').trim();
  if (localPart.length > 0) return clampar(localPart);
  return 'Usuário';
}
