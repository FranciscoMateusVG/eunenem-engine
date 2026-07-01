/**
 * Usuario tRPC router (Plan 0018 Phase A, aperture-omswg).
 *
 * Procedures:
 *   - `usuario.tutorialStatus`   query    → TutorialStatusResponse
 *   - `usuario.completarTutorial` mutation → TutorialStatusResponse
 *
 * Both are session-scoped: `idUsuario` is derived from the cookie via
 * `authService.validarSessao`; the client NEVER sends it. This forecloses
 * the obvious "complete someone else's tutorial" abuse — there is no
 * shape where a caller can target another usuario.
 *
 * Both procedures return the same `TutorialStatusResponseSchema` shape
 * so the frontend can use the mutation's response to update its local
 * cache without a follow-up query (single round-trip on the "skip"
 * / "finish" click).
 *
 * Idempotency: `completarTutorial` is first-write-wins at every layer:
 *   - Use-case re-reads the existing usuario and short-circuits when
 *     `tutorialCompletadoEm` is already non-null.
 *   - Memory adapter mirrors the predicate at the in-memory map level.
 *   - Postgres adapter enforces via `WHERE tutorial_completado_em IS NULL`
 *     so a concurrent second click also no-ops at the SQL layer.
 */
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod/v4';
import {
  atualizarSlugUsuario,
  type IdUsuario,
  marcarTutorialUsuarioComoCompletado,
  obterStatusTutorialUsuario,
  TutorialStatusResponseSchema,
  UsuarioInputInvalidoError,
  UsuarioNaoEncontradoError,
  UsuarioSlugJaExisteError,
  verificarDisponibilidadeSlug,
} from '../../../../src/index.js';
import type { TrpcContext } from './context.js';
import {
  resolverUsuarioAutenticado,
  SessaoNaoAutenticadaError,
} from './session-resolver.js';

const t = initTRPC.context<TrpcContext>().create();

/**
 * Resolve the caller's `idUsuario` via the shared central resolver
 * (aperture-6wo1f) — A2 (OAuth __Secure-/signed cookie fallback) fused with
 * the OAuth-orphan self-heal. Returns the resolved (healed-if-orphan) usuario's
 * id; the shared sentinel is mapped to the existing UNAUTHORIZED shape.
 */
async function resolveCallerIdUsuario(ctx: TrpcContext): Promise<IdUsuario> {
  const { deps, headers } = ctx;
  try {
    const { usuario } = await resolverUsuarioAutenticado(deps, headers);
    return usuario.id as IdUsuario;
  } catch (err) {
    if (err instanceof SessaoNaoAutenticadaError) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'sessao_invalida' });
    }
    throw err;
  }
}

function toTRPCError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof UsuarioNaoEncontradoError) {
    return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
  }
  if (err instanceof UsuarioSlugJaExisteError) {
    return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
  }
  if (err instanceof UsuarioInputInvalidoError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  return err instanceof Error
    ? new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err })
    : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'unknown_error' });
}

export const usuarioRouter = t.router({
  /**
   * Read-only probe. Frontend hits this on first mount of the painel /
   * any tutorial-aware surface to decide whether to render the overlay.
   *
   * Returns:
   *   - { completado: false, completadoEm: null }   first-time user
   *   - { completado: true,  completadoEm: <iso> }  already completed
   */
  tutorialStatus: t.procedure
    .output(TutorialStatusResponseSchema)
    .query(async ({ ctx }) => {
      try {
        const idUsuario = await resolveCallerIdUsuario(ctx);
        return await obterStatusTutorialUsuario(
          {
            usuarioRepository: ctx.deps.usuarioRepository,
            observability: ctx.deps.observability,
          },
          idUsuario,
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  /**
   * Idempotent flip-to-completed. Frontend fires this on either "skip"
   * or "finish the last step" click. Re-calls preserve the original
   * timestamp — the response carries the persisted value so the client
   * can update its cache in a single round-trip.
   */
  completarTutorial: t.procedure
    .output(TutorialStatusResponseSchema)
    .mutation(async ({ ctx }) => {
      try {
        const idUsuario = await resolveCallerIdUsuario(ctx);
        return await marcarTutorialUsuarioComoCompletado(
          {
            usuarioRepository: ctx.deps.usuarioRepository,
            observability: ctx.deps.observability,
          },
          idUsuario,
          ctx.deps.clock(),
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  /**
   * Edita o slug público do utilizador (aperture-2ztes). Session-scoped:
   * `idUsuario` vem do cookie, NUNCA do cliente — não há forma de editar
   * o slug de outro usuario. Sem auto-sufixo: um slug em uso devolve
   * CONFLICT e a UI pede outro. Mapeamento de erros:
   *   - UsuarioSlugJaExisteError    → CONFLICT
   *   - UsuarioInputInvalidoError   → BAD_REQUEST (formato inválido)
   *   - UsuarioNaoEncontradoError   → NOT_FOUND
   */
  atualizarSlug: t.procedure
    .input(z.object({ novoSlug: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const idUsuario = await resolveCallerIdUsuario(ctx);
        return await atualizarSlugUsuario(
          {
            usuarioRepository: ctx.deps.usuarioRepository,
            observability: ctx.deps.observability,
          },
          { idUsuario, novoSlug: input.novoSlug },
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  /**
   * Verificação inline de disponibilidade (aperture-2ztes). Session-scoped:
   * a plataforma é resolvida a partir do usuario do cookie. Devolve
   * `{ disponivel, motivo? }` — formato inválido e slug em uso são
   * resultados, não erros (só UNAUTHORIZED / NOT_FOUND escapam tipados).
   */
  verificarDisponibilidadeSlug: t.procedure
    .input(z.object({ slug: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        const idUsuario = await resolveCallerIdUsuario(ctx);
        return await verificarDisponibilidadeSlug(
          {
            usuarioRepository: ctx.deps.usuarioRepository,
            observability: ctx.deps.observability,
          },
          { idUsuario, slug: input.slug },
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),
});
