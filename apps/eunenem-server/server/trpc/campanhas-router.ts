/**
 * Campanhas tRPC router (aperture-mebax — multicampanha migration bridge POC,
 * epic aperture-7hm2g, design spec §6).
 *
 * Procedures:
 *   - `campanhas.list`  query, AUTHED → { novas, legado }
 *
 * The /campanhas page mixes the caller's 2.0 campaigns with any 1.0 legacy
 * campaigns detected via the static snapshot (lib/legacy-users.ts):
 *   - `novas`  = `findCampanhasByAdministrador(idConta)` (the port EXISTS in
 *     src/adapters/arrecadacao/campanha-repository.ts, previously wired only
 *     to the admin router — this is its first user-facing exposure) mapped to
 *     card DTOs, sorted `criadaEm` DESC.
 *   - `legado` = snapshot entries matching `usuario.email` case-insensitively,
 *     with the `nome` fallback applied server-side.
 *
 * CONTRACT: the return DTO shape is FROZEN on epic aperture-7hm2g notes — the
 * frontend (Vance) builds against it in parallel. `criadaEm` is serialized as
 * an ISO-8601 STRING here (this app registers no tRPC transformer, so a Date
 * would silently become a string on the wire while the inferred client type
 * claimed Date — serializing explicitly keeps type and wire in agreement).
 *
 * AUTH: the caller is resolved from the session cookie via the shared
 * `resolverUsuarioAutenticado` (A2 + OAuth-orphan self-heal). The client NEVER
 * sends idConta/email — no "list someone else's campaigns" shape. `slug` on
 * the 2.0 card DTO is the USUARIO's painel slug (Campanha has no slug of its
 * own); every card navigates to /painel/<slug> in the POC.
 */
import { randomUUID } from 'node:crypto';
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod/v4';
import {
  adicionarOpcaoContribuicao,
  ArrecadacaoInputInvalidoError,
  type Campanha,
  CampanhaSlugJaAlteradoError,
  criarCampanha,
  type IdCampanha,
  type IdOpcaoContribuicao,
  RESERVED_SLUGS,
} from '../../../../src/index.js';
import { buscarCampanhasLegado } from '../../lib/legacy-users.js';
import type { TrpcContext } from './context.js';
import {
  CampanhaAcessoNegadoError,
  CampanhaInexistenteError,
  resolverCampanhaAdministrada,
} from './resolve-campanha-administrada.js';
import {
  resolverUsuarioAutenticado,
  SessaoNaoAutenticadaError,
} from './session-resolver.js';

const t = initTRPC.context<TrpcContext>().create();

/** 2.0 campaign card DTO (contract frozen on epic aperture-7hm2g notes). */
const CampanhaNovaDTOSchema = z.object({
  id: z.string(),
  titulo: z.string(),
  /** The USER's painel slug — card navigates to `/painel/${slug}`. */
  slug: z.string(),
  /**
   * Mimo count for the card — `null` in the POC (a real received-mimos count
   * needs a per-campanha contribuições aggregate; deliberately out of scope,
   * the card hides the count on null). Field exists so wiring the count later
   * is contract-compatible.
   */
  quantidadeMimos: z.number().int().nonnegative().nullable(),
  /** ISO-8601. `novas` is sorted by this, DESC. */
  criadaEm: z.string(),
  /**
   * Whether the campanha has an active Recebedor projected (aperture-aphk8).
   * Read straight off the aggregate (`idRecebedor != null`) — NO extra query.
   * Nullable in the schema for forward-compat; the server always sends a
   * boolean today.
   */
  hasRecebedor: z.boolean().nullable(),
  /**
   * The campanha's OWN slug (aperture-aphk8, `campanhas.slug`) — null until
   * the owner claims one via `campanhas.definirSlug`. Distinct from `slug`
   * above, which is the USUARIO's painel slug.
   */
  campanhaSlug: z.string().nullable(),
  /**
   * Whether this campanha has already used its single slug change via the
   * PERFIL editor (aperture — 1-troca). Derived from
   * `campanha.slugAlteradoEm !== null` — defining the slug through the
   * SETUP wizard does NOT set this. The frontend uses this to hide the
   * `SlugEditor` once true (only the "copy link" block remains).
   */
  slugJaAlterado: z.boolean(),
  /**
   * The campanha's perfil_campanhas.nome_bebe (fblrt contract amendment #2)
   * — null when the campanha has no perfil row OR a blank nome_bebe. This is
   * the CANONICAL blank-perfil signal (the design doc defines "blank" as
   * nome_bebe IS NULL): the client derives hasPerfil = nomeBebe !== null for
   * the card's "completar" affordance, and may use it as the display name.
   */
  nomeBebe: z.string().nullable(),
});

const CampanhaLegadoDTOSchema = z.object({
  email: z.string(),
  /** Never empty — server-side fallback applied in lib/legacy-users.ts. */
  nome: z.string(),
  utm: z.string().nullable(),
  mimos: z.number().int().nonnegative().nullable(),
});

const CampanhasListOutputSchema = z.object({
  novas: z.array(CampanhaNovaDTOSchema),
  legado: z.array(CampanhaLegadoDTOSchema),
});

export type CampanhasListOutput = z.infer<typeof CampanhasListOutputSchema>;

/**
 * `campanhas.criar` input — name-only (aperture-x0unf NOVA LISTA V1). Bounds
 * mirror the domain `CriarCampanhaInputSchema.titulo` (trimmed, 1..200) so a
 * bad title is a clean tRPC BAD_REQUEST before the use-case runs.
 */
const CriarCampanhaInputDTOSchema = z.object({
  titulo: z.string().trim().min(1, 'Titulo nao pode ser vazio').max(200),
});

function toCardDTO(
  campanha: Campanha,
  slug: string,
  nomeBebe: string | null,
): z.infer<typeof CampanhaNovaDTOSchema> {
  return {
    id: campanha.id,
    titulo: campanha.titulo,
    slug,
    quantidadeMimos: null,
    criadaEm: campanha.criadaEm.toISOString(),
    hasRecebedor: campanha.idRecebedor != null,
    campanhaSlug: campanha.slug,
    slugJaAlterado: campanha.slugAlteradoEm !== null,
    nomeBebe,
  };
}

// ── campanha slug (aperture-aphk8) ─────────────────────────────────────────

/**
 * Campanha-slug shape — the EXISTING user-slug machinery widened to the
 * campanha column bounds: same normalization posture (trimmed, lowercase,
 * starts with a letter, alphanum+hyphens; see SLUG_USUARIO_REGEX), but
 * min 3 / max 60 (`campanhas.slug` is varchar(60); the user regex caps at 30).
 */
const CAMPANHA_SLUG_REGEX = /^[a-z][a-z0-9-]{2,59}$/;

/**
 * Reserved set = the user-slug RESERVED_SLUGS denylist ∪ {'c', 'sucesso'}
 * (aperture-aphk8): 'c' is the planned short public-path prefix for
 * per-campanha URLs and 'sucesso' the checkout-success segment ('sucesso'
 * is already in RESERVED_SLUGS; kept here explicitly per the frozen
 * contract).
 */
const RESERVED_CAMPANHA_SLUGS: ReadonlySet<string> = new Set([...RESERVED_SLUGS, 'c', 'sucesso']);

/** Normalize a raw campanha-slug input the same way the user slug is compared. */
function normalizeCampanhaSlug(raw: string): string {
  return raw.trim().toLowerCase();
}

type CampanhaSlugCheck =
  | { readonly ok: true; readonly slug: string }
  | { readonly ok: false; readonly motivo: 'formato' | 'reservado' | 'em_uso' };

/**
 * Shared validation for definirSlug/validarSlug: format → reserved →
 * per-conta uniqueness (the conta's OTHER campanhas; a DIFFERENT conta
 * holding the same slug is fine — uniqueness is per-conta only, matching
 * the non-unique DB index).
 */
async function checkCampanhaSlug(
  ctx: TrpcContext,
  idConta: string,
  idCampanha: string,
  raw: string,
): Promise<CampanhaSlugCheck> {
  const slug = normalizeCampanhaSlug(raw);
  if (!CAMPANHA_SLUG_REGEX.test(slug)) {
    return { ok: false, motivo: 'formato' };
  }
  if (RESERVED_CAMPANHA_SLUGS.has(slug)) {
    return { ok: false, motivo: 'reservado' };
  }
  const campanhas = await ctx.deps.campanhaRepository.findCampanhasByAdministrador(idConta);
  const emUso = campanhas.some((c) => c.id !== idCampanha && c.slug === slug);
  if (emUso) {
    return { ok: false, motivo: 'em_uso' };
  }
  return { ok: true, slug };
}

function slugErrorMessage(motivo: 'formato' | 'reservado' | 'em_uso'): string {
  switch (motivo) {
    case 'formato':
      return 'slug_formato_invalido';
    case 'reservado':
      return 'slug_reservado';
    case 'em_uso':
      return 'slug_em_uso';
  }
}

function toSlugTRPCError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof CampanhaAcessoNegadoError) {
    return new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
  }
  if (err instanceof CampanhaInexistenteError) {
    return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err });
  }
  if (err instanceof CampanhaSlugJaAlteradoError) {
    return new TRPCError({ code: 'FORBIDDEN', message: 'slug_ja_alterado', cause: err });
  }
  return err instanceof Error
    ? new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err })
    : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'unknown_error' });
}

export const campanhasRouter = t.router({
  /**
   * All campaigns for the /campanhas mixed grid: the caller's 2.0 campanhas
   * (`novas`, criadaEm DESC) + matching 1.0 legacy snapshot entries
   * (`legado`). Both arrays always present; either may be empty.
   */
  list: t.procedure
    .output(CampanhasListOutputSchema)
    .query(async ({ ctx }): Promise<CampanhasListOutput> => {
      const { deps, headers } = ctx;

      let usuario: Awaited<ReturnType<typeof resolverUsuarioAutenticado>>['usuario'];
      try {
        ({ usuario } = await resolverUsuarioAutenticado(deps, headers));
      } catch (err) {
        if (err instanceof SessaoNaoAutenticadaError) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'sessao_invalida' });
        }
        throw err;
      }

      try {
        const campanhas = await deps.campanhaRepository.findCampanhasByAdministrador(
          usuario.idConta,
        );
        // fblrt amendment #2: each card carries its perfil's nomeBebe (the
        // canonical blank-perfil signal). One findByIdCampanha per card — a
        // conta holds a handful of campanhas, so N small point-reads beat
        // widening the port with a batch method today.
        const perfis = await Promise.all(
          campanhas.map((campanha) =>
            deps.perfilCampanhaRepository.findByIdCampanha(campanha.id),
          ),
        );
        const nomeBebePorCampanha = new Map(
          campanhas.map((campanha, i) => [campanha.id, perfis[i]?.conteudo.nomeBebe ?? null]),
        );
        const novas = [...campanhas]
          .sort((a, b) => b.criadaEm.getTime() - a.criadaEm.getTime())
          .map((campanha) =>
            toCardDTO(campanha, usuario.slug, nomeBebePorCampanha.get(campanha.id) ?? null),
          );

        // Static-snapshot legacy detection (spec §4) — pure, in-memory match;
        // no legacy-system call at runtime.
        const legado = buscarCampanhasLegado(usuario.email);

        return { novas, legado: [...legado] };
      } catch (err) {
        throw err instanceof Error
          ? new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err })
          : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'unknown_error' });
      }
    }),

  /**
   * Create a new 2.0 campanha for the authed conta (aperture-x0unf — NOVA
   * LISTA V1: multiple lists for the same baby). Name-only: {titulo} is the
   * only input; no slug / recebedor / perfil at creation (perfil_criadores is
   * per-USER, shared across the conta's lists). Returns the created card in the
   * SAME shape as a `list` → `novas` element so the client can optimistically
   * prepend it (or just invalidate `campanhas.list`); there is NO /painel
   * landing in V1.
   *
   * Mini-saga (mirrors the signup provisioner): criarCampanha → (compensation:
   * delete on downstream failure) → adicionarOpcaoContribuicao('presente').
   * A failure deletes the half-created campanha and throws — never a campanha
   * without its initial 'presente' opção.
   */
  criar: t.procedure
    .input(CriarCampanhaInputDTOSchema)
    .output(CampanhaNovaDTOSchema)
    .mutation(async ({ ctx, input }): Promise<z.infer<typeof CampanhaNovaDTOSchema>> => {
      const { deps, headers } = ctx;

      let usuario: Awaited<ReturnType<typeof resolverUsuarioAutenticado>>['usuario'];
      try {
        ({ usuario } = await resolverUsuarioAutenticado(deps, headers));
      } catch (err) {
        if (err instanceof SessaoNaoAutenticadaError) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'sessao_invalida' });
        }
        throw err;
      }

      const idCampanha = randomUUID() as IdCampanha;
      try {
        // Step 1 — the campanha aggregate (no Recebedor; user has no PIX at
        // creation, exactly like the signup default list).
        await criarCampanha(
          {
            campanhaRepository: deps.campanhaRepository,
            recebedorRepository: deps.recebedorRepository,
            plataformaRepository: deps.plataformaRepository,
            clock: deps.clock,
            observability: deps.observability,
          },
          {
            id: idCampanha,
            idPlataforma: usuario.idPlataforma,
            idsAdministradores: [usuario.idConta],
            titulo: input.titulo,
          },
        );

        // Step 2 — the initial 'presente' opção. On failure, compensate by
        // deleting the campanha (its opcoes cascade) so no half-built list
        // survives, then rethrow the ORIGINAL error.
        let campanhaComOpcao: Campanha;
        try {
          campanhaComOpcao = await adicionarOpcaoContribuicao(
            { campanhaRepository: deps.campanhaRepository, observability: deps.observability },
            { idCampanha, idOpcao: randomUUID() as IdOpcaoContribuicao, tipo: 'presente' },
          );
        } catch (opcaoErr) {
          try {
            await deps.campanhaRepository.delete(idCampanha);
            deps.observability.logger.info('campanhas.criar.compensacao_executada', {
              idCampanha,
              erroOriginal: opcaoErr instanceof Error ? opcaoErr.message : String(opcaoErr),
            });
          } catch (compErr) {
            deps.observability.logger.info('campanhas.criar.compensacao_falhou', {
              idCampanha,
              erroCompensacao: compErr instanceof Error ? compErr.message : String(compErr),
            });
          }
          throw opcaoErr;
        }

        // Fresh campanha has no perfil_campanhas row yet → nomeBebe null
        // (blank-perfil by definition; the wizard fills it in).
        return toCardDTO(campanhaComOpcao, usuario.slug, null);
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        // Domain input rejection (e.g. an out-of-bounds title that slips past
        // the DTO schema) → BAD_REQUEST; everything else → 500.
        if (err instanceof ArrecadacaoInputInvalidoError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
        }
        throw err instanceof Error
          ? new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err })
          : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'unknown_error' });
      }
    }),

  /**
   * Claim/replace a campanha's own URL slug (aperture-aphk8). Owner-gated
   * via resolverCampanhaAdministrada (present branch — not-found/not-owner
   * collapse to UNAUTHORIZED). Validation order: formato → reservado →
   * em_uso (per-conta: only the SAME conta's other campanhas conflict).
   * Rejections are BAD_REQUEST with the message being EXACTLY one of
   * 'slug_formato_invalido' | 'slug_reservado' | 'slug_em_uso' (frozen
   * contract — the frontend switches on it). Persists the NORMALIZED slug
   * and returns it.
   *
   * `origem` (aperture — 1-troca): distinguishes the SETUP wizard
   * (`SetupCampanhaWizard`, right after `campanhas.criar` or from a card's
   * "completar" affordance) from the PERFIL editor (`PerfilBody`'s
   * `SlugEditor`). Only `origem: 'perfil'` reads/writes
   * `campanha.slugAlteradoEm` — it is the ONE call site that consumes the
   * campanha's single allowed slug change (FORBIDDEN 'slug_ja_alterado' on
   * a second attempt). `origem: 'setup'` (the default — every EXISTING
   * caller, including every test, predates this field and means "setup")
   * never blocks and never marks the campanha as having used its change,
   * so defining a slug during setup does NOT consume the perfil's later
   * one-time edit.
   */
  definirSlug: t.procedure
    .input(
      z.object({
        idCampanha: z.string().uuid(),
        slug: z.string(),
        origem: z.enum(['setup', 'perfil']).default('setup'),
      }),
    )
    .output(z.object({ slug: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const { usuario, campanha } = await resolverCampanhaAdministrada(ctx, input.idCampanha);

        if (input.origem === 'perfil' && campanha.slugAlteradoEm !== null) {
          throw new CampanhaSlugJaAlteradoError(campanha.id);
        }

        const check = await checkCampanhaSlug(ctx, usuario.idConta, campanha.id, input.slug);
        if (!check.ok) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: slugErrorMessage(check.motivo) });
        }

        const marcarAlteracao = input.origem === 'perfil';
        const alteradoEm = marcarAlteracao ? ctx.deps.clock() : campanha.slugAlteradoEm;
        await ctx.deps.campanhaRepository.updateSlug(
          campanha.id,
          check.slug,
          alteradoEm,
          marcarAlteracao,
        );
        return { slug: check.slug };
      } catch (err) {
        throw toSlugTRPCError(err);
      }
    }),

  /**
   * Availability pre-check for the slug picker (aperture-aphk8). SAME checks
   * as definirSlug but NEVER throws for a taken/invalid slug — only auth
   * errors throw. `motivo` is null exactly when `disponivel` is true.
   */
  validarSlug: t.procedure
    .input(
      z.object({
        idCampanha: z.string().uuid(),
        slug: z.string(),
      }),
    )
    .output(
      z.object({
        disponivel: z.boolean(),
        motivo: z.enum(['formato', 'reservado', 'em_uso']).nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        const { usuario, campanha } = await resolverCampanhaAdministrada(ctx, input.idCampanha);

        const check = await checkCampanhaSlug(ctx, usuario.idConta, campanha.id, input.slug);
        return check.ok
          ? { disponivel: true, motivo: null }
          : { disponivel: false, motivo: check.motivo };
      } catch (err) {
        throw toSlugTRPCError(err);
      }
    }),
});
