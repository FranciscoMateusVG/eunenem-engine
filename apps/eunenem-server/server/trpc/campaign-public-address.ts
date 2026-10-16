import type { IdCampanha, IdConta } from '../../../../src/index.js';
import { ID_PLATAFORMA_EUNENEM } from '../auth/setup.js';
import type { TrpcContext } from './context.js';

/** Public addressing belongs to owners, never to invited administrators. */
export async function isCampaignPublicOwner(ctx: TrpcContext, idCampanha: IdCampanha, idConta: IdConta) {
  return (await ctx.deps.campanhaMembrosRepository.obterAcesso(idCampanha, idConta))?.papel === 'owner';
}

/** Stable owner ordering from the membership port; no financial transfer implied. */
export async function campaignPublicOwnerSlug(ctx: TrpcContext, idCampanha: IdCampanha): Promise<string | null> {
  const members = await ctx.deps.campanhaMembrosRepository.listarMembros(idCampanha);
  for (const owner of members.filter(member => member.papel === 'owner')) {
    const usuario = await ctx.deps.usuarioRepository.findUsuarioByConta(owner.idConta as never, ID_PLATAFORMA_EUNENEM);
    if (usuario) return usuario.slug;
  }
  return null;
}
