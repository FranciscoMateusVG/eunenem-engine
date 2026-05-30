import { randomUUID } from 'node:crypto';
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  ArrecadacaoCampanhaNaoEncontradaError,
  ArrecadacaoContribuicaoJaExisteError,
  ArrecadacaoContribuicaoNaoDisponivelError,
  ArrecadacaoContribuicaoNaoEncontradaError,
  ArrecadacaoInputInvalidoError,
  ArrecadacaoLimiteOpcaoExcedidoError,
  ArrecadacaoNaoAutorizadoError,
  ArrecadacaoOpcaoContribuicaoNaoEncontradaError,
  atualizarContribuicao,
  type Campanha,
  type Contribuicao,
  criarContribuicao,
  type IdCampanha,
  type IdContribuicao,
  type IdOpcaoContribuicao,
  listarContribuicoesDeOpcao,
  removerContribuicao,
} from '../../../../src/index.js';
import type { TrpcContext } from './context.js';

const t = initTRPC.context<TrpcContext>().create();

/**
 * Sentinel errors carried out of `resolveCallerCampanha`. We don't throw
 * `TRPCError` directly inside the helper because `instanceof TRPCError`
 * across the apps/eunenem-server / root-tests module boundary has proven
 * fragile (the test runner resolves `@trpc/server` from a different
 * location than the router file, so the constructor identities diverge).
 *
 * Instead the helper throws these typed sentinels and `toTRPCError` maps
 * them to UNAUTHORIZED / INTERNAL_SERVER_ERROR. This keeps the mapping
 * table the only source of truth for HTTP codes.
 */
class SessaoAusenteError extends Error {
  public readonly name = 'SessaoAusenteError';
}
class CampanhaAusenteError extends Error {
  public readonly name = 'CampanhaAusenteError';
}

/**
 * Multi-tenant session resolution for contribuicao-* procedures
 * (aperture-d6atj). Returns the caller's `idUsuario`, `idConta`, the resolved
 * `idCampanha`, and the `idOpcaoContribuicao` of the campanha's `presente`
 * option ("presentes sacola" — the only one frontend currently writes to).
 *
 * Throws `UNAUTHORIZED` if:
 *   - no session cookie present
 *   - the cookie maps to no live session
 *   - the user owns no campanha (defensive — shouldn't happen post-B2 once
 *     signup creates a default campanha; today the test suite seeds one
 *     before calling these procedures)
 *
 * Throws `INTERNAL_SERVER_ERROR` if:
 *   - the user's campanha has no `presente` opção (we don't auto-create
 *     one — that's an operator-driven decision; surface as 500 so the
 *     drift is loud rather than silently returning an empty list).
 *
 * The resolved tuple is the ONLY source of truth for tenant scoping inside
 * the procedures — every write derives `idCampanha` + `idOpcaoContribuicao`
 * from this helper. Frontend NEVER sends them.
 */
async function resolveCallerCampanha(ctx: TrpcContext): Promise<{
  idUsuario: string;
  idConta: string;
  campanha: Campanha;
  idOpcaoPresentes: IdOpcaoContribuicao;
}> {
  const { deps, headers } = ctx;
  const token = readSessionCookie(headers, deps.sessionCookieName);
  if (!token) throw new SessaoAusenteError('Sessao ausente');

  let sessao;
  try {
    sessao = await deps.authService.validarSessao(token);
  } catch {
    // Token shape invalid (fails TokenSessaoSchema.parse) — same posture
    // as missing cookie. Don't surface the underlying parse error to the
    // client (cookie shape is implementation detail).
    throw new SessaoAusenteError('Sessao invalida');
  }
  if (!sessao) throw new SessaoAusenteError('Sessao expirada');

  const usuario = await deps.usuarioRepository.findUsuarioById(sessao.idUsuario);
  // Session valid but the usuario row is gone — treat as unauthenticated
  // (matches `auth.me` returning null in the same scenario).
  if (!usuario) throw new SessaoAusenteError('Usuario nao encontrado');

  const campanha = await deps.campanhaRepository.findFirstByAdministrador(usuario.idConta);
  if (!campanha) {
    // Defensive: by convention every signed-up user owns one campanha.
    // If they don't, the data model is in an inconsistent state — fail
    // loud so we notice rather than silently returning an empty list.
    throw new CampanhaAusenteError('Usuario nao administra nenhuma campanha');
  }

  const opcaoPresentes = campanha.opcoes.find((o) => o.tipo === 'presente');
  if (!opcaoPresentes) {
    throw new CampanhaAusenteError("Campanha nao possui opcao 'presente'");
  }

  return {
    idUsuario: usuario.id,
    idConta: usuario.idConta,
    campanha,
    idOpcaoPresentes: opcaoPresentes.id,
  };
}

/**
 * Cookie parser — same shape as the helper in auth-router. Duplicated
 * intentionally (the auth-router copy is `not exported`; trying to share
 * it would either churn that stable file or build a tiny utility module
 * for one function). If a third router needs it, lift to a shared helper.
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
 * Map engine domain errors to tRPCError (aperture-d6atj). Mirrors the
 * pattern in auth-router (PR #61). Cross-tenant access surfaces as
 * UNAUTHORIZED (NOT_FOUND would leak existence). Status-locked surfaces
 * as BAD_REQUEST with a stable `code: contribuicao_locked` in the
 * message body so the frontend can route to the right per-field message.
 */
function toTRPCError(err: unknown): TRPCError {
  if (err instanceof SessaoAusenteError) {
    return new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
  }
  if (err instanceof CampanhaAusenteError) {
    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: err.message,
      cause: err,
    });
  }
  if (err instanceof ArrecadacaoNaoAutorizadoError) {
    return new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
  }
  if (err instanceof ArrecadacaoContribuicaoNaoDisponivelError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      // Stable client-routable code; the frontend's per-field error
      // table reads this string verbatim (same convention as auth-router's
      // typed error codes).
      message: 'contribuicao_locked',
      cause: err,
    });
  }
  if (err instanceof ArrecadacaoContribuicaoNaoEncontradaError) {
    return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
  }
  if (err instanceof ArrecadacaoCampanhaNaoEncontradaError) {
    return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
  }
  if (err instanceof ArrecadacaoOpcaoContribuicaoNaoEncontradaError) {
    return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
  }
  if (err instanceof ArrecadacaoContribuicaoJaExisteError) {
    return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
  }
  if (err instanceof ArrecadacaoLimiteOpcaoExcedidoError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  if (err instanceof ArrecadacaoInputInvalidoError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: err instanceof Error ? err.message : String(err),
    cause: err,
  });
}

// ── Input schemas ─────────────────────────────────────────────────────────

const CreateInputSchema = z.object({
  nome: z.string().trim().min(1).max(120),
  valor: z.number().int().nonnegative(),
  imagemUrl: z.string().url().optional(),
  grupo: z.string().trim().min(1).max(60).optional(),
  qty: z.number().int().min(1).max(100),
});

const UpdateInputSchema = z.object({
  id: z.string().uuid(),
  nome: z.string().trim().min(1).max(120).optional(),
  valor: z.number().int().nonnegative().optional(),
  imagemUrl: z.string().url().nullable().optional(),
  grupo: z.string().trim().min(1).max(60).nullable().optional(),
});

const DeleteInputSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

// ── Projection ─────────────────────────────────────────────────────────────

function toListItem(c: Contribuicao): {
  id: IdContribuicao;
  nome: string;
  valor: number;
  imagemUrl: string | null;
  grupo: string | null;
  contribuinte: { nome: string; email: string } | null;
  status: 'disponivel' | 'indisponivel';
} {
  return {
    id: c.id,
    nome: c.nome,
    valor: c.valor,
    imagemUrl: c.imagemUrl,
    grupo: c.grupo,
    contribuinte: c.contribuinte
      ? { nome: c.contribuinte.nome, email: c.contribuinte.email }
      : null,
    status: c.status,
  };
}

// ── Router ─────────────────────────────────────────────────────────────────

/**
 * Contribuicao router (aperture-d6atj). Backs the eunenem painel
 * "presentes" tab: list + create (batched by qty) + update (single) +
 * delete (batched by ids).
 *
 * Multi-tenant boundary: every procedure resolves `idCampanha` +
 * `idOpcaoPresentes` from the session via `resolveCallerCampanha`. The
 * client never sends them. Use-cases re-check `target.idCampanha ===
 * idCampanhaEsperada` before any write (defense in depth — if a future
 * caller forgets to pre-scope, the domain still refuses cross-tenant
 * mutations).
 */
export const contribuicaoRouter = t.router({
  /**
   * Returns all contribuicoes in the caller's `presentes` opção. No input —
   * matches `auth.me`'s shape (session-scoped, no parameters). Frontend
   * uses this for the painel's gift-list page and re-fetches after every
   * mutation.
   */
  list: t.procedure.query(async ({ ctx }) => {
    try {
      const { campanha, idOpcaoPresentes } = await resolveCallerCampanha(ctx);
      const items = await listarContribuicoesDeOpcao(
        {
          contribuicaoRepository: ctx.deps.contribuicaoRepository,
          observability: ctx.deps.observability,
        },
        { idCampanha: campanha.id, idOpcaoContribuicao: idOpcaoPresentes },
      );
      return items.map(toListItem);
    } catch (err) {
      throw toTRPCError(err);
    }
  }),

  /**
   * Creates `qty` separate contribuicoes (engine is unit-level — each
   * Contribuicao row is ONE unit). Server derives `idCampanha` +
   * `idOpcaoContribuicao` from the session — client only supplies the
   * shape of the unit + how many copies to create.
   *
   * Atomicity caveat: today the create loop is NOT transactional — partial
   * failure leaves N-of-qty rows persisted. The B2 era's batch-tx port
   * (deferred per recon §3) would make this all-or-nothing. Until then,
   * caller can re-issue the request with the missing qty (idempotency
   * doesn't bite because we mint fresh ids server-side).
   */
  create: t.procedure
    .input(CreateInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const { campanha, idOpcaoPresentes } = await resolveCallerCampanha(ctx);
        const deps = {
          campanhaRepository: ctx.deps.campanhaRepository,
          contribuicaoRepository: ctx.deps.contribuicaoRepository,
          clock: ctx.deps.clock,
          observability: ctx.deps.observability,
        };

        const ids: IdContribuicao[] = [];
        for (let i = 0; i < input.qty; i++) {
          const id = randomUUID() as IdContribuicao;
          await criarContribuicao(deps, {
            id,
            idCampanha: campanha.id,
            idOpcaoContribuicao: idOpcaoPresentes,
            nome: input.nome,
            valor: input.valor,
            imagemUrl: input.imagemUrl ?? null,
            grupo: input.grupo ?? null,
          });
          ids.push(id);
        }
        return { ids };
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  update: t.procedure
    .input(UpdateInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const { campanha } = await resolveCallerCampanha(ctx);
        const updated = await atualizarContribuicao(
          {
            contribuicaoRepository: ctx.deps.contribuicaoRepository,
            observability: ctx.deps.observability,
          },
          {
            idContribuicao: input.id as IdContribuicao,
            idCampanhaEsperada: campanha.id as IdCampanha,
            nome: input.nome,
            valor: input.valor,
            imagemUrl: input.imagemUrl,
            grupo: input.grupo,
          },
        );
        return toListItem(updated);
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  /**
   * Batched delete by id. Calls `removerContribuicao` once per id; same
   * partial-failure caveat as `create` (no batch tx today). Returns the
   * ids that were successfully deleted — if any id fails, the procedure
   * throws and the caller can re-issue with the surviving subset.
   */
  delete: t.procedure
    .input(DeleteInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const { campanha } = await resolveCallerCampanha(ctx);
        const deletedIds: string[] = [];
        for (const id of input.ids) {
          await removerContribuicao(
            {
              contribuicaoRepository: ctx.deps.contribuicaoRepository,
              observability: ctx.deps.observability,
            },
            {
              idContribuicao: id as IdContribuicao,
              idCampanhaEsperada: campanha.id as IdCampanha,
            },
          );
          deletedIds.push(id);
        }
        return { deletedIds };
      } catch (err) {
        throw toTRPCError(err);
      }
    }),
});

export type ContribuicaoRouter = typeof contribuicaoRouter;
