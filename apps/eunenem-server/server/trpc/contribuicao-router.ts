import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  ArrecadacaoCampanhaNaoEncontradaError,
  ArrecadacaoContribuicaoJaExisteError,
  ArrecadacaoContribuicaoIndisponivelError,
  ArrecadacaoContribuicaoNaoEncontradaError,
  ArrecadacaoInputInvalidoError,
  ArrecadacaoLimiteOpcaoExcedidoError,
  ArrecadacaoNaoAutorizadoError,
  ArrecadacaoOpcaoContribuicaoNaoEncontradaError,
  atualizarContribuicao,
  type Campanha,
  type Contribuicao,
  esgotada,
  criarContribuicoesEmLote,
  type IdCampanha,
  type IdContribuicao,
  type IdContribuicaoPagamento,
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

  const campanha = await deps.campanhaRepository.findByAdministrador(usuario.idConta);
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
  if (err instanceof ArrecadacaoContribuicaoIndisponivelError) {
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

/**
 * imagemUrl accepts EITHER:
 *   - absolute http(s) URLs (legacy + future CDN URLs)
 *   - same-origin paths starting with `/` (e.g. `/products/1468.jpg` — used
 *     by aperture-cdwdt's static-hosted catalog images until CDN is wired)
 *
 * Was originally `z.string().url()` but that rejected the local-path shape
 * the catalog refresh (PR #71) ships. React img src tag treats both shapes
 * identically; the strict URL validation was over-tight for this field.
 */
const ImagemUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^(\/|https?:\/\/)/, 'imagemUrl must be an http(s) URL or a same-origin path starting with /');

const CreateInputSchema = z.object({
  nome: z.string().trim().min(1).max(120),
  valor: z.number().int().nonnegative(),
  imagemUrl: ImagemUrlSchema.optional(),
  grupo: z.string().trim().min(1).max(60).optional(),
  /**
   * Plan 0016 (aperture-putz5): slot capacity. `quantidade=N` produces
   * ONE row with quantidade=N, not N rows with quantidade=1 (pre-0016
   * `qty` shape — semantically renamed). Defaults to 1 in the engine
   * use-case when omitted; required here so the painel commits to a
   * value at the wire boundary.
   */
  quantidade: z.number().int().min(1).max(100),
});

/**
 * Bulk creation input (aperture-d6atj fix-up; Plan 0016 aperture-putz5
 * single-row + quantidade migration).
 *
 * Use case: operator picks "Pacote de Fraldas RN quantidade=8" + "Mamadeira
 * quantidade=4" + "kit chá de bebê" (10 items, each quantidade=1) → ONE
 * INSERT of 12 rows (NOT 30 — each item is one slot regardless of
 * quantidade).
 */
const CreateBulkInputSchema = z.object({
  items: z
    .array(
      z.object({
        nome: z.string().trim().min(1).max(120),
        valor: z.number().int().nonnegative(),
        imagemUrl: ImagemUrlSchema.optional(),
        grupo: z.string().trim().min(1).max(60).optional(),
        quantidade: z.number().int().min(1).max(100),
      }),
    )
    .min(1)
    .max(50),
});

const UpdateInputSchema = z.object({
  id: z.string().uuid(),
  nome: z.string().trim().min(1).max(120).optional(),
  valor: z.number().int().nonnegative().optional(),
  imagemUrl: ImagemUrlSchema.nullable().optional(),
  grupo: z.string().trim().min(1).max(60).nullable().optional(),
  /**
   * Plan 0016 (aperture-putz5 + aperture-1l37i): change a slot's capacity.
   * Per locked decision #10 the new value can be lower than already-sold
   * count — `quantidadeRestante` goes negative, `esgotada` returns true.
   * The use-case + entity validate `quantidade >= 1` only.
   */
  quantidade: z.number().int().min(1).max(100).optional(),
});

const DeleteInputSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

// ── Projection ─────────────────────────────────────────────────────────────

function toListItem(
  c: Contribuicao,
  indisponivel: boolean,
): {
  id: IdContribuicao;
  nome: string;
  valor: number;
  imagemUrl: string | null;
  grupo: string | null;
  quantidade: number;
  indisponivel: boolean;
} {
  // Post-Phase-1 (plan 0015): contribuição has no status + no contribuinte.
  // The "presentes" panel now shows slot definition only; per-pagamento
  // contribuinte data lives on the contribuição detail screen.
  //
  // aperture-ocw8r: `indisponivel` is a DERIVED predicate — EXISTS at
  // least one aprovado pagamento against this contribuição (Phase 1
  // dropped the contribuição.status field; the recebedor's "X de N
  // recebidos" UI reads this boolean to compute totals). Computed via
  // pagamentoRepository EXISTS query at the caller, then passed in
  // here so the projection function stays sync + injection-free.
  //
  // Plan 0016 (aperture-putz5 engine + aperture-1l37i frontend): expose
  // `quantidade` so the painel renders the slot's capacity directly
  // (e.g. "Fralda Ecológica × 7") and the admin ContribuicoesList can
  // group + aggregate across legacy multi-row data uniformly. The list
  // procedure already loads it from the entity; threading it through
  // here keeps the projection self-contained.
  return {
    id: c.id,
    nome: c.nome,
    valor: c.valor,
    imagemUrl: c.imagemUrl,
    grupo: c.grupo,
    quantidade: c.quantidade,
    indisponivel,
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
      // Plan 0016 (aperture-eg1s2): bulk SUM lookup once for all rows
      // (one indexed pagamentos query — partial index
      // `idx_intencao_items_contribuicao_aprovado` INCLUDE quantidade).
      // Each slot's esgotada state derives from quantidade_restante <= 0.
      // Falls back to empty map if no slots exist.
      const sums =
        items.length === 0
          ? new Map<IdContribuicaoPagamento, number>()
          : await ctx.deps.pagamentoRepository.somarQuantidadesContribuicoesEmPagamentosAprovados(
              items.map((c) => c.id as unknown as IdContribuicaoPagamento),
            );
      const indisponiveisSet = new Set<string>();
      for (const c of items) {
        const sold = sums.get(c.id as unknown as IdContribuicaoPagamento) ?? 0;
        if (c.quantidade - sold <= 0) {
          indisponiveisSet.add(c.id);
        }
      }
      return items.map((c) => toListItem(c, indisponiveisSet.has(c.id)));
    } catch (err) {
      throw toTRPCError(err);
    }
  }),

  /**
   * Creates ONE contribuição slot with `quantidade=N` (pre-0016 this used
   * to expand into N rows × quantidade=1 — the `qty` row-multiplier
   * pattern that Plan 0016 retires per locked decision #1).
   *
   * Server derives `idCampanha` + `idOpcaoContribuicao` from the session —
   * client only supplies the shape + quantidade.
   *
   * Backward-compat wrapper (aperture-d6atj fix-up): delegates to
   * `createBulk` with a single-item array. There is exactly ONE write
   * path (the bulk path); single-item creates go through the same
   * single-INSERT use-case.
   *
   * All-or-nothing semantics via the bulk repo: if the row fails (FK,
   * unique), nothing persists.
   */
  create: t.procedure
    .input(CreateInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const { campanha, idOpcaoPresentes } = await resolveCallerCampanha(ctx);
        const result = await criarContribuicoesEmLote(
          {
            campanhaRepository: ctx.deps.campanhaRepository,
            contribuicaoRepository: ctx.deps.contribuicaoRepository,
            clock: ctx.deps.clock,
            observability: ctx.deps.observability,
          },
          {
            idCampanha: campanha.id,
            idOpcaoContribuicao: idOpcaoPresentes,
            items: [
              {
                nome: input.nome,
                valor: input.valor,
                imagemUrl: input.imagemUrl ?? null,
                grupo: input.grupo ?? null,
                quantidade: input.quantidade,
              },
            ],
          },
        );
        return { ids: result.ids };
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  /**
   * Bulk creation across M catalog items (aperture-d6atj fix-up; Plan
   * 0016 aperture-putz5 single-row + quantidade migration).
   *
   * Concrete shape: operator picks a "kit chá de bebê" of 10 items each
   * with quantidade=1 → 10 contribuicoes in ONE INSERT. A
   * Fralda-RN-quantidade=8 slot is ONE row, not 8 — locked decision #1.
   * Without this procedure each single-create would round-trip; bulk lets
   * the painel commit a whole catalog selection in a single mutation.
   *
   * Server derives `idCampanha` + `idOpcaoPresentes` from the session —
   * the client never specifies them, and every item in the batch is
   * scoped to the same tenant.
   */
  createBulk: t.procedure
    .input(CreateBulkInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const { campanha, idOpcaoPresentes } = await resolveCallerCampanha(ctx);
        const result = await criarContribuicoesEmLote(
          {
            campanhaRepository: ctx.deps.campanhaRepository,
            contribuicaoRepository: ctx.deps.contribuicaoRepository,
            clock: ctx.deps.clock,
            observability: ctx.deps.observability,
          },
          {
            idCampanha: campanha.id,
            idOpcaoContribuicao: idOpcaoPresentes,
            items: input.items.map((item) => ({
              nome: item.nome,
              valor: item.valor,
              imagemUrl: item.imagemUrl ?? null,
              grupo: item.grupo ?? null,
              quantidade: item.quantidade,
            })),
          },
        );
        return { ids: result.ids };
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
            // Plan 0016 (aperture-putz5 engine + aperture-1l37i frontend):
            // quantidade flows through to the engine use-case. Rex's
            // engine PR extended AtualizarContribuicaoInputSchema to
            // accept this field; the painel can now run atomic single-
            // request updates for qty changes too (the qty-changed
            // fallback in saveEdit retires in a follow-up cleanup).
            quantidade: input.quantidade,
          },
        );
        // Plan 0016 (aperture-eg1s2): single-row esgotada check.
        // atualizarContribuicao already rejects updates against
        // sold-out slots upstream, so in practice this returns
        // `false` — but we compute it explicitly to keep the
        // projection contract consistent with `list`.
        const indisponivel = await esgotada(
          {
            pagamentoRepository: ctx.deps.pagamentoRepository,
            contribuicaoRepository: ctx.deps.contribuicaoRepository,
            observability: ctx.deps.observability,
          },
          { idContribuicao: updated.id },
        );
        return toListItem(updated, indisponivel);
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
              pagamentoRepository: ctx.deps.pagamentoRepository,
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
