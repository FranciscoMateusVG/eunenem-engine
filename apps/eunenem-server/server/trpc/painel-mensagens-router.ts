/**
 * aperture-16wrk / 5v766 Phase A — admin mensagens dashboard tRPC.
 *
 * Slug-owner-admin surface mounted at root as `painelMensagens`.
 * Shape:
 *
 *   - `painelMensagens.list({ slug })`             → AdminMensagensResponse
 *   - `painelMensagens.marcarLida({ slug, idPagamento })` → { lidaEm }
 *   - `painelMensagens.marcarTodasLidas({ slug })` → { marcadas }
 *
 * Tenant chain: slug → usuario → campanha (admin guard against
 * `campanha.idsAdministradores` + the session's `idConta`). The slug
 * IS the tenant — the session caller MUST be an admin of the
 * campanha that owns the slug. Returns UNAUTHORIZED on any failure of
 * the chain (no existence leak between "slug doesn't exist" and "slug
 * exists but you don't own it"). NOT_FOUND is reserved for the case
 * where the slug exists, you own it, but the campanha isn't
 * configured yet — which the resolver below treats as the same 404
 * as the visitor mural for symmetry.
 *
 * For marcarLida, an additional cross-tenant guard fires: the
 * `idPagamento` MUST belong to the admin's campanha. Without this, an
 * admin who knows a foreign idPagamento could mark someone else's
 * recado as read.
 */

import { TRPCError, initTRPC } from '@trpc/server';
import { z } from 'zod/v4';
import type { Campanha } from '../../../../src/domain/arrecadacao/entities/campanha.js';
import type { IdCampanha } from '../../../../src/domain/arrecadacao/value-objects/ids.js';
import type { IdPagamento } from '../../../../src/domain/pagamentos/value-objects/ids.js';
import type { Usuario } from '../../../../src/domain/usuario/entities/usuario.js';
import type { SlugUsuario } from '../../../../src/domain/usuario/value-objects/slug-usuario.js';
import { PagamentoNaoEncontradoError } from '../../../../src/errors/pagamentos/nao-encontrado.error.js';
import { marcarRecadoComoLido } from '../../../../src/use-cases/pagamentos/marcar-recado-como-lido.js';
import { marcarTodosRecadosComoLidos } from '../../../../src/use-cases/pagamentos/marcar-todos-recados-como-lidos.js';
import { obterRecadosAdminDeCampanha } from '../../../../src/use-cases/pagamentos/obter-recados-admin-de-campanha.js';
import { ID_PLATAFORMA_EUNENEM } from '../auth/setup.js';
import type { TrpcContext } from './context.js';
import {
  resolverUsuarioAutenticado,
  SessaoNaoAutenticadaError,
} from './session-resolver.js';

const t = initTRPC.context<TrpcContext>().create();

class PainelMensagensSessaoError extends Error {
  public readonly name = 'PainelMensagensSessaoError';
}

/**
 * Slug → usuario → campanha → admin-check. Throws UNAUTHORIZED on
 * any failure step (existence-leak posture: a non-admin sees the
 * same error whether the slug is unknown, the campanha is missing,
 * or they're authenticated but not an admin).
 */
async function resolvePainelAdminBySlug(
  ctx: TrpcContext,
  slug: string,
  idCampanha?: string,
): Promise<{ usuario: Usuario; campanha: Campanha }> {
  const { deps, headers } = ctx;
  // aperture-6wo1f: resolve the SESSION usuario via the shared central resolver
  // (A2 + OAuth-orphan self-heal). Map the shared sentinel to this router's
  // UNAUTHORIZED-bearing sentinel (preserves the existence-leak posture).
  let sessaoUsuario: Usuario;
  try {
    sessaoUsuario = (await resolverUsuarioAutenticado(deps, headers)).usuario;
  } catch (err) {
    if (err instanceof SessaoNaoAutenticadaError) {
      throw new PainelMensagensSessaoError('Sessao invalida');
    }
    throw err;
  }

  const usuario = await deps.usuarioRepository.findUsuarioBySlug(
    ID_PLATAFORMA_EUNENEM,
    slug as SlugUsuario,
  );
  if (!usuario) {
    throw new PainelMensagensSessaoError('Slug nao encontrado ou nao autorizado');
  }
  // aperture-yeauv: OPTIONAL per-campanha routing. This hop is SLUG-based
  // (it resolves the SLUG's campanha, not the session's), so we mirror the
  // shared resolver's contract locally instead of calling it. PRESENT
  // idCampanha → that campanha, verified to belong to the slug's conta
  // (idsAdministradores includes the slug owner) — not-found AND not-owned
  // collapse to the SAME non-leaking sentinel. ABSENT → oldest (back-compat).
  let campanha: Campanha | undefined;
  if (idCampanha !== undefined && idCampanha !== '') {
    campanha = await deps.campanhaRepository.findById(idCampanha as IdCampanha);
    if (!campanha || !campanha.idsAdministradores.includes(usuario.idConta)) {
      throw new PainelMensagensSessaoError('Campanha nao encontrada ou nao autorizada');
    }
  } else {
    campanha = await deps.campanhaRepository.findByAdministrador(usuario.idConta);
    if (!campanha) {
      throw new PainelMensagensSessaoError('Campanha nao encontrada ou nao autorizada');
    }
  }
  // Session admin must be one of campanha's administradores. Without
  // this, any authenticated user could read any campanha's recados.
  // For the eunenem solo-admin shape this is equivalent to `usuario`
  // === session usuario, but the broader check survives multi-admin
  // futures.
  if (!campanha.idsAdministradores.includes(sessaoUsuario.idConta)) {
    throw new PainelMensagensSessaoError('Slug nao encontrado ou nao autorizado');
  }
  return { usuario, campanha };
}

function toTRPCError(err: unknown): TRPCError {
  if (err instanceof PainelMensagensSessaoError) {
    return new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
  }
  if (err instanceof PagamentoNaoEncontradoError) {
    return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
  }
  if (err instanceof TRPCError) return err;
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: err instanceof Error ? err.message : 'erro_desconhecido',
    cause: err instanceof Error ? err : undefined,
  });
}

// aperture-yeauv: OPTIONAL per-campanha routing on the slug-addressed authed
// hop. Absent → oldest campanha (back-compat); present → that campanha,
// owner-gated to the slug's conta.
const ListInputSchema = z.object({
  slug: z.string().trim().min(1),
  idCampanha: z.string().optional(),
});

const MarcarLidaInputSchema = z.object({
  slug: z.string().trim().min(1),
  // aperture-48mxt (W2 enforce): REQUIRED — authed writes are campanha-addressed.
  idCampanha: z.string().uuid(),
  idPagamento: z.string().uuid(),
});

const MarcarTodasLidasInputSchema = z.object({
  slug: z.string().trim().min(1),
  // aperture-48mxt (W2 enforce): REQUIRED — authed writes are campanha-addressed.
  idCampanha: z.string().uuid(),
});

export const painelMensagensRouter = t.router({
  /**
   * Returns every aprovado-with-mensagem recado on the admin's
   * campanha + the counts chip data. See `AdminMensagensResponse` /
   * `AdminRecadoProjectionSchema` in the engine domain for the
   * canonical wire shape.
   */
  list: t.procedure.input(ListInputSchema).query(async ({ ctx, input }) => {
    try {
      const { campanha } = await resolvePainelAdminBySlug(ctx, input.slug, input.idCampanha);
      return await obterRecadosAdminDeCampanha(
        {
          pagamentoRepository: ctx.deps.pagamentoRepository,
          contribuicaoRepository: ctx.deps.contribuicaoRepository,
          observability: ctx.deps.observability,
        },
        campanha.id as IdCampanha,
      );
    } catch (err) {
      throw toTRPCError(err);
    }
  }),

  /**
   * Single mark-as-read. Verifies the pagamento belongs to the
   * admin's campanha before firing the use-case (cross-tenant
   * guard).
   */
  marcarLida: t.procedure.input(MarcarLidaInputSchema).mutation(async ({ ctx, input }) => {
    try {
      const { campanha } = await resolvePainelAdminBySlug(ctx, input.slug, input.idCampanha);
      const pagamento = await ctx.deps.pagamentoRepository.findById(
        input.idPagamento as IdPagamento,
      );
      if (!pagamento) {
        throw new PagamentoNaoEncontradoError(input.idPagamento as IdPagamento);
      }
      if (pagamento.intencao.idCampanha !== campanha.id) {
        // Cross-tenant attempt — surface as UNAUTHORIZED, same posture
        // as the slug guards.
        throw new PainelMensagensSessaoError(
          'Pagamento nao encontrado ou nao autorizado',
        );
      }
      return await marcarRecadoComoLido(
        {
          pagamentoRepository: ctx.deps.pagamentoRepository,
          observability: ctx.deps.observability,
        },
        input.idPagamento as IdPagamento,
        ctx.deps.clock(),
      );
    } catch (err) {
      throw toTRPCError(err);
    }
  }),

  /**
   * Batch mark-as-read. Returns the count of recados actually
   * flipped — zero is a normal outcome when the admin already
   * cleared the queue.
   */
  marcarTodasLidas: t.procedure
    .input(MarcarTodasLidasInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const { campanha } = await resolvePainelAdminBySlug(ctx, input.slug, input.idCampanha);
        return await marcarTodosRecadosComoLidos(
          {
            pagamentoRepository: ctx.deps.pagamentoRepository,
            observability: ctx.deps.observability,
          },
          campanha.id as IdCampanha,
          ctx.deps.clock(),
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),
});
