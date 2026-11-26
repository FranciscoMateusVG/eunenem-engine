import {
  type Campanha,
  campanhaArquivada,
  type IdCampanha,
  type IdConta,
  type IdContaUsuario,
  type Usuario,
} from '../../../../src/index.js';
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
 *
 * aperture-bqvb5: an archived list is offline too — nobody can view it or buy
 * from it. Only the public surface reads this; the painel never does.
 */
export async function campanhaNoAr(ctx: TrpcContext, idCampanha: IdCampanha): Promise<boolean> {
  const campanha = await ctx.deps.campanhaRepository.findById(idCampanha);
  if (!campanha || campanhaArquivada(campanha)) return false;
  return (await campaignPublicOwner(ctx, idCampanha)) !== undefined;
}

/**
 * aperture-bqvb5: the list a bare `/pagina/<slug>` (no list in the URL)
 * shows — the conta's OLDEST owned list that is not archived. Same order as
 * `findByAdministrador` (criada_em ASC, id ASC), which stays the painel's
 * default; only the public surface skips archived lists.
 */
export async function campanhaPublicaPadrao(
  ctx: TrpcContext,
  idConta: IdConta,
): Promise<Campanha | undefined> {
  const campanhas = await ctx.deps.campanhaRepository.findCampanhasByAdministrador(idConta);
  for (const campanha of campanhas) {
    if (campanhaArquivada(campanha)) continue;
    if (await isCampaignPublicOwner(ctx, campanha.id, idConta)) return campanha;
  }
  return undefined;
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
