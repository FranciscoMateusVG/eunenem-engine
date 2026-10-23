/**
 * campanhaMembros.* — owner-managed per-action permissions for shared
 * campanhas (aperture-1z18g).
 *
 *   - `meuAcesso`         any admin: own papel + effective actions (drives the
 *                         UI hiding what the caller can't do).
 *   - `listar`            OWNER-ONLY: every admin with papel + grants.
 *   - `definirPermissoes` OWNER-ONLY: replace a membro's grants.
 *   - `remover`           OWNER-ONLY: the ONLY member-removal path. Owners
 *                         can't be removed (v1 has no ownership transfer).
 *                         Revokes the member's pending invites through the
 *                         `revogarConvitesPendentesDoMembro` hook in the SAME
 *                         transaction, then drops admin + papel rows.
 *
 * Mutations run in one transaction holding the campanha row FOR UPDATE (same
 * lock order as the invite flow) and re-check the owner under the lock. Every
 * change is effective on the member's next request (guards read fresh state).
 * Invites themselves live in the sharing flow.
 */
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  ACOES_CONCEDIVEIS,
  type AcaoConcedivel,
  acoesPermitidas,
  ArrecadacaoAdministradorNaoEncontradoError,
  ArrecadacaoInputInvalidoError,
  assertCampaignPermission,
  CampanhaPermissaoNegadaError,
  definirPermissoesMembroCampanha,
  type IdCampanha,
} from '../../../../src/index.js';
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

const t = initTRPC.context<TrpcContext>().create();

const IdCampanhaInput = z.object({ idCampanha: z.string().uuid() });
const AcaoConcedivelWire = z.enum(ACOES_CONCEDIVEIS);
const AcaoWire = z.enum([...ACOES_CONCEDIVEIS, 'membros:gerenciar']);

const MembroDTOSchema = z.object({
  idConta: z.string(),
  papel: z.enum(['owner', 'membro']),
  /** Effective grantable actions (owner = all of them). */
  permissoes: z.array(AcaoConcedivelWire),
  nomeExibicao: z.string().nullable(),
  email: z.string().nullable(),
});

function toTRPCError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof CampanhaAcessoNegadoError) {
    return new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
  }
  if (err instanceof CampanhaInexistenteError) {
    return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
  }
  if (err instanceof PermissaoCampanhaNegadaError || err instanceof CampanhaPermissaoNegadaError) {
    return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
  }
  if (err instanceof ArrecadacaoAdministradorNaoEncontradoError) {
    return new TRPCError({ code: 'NOT_FOUND', message: 'membro_nao_encontrado', cause: err });
  }
  if (err instanceof ArrecadacaoInputInvalidoError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'erro_interno', cause: err });
}

function concediveis(acoes: readonly string[]): AcaoConcedivel[] {
  return ACOES_CONCEDIVEIS.filter((a) => acoes.includes(a));
}

export const campanhaMembrosRouter = t.router({
  meuAcesso: t.procedure
    .input(IdCampanhaInput)
    .output(z.object({ papel: z.enum(['owner', 'membro']), acoes: z.array(AcaoWire) }))
    .query(async ({ ctx, input }) => {
      try {
        const { usuario, campanha } = await resolverCampanhaAdministrada(ctx, input.idCampanha);
        const acesso = await ctx.deps.campanhaMembrosRepository.obterAcesso(
          campanha.id,
          usuario.idConta,
        );
        // Admin without a papel row = no rights (fail-closed, same as the guards).
        const efetivo = acesso ?? { papel: 'membro' as const, permissoes: [] };
        return { papel: efetivo.papel, acoes: [...acoesPermitidas(efetivo)] };
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  listar: t.procedure
    .input(IdCampanhaInput)
    .output(z.array(MembroDTOSchema))
    .query(async ({ ctx, input }) => {
      try {
        const { campanha } = await resolverCampanhaComPermissao(
          ctx,
          input.idCampanha,
          'membros:gerenciar',
        );
        const membros = await ctx.deps.campanhaMembrosRepository.listarMembros(campanha.id);
        return Promise.all(
          membros.map(async (m) => {
            const usuario = await ctx.deps.usuarioRepository.findUsuarioByConta(
              m.idConta,
              campanha.idPlataforma,
            );
            return {
              idConta: m.idConta,
              papel: m.papel,
              permissoes: concediveis(acoesPermitidas(m)),
              nomeExibicao: usuario?.nomeExibicao ?? null,
              email: usuario?.email ?? null,
            };
          }),
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  definirPermissoes: t.procedure
    .input(
      IdCampanhaInput.extend({
        idConta: z.string().uuid(),
        permissoes: z.array(AcaoConcedivelWire).max(ACOES_CONCEDIVEIS.length),
      }),
    )
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      try {
        // Session + membership + owner pre-check outside the trx (cheap,
        // non-leaking UNAUTHORIZED for outsiders); re-checked under the lock.
        const { usuario, campanha } = await resolverCampanhaComPermissao(
          ctx,
          input.idCampanha,
          'membros:gerenciar',
        );
        await ctx.deps.db.transaction().execute(async (trx) => {
          await trx
            .selectFrom('campanhas')
            .select('id')
            .where('id', '=', campanha.id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          await definirPermissoesMembroCampanha(
            {
              campanhaMembrosRepository: ctx.deps.campanhaMembrosRepository,
              observability: ctx.deps.observability,
            },
            {
              idCampanha: campanha.id as IdCampanha,
              idContaCaller: usuario.idConta,
              idContaMembro: input.idConta,
              permissoes: input.permissoes,
            },
            { trx },
          );
        });
        return { ok: true as const };
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  remover: t.procedure
    .input(IdCampanhaInput.extend({ idConta: z.string().uuid() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const { usuario, campanha } = await resolverCampanhaComPermissao(
          ctx,
          input.idCampanha,
          'membros:gerenciar',
        );
        const revogarConvites = ctx.deps.revogarConvitesPendentesDoMembro;
        await ctx.deps.db.transaction().execute(async (trx) => {
          await trx
            .selectFrom('campanhas')
            .select('id')
            .where('id', '=', campanha.id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          await assertCampaignPermission(
            {
              campanhaMembrosRepository: ctx.deps.campanhaMembrosRepository,
              observability: ctx.deps.observability,
            },
            { idCampanha: campanha.id, idConta: usuario.idConta, acao: 'membros:gerenciar' },
            { trx },
          );
          const alvo = await ctx.deps.campanhaMembrosRepository.obterAcesso(
            campanha.id,
            input.idConta,
            { trx },
          );
          if (!alvo) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'membro_nao_encontrado' });
          }
          if (alvo.papel === 'owner') {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'owner_nao_pode_ser_removido' });
          }
          if (revogarConvites) {
            await revogarConvites(
              { idCampanha: campanha.id, idConta: input.idConta, idUsuarioAtor: usuario.id },
              { trx },
            );
          }
          await ctx.deps.campanhaRepository.removerAdministrador(campanha.id, input.idConta, {
            trx,
          });
        });
        ctx.deps.observability.logger.info('arrecadacao.campanha.membro_removido', {
          idCampanha: campanha.id,
        });
        return { ok: true as const };
      } catch (err) {
        throw toTRPCError(err);
      }
    }),
});
