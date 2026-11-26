/**
 * aperture-bqvb5 — agradecer quem presenteou.
 *
 *   - `agradecimentos.destinatarios` — pessoas que deram presentes pagos,
 *     agrupadas por e-mail (o e-mail não sai do servidor).
 *   - `agradecimentos.enviar` — um e-mail por pessoa: a mensagem escrita
 *     agora, a padrão da lista ou a sugerida. Reply-To é a titular. Registra
 *     `agradecido_em` por presente. Limite: 200 destinatários/hora/usuário.
 *
 * Ambos exigem `mensagens:gerenciar` (a mesma permissão dos recados).
 */
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod/v4';
import type { IdCampanha } from '../../../../src/index.js';
import {
  listarPessoasAgradeciveis,
  registrarAgradecimento,
  resolverDestinatarios,
} from '../agradecimentos.js';
import {
  MENSAGEM_AGRADECIMENTO_SUGERIDA,
  renderAgradecimentoEmail,
} from '../auth/agradecimento-email.js';
import { campaignPublicOwner } from './campaign-public-address.js';
import type { TrpcContext } from './context.js';
import {
  PermissaoCampanhaNegadaError,
  resolverCampanhaComPermissao,
} from './exigir-permissao-campanha.js';
import { enforceRateLimitBudget } from './rate-limit.js';
import {
  CampanhaAcessoNegadoError,
  CampanhaInexistenteError,
} from './resolve-campanha-administrada.js';
import { SessaoNaoAutenticadaError } from './session-resolver.js';

const t = initTRPC.context<TrpcContext>().create();

export const AGRADECIMENTOS_POR_HORA = 200;

const campanhaInput = z.object({ idCampanha: z.string().uuid() });

async function resolver(ctx: TrpcContext, idCampanha: string) {
  try {
    return await resolverCampanhaComPermissao(ctx, idCampanha, 'mensagens:gerenciar');
  } catch (error) {
    if (error instanceof SessaoNaoAutenticadaError) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Entre novamente para continuar.' });
    }
    if (error instanceof PermissaoCampanhaNegadaError) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Sem permissão para enviar agradecimentos.' });
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

export const agradecimentosRouter = t.router({
  destinatarios: t.procedure.input(campanhaInput).query(async ({ ctx, input }) => {
    const { campanha } = await resolver(ctx, input.idCampanha);
    return { pessoas: await listarPessoasAgradeciveis(ctx.deps.db, campanha.id) };
  }),

  enviar: t.procedure
    .input(
      campanhaInput.extend({
        idsPagamento: z.array(z.string().uuid()).min(1).max(1000),
        /** Ausente → mensagem padrão da lista (ou a sugerida). */
        mensagem: z.string().trim().min(1).max(5000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { usuario, campanha } = await resolver(ctx, input.idCampanha);
      const { deps } = ctx;
      const destinatarios = await resolverDestinatarios(deps.db, campanha.id, input.idsPagamento);
      if (!destinatarios) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Presente não encontrado nesta lista.' });
      }
      await enforceRateLimitBudget(deps.db, {
        key: `agradecer:${usuario.id}`,
        max: AGRADECIMENTOS_POR_HORA,
        windowMs: 3600_000,
        cost: destinatarios.length,
      });

      const mensagem =
        input.mensagem ??
        (await deps.campanhaPrivacidadeRepository.mensagemAgradecimento(
          campanha.id as IdCampanha,
        )) ??
        MENSAGEM_AGRADECIMENTO_SUGERIDA;
      // Reply-To é a titular da lista (mesmo quando um membro envia).
      const titular = (await campaignPublicOwner(ctx, campanha.id)) ?? usuario;

      let enviados = 0;
      let falhas = 0;
      for (const destinatario of destinatarios) {
        try {
          await deps.enviarEmailAgradecimento(
            renderAgradecimentoEmail({
              para: destinatario,
              titular: { nome: titular.nomeExibicao, email: titular.email },
              tituloLista: campanha.titulo,
              mensagem,
            }),
          );
          await registrarAgradecimento(
            deps.db,
            campanha.id,
            destinatario.idsPagamento,
            deps.clock(),
          );
          enviados += 1;
        } catch {
          // Sem e-mail/erro SMTP no log (postura no-oracle do transporte).
          falhas += 1;
        }
      }
      deps.observability.logger.info('agradecimentos.enviados', {
        'campanha.id': campanha.id,
        enviados,
        falhas,
      });
      return { enviados, falhas };
    }),
});
