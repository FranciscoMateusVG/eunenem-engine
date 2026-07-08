/**
 * Shared campanha resolver for the authed single-resolve hops (aperture-yeauv,
 * bvz0p Phase 1 — per-campanha routing). Promotes recebedor-router's
 * resolveAdminOfCampanha into ONE place every authed hop calls, with the
 * OPTIONAL-idCampanha back-compat contract:
 *
 *   - idCampanha PRESENT → resolve THAT campanha and verify the caller owns it
 *     (campanha.idsAdministradores includes usuario.idConta). Not-found AND
 *     not-owner collapse to the SAME non-leaking sentinel — an attacker can't
 *     distinguish "doesn't exist" from "not yours".
 *   - idCampanha ABSENT → resolve the OLDEST campanha the caller administers
 *     (findByAdministrador = criada_em ASC, #332). This is the HARD back-compat
 *     rule: every bare URL / old client keeps meaning the oldest campanha.
 *
 * WHY typed sentinels (not TRPCError): `instanceof TRPCError` is fragile across
 * the apps/eunenem-server ↔ root-tests module boundary (the runner resolves
 * `@trpc/server` from a different location, so constructor identities diverge —
 * see contribuicao-router). Each caller's `toTRPCError` maps these sentinels,
 * imported from THIS module (single relative resolution → stable instanceof):
 *   - CampanhaAcessoNegadoError → UNAUTHORIZED (session fail / not-owner /
 *     not-found — all non-leaking)
 *   - CampanhaInexistenteError  → INTERNAL_SERVER_ERROR (absent branch + the
 *     caller administers no campanha = data-model inconsistency; fail loud)
 */
import type { Campanha, IdCampanha, Usuario } from '../../../../src/index.js';
import type { TrpcContext } from './context.js';
import { resolverUsuarioAutenticado, SessaoNaoAutenticadaError } from './session-resolver.js';

/** UNAUTHORIZED-bearing sentinel — session failure, not-owner, or not-found. */
export class CampanhaAcessoNegadoError extends Error {
  public readonly name = 'CampanhaAcessoNegadoError';
}

/** INTERNAL-bearing sentinel — the caller administers no campanha at all. */
export class CampanhaInexistenteError extends Error {
  public readonly name = 'CampanhaInexistenteError';
}

/**
 * Resolve the campanha an authenticated caller may act on.
 *
 * @param ctx         the tRPC request context (session cookie in headers)
 * @param idCampanha  OPTIONAL — present: resolve+own-gate that campanha;
 *                    absent: resolve the caller's OLDEST campanha (back-compat)
 * @returns the resolved `usuario` + `campanha`
 * @throws CampanhaAcessoNegadoError  no/invalid session, or a present
 *         idCampanha the caller doesn't own / that doesn't exist
 * @throws CampanhaInexistenteError   absent idCampanha + caller owns none
 */
export async function resolverCampanhaAdministrada(
  ctx: TrpcContext,
  idCampanha?: string,
): Promise<{ usuario: Usuario; campanha: Campanha }> {
  const { deps, headers } = ctx;

  let usuario: Usuario;
  try {
    usuario = (await resolverUsuarioAutenticado(deps, headers)).usuario;
  } catch (err) {
    if (err instanceof SessaoNaoAutenticadaError) {
      throw new CampanhaAcessoNegadoError('Sessao invalida');
    }
    throw err;
  }

  if (idCampanha !== undefined && idCampanha !== '') {
    const campanha = await deps.campanhaRepository.findById(idCampanha as IdCampanha);
    // Not-found AND not-owner collapse to the SAME error — never leak which.
    if (!campanha || !campanha.idsAdministradores.includes(usuario.idConta)) {
      throw new CampanhaAcessoNegadoError('Campanha nao encontrada ou nao autorizada');
    }
    return { usuario, campanha };
  }

  // Back-compat: bare URL / old client → the oldest campanha (criada_em ASC).
  const campanha = await deps.campanhaRepository.findByAdministrador(usuario.idConta);
  if (!campanha) {
    throw new CampanhaInexistenteError('Usuario nao administra nenhuma campanha');
  }
  return { usuario, campanha };
}
