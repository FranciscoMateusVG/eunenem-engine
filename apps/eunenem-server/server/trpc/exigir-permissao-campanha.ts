/**
 * Per-action authorization for shared campanhas (aperture-1z18g). Every authed
 * procedure that needs a specific action calls THIS instead of
 * `resolverCampanhaAdministrada` directly:
 *
 *   1. `resolverCampanhaAdministrada` — session + admin membership (non-leaking
 *      UNAUTHORIZED sentinel for not-admin / not-found);
 *   2. `assertCampaignPermission` — owner always passes; a membro passes only
 *      for actions the owner granted. Read fresh on every request, so a
 *      revocation takes effect on the very next call.
 *
 * Denial surfaces as `PermissaoCampanhaNegadaError` (→ FORBIDDEN). It is a
 * typed sentinel owned by THIS module for the same reason as the resolver's
 * sentinels: `instanceof` across the apps ↔ root-tests module boundary is
 * only stable for classes imported from one relative location.
 */
import {
  type AcaoCampanha,
  type AcessoMembroCampanha,
  assertCampaignPermission,
  type Campanha,
  CampanhaPermissaoNegadaError,
  type IdCampanha,
  type Usuario,
} from '../../../../src/index.js';
import type { TrpcContext } from './context.js';
import { resolverCampanhaAdministrada } from './resolve-campanha-administrada.js';

/** FORBIDDEN-bearing sentinel — caller administers the campanha but lacks the action. */
export class PermissaoCampanhaNegadaError extends Error {
  public readonly name = 'PermissaoCampanhaNegadaError';
  constructor(public readonly acao: AcaoCampanha) {
    super(`sem_permissao:${acao}`);
  }
}

/**
 * Require `acao` for an ALREADY-resolved campanha + caller (for hops with
 * their own resolver, e.g. the slug-based painel-mensagens).
 *
 * @throws PermissaoCampanhaNegadaError
 */
export async function exigirPermissaoCampanha(
  ctx: TrpcContext,
  idCampanha: IdCampanha,
  idConta: string,
  acao: AcaoCampanha,
): Promise<AcessoMembroCampanha> {
  try {
    return await assertCampaignPermission(
      {
        campanhaMembrosRepository: ctx.deps.campanhaMembrosRepository,
        observability: ctx.deps.observability,
      },
      { idCampanha, idConta, acao },
    );
  } catch (err) {
    if (err instanceof CampanhaPermissaoNegadaError) throw new PermissaoCampanhaNegadaError(acao);
    throw err;
  }
}

/**
 * Resolve the campanha (same contract as `resolverCampanhaAdministrada`) and
 * require `acao` on it.
 *
 * @throws CampanhaAcessoNegadoError / CampanhaInexistenteError (from the resolver)
 * @throws PermissaoCampanhaNegadaError when the admin lacks `acao`
 */
export async function resolverCampanhaComPermissao(
  ctx: TrpcContext,
  idCampanha: string | undefined,
  acao: AcaoCampanha,
): Promise<{ usuario: Usuario; campanha: Campanha; acesso: AcessoMembroCampanha }> {
  const { usuario, campanha } = await resolverCampanhaAdministrada(ctx, idCampanha);
  const acesso = await exigirPermissaoCampanha(ctx, campanha.id, usuario.idConta, acao);
  return { usuario, campanha, acesso };
}
