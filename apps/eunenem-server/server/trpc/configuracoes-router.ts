import { randomUUID } from 'node:crypto';
import { initTRPC, TRPCError } from '@trpc/server';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import { LifecycleEmailPreferencesPostgres } from '../../../../src/adapters/email/lifecycle-email-preferences.postgres.js';
import type { IdPagamento } from '../../../../src/domain/pagamentos/value-objects/ids.js';
import { getPrivacy } from '../painel-settings-store.js';
import {
  PermissaoCampanhaNegadaError,
  resolverCampanhaComPermissao,
} from './exigir-permissao-campanha.js';
import {
  CampanhaAcessoNegadoError,
  CampanhaInexistenteError,
  resolverCampanhaAdministrada,
} from './resolve-campanha-administrada.js';
import { SessaoNaoAutenticadaError, resolverUsuarioAutenticado } from './session-resolver.js';
import type { TrpcContext } from './context.js';

const t = initTRPC.context<TrpcContext>().create();
const campaign = z.object({ idCampanha: z.string().uuid() });
// Map the shared resolver sentinels to non-leaking tRPC errors.
const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  try {
    await resolverUsuarioAutenticado(ctx.deps, ctx.headers);
  } catch (error) {
    if (error instanceof SessaoNaoAutenticadaError)
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Entre novamente para continuar.' });
    throw error;
  }
  return next();
});
const preferences = (ctx: TrpcContext) =>
  ctx.deps.lifecycleEmailPreferences ?? new LifecycleEmailPreferencesPostgres(ctx.deps.db);
async function resolve(ctx: TrpcContext, id: string, manage = false) {
  try {
    return manage
      ? await resolverCampanhaComPermissao(ctx, id, 'mensagens:gerenciar')
      : await resolverCampanhaAdministrada(ctx, id);
  } catch (error) {
    if (error instanceof PermissaoCampanhaNegadaError)
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Sem permissão para gerenciar mensagens.',
      });
    if (error instanceof CampanhaAcessoNegadoError || error instanceof CampanhaInexistenteError)
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Campanha não encontrada ou não autorizada.',
      });
    throw error;
  }
}
export const configuracoesRouter = t.router({
  get: protectedProcedure.input(campaign).query(async ({ ctx, input }) => {
    const { usuario } = await resolve(ctx, input.idCampanha);
    const email = await preferences(ctx).getPreferences(usuario.id, usuario.idPlataforma);
    const pending = await sql<{
      id: string;
    }>`SELECT id FROM solicitacoes_exclusao_conta WHERE usuario_id=${usuario.id} AND estado='em_analise'`.execute(
      ctx.deps.db,
    );
    return {
      solicitacaoExclusao: pending.rows[0]?.id ?? null,
      exibirRecados: await getPrivacy(ctx.deps.db, input.idCampanha),
      presentes: email.payment_received,
      recados: email.new_message ?? true,
      presencas: email.presence_confirmed ?? true,
    };
  }),
  privacidade: protectedProcedure
    .input(campaign.extend({ exibirRecados: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await resolve(ctx, input.idCampanha, true);
      await sql`INSERT INTO campanha_privacidade(campanha_id,exibir_recados) VALUES(${input.idCampanha},${input.exibirRecados}) ON CONFLICT(campanha_id) DO UPDATE SET exibir_recados=EXCLUDED.exibir_recados,atualizado_em=now()`.execute(
        ctx.deps.db,
      );
      return { exibirRecados: input.exibirRecados };
    }),
  emails: protectedProcedure
    .input(
      campaign.extend({
        presentes: z.boolean().optional(),
        recados: z.boolean().optional(),
        presencas: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { usuario } = await resolve(ctx, input.idCampanha);
      await preferences(ctx).setPreferences(usuario.id, usuario.idPlataforma, {
        ...(input.presentes !== undefined ? { payment_received: input.presentes } : {}),
        ...(input.recados !== undefined ? { new_message: input.recados } : {}),
        ...(input.presencas !== undefined ? { presence_confirmed: input.presencas } : {}),
      });
      return { salvo: true };
    }),
  moderar: protectedProcedure
    .input(campaign.extend({ idPagamento: z.string().uuid(), aprovado: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { usuario } = await resolve(ctx, input.idCampanha, true);
      const payment = await ctx.deps.pagamentoRepository.findById(input.idPagamento as IdPagamento);
      if (
        !payment ||
        payment.intencao.idCampanha !== input.idCampanha ||
        payment.status !== 'aprovado' ||
        !payment.intencao.contribuinte?.mensagem?.trim()
      )
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Recado não encontrado.' });
      await sql`INSERT INTO recado_moderacao(pagamento_id,campanha_id,aprovado,ator_id) VALUES(${input.idPagamento},${input.idCampanha},${input.aprovado},${usuario.id}) ON CONFLICT(pagamento_id) DO UPDATE SET aprovado=EXCLUDED.aprovado,ator_id=EXCLUDED.ator_id,atualizado_em=now()`.execute(
        ctx.deps.db,
      );
      return { aprovado: input.aprovado };
    }),
  solicitarExclusao: protectedProcedure
    .input(z.object({ confirmacao: z.literal('SOLICITAR EXCLUSAO') }))
    .mutation(async ({ ctx }) => {
      const { usuario } = await resolverUsuarioAutenticado(ctx.deps, ctx.headers);
      const session = await ctx.deps.auth.api.getSession({ headers: ctx.headers });
      const created = session?.session.createdAt
        ? new Date(session.session.createdAt).getTime()
        : NaN;
      const age = ctx.deps.clock().getTime() - created;
      if (session?.user.id !== usuario.id || !Number.isFinite(age) || age < 0 || age > 15 * 60_000)
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Por segurança, saia e entre novamente antes de confirmar a solicitação.',
        });
      // Read-only, conservative inventory across ALL campaigns. No automatic
      // eligibility decision or deletion; balances and legal retention need review.
      const { rows } = await sql<{
        campanhas: string;
        pagamentos: string;
        repasses: string;
        repassesEmAndamento: string;
        registrosDeSaldo: string;
        eventosFuturosOuSemData: string;
      }>`WITH owned AS (
      SELECT campanha_id FROM campanha_membros_permissoes WHERE id_conta=${usuario.idConta} AND papel='owner'
    ) SELECT (SELECT count(*) FROM owned)::text AS campanhas,
      (SELECT count(*) FROM eventos WHERE id_campanha IN (SELECT campanha_id FROM owned) AND (data_hora IS NULL OR data_hora>=now()))::text AS "eventosFuturosOuSemData",
      (SELECT count(*) FROM pagamentos WHERE intencao_id_campanha IN (SELECT campanha_id FROM owned))::text AS pagamentos,
      (SELECT count(*) FROM repasses_recebedor WHERE id_campanha IN (SELECT campanha_id FROM owned))::text AS repasses,
      (SELECT count(*) FROM repasses_recebedor WHERE id_campanha IN (SELECT campanha_id FROM owned) AND status IN ('solicitado','aprovado','transferindo','verificando','enviado_ao_banco'))::text AS "repassesEmAndamento",
      (SELECT count(*) FROM lancamentos_financeiros WHERE id_campanha IN (SELECT campanha_id FROM owned) AND tipo='credito_saldo_recebedor')::text AS "registrosDeSaldo"`.execute(
        ctx.deps.db,
      );
      const { rows: requests } = await sql<{
        id: string;
      }>`INSERT INTO solicitacoes_exclusao_conta(id,usuario_id,verificacoes) VALUES(${randomUUID()},${usuario.id},${JSON.stringify({ ...rows[0], requerAnaliseFinanceira: true, exclusaoAutomatica: false })}::jsonb) ON CONFLICT(usuario_id) WHERE estado='em_analise' DO UPDATE SET usuario_id=EXCLUDED.usuario_id RETURNING id`.execute(
        ctx.deps.db,
      );
      return { protocolo: requests[0]?.id, estado: 'em_analise' as const };
    }),
});
