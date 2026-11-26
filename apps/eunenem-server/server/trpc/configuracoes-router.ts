/**
 * Configurações do painel (aperture-851nu).
 *
 * Procedures:
 *   - `configuracoes.get`         — estado atual dos toggles da página.
 *   - `configuracoes.emails`      — preferências de e-mail do PRÓPRIO usuário
 *     (por usuário, não por campanha), sobre LifecycleEmailPreferences — o
 *     envio já consulta essa preferência antes de cada e-mail.
 *   - `configuracoes.privacidade` — "Exibir recados publicamente" da campanha;
 *     exige `mensagens:gerenciar`. O mural público respeita o valor.
 *
 *   - `configuracoes.excluirLista` — exclusão da lista pelo titular.
 */
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod/v4';
import {
  type LifecycleEmailPreferences,
  LifecycleEmailPreferencesPostgres,
  type LifecycleEmailType,
} from '../../../../src/adapters/email/lifecycle-email-preferences.postgres.js';
import type { IdCampanha } from '../../../../src/index.js';
import { MENSAGEM_AGRADECIMENTO_SUGERIDA } from '../auth/agradecimento-email.js';
import type { TrpcContext } from './context.js';
import {
  PermissaoCampanhaNegadaError,
  resolverCampanhaComPermissao,
} from './exigir-permissao-campanha.js';
import {
  CampanhaAcessoNegadoError,
  CampanhaInexistenteError,
  resolverCampanhaAdministrada,
} from './resolve-campanha-administrada.js';
import { SessaoNaoAutenticadaError } from './session-resolver.js';

const t = initTRPC.context<TrpcContext>().create();

/** Toggle da tela → tipo de e-mail. Novos tipos entram só aqui. */
const EMAIL_TOGGLES = {
  presentes: 'payment_received',
  recados: 'new_message',
  presencas: 'presence_confirmed',
} as const satisfies Record<string, LifecycleEmailType>;
type EmailToggle = keyof typeof EMAIL_TOGGLES;
type EmailToggles = Record<EmailToggle, boolean>;
const EMAIL_TOGGLE_KEYS = Object.keys(EMAIL_TOGGLES) as EmailToggle[];

const campanhaInput = z.object({ idCampanha: z.string().uuid() });
const emailsInput = campanhaInput.extend(
  Object.fromEntries(EMAIL_TOGGLE_KEYS.map((k) => [k, z.boolean().optional()])) as Record<
    EmailToggle,
    z.ZodOptional<z.ZodBoolean>
  >,
);

function preferencias(ctx: TrpcContext) {
  return ctx.deps.lifecycleEmailPreferences ?? new LifecycleEmailPreferencesPostgres(ctx.deps.db);
}

function paraToggles(prefs: LifecycleEmailPreferences): EmailToggles {
  return Object.fromEntries(
    EMAIL_TOGGLE_KEYS.map((k) => [k, prefs[EMAIL_TOGGLES[k]]]),
  ) as EmailToggles;
}

/** Mapeia os sentinelas dos resolvers compartilhados para erros que não vazam. */
async function resolver(ctx: TrpcContext, idCampanha: string, gerenciarMensagens = false) {
  try {
    return gerenciarMensagens
      ? await resolverCampanhaComPermissao(ctx, idCampanha, 'mensagens:gerenciar')
      : await resolverCampanhaAdministrada(ctx, idCampanha);
  } catch (error) {
    if (error instanceof SessaoNaoAutenticadaError) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Entre novamente para continuar.' });
    }
    if (error instanceof PermissaoCampanhaNegadaError) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Sem permissão para gerenciar mensagens.' });
    }
    if (error instanceof CampanhaAcessoNegadoError || error instanceof CampanhaInexistenteError) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Campanha não encontrada ou não autorizada.',
      });
    }
    throw error;
  }
}

export const configuracoesRouter = t.router({
  get: t.procedure.input(campanhaInput).query(async ({ ctx, input }) => {
    const { usuario, campanha } = await resolver(ctx, input.idCampanha);
    const [prefs, exibirRecados, mensagemAgradecimento] = await Promise.all([
      preferencias(ctx).getPreferences(usuario.id, usuario.idPlataforma),
      ctx.deps.campanhaPrivacidadeRepository.exibeRecadosPublicamente(campanha.id),
      ctx.deps.campanhaPrivacidadeRepository.mensagemAgradecimento(campanha.id),
    ]);
    return {
      tituloLista: campanha.titulo,
      exibirRecados,
      emails: paraToggles(prefs),
      // aperture-bqvb5 — null = a lista usa a mensagem sugerida.
      mensagemAgradecimento,
      mensagemAgradecimentoSugerida: MENSAGEM_AGRADECIMENTO_SUGERIDA,
    };
  }),

  excluirLista: t.procedure.input(campanhaInput).mutation(async ({ ctx, input }) => {
    const { usuario, campanha } = await resolver(ctx, input.idCampanha);
    const { deps } = ctx;
    const erroFinanceiro = () =>
      new TRPCError({
        code: 'CONFLICT',
        message: 'Esta lista tem histórico financeiro. Fale com o atendimento para solicitar a exclusão.',
      });

    try {
      await deps.db.transaction().execute(async (trx) => {
        const lista = await trx
          .selectFrom('campanhas')
          .select('id')
          .where('id', '=', campanha.id)
          .forUpdate()
          .executeTakeFirst();
        if (!lista) return;

        const acesso = await deps.campanhaMembrosRepository.obterAcesso(
          campanha.id,
          usuario.idConta,
          { trx },
        );
        if (acesso?.papel !== 'owner') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Somente o titular pode excluir esta lista.',
          });
        }

        // Pagamentos e contribuições têm FKs restritivas. Estas tabelas
        // financeiras têm referência sem FK restritiva ou com cascata.
        const [lancamento, repasse, resgate] = await Promise.all([
          trx
            .selectFrom('lancamentos_financeiros')
            .select('id')
            .where('id_campanha', '=', campanha.id)
            .limit(1)
            .executeTakeFirst(),
          trx
            .selectFrom('repasses_recebedor')
            .select('id')
            .where('id_campanha', '=', campanha.id)
            .limit(1)
            .executeTakeFirst(),
          trx
            .selectFrom('resgates_pendentes')
            .select('id_campanha')
            .where('id_campanha', '=', campanha.id)
            .executeTakeFirst(),
        ]);
        if (lancamento || repasse || resgate) throw erroFinanceiro();

        await deps.campanhaRepository.delete(campanha.id, { trx });
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === '23503') {
        throw erroFinanceiro();
      }
      throw error;
    }
    return { ok: true as const };
  }),

  emails: t.procedure.input(emailsInput).mutation(async ({ ctx, input }) => {
    const { usuario } = await resolver(ctx, input.idCampanha);
    const patch: Partial<LifecycleEmailPreferences> = {};
    for (const k of EMAIL_TOGGLE_KEYS) {
      const valor = input[k];
      if (typeof valor === 'boolean') patch[EMAIL_TOGGLES[k]] = valor;
    }
    const repo = preferencias(ctx);
    await repo.setPreferences(usuario.id, usuario.idPlataforma, patch);
    return paraToggles(await repo.getPreferences(usuario.id, usuario.idPlataforma));
  }),

  privacidade: t.procedure
    .input(campanhaInput.extend({ exibirRecados: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { campanha } = await resolver(ctx, input.idCampanha, true);
      await ctx.deps.campanhaPrivacidadeRepository.definirExibirRecados(campanha.id as IdCampanha, input.exibirRecados);
      return { exibirRecados: input.exibirRecados };
    }),

  /** aperture-bqvb5 — mensagem padrão de agradecimento; vazio/null volta à sugerida. */
  mensagemAgradecimento: t.procedure
    .input(campanhaInput.extend({ mensagem: z.string().trim().max(5000).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const { campanha } = await resolver(ctx, input.idCampanha, true);
      const mensagem = input.mensagem ? input.mensagem : null;
      await ctx.deps.campanhaPrivacidadeRepository.definirMensagemAgradecimento(
        campanha.id as IdCampanha,
        mensagem,
      );
      return { mensagemAgradecimento: mensagem };
    }),
});
