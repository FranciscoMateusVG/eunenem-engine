import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  CampanhaCompartilhamentoPostgres,
  EmailJaMembroCampanhaError,
} from '../../../../src/adapters/arrecadacao/campanha-compartilhamento.postgres.js';
import { assertCampaignPermission } from '../../../../src/use-cases/arrecadacao/assert-campaign-permission.js';
import { ID_PLATAFORMA_EUNENEM, type IdCampanha } from '../../../../src/index.js';
import type { TrpcContext } from './context.js';
import { resolverUsuarioAutenticado, SessaoNaoAutenticadaError } from './session-resolver.js';
import { enforceRateLimit } from './rate-limit.js';

const t = initTRPC.context<TrpcContext>().create();
const campaignInput = z.object({ idCampanha: z.uuid() });
const ownerProcedure = t.procedure.input(campaignInput).use(async ({ ctx, input, next }) => {
  try {
    const { usuario } = await resolverUsuarioAutenticado(ctx.deps, ctx.headers);
    const sharing = new CampanhaCompartilhamentoPostgres(ctx.deps.db);
    const emails: string[] = [];
    const result = await ctx.deps.db.transaction().execute(async (trx) => {
      const campaign = await trx
        .selectFrom('campanhas')
        .select('id')
        .where('id', '=', input.idCampanha)
        .where('id_plataforma', '=', ID_PLATAFORMA_EUNENEM)
        .forUpdate()
        .executeTakeFirst();
      if (!campaign)
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Campanha não autorizada.' });
      await assertCampaignPermission(
        {
          campanhaMembrosRepository: ctx.deps.campanhaMembrosRepository,
          observability: ctx.deps.observability,
        },
        {
          idCampanha: input.idCampanha as IdCampanha,
          idConta: usuario.idConta,
          acao: 'membros:gerenciar',
        },
        { trx },
      );
      const result = await next({ ctx: { ...ctx, usuario, sharing, trx, emails } });
      if (!result.ok) {
        if (result.error.cause instanceof EmailJaMembroCampanhaError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: result.error.cause.message });
        }
        throw result.error;
      }
      return result;
    });
    for (const email of emails) await ctx.deps.enviarConviteCampanha(email);
    return result;
  } catch (error) {
    if (error instanceof EmailJaMembroCampanhaError)
      throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
    if (error instanceof SessaoNaoAutenticadaError) throw new TRPCError({ code: 'UNAUTHORIZED' });
    if (error instanceof Error && error.name === 'CampanhaPermissaoNegadaError')
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Somente o proprietário pode compartilhar a campanha.',
      });
    throw error;
  }
});

export const compartilhamentoRouter = t.router({
  listarConvites: ownerProcedure.query(async ({ ctx, input }) => {
    return ctx.trx
      .selectFrom('campanha_convites')
      .select(['id', 'email', 'expira_em', 'revogado_em', 'consumido_em'])
      .where('campanha_id', '=', input.idCampanha)
      .orderBy('criado_em', 'desc')
      .execute();
  }),
  convidar: ownerProcedure
    .input(z.object({ email: z.string().trim().email().max(254) }))
    .mutation(async ({ ctx, input }) => {
      await enforceRateLimit(ctx.deps.db, {
        key: `compartilhar:${ctx.usuario.id}`,
        max: 20,
        windowMs: 3600_000,
      });
      await ctx.sharing.convidar(
        {
          campanhaId: input.idCampanha,
          plataformaId: ID_PLATAFORMA_EUNENEM,
          email: input.email,
          atorId: ctx.usuario.id,
          origem: 'owner',
        },
        ctx.trx,
      );
      ctx.emails.push(input.email.trim().toLowerCase());
      return { ok: true };
    }),
  revogar: ownerProcedure
    .input(z.object({ idConvite: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.sharing.revogar(
        input.idCampanha,
        ID_PLATAFORMA_EUNENEM,
        input.idConvite,
        ctx.usuario.id,
        ctx.trx,
      );
      return { ok: true };
    }),
});
