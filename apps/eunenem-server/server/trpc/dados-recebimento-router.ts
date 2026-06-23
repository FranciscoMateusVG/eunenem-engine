/**
 * DadosRecebimento tRPC router (aperture-mcvyw #4a-i) — exposes the
 * user-level receiving-data store (DadosRecebimentoUsuario).
 *
 * Procedures:
 *   - `dadosRecebimento.salvar`  mutation, AUTHED → DadosRecebedor
 *   - `dadosRecebimento.get`     query,    AUTHED → DadosRecebedor | null
 *
 * Authed procedures derive `idUsuario` from the session cookie; the client
 * NEVER sends it (no "edit someone else's receiving data" shape). Validation
 * errors → BAD_REQUEST.
 */
import { initTRPC, TRPCError } from '@trpc/server';
import {
  type DadosRecebedor,
  DadosRecebedorSchema,
  type IdUsuario,
  obterDadosRecebimentoUsuario,
  salvarDadosRecebimentoUsuario,
  UsuarioInputInvalidoError,
} from '../../../../src/index.js';
import type { TrpcContext } from './context.js';

const t = initTRPC.context<TrpcContext>().create();

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
  if (err instanceof UsuarioInputInvalidoError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  return err instanceof Error
    ? new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err })
    : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'unknown_error' });
}

export const dadosRecebimentoRouter = t.router({
  /**
   * Create-or-update the caller's user-level receiving data (pix | conta).
   * Returns the persisted `DadosRecebedor` so the client refreshes its cache
   * without a follow-up query.
   */
  salvar: t.procedure
    .input(DadosRecebedorSchema)
    .output(DadosRecebedorSchema)
    .mutation(async ({ ctx, input }): Promise<DadosRecebedor> => {
      try {
        const idUsuario = await resolveCallerIdUsuario(ctx);
        const registro = await salvarDadosRecebimentoUsuario(
          {
            dadosRecebimentoRepository: ctx.deps.dadosRecebimentoRepository,
            observability: ctx.deps.observability,
            clock: ctx.deps.clock,
          },
          { idUsuario, dados: input },
        );
        return registro.dados;
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  /**
   * Read the caller's user-level receiving data. Returns `null` when none has
   * been saved yet (the settings form renders empty, not an error).
   */
  get: t.procedure
    .output(DadosRecebedorSchema.nullable())
    .query(async ({ ctx }): Promise<DadosRecebedor | null> => {
      try {
        const idUsuario = await resolveCallerIdUsuario(ctx);
        const registro = await obterDadosRecebimentoUsuario(
          {
            dadosRecebimentoRepository: ctx.deps.dadosRecebimentoRepository,
            observability: ctx.deps.observability,
          },
          idUsuario,
        );
        return registro?.dados ?? null;
      } catch (err) {
        throw toTRPCError(err);
      }
    }),
});
