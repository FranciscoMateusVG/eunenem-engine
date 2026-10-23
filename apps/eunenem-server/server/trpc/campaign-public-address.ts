import type { IdCampanha, IdConta, IdContaUsuario, Usuario } from '../../../../src/index.js';
import { ID_PLATAFORMA_EUNENEM } from '../auth/setup.js';
import type { TrpcContext } from './context.js';

/** Public addressing belongs to owners, never to invited administrators. */
export async function isCampaignPublicOwner(
  ctx: TrpcContext,
  idCampanha: IdCampanha,
  idConta: IdConta,
) {
  return (
    (await ctx.deps.campanhaMembrosRepository.obterAcesso(idCampanha, idConta))?.papel === 'owner'
  );
}

/**
 * aperture-851nu: a campaign is public only while at least one owner has an
 * active account. A sole owner who deactivates takes it offline; with an
 * active co-owner it stays up (including on the old owner's slug).
 */
export async function campanhaNoAr(ctx: TrpcContext, idCampanha: IdCampanha): Promise<boolean> {
  return (await campaignPublicOwner(ctx, idCampanha)) !== undefined;
}

/**
 * Stable owner ordering from the membership port; no financial transfer
 * implied. Deactivated owners are skipped, so share links point at an
 * active owner.
 */
export async function campaignPublicOwner(
  ctx: TrpcContext,
  idCampanha: IdCampanha,
): Promise<Usuario | undefined> {
  const members = await ctx.deps.campanhaMembrosRepository.listarMembros(idCampanha);
  for (const owner of members.filter((member) => member.papel === 'owner')) {
    const usuario = await ctx.deps.usuarioRepository.findUsuarioByConta(
      owner.idConta as unknown as IdContaUsuario,
      ID_PLATAFORMA_EUNENEM,
    );
    if (usuario && !usuario.desativadoEm) return usuario;
  }
  return undefined;
}

export async function campaignPublicOwnerSlug(
  ctx: TrpcContext,
  idCampanha: IdCampanha,
): Promise<string | null> {
  return (await campaignPublicOwner(ctx, idCampanha))?.slug ?? null;
}
