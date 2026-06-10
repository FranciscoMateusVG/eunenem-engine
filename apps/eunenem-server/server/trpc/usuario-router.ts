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
import {
  type IdUsuario,
  marcarTutorialUsuarioComoCompletado,
  obterStatusTutorialUsuario,
  TutorialStatusResponseSchema,
  UsuarioNaoEncontradoError,
} from '../../../../src/index.js';
import type { TrpcContext } from './context.js';

const t = initTRPC.context<TrpcContext>().create();

/**
 * Session-cookie reader. Same shape as the helper in auth-router /
 * contribuicao-router. Kept local — if a fourth router needs it, lift
 * to a shared helper.
 */
function readSessionCookie(headers: Headers, name: string): string | null {
  const cookieHeader = headers.get('cookie');
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';').map((c) => c.trim());
  const target = `${name}=`;
  for (const cookie of cookies) {
    if (cookie.startsWith(target)) {
      return decodeURIComponent(cookie.slice(target.length));
    }
  }
  return null;
}

/**
 * Resolve the caller's `idUsuario` from the session cookie. Throws
 * UNAUTHORIZED if no cookie / invalid token / no live session.
 */
async function resolveCallerIdUsuario(ctx: TrpcContext): Promise<IdUsuario> {
  const { deps, headers } = ctx;
  const token = readSessionCookie(headers, deps.sessionCookieName);
  if (!token) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'sessao_ausente' });
  }
  let sessao;
  try {
    sessao = await deps.authService.validarSessao(token);
  } catch {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'sessao_invalida' });
  }
  if (!sessao) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'sessao_expirada' });
  }
  return sessao.idUsuario as IdUsuario;
}

function toTRPCError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof UsuarioNaoEncontradoError) {
    return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
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
});
