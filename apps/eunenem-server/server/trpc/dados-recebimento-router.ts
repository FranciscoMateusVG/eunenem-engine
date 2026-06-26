/**
 * DadosRecebimento tRPC router (aperture-mcvyw #4a-i) — exposes the
 * user-level receiving-data store (DadosRecebimentoUsuario).
 *
 * Procedures:
 *   - `dadosRecebimento.salvar`                mutation, AUTHED → DadosRecebedor
 *   - `dadosRecebimento.get`                   query,    AUTHED → DadosRecebedor | null
 *   - `dadosRecebimento.getResgatePendente`    query,    AUTHED → Date | null
 *   - `dadosRecebimento.marcarResgatePendente` mutation, AUTHED → { pendenteDesde }
 *
 * Authed procedures derive `idUsuario` from the session cookie; the client
 * NEVER sends it (no "edit someone else's receiving data" shape). Validation
 * errors → BAD_REQUEST.
 */
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod/v4';
import {
  type DadosRecebedor,
  DadosRecebedorSchema,
  type IdUsuario,
  marcarResgatePendente,
  obterDadosRecebimentoUsuario,
  obterResgatePendente,
  salvarDadosRecebimentoUsuario,
  UsuarioInputInvalidoError,
} from '../../../../src/index.js';
import type { TrpcContext } from './context.js';
import {
  resolverUsuarioAutenticado,
  SessaoNaoAutenticadaError,
} from './session-resolver.js';

const t = initTRPC.context<TrpcContext>().create();

async function resolveCallerIdUsuario(ctx: TrpcContext): Promise<IdUsuario> {
  const { deps, headers } = ctx;
  // aperture-6wo1f: central A2 + OAuth-orphan self-heal. Returns the resolved
  // (healed-if-orphan) usuario; only its id is exposed here. Map the shared
  // sentinel to the existing UNAUTHORIZED shape.
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
            resgatePendenteRepository: ctx.deps.resgatePendenteRepository,
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
   *
   * NOTE (aperture-kj9el #4b): the "resgate pendente" marker is exposed via a
   * SEPARATE, non-breaking query (`getResgatePendente` below) rather than a
   * field added here — keeping `get`'s shape unchanged so the existing
   * settings-form caller (BancariosBody) needs no change and there is no
   * co-deploy coupling with the frontend.
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

  /**
   * Read the caller's "resgate pendente" intent marker (aperture-kj9el #4b) —
   * the timestamp the user clicked "preencher depois", or `null` when there is
   * no pending intent (never set, or cleared by a later full-data save). The
   * frontend renders the pending-resgate banner/CTA off this.
   */
  getResgatePendente: t.procedure
    .output(z.union([z.string(), z.date()]).nullable())
    .query(async ({ ctx }): Promise<Date | null> => {
      try {
        const idUsuario = await resolveCallerIdUsuario(ctx);
        return await obterResgatePendente(
          {
            resgatePendenteRepository: ctx.deps.resgatePendenteRepository,
            observability: ctx.deps.observability,
          },
          idUsuario,
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  /**
   * Record the "resgate pendente" intent marker — the user clicked "preencher
   * depois / estou fazendo para um amigo". No bank data is stored; only the
   * pending intent (cleared when full data is later saved). No input — the
   * caller is resolved from the session.
   */
  marcarResgatePendente: t.procedure
    .output(z.object({ pendenteDesde: z.date() }))
    .mutation(async ({ ctx }): Promise<{ pendenteDesde: Date }> => {
      try {
        const idUsuario = await resolveCallerIdUsuario(ctx);
        const { pendenteDesde } = await marcarResgatePendente(
          {
            resgatePendenteRepository: ctx.deps.resgatePendenteRepository,
            observability: ctx.deps.observability,
            clock: ctx.deps.clock,
          },
          { idUsuario },
        );
        return { pendenteDesde };
      } catch (err) {
        throw toTRPCError(err);
      }
    }),
});
